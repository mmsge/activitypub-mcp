import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { bookMetadata, bookwyrmShelfMarks } from '../../db/schema.js'
import { and, eq, ilike, count, isNull, sql, type SQL } from 'drizzle-orm'
import { SHELVES } from '../../lib/fetch-bookwyrm-shelf.js'
import { encodeCursor, decodeCursor, keysetCondition, keysetOrderBy } from './pagination.js'
import { normalizeSubjects } from '../../lib/subjects.js'
import { visibleBooks } from '../../lib/hidden.js'

// ---- shelf membership ------------------------------------------------------

/**
 * Books a tracked BookWyrm actor currently has on the named shelf.
 *
 * `unknown` is the inverse — a cached edition with no live shelf row at all: a
 * NeoDB-deduped book, one removed from every shelf, or one the shelf sync has not
 * reached yet. It exists so the admin can find orphans; a caller asking for `read`
 * must never be handed them, which is why this is a positive EXISTS rather than a
 * NOT-IN.
 *
 * The correlation is written table-qualified BY HAND, not interpolated. Drizzle
 * renders a bare column reference **unqualified** inside a select-list expression
 * (it qualifies only in WHERE), and an unqualified `book_url` in here would bind to
 * bookwyrm_shelf_marks' own column — a silent always-true self-comparison. Exactly
 * the trap documented on markCommentsExpr in tools/watched.ts.
 */
function shelfMatch(shelf: string): SQL {
  const live = sql`SELECT 1 FROM bookwyrm_shelf_marks s
                    WHERE s.book_url = book_metadata.book_url AND s.removed_at IS NULL`
  return shelf === 'unknown'
    ? sql`NOT EXISTS (${live})`
    : sql`EXISTS (${live} AND s.shelf = ${shelf})`
}

/**
 * Every distinct live shelf this book sits on, across all tracked actors.
 *
 * Plural for the same reason mark_titles / mark_comments / watched_dates are plural
 * in get_watched: with more than one tracked BookWyrm actor, two readers can shelve
 * the same edition differently. Hand-qualified — see shelfMatch.
 */
export const shelvesExpr = sql<string[]>`(
  SELECT coalesce(jsonb_agg(DISTINCT s.shelf), '[]'::jsonb)
  FROM bookwyrm_shelf_marks s
  WHERE s.book_url = book_metadata.book_url AND s.removed_at IS NULL
)`

/**
 * Is there any live shelf membership at all?
 *
 * Guards the shelf filter. Before the sync has run, `?shelf=read` would otherwise
 * answer 200 with an empty page — indistinguishable, to a caller, from "he has
 * read nothing", and precisely the input that would empty framfor's bok arena.
 * ADR 0034 already settled the principle for crawls: a successful empty result is
 * not a healthy one. Erroring turns it into a 404, which callers handle as the
 * failure it is.
 */
export async function hasShelfData(): Promise<boolean> {
  const db = getDb()
  const [row] = await db
    .select({ n: count() })
    .from(bookwyrmShelfMarks)
    .where(isNull(bookwyrmShelfMarks.removedAt))
  return (row?.n ?? 0) > 0
}

// ---- shared filter handling ------------------------------------------------

// Exported so the admin Media page filters books exactly the way get_books does —
// one definition of "filter by author", not two that drift.
export function buildConditions(input: {
  title?: string
  author?: string
  format?: string
  language?: string
  series?: string
  subject?: string
  shelf?: string
  include_hidden?: boolean
}): SQL[] {
  const conditions: SQL[] = []
  // Admin-hidden rows are out by default; `include_hidden` opts back in. Mirrors how
  // `include_unenriched` works in get_watched — the default changes, nothing is lost.
  if (!input.include_hidden) conditions.push(visibleBooks())
  if (input.title) conditions.push(ilike(bookMetadata.title, `%${input.title}%`))
  if (input.author) conditions.push(ilike(bookMetadata.author, `%${input.author}%`))
  if (input.format) conditions.push(eq(bookMetadata.physicalFormat, input.format))
  if (input.language) conditions.push(eq(bookMetadata.language, input.language))
  if (input.series) conditions.push(ilike(bookMetadata.series, `%${input.series}%`))
  if (input.shelf) conditions.push(shelfMatch(input.shelf))
  if (input.subject) {
    // subjects is a jsonb string[]; match any element, case-insensitive partial.
    conditions.push(sql`(
      jsonb_typeof(${bookMetadata.subjects}) = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${bookMetadata.subjects}) AS s(subject)
        WHERE s.subject ILIKE ${'%' + input.subject + '%'}
      )
    )`)
  }
  return conditions
}

// ---- get_books: paginated catalogue of cached book metadata ----------------

