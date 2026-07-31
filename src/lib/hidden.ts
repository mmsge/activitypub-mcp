import { isNull, isNotNull } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { bookMetadata, catalogMetadata } from '../db/schema.js'

/**
 * Rows an admin has hidden are excluded from every public read by default.
 *
 * Hiding, not deleting: both enrichment jobs re-derive their URL sets from stored posts
 * and marks on every pass (`collectBookUrls`, `collectNeodbTagHrefs`), so a DELETE is
 * undone within the six-hour cycle — silently, with no error to notice. `hidden_at` is
 * the durable way to take a bad record out of what the server serves. See ADR 0013.
 *
 * Every affected tool exposes `include_hidden` to opt back in, mirroring the
 * `include_unenriched` precedent: the default changes, the capability doesn't go away.
 */

export const visibleCatalog = () => isNull(catalogMetadata.hiddenAt)
export const visibleBooks = () => isNull(bookMetadata.hiddenAt)

/**
 * Edition URLs of every hidden book.
 *
 * The reading tools (`get_reading_stats`, `get_reading_pace`, `get_actor_reading_status`)
 * do not *list* from `book_metadata` — they derive the book list from stored posts and use
 * the table only as a metadata lookup. Filtering that lookup would leave a hidden book
 * still counted in the totals but stripped of its pages/author/format, quietly skewing
 * `avg_pages` and `pages_coverage`. So those tools drop the book from the collapsed set
 * instead, using this.
 *
 * A book with no `book_metadata` row cannot be hidden — there is nothing to carry the
 * flag. That is correct: hiding is an editorial act on a catalogue entry, and a book the
 * catalogue has never seen has no entry to act on.
 */
export async function hiddenBookUrls(): Promise<Set<string>> {
  const rows = await getDb()
    .select({ bookUrl: bookMetadata.bookUrl })
    .from(bookMetadata)
    .where(isNotNull(bookMetadata.hiddenAt))
  return new Set(rows.map((r) => r.bookUrl))
}

/** Drop hidden books from a collapsed reading set, keyed on the Edition URL each carries. */
export function withoutHidden<T extends { url?: string | null }>(books: T[], hidden: Set<string>): T[] {
  if (hidden.size === 0) return books
  return books.filter((b) => !(b.url && hidden.has(b.url)))
}

/**
 * `withoutHidden` applied only when the caller hasn't opted in — the shape every reading
 * tool needs, so none of them re-implements the `include_hidden` branch.
 */
export async function applyHiddenFilter<T extends { url?: string | null }>(
  books: T[],
  includeHidden: boolean,
): Promise<T[]> {
  if (includeHidden) return books
  return withoutHidden(books, await hiddenBookUrls())
}
