import { logger } from './logger.js'

// Markus' "Tankehav" digital garden is an Obsidian Publish site (markus.plus).
// Obsidian Publish exposes a single cache document keyed by `_publish/<path>`;
// note entries (`.md`) carry a `frontmatter` object, image/binary entries are
// null. Each note's frontmatter gives us a permalink (the markus.plus URL),
// a description (excerpt) and an image (thumbnail); dates are present on only
// some notes (`dato`/`modified`), so they're treated as optional.
const SITE_ID = '8528a8f5ceabc10547ce0121dbdada5d'
const PUBLISH_HOST = 'https://publish-01.obsidian.md'
const CACHE_URL = `${PUBLISH_HOST}/cache/${SITE_ID}`
const SITE_BASE = 'https://markus.plus'

// URL serving a note's full raw markdown (frontmatter included). Built exactly
// how the official Obsidian Publish app does it: each path segment
// percent-encoded, slashes literal.
export function noteAccessUrl(sourcePath: string): string {
  return `${PUBLISH_HOST}/access/${SITE_ID}/${sourcePath.split('/').map(encodeURIComponent).join('/')}`
}

export interface GardenPage {
  title: string
  url: string
  path: string // permalink, e.g. "/reisar/interrail/2025"
  section: string // first permalink segment, e.g. "reisar"
  sourcePath: string | null // vault path (cache-doc key); null for RSS-fallback pages
  description: string | null
  image: string | null
  date: string | null // ISO-ish date string when the note carries one
  tags: string[]
}

// The crawlable identity of one published note. Unlike GardenPage this includes
// the home page (permalink "/"), which the page list deliberately omits.
export interface GardenNoteRef {
  sourcePath: string
  path: string
  title: string
  // The note's own date, from the same `dato`/`modified`/`anskaffet` frontmatter
  // GardenPage reads. Persisted by sync-garden-content so the public stream can
  // order a note by when it was written rather than by when the bot first saw it.
  // Absent on plenty of notes, and on the RSS fallback.
  date: string | null
  tags: string[]
}

// Book-review frontmatter, keyed by the `bookwyrm` field (== a BookWyrm Edition
// URL, i.e. the book_metadata.bookUrl join key). Markus curates these by hand on
// markus.plus, so they're a trustworthy, edition-matched fallback for the ISBN and
// gap-filler for language/pages/cover/series the BookWyrm Edition may lack.
export interface ReviewMeta {
  bookwyrmUrl: string
  isbn: string | null
  language: string[] | null // `språk`, e.g. ["danish","dansk"]
  originalLanguage: string | null // `originalspråk`
  pages: number | null // `Antal sider`
  cover: string | null // `image`
  authors: string[] | null // `forfattar`
  series: string | null // `serie`
  subtitle: string | null // `undertittel`
  illustrator: string | null // `teiknar`
  reviewUrl: string | null // markus.plus permalink
}

// Process-lifetime cache. The garden changes rarely and the consumer (msge.no)
// already polls on a 6 h cadence, so a 6 h TTL keeps Obsidian out of the hot path.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
let cache: {
  at: number
  pages: GardenPage[]
  reviews: Map<string, ReviewMeta>
  noteRefs: GardenNoteRef[]
} | null = null

type AnyObject = Record<string, unknown>

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

// Frontmatter fields that should be string arrays (`forfattar`, `språk`) arrive as
// either a single string or an array; normalize to a trimmed string[] (or null).
function strArray(v: unknown): string[] | null {
  const arr = Array.isArray(v) ? v : v != null ? [v] : []
  const out = arr.map((x) => str(x)).filter((x): x is string => x != null)
  return out.length ? out : null
}

