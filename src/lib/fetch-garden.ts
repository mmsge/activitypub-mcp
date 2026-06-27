import { logger } from './logger.js'

// Markus' "Tankehav" digital garden is an Obsidian Publish site (markus.plus).
// Obsidian Publish exposes a single cache document keyed by `_publish/<path>`;
// note entries (`.md`) carry a `frontmatter` object, image/binary entries are
// null. Each note's frontmatter gives us a permalink (the markus.plus URL),
// a description (excerpt) and an image (thumbnail); dates are present on only
// some notes (`dato`/`modified`), so they're treated as optional.
const SITE_ID = '8528a8f5ceabc10547ce0121dbdada5d'
const CACHE_URL = `https://publish-01.obsidian.md/cache/${SITE_ID}`
const SITE_BASE = 'https://markus.plus'

export interface GardenPage {
  title: string
  url: string
  path: string // permalink, e.g. "/reisar/interrail/2025"
  section: string // first permalink segment, e.g. "reisar"
  description: string | null
  image: string | null
  date: string | null // ISO-ish date string when the note carries one
  tags: string[]
}

// Process-lifetime cache. The garden changes rarely and the consumer (msge.no)
// already polls on a 6 h cadence, so a 6 h TTL keeps Obsidian out of the hot path.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
let cache: { at: number; value: GardenPage[] } | null = null

type AnyObject = Record<string, unknown>

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
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
      description: null,
      image: null,
      date: null,
      tags: [],
    })
  }
  return pages
}

export async function fetchGarden(): Promise<GardenPage[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value

  let pages: GardenPage[] = []
  try {
    const res = await fetch(CACHE_URL, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`cache -> ${res.status}`)
    pages = parseCache((await res.json()) as AnyObject)
  } catch (e) {
    logger.warn({ error: e }, 'Obsidian cache fetch failed; falling back to rss.xml')
  }
  if (pages.length === 0) {
    try {
      pages = await fetchFromRss()
    } catch (e) {
      logger.warn({ error: e }, 'Tankehav rss.xml fallback failed')
      // Serve a stale cache if we have one rather than nothing.
      if (cache) return cache.value
    }
  }

  cache = { at: Date.now(), value: pages }
  logger.info({ count: pages.length }, 'Tankehav garden refreshed')
  return pages
}
