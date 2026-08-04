import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import {
  postsLane, readingLane, marksLane, musicLane, tripsLane, gardenLane,
  mergedCandidateSql, type LaneContext,
} from './lanes.js'
import { EMPTY_FACETS, type Facets } from './facets.js'
import { encodeCursor } from '../mcp/tools/pagination.js'

const dialect = new PgDialect()
const render = (s: SQL | null): string => (s == null ? '' : dialect.sqlToQuery(s).sql)

const ACTOR_IDS = {
  mastodon: ['https://skvip.lol/users/markus'],
  pixelfed: ['https://pixelfed.babb.no/users/markus'],
  loops: ['https://loops.video/ap/users/79185548970954752'],
  bookwyrm: ['https://bookwyrm.social/user/mvrkws'],
  neodb: ['https://minreol.dk/@markus@minreol.dk/'],
}

const ctx = (facets: Partial<Facets> = {}): LaneContext => ({
  facets: { ...EMPTY_FACETS, ...facets },
  actorIds: ACTOR_IDS,
  limit: 20,
})

// The lanes that read from `objects` and therefore carry a visibility verdict.
const VISIBILITY_LANES: Array<[string, (c: LaneContext) => SQL | null]> = [
  ['posts', postsLane],
  ['reading', readingLane],
  ['marks', marksLane],
]

describe('every lane that touches objects filters on visibility', () => {
  // The single assertion this whole feature rests on. A lane that forgets it
  // publishes followers-only posts.
  for (const [name, build] of VISIBILITY_LANES) {
    it(`${name} restricts to public`, () => {
      const sql = render(build(ctx()))
      expect(sql).toContain('"visibility" = \'public\'')
    })

    it(`${name} excludes soft-deleted rows`, () => {
      expect(render(build(ctx()))).toMatch(/deleted_at IS NULL/i)
    })
  }
})

