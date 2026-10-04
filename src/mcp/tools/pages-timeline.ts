import { z } from 'zod'
import { and, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { storygraphBooks, storygraphJournalEntries as e } from '../../db/schema.js'
import { osloDay } from '../../stream/event-date.js'
import {
  assemblePagesTimeline, resolveRange,
  type Bucket, type BookInfo, type DayBookRow, type PagesTimeline,
} from '../../lib/pages-timeline.js'

/**
 * `get_pages_timeline`: pages read per local day, week or month from the StoryGraph
 * journal, broken down by book. The sibling of `get_scrobble_timeline`, and shaped like
 * it, with the one difference that matters: there is NO timezone here. `entry_date` is
 * already the local calendar day — sidetal records the day StoryGraph shows — so the
 * SQL buckets the date column directly and never writes AT TIME ZONE. A test renders
 * every fragment and pins that. See ADR 0062.
 *
 * Pure logic lives in `src/lib/pages-timeline.ts`; this module is the SQL and the schemas.
 */

// ---- shared with get_journal_entries -----------------------------------------

/** A calendar date bound. A datetime is accepted and reduced to its date; no zone is read. */
export const calendarDate = (label: string) =>
  z.string()
    .refine((v) => /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v.trim()), {
      message: `${label} must be a calendar date such as "2026-10-04". A datetime is accepted and truncated to its date; any timezone suffix is ignored, since journal dates are already local days.`,
    })
    .transform((v) => v.trim().slice(0, 10))

/**
 * The book filter: the exact sidetal book id, or a case-insensitive substring of the
 * title. Both arms are bound parameters.
 */
export function bookCondition(book: string): SQL {
  return or(eq(e.bookId, book), ilike(e.bookTitle, `%${book}%`))!
}

/** `[from, to]` inclusive on the DATE column itself — no cast through a timestamp, no zone. */
export function dateWindowConditions(from?: string, to?: string): SQL[] {
  const out: SQL[] = []
  if (from) out.push(sql`${e.entryDate} >= ${from}::date`)
  if (to) out.push(sql`${e.entryDate} <= ${to}::date`)
  return out
}

/**
 * The entries that count towards a page total: not deleted, dated, and carrying
 * StoryGraph's own pages_read delta. A started marker or a percent-only update is
 * stored and served by get_journal_entries, but contributes nothing here.
 */
export function countingConditions(book?: string): SQL[] {
  const out: SQL[] = [isNull(e.deletedAt), isNotNull(e.entryDate), isNotNull(e.pagesRead)]
  if (book) out.push(bookCondition(book))
  return out
}

// ---- SQL fragments -----------------------------------------------------------

/**
 * `YYYY-MM-DD` of a date expression, via `timestamp` WITHOUT time zone.
 *
 * The cast is not decoration. `date_trunc` and `to_char` have no `date` overloads, and
 * Postgres resolves a bare date to their `timestamptz` variants, which read the session
 * TimeZone. Going through `timestamp` keeps the whole expression zone-free, so the answer
 * cannot depend on how the connection is configured.
 */
function ymd(expr: SQL): SQL<string> {
  return sql<string>`to_char(${expr}, 'YYYY-MM-DD')`
}

export function dayExpr(): SQL<string> {
  return ymd(sql`${e.entryDate}::timestamp`)
}

/** The bucket an entry belongs to. `date_trunc('week', …)` truncates to Monday. */
export function bucketExpr(bucket: Bucket): SQL<string> {
  return ymd(sql`date_trunc(${bucket}, ${e.entryDate}::timestamp)`)
}

// ---- schemas -----------------------------------------------------------------

const coreSchema = z.object({
  from: calendarDate('from').optional()
    .describe('First day, inclusive (YYYY-MM-DD, a local calendar day as StoryGraph records it). Defaults to the first day with pages; an earlier value is pulled forward to it.'),
  to: calendarDate('to').optional()
    .describe('Last day, inclusive. Defaults to today (Europe/Oslo); a later value is pushed back to today, so the future is never reported as silence.'),
  book: z.string().trim().min(1).optional()
    .describe('Only this book: the exact sidetal book_id, or a case-insensitive substring of the title.'),
  include_empty_buckets: z.boolean().default(true)
    .describe('Emit zero rows for buckets with no reading. A day without reading is signal, not missing data.'),
})

const bucketParam = z.enum(['day', 'week', 'month'] as const)

/**
 * MCP defaults: WEEKLY, TOP 5 — a bare call stays readable in a chat context. REST
 * defaults to the daily series with every book, which is what a chart wants. Those two
 * defaults are the only difference between the surfaces, the ADR 0059 convention, and
 * `pages-timeline.test.ts` pins both sets.
 */
