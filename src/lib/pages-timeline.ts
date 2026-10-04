/**
 * The pure half of `get_pages_timeline`: rolling day×book page sums up into buckets,
 * folding each bucket's books to `top_n`, and assembling the response. See ADR 0062.
 *
 * Nothing here touches a database and NOTHING HERE KNOWS ABOUT TIMEZONES — not even in
 * the way `scrobble-timeline.ts` does. A StoryGraph entry's date is already the local
 * calendar day (sidetal records what StoryGraph shows), so there is no instant to
 * convert. Bucket keys are `YYYY-MM-DD` strings and stepping them is calendar
 * arithmetic, which is why the enumeration helpers are borrowed from the scrobble
 * timeline unchanged: they never had a zone in them either.
 *
 * Page arithmetic rule: a day's pages are SUM(pages_read) over that day's live, dated
 * entries with a non-null pages_read. `pages_read` is StoryGraph's own per-update delta
 * and is never recomputed from a cumulative position. The SQL applies the filters; this
 * module only adds up what it is given.
 */
import { bucketKeys, foldKeyFor, resolveRange, type Bucket } from './scrobble-timeline.js'

export { BUCKETS, resolveRange, type Bucket } from './scrobble-timeline.js'

/** One `(day, bucket, book)` aggregate row. `bucket` comes from the SQL's date_trunc. */
export type DayBookRow = {
  day: string
  bucket: string
  bookId: string
  pages: number
  entries: number
}

/** What is known about a book, for the hoisted `books` block. */
export type BookInfo = {
  bookId: string
  title: string | null
  authors: string[]
  bookPages: number | null
}

export type PagesBucket = {
  /** The bucket's first day: a Monday for week, the 1st for month. */
  date: string
  /** The TRUE total — unaffected by top_n. */
  pages: number
  /** Entries that contributed (dated, live, with pages_read). */
  entries: number
  /** Days in the bucket whose summed pages are above zero. */
  active_days: number
  /** Books with at least one contributing entry in the bucket. */
  active_books: number
  /** The book key with the most pages in the bucket; null when none read anything. */
  top: string | null
  /** Book key → pages, pages-descending, folded to top_n. */
  books: Record<string, number>
}

export type PagesTimeline = {
  bucket: Bucket
  range: { from: string | null; to: string | null }
  totals: {
    buckets: number
    active_buckets: number
    active_days: number
    pages: number
    entries: number
    distinct_books: number
    avg_pages_per_active_day: number | null
  }
  other_key: string
  books: Record<string, { book_id: string; title: string | null; authors: string[]; book_pages: number | null; pages: number; entries: number }>
  buckets: PagesBucket[]
  filters: { book: string | null }
}

export const UNTITLED = '(untitled)'

/**
 * The key a book is reported under: its title, which is what a reader wants to see in a
 * chart. Two DIFFERENT books with the same title (a re-read in another edition is a
 * different StoryGraph book) are told apart by a short id suffix on all but the one with
 * the most pages, so neither silently absorbs the other. Every hoisted entry also
 * carries `book_id`, so nothing downstream has to parse a key.
 */
export function bookKeys(books: ReadonlyArray<{ bookId: string; title: string | null; pages: number }>): Map<string, string> {
  const sorted = [...books].sort((a, b) => b.pages - a.pages || (a.bookId < b.bookId ? -1 : a.bookId > b.bookId ? 1 : 0))
  const taken = new Set<string>()
  const out = new Map<string, string>()
  for (const b of sorted) {
    const base = b.title?.trim() || UNTITLED
    let key = base
    if (taken.has(key)) key = `${base} [${b.bookId.slice(0, 8)}]`
    for (let n = 2; taken.has(key); n++) key = `${base} [${b.bookId}#${n}]`
    taken.add(key)
    out.set(b.bookId, key)
  }
  return out
}

/** More pages first, then more range-wide pages, then key byte-wise — stable between calls. */
function compare(a: readonly [string, number], b: readonly [string, number], range: ReadonlyMap<string, number>): number {
  if (a[1] !== b[1]) return b[1] - a[1]
  const ra = range.get(a[0]) ?? 0
  const rb = range.get(b[0]) ?? 0
  if (ra !== rb) return rb - ra
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
}

/**
 * The bucket's reading leader, from its RAW per-book sums so it never changes with
 * top_n and is never the fold key. Only a book that actually moved forwards can lead.
 */
export function pickTopBook(raw: ReadonlyMap<string, number>, range: ReadonlyMap<string, number>): string | null {
  let best: readonly [string, number] | null = null
  for (const e of raw) {
    if (e[1] <= 0) continue
    if (!best || compare(e, best, range) < 0) best = e
  }
  return best ? best[0] : null
}