describe('postsLane', () => {
  it('scopes to the allowlisted accounts, never to all of objects', () => {
    // `objects` also holds strangers' posts, filed there by the boost handler.
    const sql = render(postsLane(ctx()))
    expect(sql).toContain('o.actor_ap_id = ANY(')
  })

  it('yields nothing at all when no account is configured', () => {
    expect(postsLane({ ...ctx(), actorIds: { ...ACTOR_IDS, mastodon: [], pixelfed: [], loops: [] } }))
      .toBeNull()
  })

  it('takes only thread roots as entries', () => {
    expect(render(postsLane(ctx()))).toContain('o.in_reply_to IS NULL')
  })

  it('recognises a self-thread continuation as publishable', () => {
    // The EXISTS arm is what keeps Markus' own threads together; it must itself
    // be visibility-filtered, or a public root could pull in a private reply.
    const sql = render(postsLane(ctx()))
    expect(sql).toContain('p.actor_ap_id = o.actor_ap_id')
    expect(sql.match(/"visibility" = 'public'/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('requires a published date, so event_at is never null', () => {
    expect(render(postsLane(ctx()))).toContain('o.published_at IS NOT NULL')
  })
})

describe('readingLane', () => {
  it('keeps reviews, quotations, starts and finishes', () => {
    const sql = render(readingLane(ctx()))
    expect(sql).toContain('/review/')
    expect(sql).toContain('/quotation/')
    expect(sql).toContain('started reading')
    expect(sql).toContain('finished reading')
  })

  it('does not select bare ratings', () => {
    // Built from positive matches, so a new BookWyrm post type stays out until
    // someone decides it belongs — rather than appearing silently.
    expect(render(readingLane(ctx()))).not.toContain('/rating/')
  })

  it('dates a finish by the reader\'s own finish date where BookWyrm carried one', () => {
    expect(render(readingLane(ctx()))).toContain("'finishedDate'")
  })
})

describe('marksLane', () => {
  it('joins objects with an INNER join, not a LEFT join', () => {
    // A mark's visibility lives on the Note it federated with. Without the Note
    // there is no proof it was public, and a LEFT JOIN would publish it anyway.
    const sql = render(marksLane(ctx()))
    expect(sql).toMatch(/JOIN objects o ON o\.ap_id = m\.mark_ap_id/)
    expect(sql).not.toMatch(/LEFT JOIN objects/)
  })

  it('excludes hidden catalogue rows (ADR 0013)', () => {
    expect(render(marksLane(ctx()))).toContain('cm.hidden_at IS NULL')
  })

  it('excludes wishlist marks — intent is not activity', () => {
    expect(render(marksLane(ctx()))).toContain("m.status IS DISTINCT FROM 'wishlist'")
  })

  it('prefers the shelf date over the post date (ADR 0012)', () => {
    expect(render(marksLane(ctx()))).toContain('coalesce(m.watched_at, m.published_at)')
  })
})

describe('musicLane', () => {
  it('groups by the Oslo day, not the UTC day', () => {
    const sql = render(musicLane(ctx()))
    expect(sql).toContain("AT TIME ZONE 'Europe/Oslo'")
  })

  it('bounds the scan on the indexed column, so the GROUP BY reads a range', () => {
    // Without this the digest lane sorts the whole 51k-row history per request.
    expect(render(musicLane(ctx()))).toMatch(/s\.played_at >= now\(\) - /)
  })

  it('narrows the scan further when paging', () => {
    const cursor = encodeCursor(new Date('2026-06-01T00:00:00Z'), 'scrobbleday:2026-06-01')
    expect(render(musicLane(ctx({ cursor })))).toMatch(/s\.played_at < .*interval '2 days'/)
  })

  it('sits out a hashtag filter — scrobbles carry no tags', () => {
    expect(musicLane(ctx({ tag: 'togselfie' }))).toBeNull()
  })

  it('sits out a kind filter that is not its own', () => {
    expect(musicLane(ctx({ kind: 'book_review' }))).toBeNull()
    expect(musicLane(ctx({ kind: 'scrobble_day' }))).not.toBeNull()
  })
})

describe('gardenLane', () => {
  it('excludes undated notes rather than placing them at the epoch', () => {
    const sql = render(gardenLane(ctx()))
    expect(sql).toContain('g.note_date ~')
  })

  it('guards the cast, so one malformed hand-written date cannot error the page', () => {
    const sql = render(gardenLane(ctx()))
    expect(sql).toMatch(/note_date ~ '\^\\d\{4\}\(-\\d\{2\}/)
  })

  it('excludes soft-deleted notes', () => {
    expect(render(gardenLane(ctx()))).toContain('g.deleted_at IS NULL')
  })
})

describe('every lane', () => {
  const ALL: Array<[string, (c: LaneContext) => SQL | null]> = [
    ['posts', postsLane], ['reading', readingLane], ['marks', marksLane],
    ['music', musicLane], ['trips', tripsLane], ['garden', gardenLane],
  ]

  it('orders identically, with the C collation on the tiebreaker', () => {
    // The per-lane ORDER BY, the merge ORDER BY and the keyset comparison must
    // agree exactly, or a page boundary lands where the cursor does not expect it.
    for (const [name, build] of ALL) {
      const sql = render(build(ctx()))
      expect(sql, name).toContain('ORDER BY event_at DESC, ref_id COLLATE "C" DESC')
    }
  })

  it('limits itself, so the merge never materialises a whole table', () => {
    for (const [name, build] of ALL) {
      expect(render(build(ctx())), name).toMatch(/LIMIT \$\d+\s*$/)
    }
  })

  it('applies the keyset when a cursor is present', () => {
    const cursor = encodeCursor(new Date('2026-06-01T00:00:00Z'), 'post:abc')
    for (const [name, build] of ALL) {
      expect(render(build(ctx({ cursor }))), name).toContain('COLLATE "C" <')
    }
  })

  it('applies the archive bound', () => {
    for (const [name, build] of ALL) {
      const sql = render(build(ctx({ year: 2026, month: 8 })))
      expect(sql, name).toMatch(/timestamptz/)
    }
  })

  it('emits exactly the four merge columns', () => {
    for (const [name, build] of ALL) {
      const sql = render(build(ctx()))
      expect(sql, name).toContain('AS event_at')
      expect(sql, name).toContain('AS kind')
      expect(sql, name).toContain('AS ref_id')
      expect(sql, name).toContain('AS source')
    }
  })
})

describe('mergedCandidateSql', () => {
  it('unions every lane when unfiltered', () => {
    const sql = render(mergedCandidateSql(ctx()))
    expect(sql.match(/UNION ALL/g)?.length).toBe(5) // six lanes, five joins
  })

  it('runs only the selected lane when a platform is chosen', () => {
    const sql = render(mergedCandidateSql(ctx({ platform: 'bookwyrm' })))
    expect(sql).not.toContain('UNION ALL')
    expect(sql).toContain('/review/')
    expect(sql).not.toContain('scrobbles')
  })

  it('sorts and cuts the merged candidates the same way the lanes do', () => {
    const sql = render(mergedCandidateSql(ctx()))
    expect(sql).toContain('ORDER BY event_at DESC, ref_id COLLATE "C" DESC')
  })

  it('is null when nothing can match, rather than an empty union', () => {
    expect(mergedCandidateSql({
      ...ctx({ platform: 'mastodon' }),
      actorIds: { mastodon: [], pixelfed: [], loops: [], bookwyrm: [], neodb: [] },
    })).toBeNull()
  })

  it('binds actor ids as parameters, never inlined', () => {
    const { params } = dialect.sqlToQuery(mergedCandidateSql(ctx())!)
    expect(params).toContain('https://skvip.lol/users/markus')
  })
})