export const getPagesTimelineSchema = coreSchema.extend({
  bucket: bucketParam.default('week')
    .describe('Bucketing axis; weeks start on Monday. Defaults to "week" on MCP.'),
  top_n: z.number().int().min(0).max(1000).default(5)
    .describe('Per-bucket cap on the book breakdown; 0 means every book. Overflow is summed into one row whose key the response reports as "other_key". Defaults to 5 on MCP.'),
})

export const getPagesTimelineRestSchema = coreSchema.extend({
  bucket: bucketParam.default('day')
    .describe('Bucketing axis; weeks start on Monday. Defaults to "day" on REST.'),
  top_n: z.number().int().min(0).max(1000).default(0)
    .describe('Per-bucket cap on the book breakdown; 0 (the REST default) means every book.'),
})

export type PagesTimelineInput = z.infer<typeof getPagesTimelineSchema>

// ---- handler -----------------------------------------------------------------

/** Rows from the raw `db.execute` result, whatever shape the driver wraps them in. */
function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows?: T[] })?.rows ?? []) as T[]
}

export async function getPagesTimeline(
  input: PagesTimelineInput,
  // Injected for tests. Today is the one thing here that IS a zone question: an entry's
  // date is already local, but "now" is an instant, and the clamp must be Markus' day.
  now: Date = new Date(),
): Promise<PagesTimeline> {
  const db = getDb()
  const base = countingConditions(input.book)
  const filters = { book: input.book ?? null }

  const [bounds] = await db
    .select({ min: ymd(sql`min(${e.entryDate})::timestamp`), max: ymd(sql`max(${e.entryDate})::timestamp`) })
    .from(e)
    .where(and(...base))

  const range = resolveRange(
    { min: bounds?.min ?? null, max: bounds?.max ?? null, today: osloDay(now) },
    { from: input.from, to: input.to },
  )

  const shape = {
    bucket: input.bucket,
    topN: input.top_n,
    includeEmptyBuckets: input.include_empty_buckets,
    filters,
  }
  if (!range) return assemblePagesTimeline({ ...shape, range: null, rows: [], books: [] })

  const where = and(...base, ...dateWindowConditions(range.from, range.to))

  // Grouped on the DATE COLUMN and the book, never on a re-emitted bucket expression:
  // the bucket's `$n` parameter would get a fresh placeholder in the GROUP BY and
  // Postgres would refuse it as a different expression (the trap scrobble-timeline.ts
  // documents). One bucket per date, so grouping on the date implies the bucket.
  const flat = rowsOf<{ day: string; bucket: string; book_id: string; pages: string | number; entries: string | number }>(
    await db.execute(sql`
      SELECT ${dayExpr()} AS day, ${bucketExpr(input.bucket)} AS bucket, ${e.bookId} AS book_id,
             sum(${e.pagesRead})::int AS pages, count(*)::int AS entries
      FROM ${e}
      WHERE ${where}
      GROUP BY ${e.entryDate}, ${e.bookId}
    `),
  )

  const rows: DayBookRow[] = flat.map((r) => ({
    day: r.day,
    bucket: r.bucket,
    bookId: r.book_id,
    pages: Number(r.pages),
    entries: Number(r.entries),
  }))

  const ids = [...new Set(rows.map((r) => r.bookId))]
  const books: BookInfo[] = []
  if (ids.length) {
    // Title: sidetal's books list first, else the newest title any entry carried.
    const [meta, titles] = await Promise.all([
      db.select({ id: storygraphBooks.id, title: storygraphBooks.title, authors: storygraphBooks.authors, pages: storygraphBooks.pages })
        .from(storygraphBooks).where(inArray(storygraphBooks.id, ids)),
      db.select({
        id: e.bookId,
        title: sql<string | null>`(array_agg(${e.bookTitle} ORDER BY ${e.sourceUpdatedAt} DESC) FILTER (WHERE ${e.bookTitle} IS NOT NULL))[1]`,
      }).from(e).where(inArray(e.bookId, ids)).groupBy(e.bookId),
    ])
    const byId = new Map(meta.map((m) => [m.id, m]))
    const titleOf = new Map(titles.map((t) => [t.id, t.title]))
    for (const id of ids) {
      const m = byId.get(id)
      books.push({
        bookId: id,
        title: m?.title ?? titleOf.get(id) ?? null,
        authors: Array.isArray(m?.authors) ? m!.authors : [],
        bookPages: m?.pages ?? null,
      })
    }
  }

  return assemblePagesTimeline({ ...shape, range, rows, books })
}
