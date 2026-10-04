import { sql } from 'drizzle-orm'
import { config } from '../config.js'
import { getDb } from '../db/client.js'
import { storygraphBooks, storygraphJournalEntries } from '../db/schema.js'
import {
  fetchBooks,
  fetchEntriesPage,
  type StorygraphTrace,
} from '../lib/fetch-storygraph.js'
import { logger } from '../lib/logger.js'
import {
  STORYGRAPH_SOURCE,
  recordAttempt,
  recordFailure,
  recordSuccess,
} from '../lib/source-health.js'

/**
 * Pull the StoryGraph reading journal from sidetal into Postgres. See ADR 0062.
 *
 * Incremental: the cursor is derived from the data already stored —
 * max(source_updated_at) — and sent as `since_updated`, which sidetal treats as
 * exclusive and which ALSO returns soft-deleted rows, so a deletion upstream reaches us
 * as a row with `deleted_at` set. Within a run the job follows sidetal's own opaque
 * `next_cursor` until it is null. The books list is small and fetched whole every run.
 *
 * Deploy-then-arm: with STORYGRAPH_API_URL or STORYGRAPH_API_TOKEN blank this logs and
 * returns, so the job can ship before sidetal is running.
 */

/** Pages per run. At 1000 entries a page this is 200k entries — a bug, not a backlog. */
export const MAX_PAGES = 200
const PAGE_DELAY_MS = 100

/**
 * How far behind the newest stored row the next run starts.
 *
 * `since_updated` is exclusive and a nightly scrape can stamp many rows with the same
 * instant. If a run dies between two pages that split such a tie, resuming strictly
 * after max(source_updated_at) would skip the rest of the tie forever. Re-reading the
 * last second is a handful of idempotent upserts; skipping rows is permanent.
 */
export const CURSOR_OVERLAP_MS = 1000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface StorygraphEntryRow {
  id: string
  bookId: string
  bookTitle: string | null
  /** `YYYY-MM-DD`, verbatim from sidetal. Never a Date: see the schema comment. */
  entryDate: string | null
  kind: string
  pagesRead: number | null
  pagesTotal: number | null
  bookPages: number | null
  percent: number | null
  sourceUpdatedAt: Date
  deletedAt: Date | null
  firstSeenAt: Date
  lastSeenAt: Date
  raw: Record<string, unknown>
}

