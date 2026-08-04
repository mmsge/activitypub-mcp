/** @jsxImportSource hono/jsx */
import { Hono, type Context } from 'hono'
import { createHash } from 'node:crypto'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { ttlMemo } from '../lib/memo.js'
import { InvalidCursorError } from '../mcp/tools/pagination.js'
import { getAsset } from '../activitypub/profile-assets.js'
import { streamOrigin } from './host.js'
import { loadStreamPage, loadArchiveMonths, loadUndatedGardenNotes } from './query.js'
import { renderAtom } from './feed.js'
import { renderHead, renderRobots, renderSitemap } from './meta.js'
import { platformInfo, AP_PLATFORMS, LOCAL_PLATFORMS, type Platform } from './sources.js'
import {
  EMPTY_FACETS, FRONT_PAGE_SIZE, PAGE_SIZE, cacheKey, parsePlatform, parseKind,
  parseTag, parseArchive, parseCursor, UnknownFacetError, type Facets,
} from './facets.js'
import { Layout } from './views/layout.js'
import { StreamList, UndatedGarden } from './views/entry.js'
import type { StreamPage, UndatedGardenNote } from './entries.js'

/**
 * meg.msge.no.
 *
 * A separate Hono app from the bot's, not a route group on it. The dispatcher in
 * src/index.ts picks one or the other on the Host header, so the ActivityPub
 * actor, the admin UI and the MCP endpoint are not merely shadowed here — they are
 * not mounted, and a route added to the bot app later cannot leak onto the public
 * host by accident.
 */

export const streamApp = new Hono()

const TTL = config.STREAM_CACHE_TTL_SECONDS * 1000

// Two layers: the hydrated page (expensive) and its rendered HTML plus ETag.
// Bounded on both axes — this is a public URL on a 3.7 GB box. The cap is the
// backstop; the real defence is that facets.ts normalises every filter to a closed
// enum, so the key space is small by construction.
const pageCache = ttlMemo<StreamPage>({ ttlMs: TTL, max: 200 })
const htmlCache = ttlMemo<{ body: string; etag: string }>({ ttlMs: TTL, max: 200 })
const feedCache = ttlMemo<string>({ ttlMs: Math.max(TTL, 300_000), max: 4 })
const monthsCache = ttlMemo<string[]>({ ttlMs: 3_600_000, max: 1 })
// The dateless garden notes change only when Markus publishes or dates one, so an
// hour is plenty — and it is one query for one page, not per request.
const undatedCache = ttlMemo<UndatedGardenNote[]>({ ttlMs: 3_600_000, max: 1 })

function etagOf(body: string): string {
  return `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`
}

/** The URL of a page under the current filters, for canonical links and "vis meir". */
function pathFor(f: Facets, cursor?: string | null): string {
  let base = '/'
  if (f.year != null && f.month != null) base = `/arkiv/${f.year}/${String(f.month).padStart(2, '0')}`
  else if (f.tag) base = `/emne/${encodeURIComponent(f.tag)}`
  else if (f.kind) base = `/type/${f.kind}`
  else if (f.platform) base = `/kjelde/${f.platform}`
  return cursor ? `${base}?etter=${encodeURIComponent(cursor)}` : base
}

function titleFor(f: Facets): string {
  if (f.year != null && f.month != null) return `Meg — ${f.year}/${String(f.month).padStart(2, '0')}`
  if (f.tag) return `Meg — #${f.tag}`
  if (f.kind) return `Meg — ${f.kind}`
  if (f.platform) return `Meg — ${platformInfo(f.platform).label}`
  return 'Meg'
}

function descriptionFor(f: Facets): string {
  if (f.platform) return `Alt Markus legg ut på ${platformInfo(f.platform).label}, samla på éin stad.`
  return 'Alt Markus legg ut — det han skriv, les, ser og høyrer på — samla på éin stad, i den rekkjefølgja det skjedde.'
}

/** Render and serve one view of the stream, cached and conditional-GET aware. */
async function servePage(c: Context, facets: Facets): Promise<Response> {
  const key = cacheKey(facets)

  const cached = await htmlCache.get(key, async () => {
    const page = await pageCache.get(key, () => loadStreamPage(facets))
    const canonical = `${streamOrigin()}${pathFor(facets)}`
    // Only on the garden's own first page: these notes have no date, so they have
    // no place in the stream, but hiding them entirely would drop a third of the
    // garden off the site. See loadUndatedGardenNotes.
    const undated = facets.platform === 'hage' && facets.cursor == null
      ? await undatedCache.get('all', loadUndatedGardenNotes)
      : []
    const body = (
      <Layout
        title={titleFor(facets)}
        description={descriptionFor(facets)}
        canonical={canonical}
        headExtra={renderHead({
          title: titleFor(facets),
          description: descriptionFor(facets),
          canonical,
          entries: page.entries,
        })}
        showIntro={facets.cursor == null && facets.platform == null && facets.kind == null
          && facets.tag == null && facets.year == null}
        activePlatform={facets.platform}
      >
        <StreamList
          entries={page.entries}
          nextHref={page.nextCursor ? pathFor(facets, page.nextCursor) : null}
        />
        <UndatedGarden notes={undated} />
      </Layout>
    ).toString()
    const full = `<!doctype html>${body}`
    return { body: full, etag: etagOf(full) }
  })

  // Cheap reloads, and cheap crawls.
  if (c.req.header('if-none-match') === cached.etag) {
    return c.body(null, 304, { ETag: cached.etag })
  }
  return c.html(cached.body, 200, {
    ETag: cached.etag,
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
  })
}

