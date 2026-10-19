import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { bookMetadata, storygraphReads } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { normalizeTitle } from '../lib/bookwyrm-reading.js'
import { loadBookwyrmBooks, loadDerivedReadingEvents } from '../lib/reading-query.js'
import { rangeKey, type StorygraphCsvRow, type StorygraphReadRange } from '../lib/parse-storygraph-csv.js'
import {
  collapseKey,
  matchStorygraphBook,
  mergeStorygraphReads,
  normalizeMatchText,
  type BookMatch,
  type MatchCandidate,
  type StorygraphConflict,
} from '../lib/storygraph-reads.js'

/**
 * Store the reads in a StoryGraph library export against one BookWyrm actor, and report
 * what they would add to that actor's reading cycles. See ADR 0063.
 *
 * Idempotent: identity is (actor, book, range), so the same file twice writes nothing.
 * An export is complete for the books it lists, so a read StoryGraph no longer lists for
 * a book in the file is deleted; a book absent from the file is left alone (ADR 0054's
 * rule, by book rather than by date range).
 */

export interface StorygraphImportReport {
  actorApId: string
  rowsRead: number
  rowsWithReads: number
  booksMatched: number
  matchedByIsbn: number
  matchedByTitle: number
  unmatched: { title: string; authors: string[]; reads: StorygraphReadRange[] }[]
  readsInserted: number
  readsUpdated: number
  readsUnchanged: number
  readsDeleted: number
  startsFilled: number
  finishesFilled: number
  readsAdded: number
  conflicts: StorygraphConflict[]
  unparsed: { title: string; value: string }[]
}

/** `isbn:<13>` when the export has one, else the folded title and first author. */
export function storygraphBookKey(row: Pick<StorygraphCsvRow, 'title' | 'authors' | 'isbn13'>): string {
  if (row.isbn13) return `isbn:${row.isbn13}`
  return `title:${normalizeMatchText(row.title)}|${normalizeMatchText(row.authors[0] ?? '')}`
}

/**
 * Every BookWyrm book the actor has a status about, with every Edition URL its statuses
 * named, and the ISBNs and authors the metadata cache holds for those Editions.
 */
async function loadMatchCandidates(actorApId: string): Promise<MatchCandidate[]> {
  const [books, events] = await Promise.all([loadBookwyrmBooks(actorApId), loadDerivedReadingEvents(actorApId)])

  // Every Edition URL per collapse key — the collapsed book keeps only the first one.
  const urlsByTitle = new Map<string, Set<string>>()
  for (const { event } of events) {
    const t = normalizeTitle(event.book_title)
    if (!t || !event.bookwyrm_book_url) continue
    const set = urlsByTitle.get(t) ?? new Set<string>()
    set.add(event.bookwyrm_book_url)
    urlsByTitle.set(t, set)
  }

  const allUrls = new Set<string>()
  for (const b of books) if (b.url) allUrls.add(b.url)
  for (const set of urlsByTitle.values()) for (const u of set) allUrls.add(u)
  const meta = allUrls.size
    ? await getDb()
        .select({ url: bookMetadata.bookUrl, isbn13: bookMetadata.isbn13, author: bookMetadata.author, title: bookMetadata.title })
        .from(bookMetadata)
        .where(inArray(bookMetadata.bookUrl, [...allUrls]))
    : []
  const metaByUrl = new Map(meta.map((m) => [m.url, m]))

  const candidates: MatchCandidate[] = []
  for (const b of books) {
    const key = collapseKey(b)
    if (!key) continue
    const urls = new Set<string>(urlsByTitle.get(normalizeTitle(b.title)) ?? [])
    if (b.url) urls.add(b.url)
    const isbn13s = new Set<string>()
    const authors = new Set<string>()
    if (b.author) authors.add(b.author)
    let title = b.title
    for (const u of urls) {
      const m = metaByUrl.get(u)
      if (!m) continue
      if (m.isbn13) isbn13s.add(m.isbn13)
      // The cache joins all authors with ", "; the status carries one.
      for (const a of (m.author ?? '').split(',')) if (a.trim()) authors.add(a.trim())
      title ??= m.title
    }
    candidates.push({ key, url: b.url, title, authors: [...authors], isbn13s: [...isbn13s] })
  }
  return candidates
}

