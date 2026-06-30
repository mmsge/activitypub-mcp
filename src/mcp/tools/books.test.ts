import { describe, it, expect } from 'vitest'
import { getBooksSchema } from './books.js'
import { encodeCursor, decodeCursor } from './pagination.js'

describe('getBooksSchema', () => {
  it('applies defaults for limit, page, and sort_order', () => {
    const parsed = getBooksSchema.parse({})
    expect(parsed.limit).toBe(50)
    expect(parsed.page).toBe(1)
    expect(parsed.sort_order).toBe('desc')
    expect(parsed.title).toBeUndefined()
    expect(parsed.format).toBeUndefined()
    expect(parsed.language).toBeUndefined()
    expect(parsed.cursor).toBeUndefined()
  })

  it('accepts all optional filters', () => {
    const parsed = getBooksSchema.parse({
      title: 'dune',
      format: 'Paperback',
      language: 'en',
      sort_order: 'asc',
      cursor: 'tok',
    })
    expect(parsed).toMatchObject({
      title: 'dune',
      format: 'Paperback',
      language: 'en',
      sort_order: 'asc',
      cursor: 'tok',
    })
  })

  it('enforces limit bounds (1..200)', () => {
    expect(getBooksSchema.parse({ limit: 200 }).limit).toBe(200)
    expect(() => getBooksSchema.parse({ limit: 0 })).toThrow()
    expect(() => getBooksSchema.parse({ limit: 201 })).toThrow()
  })

  it('rejects page below 1 and an unknown sort_order', () => {
    expect(() => getBooksSchema.parse({ page: 0 })).toThrow()
    expect(() => getBooksSchema.parse({ sort_order: 'sideways' })).toThrow()
  })
})

describe('books keyset cursor', () => {
  it('round-trips a (fetched_at, id) cursor', () => {
    const ts = new Date('2026-06-30T12:34:56.000Z')
    const id = '11111111-2222-3333-4444-555555555555'
    const decoded = decodeCursor(encodeCursor(ts, id))
    expect(decoded.p).toBe(ts.toISOString())
    expect(decoded.id).toBe(id)
  })
})
