// The seven categories the admin is grouped into (the mobile redesign, see ADR 0073).
// One registry, so the Oversikt tiles, the Meir sheet, the desktop rail, the tab chips
// and the old-URL redirects cannot drift.
//
// A category page lives at `/admin/k/:id?tab=:tab`. Each tab is one of the views that
// used to be its own page; `category-router.tsx` loads it.

export type CategoryId =
  | 'lesing'
  | 'sjaaing'
  | 'musikk'
  | 'reiser'
  | 'fediverse'
  | 'linkedin'
  | 'system'

export interface TabDef {
  id: string
  label: string
}

/** A link to an import, shown under "Import og synk". `anchor` is its id in `import-kinds.ts`. */
export interface ImportDef {
  verb: 'Import' | 'Hent' | 'Køyr'
  label: string
  sub: string
  anchor: string
}

/** A background sync, kicked by POST /admin/media/sync with `job`. */
export interface SyncDef {
  job: 'neodb' | 'books' | 'reading' | 'gigs' | 'lastfm'
  label: string
}

export interface Category {
  id: CategoryId
  label: string
  href: string
  tabs: TabDef[]
  imports: ImportDef[]
  sync: SyncDef[]
}

const cat = (c: Omit<Category, 'href'>): Category => ({ ...c, href: `/admin/k/${c.id}` })

export const CATEGORIES: Category[] = [
  cat({
    id: 'lesing',
    label: 'Lesing',
    tabs: [{ id: 'boker', label: 'Bøker' }],
    imports: [
      { verb: 'Import', label: 'StoryGraph-lesedatoar', sub: 'CSV-eksport frå StoryGraph', anchor: 'storygraph' },
    ],
    sync: [
      { job: 'books', label: 'Bokmetadata' },
      { job: 'reading', label: 'Lesehistorikk' },
    ],
  }),
  cat({
    id: 'sjaaing',
    label: 'Sjåing',
    tabs: [
      { id: 'film', label: 'Film og TV' },
      { id: 'youtube', label: 'YouTube' },
      { id: 'teater', label: 'Teater' },
      { id: 'spel', label: 'Spel' },
      { id: 'katalog', label: 'Heile katalogen' },
    ],
    imports: [
      { verb: 'Import', label: 'YouTube-historikk', sub: 'JSON frå Google Takeout', anchor: 'youtube' },
      { verb: 'Køyr', label: 'Reparer NeoDB-merke', sub: 'Vedlikehald, trygt å køyre fleire gonger', anchor: 'repair-neodb' },
    ],
    sync: [{ job: 'neodb', label: 'NeoDB-metadata' }],
  }),
  cat({
    id: 'musikk',
    label: 'Musikk',
    tabs: [
      { id: 'scrobblar', label: 'Scrobblar' },
      { id: 'konsertar', label: 'Konsertar' },
      { id: 'album', label: 'Album' },
      { id: 'podkastar', label: 'Podkastar' },
    ],
    imports: [],
    sync: [
      { job: 'lastfm', label: 'Last.fm' },
      { job: 'gigs', label: 'Konsertar' },
    ],
  }),
  cat({
    id: 'reiser',
    label: 'Reiser',
    tabs: [{ id: 'stasjonar', label: 'Stasjonar' }],
    imports: [
      { verb: 'Import', label: 'Togturar', sub: 'CSV frå viaduct.world', anchor: 'trips' },
      { verb: 'Import', label: 'Togruter', sub: 'GPX frå viaduct.world', anchor: 'trip-tracks' },
    ],
    sync: [],
  }),
  cat({
    id: 'fediverse',
    label: 'Fediverse',
    tabs: [
      { id: 'aktivitetar', label: 'Aktivitetar' },
      { id: 'innlegg', label: 'Innlegg' },
      { id: 'folgjer', label: 'Følgjer' },
      { id: 'traadar', label: 'Trådar' },
      { id: 'breakouts', label: 'Breakouts' },
      { id: 'synlegheit', label: 'Synlegheit' },
    ],
    imports: [
      { verb: 'Import', label: 'Mastodon-arkiv', sub: 'outbox.json frå arkivet', anchor: 'archive' },
      { verb: 'Hent', label: 'Hent utboks', sub: 'Les ein aktør si utboks over ActivityPub', anchor: 'crawl' },
      { verb: 'Køyr', label: 'Prosesser nakne objekt', sub: 'Vedlikehald', anchor: 'reprocess' },
    ],
    sync: [],
  }),
  cat({
    id: 'linkedin',
    label: 'LinkedIn',
    tabs: [{ id: 'status', label: 'Status' }],
    imports: [
      { verb: 'Import', label: 'LinkedIn-statistikk', sub: 'XLSX frå LinkedIn', anchor: 'linkedin' },
    ],
    sync: [],
  }),
  cat({
    id: 'system',
    label: 'System',
    tabs: [{ id: 'verktoy', label: 'Verktøy' }],
    imports: [],
    sync: [],
  }),
]