export async function importStorygraphReads(rows: StorygraphCsvRow[], actorApId: string): Promise<StorygraphImportReport> {
  const report: StorygraphImportReport = {
    actorApId,
    rowsRead: rows.length,
    rowsWithReads: 0,
    booksMatched: 0,
    matchedByIsbn: 0,
    matchedByTitle: 0,
    unmatched: [],
    readsInserted: 0,
    readsUpdated: 0,
    readsUnchanged: 0,
    readsDeleted: 0,
    startsFilled: 0,
    finishesFilled: 0,
    readsAdded: 0,
    conflicts: [],
    unparsed: [],
  }

  const candidates = await loadMatchCandidates(actorApId)

  // One entry per book key; two export rows for one book (it happens with ISBN-less
  // duplicates) pool their reads.
  type Planned = {
    row: StorygraphCsvRow
    match: BookMatch | null
    reads: Map<string, StorygraphReadRange>
    /** A range in the file failed to parse, so the file cannot say which reads are gone. */
    partial: boolean
  }
  const planned = new Map<string, Planned>()
  for (const row of rows) {
    for (const value of row.unparsed) report.unparsed.push({ title: row.title, value })
    const key = storygraphBookKey(row)
    const entry = planned.get(key) ?? { row, match: null, reads: new Map(), partial: false }
    if (row.unparsed.length) entry.partial = true
    for (const r of row.reads) entry.reads.set(rangeKey(r), r)
    planned.set(key, entry)
  }
  for (const entry of planned.values()) {
    if (entry.reads.size === 0) continue
    report.rowsWithReads++
    entry.match = matchStorygraphBook(entry.row, candidates)
    if (!entry.match) {
      report.unmatched.push({ title: entry.row.title, authors: entry.row.authors, reads: [...entry.reads.values()] })
      continue
    }
    report.booksMatched++
    if (entry.match.by === 'isbn') report.matchedByIsbn++
    else report.matchedByTitle++
  }

  const db = getDb()
  await db.transaction(async (tx) => {
    const keys = [...planned.keys()]
    const existing = keys.length
      ? await tx
          .select()
          .from(storygraphReads)
          .where(and(eq(storygraphReads.actorApId, actorApId), inArray(storygraphReads.bookKey, keys)))
      : []
    const existingById = new Map(existing.map((e) => [`${e.bookKey}\u0000${e.rangeKey}`, e]))
    const keep = new Set<string>()
    // A book whose cell did not fully parse keeps every stored read: a range that failed
    // to parse is not a range StoryGraph dropped.
    const partialKeys = new Set([...planned].filter(([, p]) => p.partial).map(([k]) => k))

    for (const [bookKey, { row, match, reads }] of planned) {
      for (const [rk, r] of reads) {
        const id = `${bookKey}\u0000${rk}`
        keep.add(id)
        const values = {
          title: row.title,
          authors: row.authors,
          isbn13: row.isbn13,
          matchedKey: match?.key ?? null,
          matchedBookUrl: match?.url ?? null,
          matchedBy: match?.by ?? null,
        }
        const prior = existingById.get(id)
        if (!prior) {
          await tx.insert(storygraphReads).values({
            actorApId,
            bookKey,
            rangeKey: rk,
            startedOn: r.started,
            finishedOn: r.finished,
            ...values,
          })
          report.readsInserted++
          continue
        }
        const changed =
          prior.title !== values.title ||
          JSON.stringify(prior.authors) !== JSON.stringify(values.authors) ||
          prior.isbn13 !== values.isbn13 ||
          prior.matchedKey !== values.matchedKey ||
          prior.matchedBookUrl !== values.matchedBookUrl ||
          prior.matchedBy !== values.matchedBy
        if (!changed) {
          report.readsUnchanged++
          continue
        }
        await tx.update(storygraphReads).set({ ...values, updatedAt: new Date() }).where(eq(storygraphReads.id, prior.id))
        report.readsUpdated++
      }
    }

    const stale = existing
      .filter((e) => !partialKeys.has(e.bookKey) && !keep.has(`${e.bookKey}\u0000${e.rangeKey}`))
      .map((e) => e.id)
    if (stale.length) {
      await tx.delete(storygraphReads).where(inArray(storygraphReads.id, stale))
      report.readsDeleted = stale.length
    }
  })

  // What the matched reads do to BookWyrm's cycles. The same merge the reading tools run,
  // so the report and the tools cannot disagree about what was filled.
  const books = new Map((await loadBookwyrmBooks(actorApId)).map((b) => [collapseKey(b), b]))
  for (const { match, reads } of planned.values()) {
    if (!match || reads.size === 0) continue
    const book = books.get(match.key)
    if (!book) continue
    const out = mergeStorygraphReads(book, [...reads.values()])
    report.startsFilled += out.startsFilled
    report.finishesFilled += out.finishesFilled
    report.readsAdded += out.readsAdded
    report.conflicts.push(...out.conflicts)
  }

  for (const c of report.conflicts) {
    logger.warn({ actorApId, ...c }, 'StoryGraph read date disagrees with BookWyrm; BookWyrm kept')
  }
  logger.info(
    {
      actorApId,
      rowsRead: report.rowsRead,
      rowsWithReads: report.rowsWithReads,
      booksMatched: report.booksMatched,
      unmatched: report.unmatched.length,
      readsInserted: report.readsInserted,
      readsUpdated: report.readsUpdated,
      readsUnchanged: report.readsUnchanged,
      readsDeleted: report.readsDeleted,
      startsFilled: report.startsFilled,
      conflicts: report.conflicts.length,
    },
    'StoryGraph read dates import complete',
  )
  return report
}
