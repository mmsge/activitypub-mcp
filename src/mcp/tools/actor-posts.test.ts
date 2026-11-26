import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  decodePostsCursor,
  encodeMetricCursor,
  engagementOf,
  getActorPostsSchema,
  hashtagCondition,
  metricExpr,
  metricKeysetCondition,
  metricOrderBy,
  SORT_METRICS,
} from './actor-posts.js'
import { encodeCursor, InvalidCursorError } from './pagination.js'

const dialect = new PgDialect()

describe('getActorPostsSchema', () => {
  it('accepts an optional tag and leaves it undefined when absent', () => {
    const parsed = getActorPostsSchema.parse({ actor_handle: '@markus@skvip.lol' })
    expect(parsed.tag).toBeUndefined()
  })

  it('keeps the tag verbatim (normalization happens at query time)', () => {
    const parsed = getActorPostsSchema.parse({ actor_handle: '@a@b', tag: '#TogSelfie' })
    expect(parsed.tag).toBe('#TogSelfie')
  })
})

describe('hashtagCondition', () => {
  it('binds the normalized tag (leading # stripped, lowercased)', () => {
    const { sql, params } = dialect.sqlToQuery(hashtagCondition('#TogSelfie'))
    // The whole predicate is bound as a single parameter, matching hashtag-stats.
    expect(params).toEqual(['togselfie'])
    expect(sql).toContain('EXISTS')
    expect(sql).toContain('jsonb_array_elements')
    // Only Hashtag tags count, so Mentions/Editions in the same array are ignored.
    expect(sql).toContain("lower(t->>'type') = 'hashtag'")
  })

  it('guards against non-array tags so jsonb_array_elements never errors', () => {
    const { sql } = dialect.sqlToQuery(hashtagCondition('togselfie'))
    expect(sql).toContain("jsonb_typeof")
    expect(sql).toContain("'array'")
  })

  it('normalizes a bare (no-#) tag the same way', () => {
    const { params } = dialect.sqlToQuery(hashtagCondition('TOGSELFIE'))
    expect(params).toEqual(['togselfie'])
  })
})

