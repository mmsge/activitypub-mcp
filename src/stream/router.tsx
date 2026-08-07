/** @jsxImportSource hono/jsx */
import { Hono, type Context } from 'hono'
import { createHash } from 'node:crypto'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { ttlMemo } from '../lib/memo.js'
import { InvalidCursorError } from '../mcp/tools/pagination.js'
import { getAsset } from '../activitypub/profile-assets.js'
import { streamOrigin } from './host.js'
import { loadStreamPage, loadArchiveMonths, loadUndatedGardenNotes, loadEntriesByRefIds } from './query.js'
import { loadJourneys, loadJourney } from './journeys.js'
import { renderAtom } from './feed.js'
import { renderHead, renderRobots, renderSitemap } from './meta.js'
import { verifyProxyPath } from './image-proxy.js'
import { getImage } from './image-cache.js'
import { opsRouter } from '../ops/router.js'
import { platformInfo, AP_PLATFORMS, LOCAL_PLATFORMS, type Platform } from './sources.js'
import {
  EMPTY_FACETS, FRONT_PAGE_SIZE, PAGE_SIZE, cacheKey, parsePlatform, parseKind,
  parseTag, parseArchive, parseCursor, UnknownFacetError, type Facets,
} from './facets.js'
import { Layout } from './views/layout.js'
import { StreamList, UndatedGarden } from './views/entry.js'
import { JourneyList, JourneyPage } from './views/journey.js'
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

// Ops contract: /healthz, /version, /health (naustet-server ADR 0022). Literally the
// same router object the bot app mounts — one container, one image, one commit behind
// both hosts (ADR 0032), so they must not be able to answer differently. Mounted first,
// ahead of every page route and of streamApp.notFound(), which would otherwise turn a
// missing ops path into a 404 HTML page and read as "endpoint absent" to the box audit.
streamApp.route('', opsRouter)

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
// Rendered journey pages, index and detail in one map. `null` is cached too, so a
// crawler walking made-up slugs cannot turn every 404 into two queries. Capped
// well above the 13 real journeys, and the key space is bounded by the router's
// single :slug segment.
const journeyCache = ttlMemo<{ body: string; etag: string } | null>({ ttlMs: TTL, max: 64 })

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

  return conditional(c, cached.body, cached.etag)
}

/** Serve a cached HTML body with its ETag. Cheap reloads, and cheap crawls. */
function conditional(c: Context, body: string, etag: string): Response {
  if (c.req.header('if-none-match') === etag) {
    return c.body(null, 304, { ETag: etag })
  }
  return c.html(body, 200, {
    ETag: etag,
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

/**
 * The journey pages.
 *
 * Outside the facet system on purpose. Every other view is the same timeline
 * under a filter, ordered by `(event_at DESC, ref_id DESC)` and paged by keyset;
 * a journey is a named set of trips with its posts gathered under it, which is a
 * different shape entirely. Bending facets to carry it would have put a
 * non-chronological grouping through machinery whose whole correctness argument
 * is that the ordering is a strict total order over dates.
 *
 * Journeys are few (13) and change only when Markus imports a CSV, so both pages
 * are cached for the ordinary stream TTL and neither pages.
 */
streamApp.get('/reise', async (c) => {
  const cached = await journeyCache.get('index', async () => {
    const journeys = await loadJourneys()
    const canonical = `${streamOrigin()}/reise`
    const title = 'Meg — reiser'
    const description = 'Togreisene til Markus, med alt han la ut undervegs.'
    const html = (
      <Layout
        title={title}
        description={description}
        canonical={canonical}
        headExtra={renderHead({ title, description, canonical, entries: [] })}
      >
        <JourneyList journeys={journeys} />
      </Layout>
    ).toString()
    const full = `<!doctype html>${html}`
    return { body: full, etag: etagOf(full) }
  })
  if (!cached) return c.notFound()
  return conditional(c, cached.body, cached.etag)
})

streamApp.get('/reise/:slug', async (c) => {
  const slug = c.req.param('slug')
  const cached = await journeyCache.get(`j:${slug}`, async () => {
    const journey = await loadJourney(slug)
    if (!journey) return null
    const entries = await loadEntriesByRefIds(journey.postRefIds)
    const canonical = `${streamOrigin()}/reise/${journey.slug}`
    const title = `Meg — ${journey.name}`
    const description = `${journey.name}: ${journey.trips} etappar`
      + (journey.km > 0 ? `, ${journey.km} km` : '')
      + (journey.posts > 0 ? `, ${journey.posts} innlegg` : '')
    const html = (
      <Layout
        title={title}
        description={description}
        canonical={canonical}
        headExtra={renderHead({ title, description, canonical, entries })}
      >
        <JourneyPage journey={journey} entries={entries} />
      </Layout>
    ).toString()
    const full = `<!doctype html>${html}`
    return { body: full, etag: etagOf(full) }
  })
  if (!cached) return c.notFound()
  return conditional(c, cached.body, cached.etag)
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
  // Journeys are listed with a lastmod: unlike the month pages, a journey gains
  // content when a post is bound to one of its trips, and its last departure is
  // the closest honest stand-in for when that stopped happening.
  const journeys = await loadJourneys().catch((e) => {
    logger.error(e, 'Could not load journeys for the sitemap; omitting them')
    return []
  })
  const body = renderSitemap([
    { loc: `${origin}/` },
    ...[...AP_PLATFORMS, ...LOCAL_PLATFORMS].map((p) => ({ loc: `${origin}/kjelde/${p}` })),
    { loc: `${origin}/reise` },
    ...journeys.map((j) => ({ loc: `${origin}/reise/${j.slug}`, lastmod: j.lastAt.toISOString() })),
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

/**
 * Proxied images: /bilete/<sig>/<base64url of the upstream URL>.
 *
 * A path this app did not mint fails the signature and 404s, so there is no way to
 * ask for an arbitrary host. See image-proxy.ts for why that matters and what else
 * stands behind it.
 *
 * The response is immutable — the signature covers the exact upstream URL, so a
 * given path always means the same image. That is what makes a year-long
 * Cache-Control honest and keeps this off the hot path entirely.
 */
streamApp.get('/bilete/:sig/:encoded', async (c) => {
  if (config.STREAM_IMAGE_CACHE_MB === 0) return c.notFound()
  const url = verifyProxyPath(c.req.param('sig'), c.req.param('encoded'))
  if (!url) return c.notFound()

  const img = await getImage(url)
  // A dead origin is a missing image, not a broken page: the <img> fails to load
  // and everything around it still renders.
  if (!img) return c.body(null, 404)

  if (c.req.header('if-none-match') === img.etag) return c.body(null, 304, { ETag: img.etag })
  return c.body(img.body, 200, {
    'Content-Type': img.contentType,
    'Content-Length': String(img.body.length),
    ETag: img.etag,
    'Cache-Control': 'public, max-age=31536000, immutable',
    // The bytes are remote in origin even though they are served from here.
    'X-Content-Type-Options': 'nosniff',
  })
})

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
