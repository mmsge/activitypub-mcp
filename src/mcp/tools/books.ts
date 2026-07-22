import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { bookMetadata } from '../../db/schema.js'
import { and, eq, ilike, count, sql, type SQL } from 'drizzle-orm'
import { encodeCursor, decodeCursor, keysetCondition, keysetOrderBy } from './pagination.js'
import { normalizeSubjects } from '../../lib/subjects.js'

// ---- shared filter handling ------------------------------------------------

function buildConditions(input: {
  title?: string
  author?: string
  format?: string
  language?: string
  series?: string
  subject?: string
}): SQL[] {
  const conditions: SQL[] = []
  if (input.title) conditions.push(ilike(bookMetadata.title, `%${input.title}%`))
  if (input.author) conditions.push(ilike(bookMetadata.author, `%${input.author}%`))
  if (input.format) conditions.push(eq(bookMetadata.physicalFormat, input.format))
  if (input.language) conditions.push(eq(bookMetadata.language, input.language))
  if (input.series) conditions.push(ilike(bookMetadata.series, `%${input.series}%`))
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
  sort_order: z.enum(['asc', 'desc']).default('desc')
    .describe('Order by fetched_at. "desc" (default) is most-recently-enriched first; "asc" is oldest first.'),
  limit: z.number().int().min(1).max(200).default(50),
  page: z.number().int().min(1).default(1)
    .describe('Offset-based page (legacy). Ignored when "cursor" is supplied; prefer "cursor" for deep traversal.'),
  cursor: z.string().optional()
    .describe('Opaque pagination cursor from a previous response\'s next_cursor. When set, page/offset is ignored and traversal continues from where the last page ended (respecting sort_order and all filters).'),
})

export async function getBooks(input: z.infer<typeof getBooksSchema>) {
  const db = getDb()
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
      fetched_at: b.fetchedAt?.toISOString() ?? null,
    })),
  }
}
