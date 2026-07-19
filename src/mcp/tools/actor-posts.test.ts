import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { getActorPostsSchema, hashtagCondition } from './actor-posts.js'

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
