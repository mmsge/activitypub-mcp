/** @jsxImportSource hono/jsx */
import { Hono, type Context } from 'hono'
import { logger } from '../lib/logger.js'
import {
  queryBooks,
  queryWatched,
  queryOther,
  queryScrobbles,
  catalogueCategories,
  failedCatalogueItems,
  catalogueItemById,
  bookById,
  bookwyrmActorHandles,
  type BookFilters,
  type WatchedFilters,
  type OtherFilters,
  type ScrobbleFilters,
} from './media-query.js'
import { BooksTab, WatchedTab, OtherTab, ScrobblesTab } from './views/media.js'
import { enrichCatalogueItem, syncNeodbMetadata } from '../jobs/sync-neodb-metadata.js'
import { enrichBookEdition, syncBookMetadata } from '../jobs/sync-book-metadata.js'
import { syncReadingHistory } from '../jobs/sync-reading-history.js'
import { syncScrobbles } from '../jobs/sync-scrobbles.js'

const app = new Hono()

const TABS = ['books', 'watched', 'other', 'scrobbles'] as const
type Tab = (typeof TABS)[number]

function tabOf(c: Context): Tab {
  const t = c.req.query('tab')
  return (TABS as readonly string[]).includes(t ?? '') ? (t as Tab) : 'books'
}

const pageOf = (c: Context) => Math.max(0, Number(c.req.query('page') ?? '0') || 0)

/**
 * Where a POST should send the browser back to.
 *
 * The form echoes the current query string so an action lands you back on the same tab,
 * page and filters. It is attacker-controllable, so only same-site admin media paths are
 * honoured — anything else would turn every one of these buttons into an open redirect.
 */
function safeReturn(raw: unknown): string {
  const v = typeof raw === 'string' ? raw : ''
  return v.startsWith('/admin/media') && !v.startsWith('//') ? v : '/admin/media'
}

function redirectWith(c: Context, returnTo: string, notice: string) {
  const url = new URL(returnTo, 'https://placeholder.invalid')
  url.searchParams.set('notice', notice)
  return c.redirect(`${url.pathname}?${url.searchParams.toString()}`)
}

/** The URL the current view's forms should echo back. */
function currentPath(c: Context): string {
  const url = new URL(c.req.url)
  url.searchParams.delete('notice')
  const qs = url.searchParams.toString()
  return qs ? `/admin/media?${qs}` : '/admin/media'
}

// --- GET ---------------------------------------------------------------------

app.get('/', async (c) => {
  const tab = tabOf(c)
  const page = pageOf(c)
  const notice = c.req.query('notice')
  const returnTo = currentPath(c)
  const q = (k: string) => c.req.query(k) || undefined

  if (tab === 'watched') {
    const filters: WatchedFilters = {
      title: q('title'),
      director: q('director'),
      comment: q('comment'),
      category: q('category'),
      status: q('status'),
      year: q('year'),
      from: q('from'),
      to: q('to'),
      health: q('health'),
      showDeleted: c.req.query('showDeleted') === '1',
      sort: q('sort') === 'enriched' ? 'enriched' : 'watched',
    }
    const data = await queryWatched(filters, page)
    return c.html(
      <WatchedTab
        data={data}
        filters={c.req.query() as Record<string, string | undefined>}
        notice={notice}
        returnTo={returnTo}
      />
    )
  }

  if (tab === 'other') {
    const filters: OtherFilters = {
      title: q('title'),
      category: q('category'),
      health: q('health'),
      sort: q('sort') === 'watched' ? 'watched' : 'enriched',
    }
    const [data, categories] = await Promise.all([queryOther(filters, page), catalogueCategories()])
    return c.html(
      <OtherTab
        data={data}
        categories={categories}
        filters={c.req.query() as Record<string, string | undefined>}
        notice={notice}
        returnTo={returnTo}
      />
    )
  }

  if (tab === 'scrobbles') {
    const filters: ScrobbleFilters = {
      artist: q('artist'),
      album: q('album'),
      sort: q('sort') === 'recent' ? 'recent' : 'plays',
    }
    const data = await queryScrobbles(filters, page)
    return c.html(
      <ScrobblesTab
        data={data}
        filters={c.req.query() as Record<string, string | undefined>}
        notice={notice}
        returnTo={returnTo}
      />
    )
  }

  const actors = bookwyrmActorHandles()
  const actor = q('actor') ?? actors[0]
  const filters: BookFilters = {
    title: q('title'),
    author: q('author'),
    format: q('format'),
    language: q('language'),
    series: q('series'),
    subject: q('subject'),
    shelf: q('shelf'),
    sort: q('sort') === 'enriched' ? 'enriched' : 'read',
    actor,
  }
  const data = await queryBooks(filters, page)
  return c.html(
    <BooksTab
      data={data}
      actors={actors}
      actor={actor}
      filters={c.req.query() as Record<string, string | undefined>}
      notice={notice}
      returnTo={returnTo}
    />
  )
})

