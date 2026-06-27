import { describe, it, expect } from 'vitest'
import { aggregateReadingStats, type BookForStats } from './reading-stats.js'
import { getReadingStatsSchema } from './reading-stats.js'

// Build a book with read-shelf defaults; override per case.
function book(partial: Partial<BookForStats>): BookForStats {
  return {
    title: 'T',
    author: 'A',
    url: 'u',
    shelf: 'read',
    finished: null,
    rating: null,
    pages: null,
    format: null,
    pubYear: null,
    ...partial,
  }
}

// Apply schema defaults (status='read', group_by='year', limit=20) like the tool does.
const withDefaults = (over: Record<string, unknown> = {}) =>
  getReadingStatsSchema.parse({ actor_handle: '@x@y', ...over })

const SAMPLE: BookForStats[] = [
  book({ title: 'The Radleys', format: 'Paperback', pages: 352, finished: new Date('2026-03-01'), rating: '4' }),
  book({ title: 'Terminal Boredom', format: 'Paperback', pages: 218, finished: new Date('2026-05-02'), rating: '5' }),
  book({ title: 'Paper Girls', format: 'GraphicNovel', pages: 800, finished: new Date('2026-06-20') }),
  book({ title: 'Ducks', format: 'GraphicNovel', pages: null, finished: new Date('2026-02-10') }), // no pages
  book({ title: 'Veke 53', format: 'AudiobookFormat', pages: null, finished: new Date('2026-01-05') }),
  book({ title: 'Old One', format: 'Paperback', pages: 100, finished: new Date('2025-12-01') }), // different year
  book({ title: 'On Shelf', shelf: 'reading', pages: 500, finished: null }), // not read
]

describe('aggregateReadingStats', () => {
  it('only counts the requested shelf (default read)', () => {
    const r = aggregateReadingStats(SAMPLE, withDefaults())
    expect(r.total_books).toBe(6) // the 'reading' book is excluded
  })

  it('reports page coverage instead of silently dropping unknowns', () => {
    const r = aggregateReadingStats(SAMPLE, withDefaults({ year: 2026 }))
    // 2026 read books: Radleys, Terminal Boredom, Paper Girls, Ducks, Veke 53 = 5
    expect(r.total_books).toBe(5)
    expect(r.books_with_pages).toBe(3) // Ducks + Veke 53 lack pages
    expect(r.pages_coverage).toBe('3/5 books with known page counts')
  })

  it('answers "average length of books read in 2026" overall and prose-only', () => {
    const r = aggregateReadingStats(SAMPLE, withDefaults({ year: 2026 }))
    // overall pages: 352, 218, 800 -> avg 457 (1370/3), median 352, total 1370
    expect(r.total_pages).toBe(1370)
    expect(r.avg_pages).toBe(457)
    expect(r.median_pages).toBe(352)
    // prose-only excludes the GraphicNovel (Paper Girls): 352, 218 -> avg 285
    expect(r.avg_pages_prose).toBe(285)
    expect(r.prose_books).toBe(2)
  })

  it('filters by finish-date year and reports the span', () => {
    const r = aggregateReadingStats(SAMPLE, withDefaults({ year: 2026 }))
    expect(r.first_finished_at).toBe('2026-01-05')
    expect(r.last_finished_at).toBe('2026-06-20')
  })

  it('groups by format with per-format page rollups', () => {
    const r = aggregateReadingStats(SAMPLE, withDefaults({ year: 2026, group_by: 'format' }))
    const paperback = r.top.find((t) => t.key === 'Paperback')
    const graphic = r.top.find((t) => t.key === 'GraphicNovel')
    expect(paperback).toMatchObject({ books: 2, total_pages: 570, avg_pages: 285 })
    expect(graphic).toMatchObject({ books: 2, total_pages: 800, avg_pages: 800 }) // Ducks has no pages
  })

  it('builds a ratings distribution over whole stars', () => {
    const r = aggregateReadingStats(SAMPLE, withDefaults({ year: 2026 }))
    expect(r.rating.count).toBe(2)
    expect(r.rating.avg).toBe(4.5)
    expect(r.rating.distribution['4']).toBe(1)
    expect(r.rating.distribution['5']).toBe(1)
  })

  it('filters by exact format and by author substring', () => {
    expect(aggregateReadingStats(SAMPLE, withDefaults({ format: 'GraphicNovel' })).total_books).toBe(2)
    expect(aggregateReadingStats(SAMPLE, withDefaults({ author: 'a' })).total_books).toBe(6) // author 'A' matches all
  })

  it('returns empty-but-shaped stats when nothing matches', () => {
    const r = aggregateReadingStats(SAMPLE, withDefaults({ year: 1990 }))
    expect(r.total_books).toBe(0)
    expect(r.avg_pages).toBeNull()
    expect(r.median_pages).toBeNull()
    expect(r.pages_coverage).toBe('0/0 books with known page counts')
  })
})
