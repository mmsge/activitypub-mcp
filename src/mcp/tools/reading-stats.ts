import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { bookMetadata } from '../../db/schema.js'
import { inArray } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'
import { loadCollapsedBooks } from '../../lib/reading-query.js'
import { fillNamesFromLiveShelf } from '../../lib/book-identity.js'

// Formats whose page count isn't a prose-comparable "length", so the prose-only
// average excludes them (comics/graphic novels and audiobooks). Poetry has no
// distinct BookWyrm format, so it can't be separated and stays in the overall avg.
const NON_PROSE_FORMATS = new Set(['GraphicNovel', 'Comic', 'AudiobookFormat', 'Audiobook'])

export const getReadingStatsSchema = z.object({
  actor_handle: z.string().describe('Actor handle (@user@domain) or full actor URL'),
  status: z.enum(['reading', 'read', 'to-read']).default('read')
    .describe('Which shelf to aggregate. Defaults to "read" (finished books).'),
  year: z.number().int().optional()
    .describe('Scope to books finished in this calendar year. Omit for all-time.'),
  from: z.string().optional().describe('Only count books finished at or after this ISO date'),
  to: z.string().optional().describe('Only count books finished at or before this ISO date'),
  format: z.string().optional()
    .describe('Filter by physical format, e.g. "Paperback" or "GraphicNovel" (exact match)'),
  author: z.string().optional().describe('Filter by author (case-insensitive, partial match)'),
  rating: z.number().optional().describe('Filter to books rated exactly this (rounded to whole stars)'),
  group_by: z.enum(['year', 'month', 'format', 'author', 'rating', 'series', 'subject']).default('year')
    .describe('Dimension for the top-N breakdown returned in "top". "subject" counts a book once per subject (multi-valued), so subject group sizes can sum to more than total_books.'),
  limit: z.number().int().min(1).max(100).default(20),
})

type ReadingStatsInput = z.infer<typeof getReadingStatsSchema>

// One book's facts needed for aggregation: collapsed reading state + joined metadata.
export interface BookForStats {
  title: string | null
  author: string | null
  url: string | null
  shelf: 'reading' | 'read' | 'to-read' | null
  finished: Date | null
  rating: string | null
  pages: number | null
  format: string | null
  pubYear: number | null
  language: string | null
  series: string | null
  subjects: string[] | null
}

const isoDate = (d: Date | null): string | null => d?.toISOString().slice(0, 10) ?? null
const round = (n: number): number => Math.round(n)

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : round((s[mid - 1] + s[mid]) / 2)
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return round(values.reduce((a, b) => a + b, 0) / values.length)
}

// A book's key(s) in the requested dimension. Every dimension is single-valued
// except `subject`, where a book counts once per subject it carries.
function groupKeys(book: BookForStats, dim: ReadingStatsInput['group_by']): string[] {
  switch (dim) {
    case 'year':
      return [book.finished ? String(book.finished.getUTCFullYear()) : 'unknown']
    case 'month':
      return [book.finished ? isoDate(book.finished)!.slice(0, 7) : 'unknown']
    case 'format':
      return [book.format ?? 'unknown']
    case 'author':
      return [book.author ?? 'unknown']
    case 'rating':
      return [book.rating != null ? String(round(Number(book.rating))) : 'unrated']
    case 'series':
      return [book.series ?? 'unknown']
    case 'subject':
      return book.subjects?.length ? book.subjects : ['unknown']
  }
}

/**
 * Roll a set of collapsed+enriched books into reading statistics. Pure, so the
 * aggregation is unit-testable without a DB. Page-based numbers are computed only
 * over books with a known page count and that coverage is reported explicitly
 * (books_with_pages / total_books); the prose-only average drops comics/audiobooks
 * so a graphic-novel-heavy span doesn't skew it.
 */
