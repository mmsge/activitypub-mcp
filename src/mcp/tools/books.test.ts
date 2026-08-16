import { describe, it, expect } from 'vitest'
import { and } from 'drizzle-orm'
import { getBooksSchema, buildConditions } from './books.js'
import { getDb } from '../../db/client.js'
import { bookMetadata } from '../../db/schema.js'
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


describe('the shelf filter', () => {
  // WHERE clause only — see the same helper in lib/hidden.test.ts for why.
  const renderWhere = (input: Parameters<typeof buildConditions>[0]) => {
    const conditions = buildConditions(input)
    if (conditions.length === 0) return ''
    return getDb().select({ id: bookMetadata.id }).from(bookMetadata)
      .where(and(...conditions)).toSQL().sql.split(' where ')[1] ?? ''
  }

  it('accepts every shelf plus unknown, and rejects anything else', () => {
    for (const shelf of ['read', 'reading', 'to-read', 'stopped-reading', 'unknown']) {
      expect(getBooksSchema.parse({ shelf }).shelf).toBe(shelf)
    }
    expect(() => getBooksSchema.parse({ shelf: 'stopped' })).toThrow()
    expect(() => getBooksSchema.parse({ shelf: 'abandoned' })).toThrow()
  })

  it('is absent by default, so the endpoint still returns every cached book', () => {
    expect(getBooksSchema.parse({}).shelf).toBeUndefined()
    expect(renderWhere({})).not.toContain('bookwyrm_shelf_marks')
  })

  it('correlates on a table-qualified book_url, not a bare one', () => {
    // A bare `book_url` inside the subquery binds to bookwyrm_shelf_marks' own
    // column — an always-true self-comparison that would match every book. The
    // qualification is the entire correctness of this filter.
    const where = renderWhere({ shelf: 'read' })
    expect(where).toContain('bookwyrm_shelf_marks')
    expect(where).toContain('s.book_url = book_metadata.book_url')
    expect(where).toContain('s.removed_at IS NULL')
  })

  it('asks for membership positively, so an unsynced book is not "read"', () => {
    expect(renderWhere({ shelf: 'read' })).toContain('EXISTS')
    expect(renderWhere({ shelf: 'read' })).not.toContain('NOT EXISTS')
  })

  it('unknown is the inverse — no live shelf row at all', () => {
    expect(renderWhere({ shelf: 'unknown' })).toContain('NOT EXISTS')
  })
})
