import { fetchBookwyrmShelf } from './fetch-bookwyrm-shelf.js'

// The identity fields the reading tools display for a book. Both pace and stats
// fill these in the same order: enrichment cache (canonical Edition title/author)
// first, then whatever was parsed from the stored status, and finally — for books
// that still have no title at all — a live shelf merge by Edition URL (below).
export interface NamedBook {
  url: string | null
  title: string | null
  author: string | null
}

/**
 * Merge live-shelf identity into books that still lack a title after the
 * book_metadata cache join (typically a book whose statuses were all comments —
 * URL-only, no Edition tag — and whose Edition hasn't been enriched yet). Fetches
 * the actor's shelves once and matches by Edition URL. No-op (and no network)
 * when every book with a URL already has a title; shelf fetch failures degrade
 * to the nulls we started with. Mutates in place.
 */
export async function fillNamesFromLiveShelf(actorApId: string, books: NamedBook[]): Promise<void> {
  if (!books.some((b) => b.url && !b.title)) return

  const items = (
    await Promise.all(
      (['reading', 'read', 'to-read'] as const).map((shelf) => fetchBookwyrmShelf(actorApId, shelf)),
    )
  ).flat()

  const byUrl = new Map<string, { title: string | null; author: string | null }>()
  for (const it of items) {
    if (it.bookUrl && !byUrl.has(it.bookUrl)) {
      byUrl.set(it.bookUrl, { title: it.bookTitle, author: it.bookAuthor })
    }
  }

  for (const b of books) {
    const hit = b.url ? byUrl.get(b.url) : undefined
    if (!hit) continue
    b.title ??= hit.title
    b.author ??= hit.author
  }
}