/** Cap at top_n and sum the remainder into the fold key. top_n 0 means every book. */
export function foldBooks(
  raw: ReadonlyMap<string, number>,
  opts: { topN: number; foldKey: string; range: ReadonlyMap<string, number> },
): Record<string, number> {
  const sorted = [...raw].sort((a, b) => compare(a, b, opts.range))
  const head = opts.topN > 0 ? sorted.slice(0, opts.topN) : sorted
  const out: Record<string, number> = {}
  for (const [k, v] of head) out[k] = v
  if (opts.topN > 0 && sorted.length > opts.topN) {
    let rest = 0
    for (const [, v] of sorted.slice(opts.topN)) rest += v
    out[opts.foldKey] = rest
  }
  return out
}

/** Pages per active day, one decimal; null when nothing was read. */
export function averagePerActiveDay(pages: number, activeDays: number): number | null {
  return activeDays > 0 ? Math.round((pages / activeDays) * 10) / 10 : null
}

/**
 * Build the response from the day×book aggregate, the book metadata and the resolved
 * range. Buckets come back newest-first, like every other feed here.
 */
export function assemblePagesTimeline(input: {
  bucket: Bucket
  range: { from: string; to: string } | null
  rows: readonly DayBookRow[]
  books: readonly BookInfo[]
  topN: number
  includeEmptyBuckets: boolean
  filters: { book: string | null }
}): PagesTimeline {
  const info = new Map(input.books.map((b) => [b.bookId, b]))

  // Range-wide per-book figures, from the same rows the buckets are built from, so the
  // two can never disagree.
  const perBook = new Map<string, { pages: number; entries: number }>()
  for (const r of input.rows) {
    const t = perBook.get(r.bookId) ?? { pages: 0, entries: 0 }
    t.pages += r.pages
    t.entries += r.entries
    perBook.set(r.bookId, t)
  }
  const keys = bookKeys([...perBook].map(([bookId, t]) => ({ bookId, title: info.get(bookId)?.title ?? null, pages: t.pages })))
  const rangePages = new Map<string, number>()
  for (const [bookId, t] of perBook) rangePages.set(keys.get(bookId)!, t.pages)
  const foldKey = foldKeyFor(rangePages.keys())

  // Per bucket: book sums, entry counts and per-day sums (for active days).
  type Acc = { books: Map<string, number>; activeBooks: Set<string>; entries: number; days: Map<string, number> }
  const byBucket = new Map<string, Acc>()
  for (const r of input.rows) {
    let acc = byBucket.get(r.bucket)
    if (!acc) byBucket.set(r.bucket, (acc = { books: new Map(), activeBooks: new Set(), entries: 0, days: new Map() }))
    const key = keys.get(r.bookId)!
    acc.books.set(key, (acc.books.get(key) ?? 0) + r.pages)
    if (r.entries > 0) acc.activeBooks.add(key)
    acc.entries += r.entries
    acc.days.set(r.day, (acc.days.get(r.day) ?? 0) + r.pages)
  }

  const enumerated = input.range ? bucketKeys(input.range.from, input.range.to, input.bucket) : []
  const buckets: PagesBucket[] = []
  let activeBuckets = 0
  let activeDays = 0
  let totalPages = 0
  let totalEntries = 0
  for (const date of enumerated) {
    const acc = byBucket.get(date)
    let pages = 0
    let days = 0
    if (acc) {
      for (const v of acc.books.values()) pages += v
      for (const v of acc.days.values()) if (v > 0) days++
    }
    totalPages += pages
    totalEntries += acc?.entries ?? 0
    activeDays += days
    if (pages > 0) activeBuckets++
    if (pages === 0 && (acc?.entries ?? 0) === 0 && !input.includeEmptyBuckets) continue
    const raw = acc?.books ?? new Map<string, number>()
    buckets.push({
      date,
      pages,
      entries: acc?.entries ?? 0,
      active_days: days,
      active_books: acc?.activeBooks.size ?? 0,
      top: pickTopBook(raw, rangePages),
      books: foldBooks(raw, { topN: input.topN, foldKey, range: rangePages }),
    })
  }
  buckets.reverse()

  const books: PagesTimeline['books'] = {}
  for (const [bookId, t] of [...perBook].sort((a, b) => b[1].pages - a[1].pages || (keys.get(a[0])! < keys.get(b[0])! ? -1 : 1))) {
    const i = info.get(bookId)
    books[keys.get(bookId)!] = {
      book_id: bookId,
      title: i?.title ?? null,
      authors: i?.authors ?? [],
      book_pages: i?.bookPages ?? null,
      pages: t.pages,
      entries: t.entries,
    }
  }

  return {
    bucket: input.bucket,
    range: { from: input.range?.from ?? null, to: input.range?.to ?? null },
    totals: {
      buckets: enumerated.length,
      active_buckets: activeBuckets,
      active_days: activeDays,
      pages: totalPages,
      entries: totalEntries,
      distinct_books: perBook.size,
      avg_pages_per_active_day: averagePerActiveDay(totalPages, activeDays),
    },
    other_key: foldKey,
    books,
    buckets,
    filters: input.filters,
  }
}