// --- POST: per-row re-enrichment ---------------------------------------------

// `queueNeodbEnrichment` and `queueBookMetadataEnrichment` both refuse to do anything for
// an item that is already cached — the former dedupes on a Set that never clears and
// skips anything already enriched, the latter returns early when a row exists. Both are
// exactly right for on-ingest use and exactly wrong here, where the whole point is to
// refetch something whose stored data is bad. So this uses the forced variants.
app.post('/reenrich', async (c) => {
  const body = await c.req.parseBody()
  const returnTo = safeReturn(body.return)
  const kind = String(body.kind ?? '')
  const id = String(body.id ?? '')

  try {
    if (kind === 'book') {
      const row = await bookById(id)
      if (!row) return redirectWith(c, returnTo, 'Book not found')
      const ok = await enrichBookEdition(row.bookUrl)
      return redirectWith(c, returnTo, ok ? 'Book re-enriched' : 'Re-enrich returned no metadata')
    }

    // The Watched grid's row id is a mark id, not a catalogue id, so it passes the
    // catalogue URL straight through.
    const item = kind === 'catalogUrl'
      ? { itemUrl: id, category: null, itemType: null }
      : await catalogueItemById(id)
    if (!item) return redirectWith(c, returnTo, 'Item not found')

    const meta = await enrichCatalogueItem(item.itemUrl, { category: item.category, itemType: item.itemType })
    return redirectWith(c, returnTo, meta ? 'Item re-enriched' : 'Re-enrich failed — see server logs')
  } catch (e) {
    logger.error({ err: e, kind, id }, 'Admin re-enrich failed')
    return redirectWith(c, returnTo, 'Re-enrich errored — see server logs')
  }
})

const RETRY_MAX = 50
const RETRY_DELAY_MS = 200

app.post('/retry-failed', async (c) => {
  const body = await c.req.parseBody()
  const returnTo = safeReturn(body.return)

  const items = await failedCatalogueItems(RETRY_MAX)
  let ok = 0
  for (const item of items) {
    try {
      if (await enrichCatalogueItem(item.itemUrl, { category: item.category, itemType: item.itemType })) ok++
    } catch (e) {
      logger.warn({ err: e, itemUrl: item.itemUrl }, 'Retry of failed enrichment errored')
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
  }

  const capped = items.length === RETRY_MAX ? ` (capped at ${RETRY_MAX} per press)` : ''
  return redirectWith(c, returnTo, `Retried ${items.length}, ${ok} enriched${capped}`)
})

// --- POST: global syncs ------------------------------------------------------

/**
 * Detached, with an in-flight guard.
 *
 * These jobs run for tens of seconds to minutes (syncNeodbMetadata is bounded at 200
 * fetches with a delay between each; a cold syncScrobbles walks the whole Last.fm
 * history), so awaiting them would hang the request and invite a retry. Detaching also
 * makes the buttons idempotent: a double-click, an F5 on the redirect, or two open admin
 * tabs can't stampede BookWyrm/NeoDB/Last.fm.
 *
 * Deliberately unlike /admin/import/*, which awaits — there the counts *are* the result;
 * here the result lands in the logs.
 */
const running = new Set<string>()

export function kick(job: string, fn: () => Promise<void>): 'started' | 'already running' {
  if (running.has(job)) return 'already running'
  running.add(job)
  void fn()
    .catch((e) => logger.error({ err: e, job }, 'Admin-triggered sync failed'))
    .finally(() => running.delete(job))
  return 'started'
}

const SYNC_JOBS: Record<string, { label: string; run: () => Promise<void> }> = {
  neodb: { label: 'NeoDB metadata', run: () => syncNeodbMetadata() },
  books: { label: 'Book metadata', run: () => syncBookMetadata() },
  // Chained in the same order the scheduler uses: the history has to land before
  // enrichment collects Edition URLs from it, or the pass finds nothing new.
  reading: { label: 'Reading history', run: async () => { await syncReadingHistory(); await syncBookMetadata() } },
  lastfm: { label: 'Last.fm scrobbles', run: () => syncScrobbles() },
}

app.post('/sync', async (c) => {
  const body = await c.req.parseBody()
  const returnTo = safeReturn(body.return)
  const job = String(body.job ?? '')
  const entry = SYNC_JOBS[job]
  if (!entry) return redirectWith(c, returnTo, 'Unknown sync job')
  return redirectWith(c, returnTo, `${entry.label} sync ${kick(job, entry.run)}`)
})

export { app as mediaRouter }