describe('sort_by', () => {
  it('defaults to the post date, so existing callers see no change', () => {
    expect(getActorPostsSchema.parse({ actor_handle: '@a@b' }).sort_by).toBe('published')
    expect(getActorPostsSchema.parse({ actor_handle: '@a@b', sort_by: 'views' }).sort_by).toBe('views')
    expect(() => getActorPostsSchema.parse({ actor_handle: '@a@b', sort_by: 'random' })).toThrow()
  })

  it('reads views from the TikTok archive post and the rest from AS2 collections, guarded', () => {
    const views = dialect.sqlToQuery(metricExpr('views')).sql
    expect(views).toContain(`jsonb_typeof("objects"."raw"->'tiktokArchive'->'post'->'views') = 'number'`)
    expect(views).toContain(`("objects"."raw"->'tiktokArchive'->'post'->>'views')::numeric`)
    for (const metric of ['likes', 'shares', 'replies'] as const) {
      const q = dialect.sqlToQuery(metricExpr(metric)).sql
      expect(q).toContain(`jsonb_typeof("objects"."raw"->'${metric}'->'totalItems') = 'number'`)
      expect(q).toContain(`("objects"."raw"->'${metric}'->>'totalItems')::numeric`)
    }
  })

  it('every metric the schema accepts is also a key of `engagement`, so a caller can see what it sorted by', () => {
    expect([...SORT_METRICS]).toEqual(['views', 'likes', 'shares', 'replies'])
    expect(Object.keys(engagementOf(null))).toEqual([...SORT_METRICS])
    for (const metric of SORT_METRICS) {
      expect(getActorPostsSchema.parse({ actor_handle: '@a@b', sort_by: metric }).sort_by).toBe(metric)
    }
  })

  it('puts posts without the count last in both directions, then the date newest first, then the id', () => {
    const desc = dialect.sqlToQuery(metricOrderBy(metricExpr('views'), 'desc')).sql
    expect(desc).toMatch(/END\) DESC NULLS LAST, "objects"\."published_at" DESC NULLS LAST, "objects"\."id" DESC$/)
    // "asc" reverses the count only: two equal posts, and the no-count tail, still read newest first.
    const asc = dialect.sqlToQuery(metricOrderBy(metricExpr('views'), 'asc')).sql
    expect(asc).toMatch(/END\) ASC NULLS LAST, "objects"\."published_at" DESC NULLS LAST, "objects"\."id" DESC$/)
  })

  it('continues past the cursor row: a lower count, the same count but older, or no count at all', () => {
    const cursor = { p: '2025-03-14T19:30:00.000Z', id: '00000000-0000-0000-0000-000000000001', m: '990000' }
    const { sql, params } = dialect.sqlToQuery(metricKeysetCondition(metricExpr('views'), cursor, 'desc'))
    expect(sql).toContain('< $1::numeric OR (')
    expect(sql).toMatch(/IS NULL\)$/)
    expect(params).toEqual(['990000', '990000', cursor.p, cursor.p, cursor.id])
    // Inside a tie the date keyset runs newest first: strictly older, or the same instant with a lower id.
    expect(sql).toContain(`"objects"."published_at" < $3::timestamptz OR ("objects"."published_at" = $4::timestamptz AND "objects"."id" < $5::uuid)`)
    // In the trailing section with no count, only the date keyset is left.
    const tail = dialect.sqlToQuery(metricKeysetCondition(metricExpr('views'), { ...cursor, m: null }, 'desc')).sql
    expect(tail).toMatch(/^\(\(CASE .* END\) IS NULL AND/)
  })

  it('under asc the count comparison flips and the tie-break does not, matching the ORDER BY', () => {
    const cursor = { p: '2025-03-14T19:30:00.000Z', id: '00000000-0000-0000-0000-000000000001', m: '12' }
    const { sql } = dialect.sqlToQuery(metricKeysetCondition(metricExpr('likes'), cursor, 'asc'))
    expect(sql).toContain('> $1::numeric OR (')
    expect(sql).toContain(`"objects"."published_at" < $3::timestamptz OR ("objects"."published_at" = $4::timestamptz AND "objects"."id" < $5::uuid)`)
    const tail = dialect.sqlToQuery(metricKeysetCondition(metricExpr('likes'), { ...cursor, m: null }, 'asc')).sql
    expect(tail).toContain(`IS NULL AND ("objects"."published_at" < $1::timestamptz`)
  })

  it('round-trips a count cursor and refuses it under another sort', () => {
    const token = encodeMetricCursor('views', '180200', new Date('2022-01-13T06:54:26Z'), 'abc')
    expect(decodePostsCursor(token, 'views')).toEqual({ p: '2022-01-13T06:54:26.000Z', id: 'abc', m: '180200' })
    expect(() => decodePostsCursor(token, 'likes')).toThrow(InvalidCursorError)
    expect(() => decodePostsCursor(token, 'published')).toThrow(/belongs to sort_by=views/)
  })

  it('keeps the date cursor as it was, and refuses it under a count sort', () => {
    const token = encodeCursor(new Date('2022-01-13T06:54:26Z'), 'abc')
    expect(decodePostsCursor(token, 'published')).toEqual({ p: '2022-01-13T06:54:26.000Z', id: 'abc', m: null })
    expect(() => decodePostsCursor(token, 'views')).toThrow(/belongs to sort_by=published/)
  })

  it('refuses a count cursor whose count is not a number', () => {
    const forged = Buffer.from(JSON.stringify({ p: null, id: 'x', s: 'views', m: "1); DROP TABLE objects;--" })).toString('base64url')
    expect(() => decodePostsCursor(forged, 'views')).toThrow(InvalidCursorError)
  })
})

describe('engagementOf', () => {
  it('reads the four counts, null where the post has none or has something else', () => {
    expect(engagementOf({
      likes: { type: 'Collection', totalItems: 15100 },
      shares: { type: 'Collection', totalItems: 1108 },
      replies: { type: 'Collection', first: { type: 'CollectionPage' } },
      tiktokArchive: { post: { views: 180200 } },
    })).toEqual({ views: 180200, likes: 15100, shares: 1108, replies: null })
    expect(engagementOf({ likes: { totalItems: '12' } })).toEqual({ views: null, likes: null, shares: null, replies: null })
    expect(engagementOf(null)).toEqual({ views: null, likes: null, shares: null, replies: null })
  })
})

