import { describe, it, expect } from 'vitest'
import {
  assemblePagesTimeline, averagePerActiveDay, bookKeys, foldBooks, pickTopBook, UNTITLED,
  type BookInfo, type DayBookRow,
} from './pages-timeline.js'

const BOOKS: BookInfo[] = [
  { bookId: 'aaaa1111-0000', title: 'Nora', authors: ['Ibsen'], bookPages: 130 },
  { bookId: 'bbbb2222-0000', title: 'Ubesvart anrop', authors: ['Dåsnes'], bookPages: 352 },
  { bookId: 'cccc3333-0000', title: 'Kjærleik', authors: [], bookPages: null },
]

const row = (day: string, bucket: string, bookId: string, pages: number, entries = 1): DayBookRow =>
  ({ day, bucket, bookId, pages, entries })

describe('assemblePagesTimeline', () => {
  const rows: DayBookRow[] = [
    // Week of Monday 2026-09-28
    row('2026-09-28', '2026-09-28', 'aaaa1111-0000', 40, 2),
    row('2026-09-28', '2026-09-28', 'bbbb2222-0000', 10),
    row('2026-09-30', '2026-09-28', 'bbbb2222-0000', 25),
    // Week of 2026-10-05 is silent; week of 2026-10-12 has one day.
    row('2026-10-13', '2026-10-12', 'cccc3333-0000', 12),
  ]
  const base = {
    bucket: 'week' as const,
    range: { from: '2026-09-28', to: '2026-10-14' },
    rows,
    books: BOOKS,
    topN: 0,
    includeEmptyBuckets: true,
    filters: { book: null },
  }

  it('sums pages per bucket and keeps silent buckets, newest first', () => {
    const t = assemblePagesTimeline(base)
    expect(t.buckets.map((b) => [b.date, b.pages])).toEqual([
      ['2026-10-12', 12],
      ['2026-10-05', 0],
      ['2026-09-28', 75],
    ])
    expect(t.totals).toEqual({
      buckets: 3,
      active_buckets: 2,
      active_days: 3,
      pages: 87,
      entries: 5,
      distinct_books: 3,
      avg_pages_per_active_day: 29,
    })
  })

  it('reports active days and active books per bucket, and the leader from raw sums', () => {
    const week = assemblePagesTimeline(base).buckets.find((b) => b.date === '2026-09-28')!
    expect(week.active_days).toBe(2)
    expect(week.active_books).toBe(2)
    expect(week.entries).toBe(4)
    expect(week.top).toBe('Nora') // 40 against 35
    expect(week.books).toEqual({ Nora: 40, 'Ubesvart anrop': 35 })
  })

  it('a day without reading is signal: an empty bucket is a zero row, not a gap', () => {
    const silent = assemblePagesTimeline(base).buckets.find((b) => b.date === '2026-10-05')!
    expect(silent).toEqual({ date: '2026-10-05', pages: 0, entries: 0, active_days: 0, active_books: 0, top: null, books: {} })
  })

  it('drops silent buckets only when asked, and never from the totals', () => {
    const t = assemblePagesTimeline({ ...base, includeEmptyBuckets: false })
    expect(t.buckets.map((b) => b.date)).toEqual(['2026-10-12', '2026-09-28'])
    expect(t.totals.buckets).toBe(3)
  })

  it('folds past top_n without changing the bucket total or the leader', () => {
    const t = assemblePagesTimeline({ ...base, topN: 1 })
    const week = t.buckets.find((b) => b.date === '2026-09-28')!
    expect(week.pages).toBe(75)
    expect(week.top).toBe('Nora')
    expect(week.books).toEqual({ Nora: 40, Other: 35 })
    expect(t.other_key).toBe('Other')
  })

  it('hoists book metadata with the book_id, so a key never needs parsing', () => {
    const t = assemblePagesTimeline(base)
    expect(t.books['Ubesvart anrop']).toEqual({
      book_id: 'bbbb2222-0000', title: 'Ubesvart anrop', authors: ['Dåsnes'], book_pages: 352, pages: 35, entries: 2,
    })
    expect(Object.keys(t.books)).toEqual(['Nora', 'Ubesvart anrop', 'Kjærleik']) // pages-descending
  })

  it('by day, a bucket is exactly the stored date', () => {
    const dayRows = rows.filter((r) => r.day <= '2026-09-30').map((r) => ({ ...r, bucket: r.day }))
    const t = assemblePagesTimeline({ ...base, bucket: 'day', rows: dayRows, range: { from: '2026-09-28', to: '2026-09-30' } })
    expect(t.buckets.map((b) => [b.date, b.pages, b.active_days])).toEqual([
      ['2026-09-30', 25, 1],
      ['2026-09-29', 0, 0],
      ['2026-09-28', 50, 1],
    ])
  })

  it('is a well-formed empty answer when nothing matched', () => {
    const t = assemblePagesTimeline({ ...base, range: null, rows: [] })
    expect(t.buckets).toEqual([])
    expect(t.range).toEqual({ from: null, to: null })
    expect(t.totals.avg_pages_per_active_day).toBeNull()
    expect(t.totals.distinct_books).toBe(0)
  })
})

describe('bookKeys', () => {
  it('keys on the title, and separates two different books that share one', () => {
    // A re-read in another edition is a different StoryGraph book with the same title.
    const keys = bookKeys([
      { bookId: 'x1234567-a', title: 'Nora', pages: 10 },
      { bookId: 'y7654321-b', title: 'Nora', pages: 90 },
      { bookId: 'z0000000-c', title: null, pages: 1 },
    ])
    expect(keys.get('y7654321-b')).toBe('Nora') // the one with more pages keeps the bare title
    expect(keys.get('x1234567-a')).toBe('Nora [x1234567]')
    expect(keys.get('z0000000-c')).toBe(UNTITLED)
  })
})

describe('pickTopBook / foldBooks', () => {
  const range = new Map([['A', 100], ['B', 50]])

  it('breaks a tie by range-wide pages, then by key', () => {
    expect(pickTopBook(new Map([['B', 10], ['A', 10]]), range)).toBe('A')
    expect(pickTopBook(new Map([['D', 10], ['C', 10]]), new Map())).toBe('C')
  })

  it('never crowns a book that went nowhere (a correction can be negative)', () => {
    expect(pickTopBook(new Map([['A', 0], ['B', -5]]), range)).toBeNull()
  })

  it('top_n 0 keeps every book', () => {
    expect(foldBooks(new Map([['A', 1], ['B', 2]]), { topN: 0, foldKey: 'Other', range })).toEqual({ B: 2, A: 1 })
  })
})

describe('averagePerActiveDay', () => {
  it('rounds to one decimal and is null with no reading', () => {
    expect(averagePerActiveDay(100, 3)).toBe(33.3)
    expect(averagePerActiveDay(0, 0)).toBeNull()
  })
})