// Title is the note's filename (its human-readable basename), unless frontmatter
// overrides it. e.g. "_publish/Meldingar/Film/The Woman In Cabin 10.md".
function titleFromKey(key: string): string {
  const base = key.replace(/^_publish\//, '').replace(/\.md$/, '')
  const last = base.split('/').pop() || base
  return last.trim()
}

function tagsFrom(entry: AnyObject): string[] {
  const raw = entry.tags
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const t of raw) {
    if (typeof t === 'string') out.push(t.replace(/^#/, ''))
    else if (t && typeof (t as AnyObject).tag === 'string')
      out.push(((t as AnyObject).tag as string).replace(/^#/, ''))
  }
  return out
}

function parseCache(data: AnyObject): GardenPage[] {
  // Two source files can resolve to the same permalink (e.g. a renamed note left
  // an alias behind), so dedupe by path and keep the richer (dated) entry.
  const byPath = new Map<string, GardenPage>()
  for (const [key, value] of Object.entries(data)) {
    if (!key.endsWith('.md') || !value || typeof value !== 'object') continue
    const entry = value as AnyObject
    const fm = (entry.frontmatter as AnyObject) || {}
    const permalink = str(fm.permalink)
    if (!permalink || permalink === '/') continue // skip the home page

    const path = permalink.startsWith('/') ? permalink : `/${permalink}`
    const section = path.split('/').filter(Boolean)[0] || 'anna'
    const page: GardenPage = {
      title: str(fm.title) || titleFromKey(key),
      url: `${SITE_BASE}${path}`,
      path,
      section,
      sourcePath: key,
      description: str(fm.description),
      image: str(fm.image),
      date: str(fm.dato) || str(fm.modified) || str(fm.anskaffet),
      tags: tagsFrom(entry),
    }
    const existing = byPath.get(path)
    if (!existing || (!existing.date && page.date)) byPath.set(path, page)
  }
  return [...byPath.values()]
}

/**
 * Every published .md note as a crawlable ref, INCLUDING the home page
 * (permalink "/"), keyed by its unique vault path. Notes without a permalink
 * are skipped, same as parseCache. Pure (no I/O).
 */
export function parseNoteRefs(data: AnyObject): GardenNoteRef[] {
  const refs: GardenNoteRef[] = []
  for (const [key, value] of Object.entries(data)) {
    if (!key.endsWith('.md') || !value || typeof value !== 'object') continue
    const fm = ((value as AnyObject).frontmatter as AnyObject) || {}
    const permalink = str(fm.permalink)
    if (!permalink) continue
    const path = permalink.startsWith('/') ? permalink : `/${permalink}`
    refs.push({
      sourcePath: key,
      path,
      title: str(fm.title) || titleFromKey(key),
      date: str(fm.dato) || str(fm.modified) || str(fm.anskaffet),
      tags: tagsFrom(value as AnyObject),
    })
  }
  return refs
}

/**
 * Remove a leading YAML frontmatter block from raw note markdown. Only strips
 * when the document's very first line (after an optional BOM) is `---`; the
 * block ends at the next line that is exactly `---` (trailing spaces / CRLF
 * tolerated). An unterminated opening fence is not frontmatter — the input is
 * returned unchanged — and `---` thematic breaks later in the body are
 * untouched since only offset 0 is matched.
 */
export function stripFrontmatter(raw: string): string {
  const m = raw.match(/^﻿?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/)
  return m ? raw.slice(m[0].length).replace(/^\r?\n/, '') : raw
}

/**
 * Parse the Obsidian cache document into a map of book-review metadata keyed by the
 * `bookwyrm` frontmatter URL (== a BookWyrm Edition id / book_metadata.bookUrl).
 * Only notes carrying a `bookwyrm` field are emitted — that field is unique to the
 * `Bøker/Meldingar` book reviews, so this naturally scopes to them. Pure (no I/O).
 */
export function parseGardenReviews(data: AnyObject): Map<string, ReviewMeta> {
  const byUrl = new Map<string, ReviewMeta>()
  for (const [, value] of Object.entries(data)) {
    if (!value || typeof value !== 'object') continue
    const fm = ((value as AnyObject).frontmatter as AnyObject) || {}
    const bookwyrmUrl = str(fm.bookwyrm)
    if (!bookwyrmUrl) continue // the join key; non-book notes lack it
    const permalink = str(fm.permalink)
    byUrl.set(bookwyrmUrl, {
      bookwyrmUrl,
      isbn: str(fm.isbn),
      language: strArray(fm['språk']),
      originalLanguage: str(fm['originalspråk']),
      pages: num(fm['Antal sider']),
      cover: str(fm.image),
      authors: strArray(fm.forfattar),
      series: str(fm.serie),
      subtitle: str(fm.undertittel),
      illustrator: str(fm.teiknar),
      reviewUrl: permalink ? `${SITE_BASE}${permalink.startsWith('/') ? permalink : `/${permalink}`}` : null,
    })
  }
  return byUrl
}

// Bare fallback: the RSS feed carries only <title> + <link>, no frontmatter, so
// description/image/date are unavailable and the section is read off the link.
async function fetchFromRss(): Promise<GardenPage[]> {
  const res = await fetch(`${SITE_BASE}/rss.xml`, { headers: { Accept: 'application/rss+xml' } })
  if (!res.ok) throw new Error(`rss.xml -> ${res.status}`)
  const xml = await res.text()
  const pages: GardenPage[] = []
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml))) {
    const block = m[1]
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1]
    if (!title || !link) continue
    let path = link.trim()
    try { path = new URL(link.trim()).pathname } catch { /* keep raw */ }
    const section = path.split('/').filter(Boolean)[0] || 'anna'
    pages.push({
      title: title.trim(),
      url: link.trim(),
      path,
      section,
      sourcePath: null,
      description: null,
      image: null,
      date: null,
      tags: [],
    })
  }
  return pages
}

