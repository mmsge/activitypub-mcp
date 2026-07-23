import { describe, it, expect } from 'vitest'
import { getWatchedSchema } from './watched.js'

describe('getWatchedSchema', () => {
  it('applies defaults for limit, page, and sort_order', () => {
    const parsed = getWatchedSchema.parse({})
    expect(parsed.limit).toBe(50)
    expect(parsed.page).toBe(1)
    expect(parsed.sort_order).toBe('desc')
    expect(parsed.title).toBeUndefined()
    expect(parsed.category).toBeUndefined()
    expect(parsed.item_type).toBeUndefined()
    expect(parsed.imdb).toBeUndefined()
    expect(parsed.cursor).toBeUndefined()
  })

  it('accepts all optional filters', () => {
    const parsed = getWatchedSchema.parse({
      title: 'conflict',
      category: 'tv',
      item_type: 'TVSeason',
      genre: 'thriller',
      imdb: 'tt27579939',
      sort_order: 'asc',
      cursor: 'tok',
    })
    expect(parsed).toMatchObject({
      title: 'conflict',
      category: 'tv',
      item_type: 'TVSeason',
      genre: 'thriller',
      imdb: 'tt27579939',
      sort_order: 'asc',
      cursor: 'tok',
    })
  })

  it('enforces limit bounds (1..200)', () => {
    expect(getWatchedSchema.parse({ limit: 200 }).limit).toBe(200)
    expect(() => getWatchedSchema.parse({ limit: 0 })).toThrow()
    expect(() => getWatchedSchema.parse({ limit: 201 })).toThrow()
  })

  it('rejects page below 1 and an unknown sort_order', () => {
    expect(() => getWatchedSchema.parse({ page: 0 })).toThrow()
    expect(() => getWatchedSchema.parse({ sort_order: 'sideways' })).toThrow()
  })
})