function facetsFrom(c: Context, overrides: Partial<Facets>): Facets {
  const cursor = parseCursor(c.req.query('etter'))
  const isFront = cursor == null && Object.keys(overrides).length === 0
  return {
    ...EMPTY_FACETS,
    ...overrides,
    cursor,
    // The front page shows more; every following page is a normal page. Never
    // client-settable, so it contributes two values to the cache key at most.
    limit: isFront ? FRONT_PAGE_SIZE : PAGE_SIZE,
  }
}

streamApp.get('/', (c) => servePage(c, facetsFrom(c, {})))

streamApp.get('/kjelde/:slug', (c) =>
  servePage(c, facetsFrom(c, { platform: parsePlatform(c.req.param('slug')) })))

streamApp.get('/type/:kind', (c) =>
  servePage(c, facetsFrom(c, { kind: parseKind(c.req.param('kind')) })))

streamApp.get('/emne/:tag', (c) =>
  servePage(c, facetsFrom(c, { tag: parseTag(c.req.param('tag')) })))

streamApp.get('/arkiv/:year/:month', (c) => {
  const { year, month } = parseArchive(c.req.param('year'), c.req.param('month'))
  return servePage(c, facetsFrom(c, { year, month }))
})

streamApp.get('/feed.atom', async (c) => {
  const body = await feedCache.get('main', async () => {
    const page = await loadStreamPage({ ...EMPTY_FACETS, limit: 50 })
    return renderAtom(page.entries, {
      title: 'Meg — straumen',
      alternate: `${streamOrigin()}/`,
      self: `${streamOrigin()}/feed.atom`,
    })
  })
  const etag = etagOf(body)
  if (c.req.header('if-none-match') === etag) return c.body(null, 304, { ETag: etag })
  return c.body(body, 200, {
    'Content-Type': 'application/atom+xml; charset=utf-8',
    ETag: etag,
    'Cache-Control': 'public, max-age=300',
  })
})

streamApp.get('/robots.txt', (c) =>
  c.text(renderRobots(), 200, { 'Cache-Control': 'public, max-age=3600' }))

streamApp.get('/sitemap.xml', async (c) => {
  const origin = streamOrigin()
  const months = await monthsCache.get('all', loadArchiveMonths)
  const body = renderSitemap([
    { loc: `${origin}/` },
    ...[...AP_PLATFORMS, ...LOCAL_PLATFORMS].map((p) => ({ loc: `${origin}/kjelde/${p}` })),
    ...months.map((m) => ({ loc: `${origin}/arkiv/${m.replace('-', '/')}` })),
  ])
  return c.body(body, 200, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  })
})

// The avatar and the link-preview card, served from this origin rather than linked
// to bot.skvip.lol — so reading the public page makes no request to the bot's
// domain. Same content-hash/ETag handling as the bot's own asset route.
for (const [path, asset] of [['/ikon.png', 'avatar'], ['/kort.png', 'header']] as const) {
  streamApp.get(path, (c) => {
    const { body, hash } = getAsset(asset)
    const etag = `"${hash}"`
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, { ETag: etag })
    return c.body(body, 200, {
      'Content-Type': 'image/png',
      'Content-Length': String(body.length),
      ETag: etag,
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
  })
}

streamApp.get('/healthz', (c) => c.text('ok'))

/** A minimal page in the site's own voice, for the outcomes that are not a stream. */
function message(c: Context, status: 400 | 404 | 500, title: string, body: string): Response {
  return c.html(
    `<!doctype html>${(
      <Layout title={`Meg — ${title}`} description={title} canonical={`${streamOrigin()}/`}>
        <p class="empty">{body} <a href="/">Til framsida</a>.</p>
      </Layout>
    ).toString()}`,
    status,
  )
}

streamApp.notFound((c) => message(c, 404, 'ikkje funne', 'Fann ikkje den sida.'))

streamApp.onError((err, c) => {
  // A bad filter is the caller's mistake, not ours. 404 rather than 500 keeps a
  // typo'd URL out of the error log — and, because facets.ts rejects before the
  // cache is consulted, out of the cache too.
  if (err instanceof UnknownFacetError) return message(c, 404, 'ikkje funne', 'Fann ikkje den sida.')
  if (err instanceof InvalidCursorError) {
    return message(c, 400, 'ugyldig lenkje', 'Den lenkja gjev ikkje meining.')
  }
  logger.error(err, 'Stream request failed')
  return message(c, 500, 'noko gjekk gale', 'Noko gjekk gale her. Prøv igjen om litt.')
})

/** Drop every cached page. Used after a deploy or from the admin UI. */
export function clearStreamCaches(): void {
  pageCache.clear()
  htmlCache.clear()
  feedCache.clear()
  monthsCache.clear()
  undatedCache.clear()
}