export function aggregateReadingStats(books: BookForStats[], input: ReadingStatsInput) {
  const hasDateFilter = input.year != null || input.from != null || input.to != null
  const fromTs = input.from ? Date.parse(input.from) : null
  const toTs = input.to ? Date.parse(input.to) : null

  const filtered = books.filter((b) => {
    if (b.shelf !== input.status) return false
    if (input.author && !(b.author ?? '').toLowerCase().includes(input.author.toLowerCase())) return false
    if (input.format && b.format !== input.format) return false
    if (input.rating != null && (b.rating == null || round(Number(b.rating)) !== input.rating)) return false
    if (hasDateFilter) {
      if (!b.finished) return false
      const t = b.finished.getTime()
      if (input.year != null && b.finished.getUTCFullYear() !== input.year) return false
      if (fromTs != null && t < fromTs) return false
      if (toTs != null && t > toTs) return false
    }
    return true
  })

  const withPages = filtered.filter((b) => b.pages != null)
  const pages = withPages.map((b) => b.pages as number)
  const prosePages = withPages
    .filter((b) => !NON_PROSE_FORMATS.has(b.format ?? ''))
    .map((b) => b.pages as number)

  // Finish span.
  const finishes = filtered.map((b) => b.finished).filter((d): d is Date => d != null)
  const firstFinished = finishes.length ? new Date(Math.min(...finishes.map((d) => d.getTime()))) : null
  const lastFinished = finishes.length ? new Date(Math.max(...finishes.map((d) => d.getTime()))) : null

  // Ratings.
  const ratings = filtered.map((b) => (b.rating != null ? Number(b.rating) : null)).filter((n): n is number => n != null && Number.isFinite(n))
  const distribution: Record<string, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const r of ratings) {
    const star = Math.min(5, Math.max(1, round(r)))
    distribution[star] = (distribution[star] ?? 0) + 1
  }

  // Per-format breakdown (always by format, small cardinality, unbounded).
  const byFormatMap = new Map<string, BookForStats[]>()
  for (const b of filtered) {
    const k = b.format ?? 'unknown'
    ;(byFormatMap.get(k) ?? byFormatMap.set(k, []).get(k)!).push(b)
  }
  const by_format = [...byFormatMap.entries()]
    .map(([format, group]) => {
      const gp = group.map((b) => b.pages).filter((p): p is number => p != null)
      return { format, books: group.length, total_pages: gp.reduce((a, b) => a + b, 0), avg_pages: mean(gp) }
    })
    .sort((a, b) => b.books - a.books)

  // Per-language breakdown (small cardinality, unbounded), now that language is
  // normalized and reliably populated from the enriched book_metadata cache.
  const byLanguageMap = new Map<string, BookForStats[]>()
  for (const b of filtered) {
    const k = b.language ?? 'unknown'
    ;(byLanguageMap.get(k) ?? byLanguageMap.set(k, []).get(k)!).push(b)
  }
  const by_language = [...byLanguageMap.entries()]
    .map(([language, group]) => ({ language, books: group.length }))
    .sort((a, b) => b.books - a.books)

  // Top-N breakdown by the requested dimension.
  const topMap = new Map<string, BookForStats[]>()
  for (const b of filtered) {
    for (const k of groupKeys(b, input.group_by)) {
      ;(topMap.get(k) ?? topMap.set(k, []).get(k)!).push(b)
    }
  }
  const top = [...topMap.entries()]
    .map(([key, group]) => {
      const gp = group.map((b) => b.pages).filter((p): p is number => p != null)
      return { key, books: group.length, total_pages: gp.reduce((a, b) => a + b, 0), avg_pages: mean(gp) }
    })
    .sort((a, b) => b.books - a.books)
    .slice(0, input.limit)

  return {
    total_books: filtered.length,
    books_with_pages: withPages.length,
    pages_coverage: `${withPages.length}/${filtered.length} books with known page counts`,
    total_pages: pages.reduce((a, b) => a + b, 0),
    avg_pages: mean(pages),
    median_pages: median(pages),
    avg_pages_prose: mean(prosePages),
    prose_books: prosePages.length,
    first_finished_at: isoDate(firstFinished),
    last_finished_at: isoDate(lastFinished),
    rating: {
      // One-decimal average (not the integer-rounding `mean` used for pages).
      avg: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null,
      count: ratings.length,
      distribution,
    },
    by_format,
    by_language,
    group_by: input.group_by,
    top,
    filters: {
      actor_handle: input.actor_handle,
      status: input.status,
      year: input.year ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      format: input.format ?? null,
      author: input.author ?? null,
      rating: input.rating ?? null,
    },
  }
}

export async function getReadingStats(input: ReadingStatsInput) {
  const actor = input.actor_handle.startsWith('http')
    ? { apId: input.actor_handle }
    : await resolveActorByHandle(input.actor_handle)
  if (!actor) return { error: `Could not resolve actor: ${input.actor_handle}` }

  // Collapse the actor's stored reading events to one row per book (same shared
  // loader as get_actor_reading_status's offline path and get_reading_pace).
  const collapsed = await loadCollapsedBooks(actor.apId)

  // Join cached per-edition metadata by book URL.
  const db = getDb()
  const urls = collapsed.map((b) => b.url).filter((u): u is string => !!u)
  const metaRows = urls.length
    ? await db
        .select({
          bookUrl: bookMetadata.bookUrl,
          title: bookMetadata.title,
          author: bookMetadata.author,
          pages: bookMetadata.pages,
          physicalFormat: bookMetadata.physicalFormat,
          pubYear: bookMetadata.pubYear,
          language: bookMetadata.language,
          series: bookMetadata.series,
          subjects: bookMetadata.subjects,
        })
        .from(bookMetadata)
        .where(inArray(bookMetadata.bookUrl, urls))
    : []
  const metaByUrl = new Map<string, (typeof metaRows)[number]>()
  for (const m of metaRows) metaByUrl.set(m.bookUrl, m)

  // Identity precedence mirrors get_reading_pace: cache's canonical Edition
  // title/author first (so e.g. the `author` filter matches books whose stored
  // statuses never carried an author), parsed status fields next, live shelf
  // merge last for any book still nameless.
  const books: BookForStats[] = collapsed.map((b) => {
    const m = b.url ? metaByUrl.get(b.url) : undefined
    const subjects = Array.isArray(m?.subjects)
      ? (m.subjects as unknown[]).filter((s): s is string => typeof s === 'string')
      : null
    return {
      title: m?.title ?? b.title,
      author: m?.author ?? b.author,
      url: b.url,
      shelf: b.shelf,
      finished: b.finished,
      rating: b.rating,
      pages: m?.pages ?? null,
      format: m?.physicalFormat ?? null,
      pubYear: m?.pubYear ?? null,
      language: m?.language ?? null,
      series: m?.series ?? null,
      subjects: subjects?.length ? subjects : null,
    }
  })
  await fillNamesFromLiveShelf(actor.apId, books)

  return aggregateReadingStats(books, input)
}