// Refresh the process-lifetime cache when stale. Parses both the page list and the
// book-review map from the one cache document so neither needs a second fetch.
async function refreshGarden(): Promise<void> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return

  let pages: GardenPage[] = []
  let reviews = new Map<string, ReviewMeta>()
  let noteRefs: GardenNoteRef[] = []
  try {
    const res = await fetch(CACHE_URL, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`cache -> ${res.status}`)
    const doc = (await res.json()) as AnyObject
    pages = parseCache(doc)
    reviews = parseGardenReviews(doc)
    noteRefs = parseNoteRefs(doc)
  } catch (e) {
    logger.warn({ error: e }, 'Obsidian cache fetch failed; falling back to rss.xml')
  }
  if (pages.length === 0) {
    try {
      // RSS carries no frontmatter, so the review map stays empty (enrichment then
      // simply skips the review layer) and noteRefs stays empty (no vault paths).
      pages = await fetchFromRss()
    } catch (e) {
      logger.warn({ error: e }, 'Tankehav rss.xml fallback failed')
      // Keep serving a stale cache if we have one rather than nothing.
      if (cache) return
    }
  }

  cache = { at: Date.now(), pages, reviews, noteRefs }
  logger.info({ count: pages.length, reviews: reviews.size }, 'Tankehav garden refreshed')
}

export async function fetchGarden(): Promise<GardenPage[]> {
  await refreshGarden()
  return cache?.pages ?? []
}

// Crawlable note refs from the cached cache document (no extra network fetch).
// An empty array means "cache doc unavailable this cycle" — callers must treat
// that as unknown, not as an empty garden.
export async function fetchGardenNoteRefs(): Promise<GardenNoteRef[]> {
  await refreshGarden()
  return cache?.noteRefs ?? []
}

// Book-review metadata keyed by the `bookwyrm` Edition URL. Reuses fetchGarden's
// cached cache document (no extra network fetch).
export async function fetchGardenBookReviews(): Promise<Map<string, ReviewMeta>> {
  await refreshGarden()
  return cache?.reviews ?? new Map()
}
