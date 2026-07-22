import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { bookMetadata } from '../../db/schema.js'
import { eq, or, ilike, desc } from 'drizzle-orm'
import { normalizeIsbn, isbn10to13 } from '../../lib/isbn.js'
import { normalizeSubjects } from '../../lib/subjects.js'

// Look up the full enriched metadata for one book from the book_metadata cache,
// resolved by Edition URL (exact), ISBN (13 or 10), or a partial title match.
export const getBookDetailsSchema = z.object({
  book_url: z.string().optional().describe('BookWyrm Edition AP id (exact match, the primary key)'),
  isbn: z.string().optional().describe('ISBN-13 or ISBN-10 (hyphens/spaces ignored)'),
  title: z.string().optional().describe('Case-insensitive partial title match (most recent wins)'),
})

type BookDetailsInput = z.infer<typeof getBookDetailsSchema>

export async function getBookDetails(input: BookDetailsInput) {
  if (!input.book_url && !input.isbn && !input.title) {
    return { error: 'Provide at least one of book_url, isbn, or title' }
  }
  const db = getDb()

  let where
  if (input.book_url) {
    where = eq(bookMetadata.bookUrl, input.book_url)
  } else if (input.isbn) {
    const norm = normalizeIsbn(input.isbn)
    if (!norm) return { error: `Not a valid ISBN: ${input.isbn}` }
    // Match either ISBN form, and the 13-form derived from a 10-digit input.
    const alt = norm.length === 10 ? isbn10to13(norm) : null
    const candidates = [eq(bookMetadata.isbn13, norm), eq(bookMetadata.isbn10, norm)]
    if (alt) candidates.push(eq(bookMetadata.isbn13, alt))
    where = or(...candidates)
  } else {
    where = ilike(bookMetadata.title, `%${input.title}%`)
  }

  const rows = await db
    .select()
    .from(bookMetadata)
    .where(where)
    .orderBy(desc(bookMetadata.fetchedAt))
    .limit(1)

  const b = rows[0]
  if (!b) return { error: 'No book metadata found for the given query' }

  return {
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
    description: b.description,
    subjects: normalizeSubjects(b.subjects),
    isbn_source: b.isbnSource,
    page_source: b.pageSource,
    source_map: b.sourceMap ?? null,
    fetched_at: b.fetchedAt?.toISOString() ?? null,
  }
}
