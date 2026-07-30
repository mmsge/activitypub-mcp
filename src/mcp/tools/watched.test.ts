import { describe, it, expect } from 'vitest'
import { getWatchedSchema, getCatalogueDetailsSchema, markCommentsExpr } from './watched.js'
import { getDb } from '../../db/client.js'
import { catalogMetadata } from '../../db/schema.js'

describe('mark_comments correlation', () => {
  // Drizzle qualifies a column reference in WHERE ("catalog_metadata"."item_url") but NOT
  // inside a select-list expression, where it renders a bare "item_url". In this subquery
  // that binds to neodb_marks' own column — an always-true self-comparison that silently
  // hands every catalogue row every comment in the table. It throws no error and the
  // response shape looks right, so only the rendered SQL catches a regression.
  it('correlates on catalog_metadata.item_url, table-qualified', () => {
    const { sql } = getDb()
      .select({ markComments: markCommentsExpr })
      .from(catalogMetadata)
      .toSQL()
    expect(sql).toContain('m.item_url = catalog_metadata.item_url')
    expect(sql).not.toMatch(/m\.item_url = "?item_url"?/)
  })
})

describe('getWatchedSchema', () => {
  it('applies defaults for limit, page, sort_order, and include_unenriched', () => {
    const parsed = getWatchedSchema.parse({})
    expect(parsed.limit).toBe(50)
    expect(parsed.page).toBe(1)
    expect(parsed.sort_order).toBe('desc')
    expect(parsed.include_unenriched).toBe(false)
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
      mark_comment: 'kino',
      sort_order: 'asc',
      cursor: 'tok',
    })
    expect(parsed).toMatchObject({
      title: 'conflict',
      category: 'tv',
      item_type: 'TVSeason',
      genre: 'thriller',
      imdb: 'tt27579939',
      mark_comment: 'kino',
      sort_order: 'asc',
      cursor: 'tok',
    })
  })

  it('leaves mark_comment unset by default and takes it verbatim — no parsing, no trimming', () => {
    expect(getWatchedSchema.parse({}).mark_comment).toBeUndefined()
    // The comments are Nynorsk prose, full stop included; the filter must not
    // normalise what it is handed.
    expect(getWatchedSchema.parse({ mark_comment: 'Sett på kino.' }).mark_comment).toBe('Sett på kino.')
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

describe('getCatalogueDetailsSchema', () => {
  it('accepts item_url, title, and category', () => {
    const parsed = getCatalogueDetailsSchema.parse({
      item_url: 'https://minreol.dk/album/abc', title: 'abbey', category: 'music',
    })
    expect(parsed).toMatchObject({
      item_url: 'https://minreol.dk/album/abc', title: 'abbey', category: 'music',
    })
  })

  it('allows an empty object (handler validates that at least one selector is set)', () => {
    expect(() => getCatalogueDetailsSchema.parse({})).not.toThrow()
  })
})
