import { describe, it, expect } from 'vitest'
import { aggregateReadingPace, daysToFinish, getReadingPaceSchema, type BookForPace } from './reading-pace.js'
import type { ReadingCycle } from '../../lib/bookwyrm-reading.js'

const cycle = (started: string | null, finished: string | null, n = 1): ReadingCycle => ({
  started: started ? new Date(started) : null,
  finished: finished ? new Date(finished) : null,
  cycle: n,
})

function book(partial: Partial<BookForPace>): BookForPace {
  return { title: 'T', author: 'A', url: 'u', cycles: [], pages: null, ...partial }
}

// Apply schema defaults (sort='finished', limit=50) like the tool does.
const withDefaults = (over: Record<string, unknown> = {}) =>
  getReadingPaceSchema.parse({ actor_handle: '@x@y', ...over })

describe('daysToFinish', () => {
  it('is calendar-day inclusive: same day = 1, next day = 2', () => {
    expect(daysToFinish(new Date('2026-07-11T08:00:00Z'), new Date('2026-07-11T22:00:00Z'))).toBe(1)
    expect(daysToFinish(new Date('2026-07-11T23:00:00Z'), new Date('2026-07-12T01:00:00Z'))).toBe(2)
    expect(daysToFinish(new Date('2026-07-11T00:00:00Z'), new Date('2026-07-22T00:00:00Z'))).toBe(12)
  })
})

describe('aggregateReadingPace', () => {
  it('computes days_to_finish and pages_per_day per finished cycle', () => {
    const out = aggregateReadingPace(
      [book({ title: 'Chanta', pages: 240, cycles: [cycle('2026-05-01', '2026-05-12')] })],
      withDefaults(),
    )
    expect(out.summary.books_finished).toBe(1)
    expect(out.books[0].days_to_finish).toBe(12)
    expect(out.books[0].pages_per_day).toBe(20)
  })

  it('a cycle without a start still counts, with null pace and reported coverage', () => {
    const out = aggregateReadingPace(
      [
        book({ title: 'Known', pages: 100, cycles: [cycle('2026-01-01', '2026-01-10')] }),
        book({ title: 'Unknown', url: 'u2', pages: 100, cycles: [cycle(null, '2026-02-01')] }),
      ],
      withDefaults(),
    )
    expect(out.summary.books_finished).toBe(2)
    expect(out.summary.start_coverage).toBe('1/2 finished cycles with a known start date')
    const unknown = out.books.find((b) => b.title === 'Unknown')
    expect(unknown?.days_to_finish).toBeNull()
    expect(unknown?.pages_per_day).toBeNull()
  })

  it('open cycles (currently reading) are not counted', () => {
    const out = aggregateReadingPace(
      [book({ cycles: [cycle('2026-07-01', null)] })],
      withDefaults(),
    )
    expect(out.summary.books_finished).toBe(0)
    expect(out.books).toHaveLength(0)
  })

  it('filters cycles by finish year and marks rereads', () => {
    const out = aggregateReadingPace(
      [
        book({
          title: 'Dune',
          cycles: [cycle('2024-01-01', '2024-01-20', 1), cycle('2026-06-01', '2026-06-15', 2)],
        }),
      ],
      withDefaults({ year: 2026 }),
    )
    expect(out.summary.books_finished).toBe(1)
    expect(out.books[0].cycle).toBe(2)
    expect(out.books[0].is_reread).toBe(true)
    expect(out.summary.rereads).toBe(1)
  })

  it('sort=fastest orders by days ascending with unknown-start cycles last', () => {
    const out = aggregateReadingPace(
      [
        book({ title: 'Slow', url: 'u1', cycles: [cycle('2026-01-01', '2026-01-30')] }),
        book({ title: 'Fast', url: 'u2', cycles: [cycle('2026-02-01', '2026-02-02')] }),
        book({ title: 'NoStart', url: 'u3', cycles: [cycle(null, '2026-03-01')] }),
      ],
      withDefaults({ sort: 'fastest' }),
    )
    expect(out.books.map((b) => b.title)).toEqual(['Fast', 'Slow', 'NoStart'])
  })

  it('detects overlap periods and max concurrency', () => {
    const out = aggregateReadingPace(
      [
        book({ title: 'A', url: 'ua', cycles: [cycle('2026-06-01', '2026-06-10')] }),
        book({ title: 'B', url: 'ub', cycles: [cycle('2026-06-05', '2026-06-20')] }),
        book({ title: 'C', url: 'uc', cycles: [cycle('2026-07-01', '2026-07-02')] }),
      ],
      withDefaults(),
    )
    expect(out.summary.max_concurrent_books).toBe(2)
    expect(out.overlaps).toHaveLength(1)
    expect(out.overlaps[0].books).toEqual(['A', 'B'])
    expect(out.overlaps[0].from).toBe('2026-06-05')
    expect(out.overlaps[0].to).toBe('2026-06-10')
  })

  it('summary aggregates avg/median days and fastest/slowest', () => {
    const out = aggregateReadingPace(
      [
        book({ title: 'A', url: 'ua', cycles: [cycle('2026-01-01', '2026-01-02')] }), // 2 days
        book({ title: 'B', url: 'ub', cycles: [cycle('2026-02-01', '2026-02-10')] }), // 10 days
      ],
      withDefaults(),
    )
    expect(out.summary.avg_days_to_finish).toBe(6)
    expect(out.summary.median_days_to_finish).toBe(6)
    expect(out.summary.fastest).toEqual({ title: 'A', days: 2 })
    expect(out.summary.slowest).toEqual({ title: 'B', days: 10 })
  })
})