export interface StorygraphBookRow {
  id: string
  title: string | null
  authors: string[]
  pages: number | null
  coverUrl: string | null
  updatedAt: Date | null
  raw: Record<string, unknown>
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function instant(v: unknown): Date | null {
  if (typeof v !== 'string' || v.trim() === '') return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * The calendar day, or null. Kept as the string sidetal sent: it is already the local
 * day, and a round trip through `Date` would reinterpret it in whatever zone the
 * process runs in. Anything not shaped `YYYY-MM-DD` is treated as undated rather than
 * guessed at.
 */
export function entryDateOf(v: unknown): string | null {
  return typeof v === 'string' && DATE_RE.test(v) ? v : null
}

/**
 * One sidetal entry as a row, or null when it lacks what the row cannot exist without
 * (its id, its book, the updated_at that is our cursor).
 *
 * `pages_read` is taken as given — StoryGraph's own delta — and never derived from
 * `pages_total`, even where it is null.
 */
export function toEntryRow(entry: Record<string, unknown>): StorygraphEntryRow | null {
  const id = str(entry.id)
  const bookId = str(entry.book_id)
  const sourceUpdatedAt = instant(entry.updated_at)
  if (!id || !bookId || !sourceUpdatedAt) return null

  return {
    id,
    bookId,
    bookTitle: str(entry.book_title),
    entryDate: entryDateOf(entry.date),
    kind: str(entry.kind) ?? 'unknown',
    pagesRead: int(entry.pages_read),
    pagesTotal: int(entry.pages_total),
    bookPages: int(entry.book_pages),
    percent: num(entry.percent),
    sourceUpdatedAt,
    deletedAt: instant(entry.deleted_at),
    // sidetal always sends both; falling back to updated_at keeps a NOT NULL column
    // honest rather than inventing "now".
    firstSeenAt: instant(entry.first_seen_at) ?? sourceUpdatedAt,
    lastSeenAt: instant(entry.last_seen_at) ?? sourceUpdatedAt,
    raw: entry,
  }
}

export function toBookRow(book: Record<string, unknown>): StorygraphBookRow | null {
  const id = str(book.id)
  if (!id) return null
  return {
    id,
    title: str(book.title),
    authors: Array.isArray(book.authors) ? book.authors.filter((a): a is string => typeof a === 'string') : [],
    pages: int(book.pages),
    coverUrl: str(book.cover_url),
    updatedAt: instant(book.updated_at),
    raw: book,
  }
}

/**
 * Keep one row per id within a batch — the one with the newest `sourceUpdatedAt`, and
 * the later one on a tie, which is the later one in sidetal's (updated_at, id) order.
 * A single INSERT … ON CONFLICT may not touch the same key twice; Postgres refuses it.
 */
export function dedupeById<T extends { id: string; sourceUpdatedAt?: Date | null }>(rows: readonly T[]): T[] {
  const byId = new Map<string, T>()
  for (const row of rows) {
    const prev = byId.get(row.id)
    const prevAt = prev?.sourceUpdatedAt?.getTime() ?? -Infinity
    const at = row.sourceUpdatedAt?.getTime() ?? -Infinity
    if (!prev || at >= prevAt) byId.set(row.id, row)
  }
  return [...byId.values()]
}

/**
 * The columns a re-poll overwrites, as references to the incoming (`excluded`) row.
 *
 * `firstSeenAt` is deliberately absent: it is sidetal's record of when the entry first
 * appeared, written once on insert. `id` is the conflict target. Same trap as
 * `linkedinPostUpdateSet` and ADR 0013 — any key present here is rewritten on every
 * pull. Exported so a test can assert the absence.
 */
export function entryUpdateSet() {
  const ex = (col: string) => sql.raw(`excluded."${col}"`)
  return {
    bookId: ex('book_id'),
    bookTitle: ex('book_title'),
    entryDate: ex('entry_date'),
    kind: ex('kind'),
    pagesRead: ex('pages_read'),
    pagesTotal: ex('pages_total'),
    bookPages: ex('book_pages'),
    percent: ex('percent'),
    sourceUpdatedAt: ex('source_updated_at'),
    deletedAt: ex('deleted_at'),
    lastSeenAt: ex('last_seen_at'),
    raw: ex('raw'),
    ingestedAt: sql`now()`,
  }
}

/**
 * Only move a row forwards. The cursor overlap re-reads the last second on purpose, and
 * a stale copy of a row must never overwrite a newer one — least of all un-delete it.
 */
export const ENTRY_UPDATE_WHERE = sql`excluded."source_updated_at" >= ${storygraphJournalEntries.sourceUpdatedAt}`

export function bookUpdateSet() {
  const ex = (col: string) => sql.raw(`excluded."${col}"`)
  return {
    title: ex('title'),
    authors: ex('authors'),
    pages: ex('pages'),
    coverUrl: ex('cover_url'),
    raw: ex('raw'),
    updatedAt: ex('updated_at'),
    ingestedAt: sql`now()`,
  }
}

/**
 * The `since_updated` to send, from max(source_updated_at) of what is stored. Undefined
 * on an empty table: the first run reads everything (and, without since_updated, sidetal
 * leaves deleted rows out, which is right — there is nothing here yet to delete).
 */
export function cursorFrom(maxUpdatedAt: Date | null): string | undefined {
  if (!maxUpdatedAt || Number.isNaN(maxUpdatedAt.getTime())) return undefined
  return new Date(maxUpdatedAt.getTime() - CURSOR_OVERLAP_MS).toISOString()
}

async function storedCursor(): Promise<string | undefined> {
  const db = getDb()
  // Epoch milliseconds rather than the timestamptz itself: an epoch is the same number in
  // every session zone, so nothing about the cursor depends on how the driver renders
  // a timestamp. Floored, so the cursor can only move backwards (into the overlap).
  const [row] = await db
    .select({
      ms: sql<string | null>`floor(extract(epoch from max(${storygraphJournalEntries.sourceUpdatedAt})) * 1000)::bigint::text`,
    })
    .from(storygraphJournalEntries)
  return cursorFrom(row?.ms ? new Date(Number(row.ms)) : null)
}

async function upsertEntries(rows: StorygraphEntryRow[]): Promise<number> {
  const unique = dedupeById(rows)
  if (unique.length === 0) return 0
  await getDb()
    .insert(storygraphJournalEntries)
    .values(unique)
    .onConflictDoUpdate({
      target: storygraphJournalEntries.id,
      set: entryUpdateSet(),
      setWhere: ENTRY_UPDATE_WHERE,
    })
  return unique.length
}

async function upsertBooks(rows: StorygraphBookRow[]): Promise<number> {
  const unique = dedupeById(rows)
  if (unique.length === 0) return 0
  await getDb()
    .insert(storygraphBooks)
    .values(unique)
    .onConflictDoUpdate({ target: storygraphBooks.id, set: bookUpdateSet() })
  return unique.length
}

function describe(trace: StorygraphTrace): string {
  const body = trace.body.replace(/\s+/g, ' ').trim().slice(0, 160)
  return trace.status === 0 ? `no response (${body})` : `HTTP ${trace.status} ${body}`
}

export async function syncStorygraph(): Promise<void> {
  const base = config.STORYGRAPH_API_URL.trim()
  const token = config.STORYGRAPH_API_TOKEN.trim()
  if (!base || !token) {
    logger.info('STORYGRAPH_API_URL / STORYGRAPH_API_TOKEN not set, skipping StoryGraph sync')
    return
  }

  await recordAttempt(STORYGRAPH_SOURCE)

  let since: string | undefined
  try {
    since = await storedCursor()
  } catch (e) {
    const err = e as Error
    await recordFailure(STORYGRAPH_SOURCE, 0, err.message, {
      status: 0,
      body: err.stack ?? err.message,
      note: `Could not read the stored cursor — ${err.message}`,
    })
    return
  }
  logger.info({ since: since ?? '(full)' }, 'Starting StoryGraph sync')

  let cursor: string | undefined
  let pages = 0
  let received = 0
  let skipped = 0
  let written = 0
  let deleted = 0
  let truncated = true
  let last: StorygraphTrace | null = null

  try {
    for (; pages < MAX_PAGES; ) {
      const page = await fetchEntriesPage(base, token, { sinceUpdated: since, cursor })
      last = page.trace
      if (page.kind === 'error') {
        const note = `entries: page ${pages + 1} failed — ${describe(page.trace)}` +
          (written ? ` (${written} entr${written === 1 ? 'y' : 'ies'} from earlier pages kept; the next run resumes from them)` : '')
        await recordFailure(STORYGRAPH_SOURCE, page.status, page.message, { status: page.status, body: page.trace.body, note })
        return
      }
      pages++
      received += page.data.entries.length
      const rows: StorygraphEntryRow[] = []
      for (const entry of page.data.entries) {
        const row = toEntryRow(entry)
        if (row) rows.push(row)
        else skipped++
      }
      deleted += rows.filter((r) => r.deletedAt).length
      written += await upsertEntries(rows)

      if (!page.data.nextCursor) {
        truncated = false
        break
      }
      cursor = page.data.nextCursor
      await sleep(PAGE_DELAY_MS)
    }
  } catch (e) {
    const err = e as Error
    await recordFailure(STORYGRAPH_SOURCE, 0, err.message, {
      status: 0,
      body: err.stack ?? err.message,
      note: `entries: threw after ${pages} page(s) — ${err.message}`,
    })
    return
  }

  if (truncated) {
    // Never silent: a cap that is hit looks exactly like a complete run from the counts.
    logger.warn({ maxPages: MAX_PAGES }, 'StoryGraph sync hit the page cap; the next run continues from the stored cursor')
  }
  if (skipped) logger.warn({ skipped }, 'StoryGraph entries without id/book_id/updated_at were skipped')

  const books = await fetchBooks(base, token)
  if (books.kind === 'error') {
    const note = `entries: ${written} upserted over ${pages} page(s); books failed — ${describe(books.trace)}`
    await recordFailure(STORYGRAPH_SOURCE, books.status, books.message, { status: books.status, body: books.trace.body, note })
    return
  }
  let booksWritten = 0
  try {
    booksWritten = await upsertBooks(books.data.books.map(toBookRow).filter((b): b is StorygraphBookRow => b !== null))
  } catch (e) {
    const err = e as Error
    await recordFailure(STORYGRAPH_SOURCE, 0, err.message, {
      status: 0,
      body: err.stack ?? err.message,
      note: `entries: ${written} upserted; books upsert threw — ${err.message}`,
    })
    return
  }

  const note = [
    `entries: ${pages} page(s) since ${since ?? 'the beginning'}, ${received} received, ${written} upserted` +
      (deleted ? ` (${deleted} carrying a deletion)` : '') +
      (skipped ? `, ${skipped} skipped as malformed` : '') + '.',
    truncated ? `Stopped at the ${MAX_PAGES}-page cap — the next run continues.` : null,
    `books: ${booksWritten} upserted.`,
  ].filter(Boolean).join(' ')

  // Items = entries AND books upserted. The books list is re-read whole every run, so a
  // night without reading still counts its books, which keeps recordSuccess' "returned
  // nothing although it has before" warning for the case it was written for — sidetal
  // serving nothing at all — instead of firing on every idle hourly pull. The note
  // carries the split.
  await recordSuccess(STORYGRAPH_SOURCE, written + booksWritten, {
    status: (last ?? books.trace).status,
    body: last?.body ?? books.trace.body,
    note,
  })
  logger.info({ pages, received, written, deleted, skipped, books: booksWritten }, 'StoryGraph sync complete')
}