export function category(id: string): Category | undefined {
  return CATEGORIES.find((c) => c.id === id)
}

export function categoryHref(id: CategoryId, tab?: string, params: Record<string, string> = {}): string {
  const sp = new URLSearchParams(tab ? { tab, ...params } : params)
  const qs = sp.toString()
  return qs ? `/admin/k/${id}?${qs}` : `/admin/k/${id}`
}

/** The category and tab a request asks for, falling back to the first tab. */
export function resolveTab(catId: string, tabId: string | undefined): { cat: Category; tab: TabDef } | null {
  const c = category(catId)
  if (!c) return null
  const tab = c.tabs.find((t) => t.id === tabId) ?? c.tabs[0]!
  return { cat: c, tab }
}

// --- old URLs ------------------------------------------------------------------

const OLD_MEDIA_TABS: Record<string, [CategoryId, string]> = {
  books: ['lesing', 'boker'],
  watched: ['sjaaing', 'film'],
  theatre: ['sjaaing', 'teater'],
  youtube: ['sjaaing', 'youtube'],
  other: ['sjaaing', 'katalog'],
  gigs: ['musikk', 'konsertar'],
  scrobbles: ['musikk', 'scrobblar'],
}

const OLD_PAGES: Record<string, [CategoryId, string]> = {
  '/admin/activities': ['fediverse', 'aktivitetar'],
  '/admin/objects': ['fediverse', 'innlegg'],
  '/admin/follows': ['fediverse', 'folgjer'],
  '/admin/threads': ['fediverse', 'traadar'],
  '/admin/breakouts': ['fediverse', 'breakouts'],
  '/admin/visibility': ['fediverse', 'synlegheit'],
  '/admin/stations': ['reiser', 'stasjonar'],
  '/admin/linkedin': ['linkedin', 'status'],
  '/admin/tools': ['system', 'verktoy'],
}

/**
 * Where an old admin URL lives now, keeping its filters, or null when it is not one.
 * `/admin/media?tab=other&category=game` lands on Spel, the other NeoDB categories on
 * the whole catalogue, so a bookmarked filter keeps showing the same rows.
 */
export function redirectFor(pathname: string, search: URLSearchParams): string | null {
  const params = new URLSearchParams(search)
  let target: [CategoryId, string] | undefined
  if (pathname === '/admin/media' || pathname === '/admin/media/') {
    const old = params.get('tab') ?? 'books'
    target = OLD_MEDIA_TABS[old] ?? OLD_MEDIA_TABS.books
    if (old === 'other') {
      const sub = OTHER_SPLIT[params.get('category') ?? '']
      if (sub) {
        target = sub
        params.delete('category')
      }
    }
  } else {
    target = OLD_PAGES[pathname.replace(/\/$/, '')]
  }
  if (!target) return null
  params.set('tab', target[1])
  return `/admin/k/${target[0]}?${params.toString()}`
}

/** NeoDB categories that have a tab of their own, carved out of "Other media". */
export const OTHER_SPLIT: Record<string, [CategoryId, string]> = {
  game: ['sjaaing', 'spel'],
  music: ['musikk', 'album'],
  podcast: ['musikk', 'podkastar'],
}
