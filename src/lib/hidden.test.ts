import { describe, it, expect } from 'vitest'
import { withoutHidden } from './hidden.js'
import { getBooksSchema, buildConditions } from '../mcp/tools/books.js'
import { getWatchedSchema, getCatalogueDetailsSchema } from '../mcp/tools/watched.js'
import { getBookDetailsSchema } from '../mcp/tools/book-details.js'
import { getReadingStatsSchema } from '../mcp/tools/reading-stats.js'
import { getReadingPaceSchema } from '../mcp/tools/reading-pace.js'
import { getActorReadingStatusSchema } from '../mcp/tools/actor-reading.js'
import { catalogUpsertValues } from '../jobs/sync-neodb-metadata.js'
import { bookUpsertValues } from '../jobs/sync-book-metadata.js'
import { and } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { bookMetadata } from '../db/schema.js'
import { endpoints } from '../rest/table.js'

describe('include_hidden is off by default on every tool that can serve a hidden row', () => {
  const schemas = {
    get_books: getBooksSchema,
    get_book_details: getBookDetailsSchema,
    get_watched: getWatchedSchema,
    get_catalogue_details: getCatalogueDetailsSchema,
    get_reading_stats: getReadingStatsSchema,
    get_reading_pace: getReadingPaceSchema,
    get_actor_reading_status: getActorReadingStatusSchema,
  }

  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name} defaults include_hidden to false and accepts true`, () => {
      const base = name.startsWith('get_reading') || name === 'get_actor_reading_status'
        ? { actor_handle: '@a@b.test' }
        : { item_url: 'https://x.test/1', book_url: 'https://x.test/1' }
      expect(schema.parse(base).include_hidden).toBe(false)
      expect(schema.parse({ ...base, include_hidden: true }).include_hidden).toBe(true)
    })
  }
})

// coerceQuery only converts params named in an endpoint's `booleans` array. Miss one and
// GET /api/v1/books?include_hidden=true reaches zod as the STRING "true" and 400s — while
// the POST/QUERY path (JSON body, no coercion) keeps working, so the bug stays invisible
// to anyone testing with a body.
describe('REST boolean coercion', () => {
  const shouldCoerce = [
    '/books', '/book-details', '/watched', '/catalogue-details',
    '/reading-stats', '/reading-pace', '/actor-reading-status',
  ]

  for (const path of shouldCoerce) {
    it(`${path} lists include_hidden in its booleans array`, () => {
      const ep = endpoints.find((e) => e.path === path)
      expect(ep, `no endpoint registered at ${path}`).toBeDefined()
      expect(ep!.booleans).toContain('include_hidden')
    })
  }

  it('does not lose the booleans that were already there', () => {
    expect(endpoints.find((e) => e.path === '/watched')!.booleans).toContain('include_unenriched')
    expect(endpoints.find((e) => e.path === '/actor-reading-status')!.booleans).toContain('use_live')
  })
})

describe('get_books visibility condition', () => {
  // Render only the WHERE clause: `select()` names every column, `hidden_at` among them,
  // so asserting against the whole statement would pass for the wrong reason.
  const renderWhere = (input: Parameters<typeof buildConditions>[0]) => {
    const conditions = buildConditions(input)
    if (conditions.length === 0) return ''
    return getDb().select({ id: bookMetadata.id }).from(bookMetadata)
      .where(and(...conditions)).toSQL().sql.split(' where ')[1] ?? ''
  }

  it('excludes hidden rows by default', () => {
    expect(renderWhere({})).toContain('"hidden_at" is null')
  })

  it('drops the condition under include_hidden', () => {
    expect(buildConditions({ include_hidden: true })).toHaveLength(0)
    expect(buildConditions({ include_hidden: true, author: 'x' })).toHaveLength(1)
    expect(renderWhere({ include_hidden: true, author: 'x' })).not.toContain('hidden_at')
  })

  it('keeps the visibility condition alongside other filters', () => {
    const where = renderWhere({ author: 'x', format: 'Paperback' })
    expect(where).toContain('"hidden_at" is null')
    expect(where).toContain('ilike')
  })
})

// The reading tools do not LIST from book_metadata — they derive the book list from stored
// posts and use the table only as a metadata lookup. Filtering just that lookup would leave
// a hidden book counted in total_books but stripped of pages/author/format, skewing
// avg_pages and pages_coverage rather than removing it. Hence dropping whole entries.
describe('withoutHidden drops the book, not just its metadata', () => {
  const books = [
    { url: 'https://bw.test/book/1', title: 'Kept' },
    { url: 'https://bw.test/book/2', title: 'Hidden' },
    { url: null, title: 'No edition URL' },
  ]

  it('removes only the hidden entry', () => {
    const out = withoutHidden(books, new Set(['https://bw.test/book/2']))
    expect(out.map((b) => b.title)).toEqual(['Kept', 'No edition URL'])
  })

  it('keeps books with no Edition URL — they have no row that could carry the flag', () => {
    const out = withoutHidden(books, new Set(['https://bw.test/book/1', 'https://bw.test/book/2']))
    expect(out.map((b) => b.title)).toEqual(['No edition URL'])
  })

  it('is a no-op when nothing is hidden', () => {
    expect(withoutHidden(books, new Set())).toBe(books)
  })
})

// The highest-value test here. Both upserts do `onConflictDoUpdate({ set: values })`, so
// every key in `values` is rewritten on each refresh. Adding hiddenAt there — the obvious
// way to "keep the row in sync" — would silently unhide an admin-hidden row on the next
// 6-hourly enrichment pass, with no error and nothing in the logs.
describe('enrichment cannot unhide a row', () => {
  it('the NeoDB catalogue upsert never writes hidden_at', () => {
    const meta = {
      itemUrl: 'https://minreol.dk/movie/x', category: 'movie', itemType: 'Movie',
      title: 'T', displayTitle: null, origTitle: null, description: null, coverUrl: null,
      imdb: null, imdbUrl: null, tmdbUrl: null, externalResources: [], year: 2020,
      seasonNumber: null, episodeCount: null, genre: [], director: [], actors: [],
      language: [], area: [], rating: null, parentUuid: null, details: {},
      sourceMap: {}, bookwyrmBookUrl: null, raw: {},
    }
    const keys = Object.keys(catalogUpsertValues(meta as never, [], {}, new Date()))
    expect(keys).not.toContain('hiddenAt')
    expect(keys).not.toContain('hidden_at')
    expect(keys).toContain('enrichedAt') // sanity: the builder really did produce the row
  })

  it('the book metadata upsert never writes hidden_at', () => {
    const keys = Object.keys(bookUpsertValues({ bookUrl: 'https://bw.test/book/1' } as never))
    expect(keys).not.toContain('hiddenAt')
    expect(keys).not.toContain('hidden_at')
    expect(keys).toContain('fetchedAt')
  })
})
