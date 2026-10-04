import { z } from 'zod'
import { and, count, eq, isNull, sql, type SQL } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { storygraphJournalEntries as e } from '../../db/schema.js'
import { InvalidCursorError } from './pagination.js'
import { bookCondition, calendarDate, dateWindowConditions } from './pages-timeline.js'

/**
 * `get_journal_entries`: the StoryGraph journal rows themselves, newest day first. The
 * raw companion to `get_pages_timeline` — including what the timeline leaves out:
 * undated entries, started/finished markers and percent-only updates. See ADR 0062.
 *
 * Ordered by (entry_date DESC NULLS LAST, id DESC) and paged by keyset. The shared
 * cursor helper in `pagination.ts` keys on a timestamptz, and casting this DATE to one
 * would pull the session zone into a column that has none; so the cursor here carries
 * the date as a date, reuses the helper's InvalidCursorError (so the REST router's 400
 * mapping applies), and compares on the date column directly.
 */

export const JOURNAL_KINDS = ['progress', 'started', 'finished', 'percent'] as const

export const getJournalEntriesSchema = z.object({
  from: calendarDate('from').optional().describe('Only entries on or after this local day (YYYY-MM-DD). Excludes undated entries.'),
  to: calendarDate('to').optional().describe('Only entries on or before this local day (YYYY-MM-DD). Excludes undated entries.'),
  book: z.string().trim().min(1).optional()
    .describe('Only this book: the exact sidetal book_id, or a case-insensitive substring of the title.'),
  kind: z.enum(JOURNAL_KINDS).optional()
    .describe('progress = a pages update; started / finished = shelf markers; percent = a percent-only update with no page count.'),
  include_deleted: z.boolean().default(false)
    .describe('Include entries deleted on StoryGraph (they carry deleted_at). Off by default; they never count towards page totals.'),
  limit: z.number().int().min(1).max(500).default(50),
  cursor: z.string().optional().describe("Opaque cursor from a previous response's next_cursor"),
})

export type JournalEntriesInput = z.infer<typeof getJournalEntriesSchema>

// ---- cursor ------------------------------------------------------------------

type JournalCursor = { d: string | null; id: string }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function encodeJournalCursor(date: string | null, id: string): string {
  return Buffer.from(JSON.stringify({ d: date, id } satisfies JournalCursor), 'utf8').toString('base64url')
}

export function decodeJournalCursor(token: string): JournalCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidCursorError('Invalid cursor: not a valid token')
  }
  const c = parsed as JournalCursor
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !(c.d === null || (typeof c.d === 'string' && DATE_RE.test(c.d)))) {
    throw new InvalidCursorError('Invalid cursor: malformed payload')
  }
  return { d: c.d, id: c.id }
}

/** Byte-order on the id, so ORDER BY and the keyset agree whatever the DB collation. */
const idC = sql`${e.id} COLLATE "C"`

export function journalOrderBy(): SQL {
  return sql`${e.entryDate} DESC NULLS LAST, ${idC} DESC`
}

/** Rows strictly after the cursor row under `journalOrderBy`. Undated rows trail. */
export function journalKeysetCondition(c: JournalCursor): SQL {
  const id = sql`${c.id}::text COLLATE "C"`
  if (c.d === null) return sql`(${e.entryDate} IS NULL AND ${idC} < ${id})`
  return sql`(${e.entryDate} < ${c.d}::date OR (${e.entryDate} = ${c.d}::date AND ${idC} < ${id}) OR ${e.entryDate} IS NULL)`
}

export function journalConditions(input: Pick<JournalEntriesInput, 'from' | 'to' | 'book' | 'kind' | 'include_deleted'>): SQL[] {
  const out: SQL[] = []
  if (!input.include_deleted) out.push(isNull(e.deletedAt))
  out.push(...dateWindowConditions(input.from, input.to))
  if (input.book) out.push(bookCondition(input.book))
  if (input.kind) out.push(eq(e.kind, input.kind))
  return out
}

const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString())

export async function getJournalEntries(input: JournalEntriesInput) {
  const conditions = journalConditions(input)
  // Decoded before any query, so a bad token is a 400 and never opens a connection.
  const keyset = input.cursor ? journalKeysetCondition(decodeJournalCursor(input.cursor)) : null
  const db = getDb()

  const [totals] = await db.select({ total: count() }).from(e).where(and(...conditions))

  const rows = await db
    .select({
      id: e.id,
      book_id: e.bookId,
      book_title: e.bookTitle,
      date: e.entryDate,
      kind: e.kind,
      pages_read: e.pagesRead,
      pages_total: e.pagesTotal,
      book_pages: e.bookPages,
      percent: e.percent,
      updated_at: e.sourceUpdatedAt,
      deleted_at: e.deletedAt,
      first_seen_at: e.firstSeenAt,
      last_seen_at: e.lastSeenAt,
    })
    .from(e)
    .where(and(...conditions, ...(keyset ? [keyset] : [])))
    .orderBy(journalOrderBy())
    .limit(input.limit)

  const last = rows[rows.length - 1]
  return {
    count: rows.length,
    total: Number(totals?.total ?? 0),
    next_cursor: last && rows.length === input.limit ? encodeJournalCursor(last.date ?? null, last.id) : null,
    entries: rows.map((r) => ({
      ...r,
      // `date` is the stored DATE string, untouched: already the local day.
      updated_at: iso(r.updated_at),
      deleted_at: iso(r.deleted_at),
      first_seen_at: iso(r.first_seen_at),
      last_seen_at: iso(r.last_seen_at),
    })),
    filters: {
      from: input.from ?? null,
      to: input.to ?? null,
      book: input.book ?? null,
      kind: input.kind ?? null,
      include_deleted: input.include_deleted,
    },
  }
}