export const getBooksSchema = z.object({
  title: z.string().optional().describe('Filter by title (case-insensitive, partial match)'),
  author: z.string().optional().describe('Filter by author (case-insensitive, partial match)'),
  format: z.string().optional().describe('Filter by exact physical_format, e.g. "Paperback", "Hardcover", "GraphicNovel", "AudiobookFormat"'),
  language: z.string().optional().describe('Filter by exact language (normalized ISO-639-1 code, e.g. "en", "no")'),
  series: z.string().optional().describe('Filter by series name (case-insensitive, partial match)'),
  subject: z.string().optional().describe('Filter by subject/genre (case-insensitive partial match against any of the book\'s subjects)'),
  shelf: z.enum([...SHELVES, 'unknown']).optional()
    .describe('Filter to books a tracked BookWyrm actor currently has on this shelf. "stopped-reading" is the ones started and put down without finishing; "unknown" is the inverse of all four — cached editions with no live shelf membership. Omit for every cached book regardless of shelf, which is what this endpoint has always returned and remains the default.'),
  include_hidden: z.boolean().default(false)
    .describe('Include books an admin has hidden from the served catalogue. Off by default. Hidden books still exist and are still enriched; they are suppressed from listings, not deleted.'),
  sort_order: z.enum(['asc', 'desc']).default('desc')
    .describe('Order by fetched_at. "desc" (default) is most-recently-enriched first; "asc" is oldest first.'),
  limit: z.number().int().min(1).max(200).default(50),
  page: z.number().int().min(1).default(1)
    .describe('Offset-based page (legacy). Ignored when "cursor" is supplied; prefer "cursor" for deep traversal.'),
  cursor: z.string().optional()
    .describe('Opaque pagination cursor from a previous response\'s next_cursor. When set, page/offset is ignored and traversal continues from where the last page ended (respecting sort_order and all filters).'),
})

/** One shelf, or null when there are none or more than one. See the response comment. */
function shelfScalar(shelves: unknown): string | null {
  return Array.isArray(shelves) && shelves.length === 1 ? String(shelves[0]) : null
}

export async function getBooks(input: z.infer<typeof getBooksSchema>) {
  const db = getDb()

  // Refuse a shelf filter we cannot honestly answer — see hasShelfData.
  if (input.shelf && !(await hasShelfData())) {
    return {
      error:
        'Shelf membership has not been synced yet — bookwyrm_shelf_marks has no live rows. ' +
        'Refusing to answer a shelf filter with an empty page, which a caller cannot tell ' +
        'from "no books are on that shelf". Run `npm run sync-bookwyrm-shelves`. See ADR 0034.',
    }
  }

  const filterConditions = buildConditions(input)

  // total reflects the filters only (not the cursor), so it's a stable count of
  // every matching book regardless of which page we're on.
  const filterWhere = filterConditions.length ? and(...filterConditions) : undefined
  const [totals] = await db.select({ total: count() }).from(bookMetadata).where(filterWhere)

  // Keyset pagination: continue strictly past the cursor row using (fetched_at, id)
  // as the ordering key. Falls back to offset pagination when no cursor is given.
  const conditions = [...filterConditions]
  if (input.cursor) {
    conditions.push(keysetCondition(bookMetadata.fetchedAt, bookMetadata.id, decodeCursor(input.cursor), input.sort_order))
  }

  const where = conditions.length ? and(...conditions) : undefined
  const orderBy = keysetOrderBy(bookMetadata.fetchedAt, bookMetadata.id, input.sort_order)

  const baseQuery = db
    .select({
      id: bookMetadata.id,
      bookUrl: bookMetadata.bookUrl,
      workUrl: bookMetadata.workUrl,
      title: bookMetadata.title,
      subtitle: bookMetadata.subtitle,
      author: bookMetadata.author,
      series: bookMetadata.series,
      pages: bookMetadata.pages,
      physicalFormat: bookMetadata.physicalFormat,
      isbn13: bookMetadata.isbn13,
      isbn10: bookMetadata.isbn10,
      pubYear: bookMetadata.pubYear,
      language: bookMetadata.language,
      originalLanguage: bookMetadata.originalLanguage,
      publisher: bookMetadata.publisher,
      coverUrl: bookMetadata.coverUrl,
      subjects: bookMetadata.subjects,
      fetchedAt: bookMetadata.fetchedAt,
      shelves: shelvesExpr,
    })
    .from(bookMetadata)
    .where(where)
    .orderBy(orderBy)
    .limit(input.limit)

  // Cursor traversal is offset-free; only the legacy offset path applies page.
  const rows = input.cursor
    ? await baseQuery
    : await baseQuery.offset((input.page - 1) * input.limit)

  // A full page may have more behind it; a short page is the end of the run.
  const last = rows[rows.length - 1]
  const nextCursor = rows.length === input.limit && last
    ? encodeCursor(last.fetchedAt, last.id)
    : null

  return {
    count: rows.length,
    total: totals?.total ?? 0,
    page: input.cursor ? null : input.page,
    next_cursor: nextCursor,
    sort_order: input.sort_order,
    filters: {
      title: input.title ?? null,
      author: input.author ?? null,
      format: input.format ?? null,
      language: input.language ?? null,
      series: input.series ?? null,
      subject: input.subject ?? null,
      shelf: input.shelf ?? null,
    },
    books: rows.map((b) => ({
      book_url: b.bookUrl,
      work_url: b.workUrl,
      title: b.title,
      subtitle: b.subtitle,
      author: b.author,
      series: b.series,
      pages: b.pages,
      physical_format: b.physicalFormat,
      isbn13: b.isbn13,
      isbn10: b.isbn10,
      pub_year: b.pubYear,
      language: b.language,
      original_language: b.originalLanguage,
      publisher: b.publisher,
      cover_url: b.coverUrl,
      subjects: normalizeSubjects(b.subjects),
      // The scalar is the value when every tracked actor agrees (or there is only
      // one of them), null when the book has no live shelf row OR when they
      // disagree. A caller that needs to tell those two apart reads `shelves`.
      shelf: shelfScalar(b.shelves),
      shelves: Array.isArray(b.shelves) ? b.shelves : [],
      fetched_at: b.fetchedAt?.toISOString() ?? null,
    })),
  }
}
