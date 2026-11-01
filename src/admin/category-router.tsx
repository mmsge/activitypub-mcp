/** @jsxImportSource hono/jsx */
import { Hono, type Context } from 'hono'
import type { FC } from 'hono/jsx'
import { and, desc, eq, isNull, like, or, sql, count, type SQL } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { activities, objects, follows, actors, neodbMarks, linkedinPosts, linkedinPostMetrics } from '../db/schema.js'
import { config } from '../config.js'
import { resolveTab, type Category, type TabDef } from './categories.js'
import {
  queryBooks, queryWatched, queryOther, queryScrobbles, queryYoutubeWatches, youtubeAccounts,
  catalogueCategories, bookwyrmActorHandles, queryGigs, gigCities, PAGE_SIZE,
  type OtherFilters,
} from './media-query.js'
import { runningJobs } from './media-router.js'
import { getTheatre, getTheatreSchema } from '../mcp/tools/theatre.js'
import { getPostBreakouts } from '../mcp/tools/post-breakouts.js'
import { getThreadLeaderboard } from '../mcp/tools/thread-leaderboard.js'
import { loadWalkFailures } from '../lib/thread-store.js'
import { getStationDiscrepancies, getStationDiscrepanciesSchema } from '../mcp/tools/station-discrepancies.js'
import { deriveTokenStatus, getSourceHealth, LINKEDIN_SOURCE } from '../lib/source-health.js'
import { streamEnabled } from '../stream/host.js'
import { parseSources } from '../stream/sources.js'
import { endpoints } from '../rest/table.js'
import {
  BooksView, WatchedView, CatalogueView, GigsView, TheatreView, ScrobblesView, YoutubeView, type TabCtx,
} from './views/media-tabs.js'
import { CategoryPage } from './views/kit.js'
import {
  ReadingEventsView, TripsView, RoutesView, LinkedinPostsView, LinkedinStatsView, JobsView, type RouteRow,
} from './views/data-tabs.js'
import { getReadingEvents, getReadingEventsSchema } from '../mcp/tools/reading-events.js'
import { getTrainTrips, getTrainTripsSchema } from '../mcp/tools/train-trips.js'
import { getLinkedinPosts, getLinkedinPostsSchema } from '../mcp/tools/linkedin-posts.js'
import { getLinkedinStats, getLinkedinStatsSchema } from '../mcp/tools/linkedin-stats.js'
import { tripTrackMatchSql } from '../jobs/import-trip-tracks.js'
import { jobStatuses } from '../jobs/job-runs.js'
import {
  ActivitiesView, ObjectsView, FollowsView, ThreadsView, BreakoutsView, VisibilityView, StationsView,
  LinkedinView, ToolsView, INFRA_ROUTES,
} from './views/other-tabs.js'

// `/admin/k/:kategori?tab=:tab` — one page per category, one loader per tab. Every
// loader is the query its old page ran; only the rendering changed (ADR 0073).

const app = new Hono()

const LIST_LIMIT = 25

/** The URL this view's forms echo back, so a POST lands on the same tab, page and filters. */
function currentPath(c: Context): string {
  const url = new URL(c.req.url)
  url.searchParams.delete('notice')
  url.searchParams.delete('error')
  const qs = url.searchParams.toString()
  return qs ? `${url.pathname}?${qs}` : url.pathname
}

const pageOf = (c: Context) => Math.max(0, Number(c.req.query('page') ?? '0') || 0)

type Loader = (c: Context, ctx: TabCtx) => Promise<Response>

const opt = (c: Context, k: string) => c.req.query(k) || undefined

function otherFilters(c: Context, category?: string): OtherFilters {
  return {
    title: opt(c, 'title'),
    category: category ?? opt(c, 'category'),
    health: opt(c, 'health'),
    hidden: opt(c, 'hidden'),
    sort: c.req.query('sort') === 'watched' ? 'watched' : 'enriched',
  }
}

function catalogueSplit(category: string, empty: string): Loader {
  return async (c, ctx) => {
    const [data, categories] = await Promise.all([queryOther(otherFilters(c, category), pageOf(c)), catalogueCategories()])
    return c.html(<CatalogueView ctx={ctx} data={data} fixedCategory={category} categories={categories} empty={empty} />)
  }
}

const LOADERS: Record<string, Loader> = {
  // --- Lesing
  'lesing/lesingar': async (c, ctx) => {
    const actorsList = bookwyrmActorHandles()
    const actor = opt(c, 'actor') ?? actorsList[0]
    if (!actor) {
      return c.html(<ReadingEventsView ctx={ctx} actors={actorsList} result={{ error: 'BOOKWYRM_ACTORS er ikkje sett' }} />)
    }
    const type = opt(c, 'event_type')
    const parsed = getReadingEventsSchema.safeParse({
      actor_handle: actor, event_type: type, limit: LIST_LIMIT, cursor: opt(c, 'cursor'),
    })
    const result = parsed.success
      ? await getReadingEvents(parsed.data)
      : { error: 'Ugyldig filter' }
    return c.html(<ReadingEventsView ctx={ctx} result={result} actors={actorsList} actor={actor} />)
  },
  'lesing/boker': async (c, ctx) => {
    const actorsList = bookwyrmActorHandles()
    const actor = opt(c, 'actor') ?? actorsList[0]
    const data = await queryBooks({
      title: opt(c, 'title'), author: opt(c, 'author'), format: opt(c, 'format'), language: opt(c, 'language'),
      series: opt(c, 'series'), subject: opt(c, 'subject'), shelf: opt(c, 'shelf'), hidden: opt(c, 'hidden'),
      sort: c.req.query('sort') === 'enriched' ? 'enriched' : 'read', actor,
    }, pageOf(c))
    return c.html(<BooksView ctx={ctx} data={data} actors={actorsList} actor={actor} />)
  },

  // --- Sjåing
  'sjaaing/film': async (c, ctx) => {
    const data = await queryWatched({
      title: opt(c, 'title'), director: opt(c, 'director'), comment: opt(c, 'comment'), category: opt(c, 'category'),
      status: opt(c, 'status'), year: opt(c, 'year'), from: opt(c, 'from'), to: opt(c, 'to'), health: opt(c, 'health'),
      hidden: opt(c, 'hidden'), showDeleted: c.req.query('showDeleted') === '1', undated: c.req.query('undated') === '1',
      sort: c.req.query('sort') === 'enriched' ? 'enriched' : 'watched',
    }, pageOf(c))
    return c.html(<WatchedView ctx={ctx} data={data} />)
  },
  'sjaaing/youtube': async (c, ctx) => {
    const [data, accounts] = await Promise.all([
      queryYoutubeWatches({
        channel: opt(c, 'channel'), title: opt(c, 'title'), account: opt(c, 'account'),
        sort: c.req.query('sort') === 'recent' ? 'recent' : 'watches',
      }, pageOf(c)),
      youtubeAccounts(),
    ])
    return c.html(<YoutubeView ctx={ctx} data={data} accounts={accounts} />)
  },
  // The same query get_theatre answers with, so the tab never disagrees with the tool.
  // Hidden items are listed, badged, so they can be unhidden from here.
  'sjaaing/teater': async (c, ctx) => {
    const page = pageOf(c)
    const status = opt(c, 'status')
    const result = await getTheatre(getTheatreSchema.parse({
      q: opt(c, 'q'), troupe: opt(c, 'troupe'), person: opt(c, 'person'),
      status: ['wishlist', 'progress', 'complete', 'dropped'].includes(status ?? '') ? status : undefined,
      include_hidden: true, limit: PAGE_SIZE, page: page + 1,
    }))
    return c.html(<TheatreView ctx={ctx}
      data={{ rows: result.visits, total: result.total, page, hasMore: (page + 1) * PAGE_SIZE < result.total }} />)
  },
  'sjaaing/spel': catalogueSplit('game', 'Ingen spel frå NeoDB enno.'),
  'sjaaing/katalog': async (c, ctx) => {
    const [data, categories] = await Promise.all([queryOther(otherFilters(c), pageOf(c)), catalogueCategories()])
    return c.html(<CatalogueView ctx={ctx} data={data} categories={categories} empty="Ingen katalogoppføringar med dette filteret." />)
  },

  // --- Musikk
  'musikk/scrobblar': async (c, ctx) => {
    const data = await queryScrobbles({
      artist: opt(c, 'artist'), album: opt(c, 'album'), sort: c.req.query('sort') === 'recent' ? 'recent' : 'plays',
    }, pageOf(c))
    return c.html(<ScrobblesView ctx={ctx} data={data} />)
  },
  'musikk/konsertar': async (c, ctx) => {
    const [data, cities] = await Promise.all([
      queryGigs({
        q: opt(c, 'q'), city: opt(c, 'city'), health: opt(c, 'health'), hidden: opt(c, 'hidden'),
        sort: c.req.query('sort') === 'enriched' ? 'enriched' : 'gig_date',
      }, pageOf(c)),
      gigCities(),
    ])
    return c.html(<GigsView ctx={ctx} data={data} cities={cities} />)
  },
  'musikk/album': catalogueSplit('music', 'Ingen album frå NeoDB enno.'),
  'musikk/podkastar': catalogueSplit('podcast', 'Ingen podkastar frå NeoDB enno.'),

  // --- Reiser
  'reiser/turar': async (c, ctx) => {
    const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1)
    const year = Number(c.req.query('year'))
    const result = await getTrainTrips(getTrainTripsSchema.parse({
      station: opt(c, 'station'), journey: opt(c, 'journey'), status: opt(c, 'status'),
      year: Number.isInteger(year) && year > 1900 ? year : undefined, limit: LIST_LIMIT, page,
    }))
    return c.html(<TripsView ctx={ctx} result={result} page={page} />)
  },
  'reiser/ruter': async (c, ctx) => {
    const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1)
    const { rows, hasMore, coverage } = await loadRoutes(c, page)
    return c.html(<RoutesView ctx={ctx} rows={rows} page={page} hasMore={hasMore} coverage={coverage} />)
  },
  // Same handler as get_station_discrepancies (ADR 0072).
  'reiser/stasjonar': async (c, ctx) => {
    const report = await getStationDiscrepancies(getStationDiscrepanciesSchema.parse({}))
    return c.html(<StationsView ctx={ctx} report={report} />)
  },

  // --- Fediverse
  'fediverse/aktivitetar': async (c, ctx) => {
    const page = pageOf(c)
    const conditions = []
    const actor = opt(c, 'actor')
    const type = opt(c, 'type')
    if (actor) conditions.push(eq(activities.actorApId, actor))
    if (type) conditions.push(eq(activities.type, type))
    const rows = await getDb().select().from(activities)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(activities.receivedAt))
      .limit(LIST_LIMIT + 1)
      .offset(page * LIST_LIMIT)
    return c.html(<ActivitiesView ctx={ctx} rows={rows.slice(0, LIST_LIMIT)} page={page} hasMore={rows.length > LIST_LIMIT} />)
  },
  'fediverse/innlegg': async (c, ctx) => {
    const page = pageOf(c)
    const actor = opt(c, 'actor')
    const type = opt(c, 'type')
    const q = opt(c, 'q')
    const conditions = [isNull(objects.deletedAt)]
    if (actor) conditions.push(eq(objects.actorApId, actor))
    if (type) conditions.push(eq(objects.type, type))
    if (q) conditions.push(or(like(objects.contentText, `%${q}%`), like(objects.summary, `%${q}%`))!)
    const rows = await getDb().select().from(objects)
      .where(and(...conditions))
      .orderBy(desc(objects.publishedAt))
      .limit(LIST_LIMIT + 1)
      .offset(page * LIST_LIMIT)
    return c.html(<ObjectsView ctx={ctx} rows={rows.slice(0, LIST_LIMIT)} page={page} hasMore={rows.length > LIST_LIMIT} />)
  },
  'fediverse/folgjer': async (c, ctx) => {
    const rows = await getDb()
      .select({
        actorApId: follows.actorApId, status: follows.status, followedAt: follows.followedAt,
        acceptedAt: follows.acceptedAt, handle: actors.handle, displayName: actors.displayName, iconUrl: actors.iconUrl,
      })
      .from(follows)
      .leftJoin(actors, eq(follows.actorApId, actors.apId))
      .orderBy(desc(follows.followedAt))
    return c.html(<FollowsView ctx={ctx} rows={rows} />)
  },
  // No scope passed: the admin IS the owner, so unlisted roots are included (ADR 0026).
  'fediverse/traadar': async (c, ctx) => {
    const [report, failures] = await Promise.all([
      getThreadLeaderboard({ sort: 'external_nodes', limit: 50 }),
      loadWalkFailures(50),
    ])
    if ('error' in report) return c.html(<ThreadsError ctx={ctx} error={String(report.error)} />)
    return c.html(<ThreadsView ctx={ctx} report={report} failures={failures} />)
  },
  'fediverse/breakouts': async (c, ctx) => {
    const report = await getPostBreakouts({ days: 30, limit: 50 })
    if ('error' in report) return c.html(<ThreadsError ctx={ctx} error={String(report.error)} />)
    return c.html(<BreakoutsView ctx={ctx} report={report} />)
  },
  'fediverse/synlegheit': async (c, ctx) => c.html(<VisibilityView ctx={ctx} d={await loadVisibility()} />),

  // --- LinkedIn
  'linkedin/status': async (c, ctx) => {
    const db = getDb()
    const [[posts], [metrics], latest, health] = await Promise.all([
      db.select({ cnt: count() }).from(linkedinPosts),
      db.select({ cnt: count() }).from(linkedinPostMetrics),
      db.select({ latest: sql<string | null>`max(${linkedinPostMetrics.exportDate})` }).from(linkedinPostMetrics),
      getSourceHealth(LINKEDIN_SOURCE),
    ])
    return c.html(<LinkedinView ctx={ctx} data={{
      enabled: Boolean(config.LINKEDIN_DMA_TOKEN),
      status: deriveTokenStatus(health, linkedinStaleMs(), new Date()),
      lastSuccessAt: health?.lastSuccessAt ?? null,
      lastDataAt: health?.lastDataAt ?? null,
      lastError: health?.lastError ?? null,
      lastNote: health?.lastNote ?? null,
      lastHttpStatus: health?.lastHttpStatus ?? null,
      posts: Number(posts?.cnt ?? 0),
      metricRows: Number(metrics?.cnt ?? 0),
      latestExport: latest[0]?.latest ?? null,
    }} />)
  },

  'linkedin/innlegg': async (c, ctx) => {
    const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1)
    const result = await getLinkedinPosts(getLinkedinPostsSchema.parse({ limit: 25, page }))
    return c.html(<LinkedinPostsView ctx={ctx} result={result} />)
  },
  'linkedin/statistikk': async (c, ctx) =>
    c.html(<LinkedinStatsView ctx={ctx} stats={await getLinkedinStats(getLinkedinStatsSchema.parse({}))} />),

  // --- System
  'system/jobbar': async (c, ctx) => c.html(<JobsView ctx={ctx} jobs={await jobStatuses()} />),
  'system/verktoy': async (c, ctx) => c.html(<ToolsView ctx={ctx} endpoints={endpoints} infra={INFRA_ROUTES} />),
}

/**
 * The routes for Reiser → Ruter, newest first. The same join as get_trip_tracks
 * (`tripTrackMatchSql`, LATERAL … LIMIT 1 so a trip stored twice cannot duplicate a
 * row); that tool orders oldest first for a map, a list wants the latest on top.
 */
async function loadRoutes(c: Context, page: number) {
  const db = getDb()
  const conds: SQL[] = []
  const station = opt(c, 'station')
  if (station) conds.push(sql`(tt.from_station ILIKE ${`%${station}%`} OR tt.to_station ILIKE ${`%${station}%`})`)
  const year = Number(c.req.query('year'))
  if (Number.isInteger(year) && year > 1900) {
    conds.push(sql`tt.departure_local >= ${`${year}-01-01`}::timestamp`)
    conds.push(sql`tt.departure_local < ${`${year + 1}-01-01`}::timestamp`)
  }
  if (c.req.query('matched') === 'yes') conds.push(sql`t.id IS NOT NULL`)
  if (c.req.query('matched') === 'no') conds.push(sql`t.id IS NULL`)
  const where = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``
  const rows = [...(await db.execute(sql`
    SELECT tt.viaduct_trip_id, tt.from_station, tt.to_station, tt.departure_local::text AS departure_local,
      tt.measured_km, tt.point_count, tt.segments, t.id AS trip_id, t.journey
    FROM trip_tracks tt
    LEFT JOIN LATERAL (SELECT * FROM train_trips t WHERE ${tripTrackMatchSql('tt', 't')} LIMIT 1) t ON true
    ${where}
    ORDER BY tt.departure_local DESC, tt.viaduct_trip_id
    LIMIT ${LIST_LIMIT + 1} OFFSET ${(page - 1) * LIST_LIMIT}`)) as unknown as Array<Record<string, unknown>>]
  const [coverage] = [...(await db.execute(sql`
    SELECT count(*)::int AS tracks,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM train_trips t WHERE ${tripTrackMatchSql('tt', 't')}))::int AS matched
    FROM trip_tracks tt`)) as unknown as Array<{ tracks: number; matched: number }>]
  return {
    hasMore: rows.length > LIST_LIMIT,
    coverage: { tracks: coverage?.tracks ?? 0, matched: coverage?.matched ?? 0 },
    rows: rows.slice(0, LIST_LIMIT).map((r): RouteRow => ({
      viaductTripId: String(r.viaduct_trip_id),
      fromStation: String(r.from_station),
      toStation: String(r.to_station),
      departureLocal: String(r.departure_local),
      measuredKm: r.measured_km == null ? null : Number(r.measured_km),
      pointCount: Number(r.point_count ?? 0),
      segments: (r.segments as number[][][] | null) ?? null,
      tripId: (r.trip_id as string | null) ?? null,
      journey: (r.journey as string | null) ?? null,
    })),
  }
}

/** Twice the poll interval before calling LinkedIn stale: one missed run is a blip. */
export function linkedinStaleMs(): number {
  return config.LINKEDIN_SYNC_INTERVAL_HOURS * 2 * 60 * 60_000
}

/** A tool that answers with an error (feature unconfigured) renders the frame with the reason. */
const ThreadsError: FC<{ ctx: TabCtx; error: string }> = ({ ctx, error }) => (
  <CategoryPage {...ctx} error={error} lead="Kunne ikkje hente data" help={<>Verktøyet svarte med ein feil. Grunnen står over.</>} />
)

app.get('/:cat', async (c) => {
  const found = resolveTab(c.req.param('cat'), c.req.query('tab'))
  if (!found) return c.notFound()
  const { cat, tab } = found
  const loader = LOADERS[`${cat.id}/${tab.id}`]
  if (!loader) return c.notFound()
  return loader(c, tabCtx(c, cat, tab))
})

function tabCtx(c: Context, cat: Category, tab: TabDef): TabCtx {
  return {
    cat,
    tab,
    notice: opt(c, 'notice'),
    error: opt(c, 'error'),
    running: runningJobs(),
    returnTo: currentPath(c),
    q: c.req.query() as Record<string, string | undefined>,
  }
}

/**
 * The pre-launch check for the public stream. Publishing the archive is the one
 * irreversible step: a post that should not have been public is public the moment a
 * crawler reads it. This is where the classifier meets the real rows.
 */
async function loadVisibility() {
  const db = getDb()
  const counts = await db
    .select({
      actorApId: objects.actorApId,
      handle: actors.handle,
      software: actors.software,
      visibility: sql<string>`coalesce(${objects.visibility}, 'unknown')`,
      count: sql<number>`count(*)::int`,
    })
    .from(objects)
    .leftJoin(actors, eq(actors.apId, objects.actorApId))
    .where(isNull(objects.deletedAt))
    .groupBy(objects.actorApId, actors.handle, actors.software, objects.visibility)
    .orderBy(desc(sql`count(*)`))

  const sampleCols = {
    apId: objects.apId,
    url: objects.url,
    visibility: sql<string>`coalesce(${objects.visibility}, 'unknown')`,
    publishedAt: objects.publishedAt,
    contentText: objects.contentText,
    // Shown verbatim so a wrong verdict can be checked against the actual data.
    to: sql<string | null>`${objects.raw}->>'to'`,
    cc: sql<string | null>`${objects.raw}->>'cc'`,
  }
  const [withheld, publishable, [markStats], actorHandles] = await Promise.all([
    db.select(sampleCols).from(objects)
      .where(and(isNull(objects.deletedAt), sql`coalesce(${objects.visibility}, 'unknown') <> 'public'`))
      .orderBy(desc(objects.publishedAt)).limit(25),
    db.select(sampleCols).from(objects)
      .where(and(isNull(objects.deletedAt), eq(objects.visibility, 'public')))
      .orderBy(desc(objects.publishedAt)).limit(15),
    // A mark's visibility lives on the Note it federated with; without that Note it is withheld.
    db.select({
      total: sql<number>`count(*)::int`,
      withNote: sql<number>`count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM objects o WHERE o.ap_id = ${neodbMarks.markApId}))::int`,
    }).from(neodbMarks).where(isNull(neodbMarks.deletedAt)),
    db.select({ handle: actors.handle }).from(actors),
  ])

  let configuredHandles: string[] = []
  try {
    configuredHandles = parseSources(config.STREAM_SOURCES).map((s) => s.handle)
  } catch (e) {
    configuredHandles = [`(STREAM_SOURCES is invalid: ${e instanceof Error ? e.message : String(e)})`]
  }
  const known = new Set(actorHandles.map((r) => (r.handle ?? '').toLowerCase()))

  return {
    counts,
    withheld,
    publishable,
    unknownTotal: counts.filter((x) => x.visibility === 'unknown').reduce((s, x) => s + x.count, 0),
    streamEnabled: streamEnabled(),
    streamDomain: config.STREAM_DOMAIN,
    includeUnlisted: config.STREAM_INCLUDE_UNLISTED,
    configuredHandles,
    unresolvedHandles: configuredHandles.filter((h) => !known.has(h.toLowerCase())),
    markCounts: {
      total: markStats?.total ?? 0,
      withNote: markStats?.withNote ?? 0,
      withoutNote: (markStats?.total ?? 0) - (markStats?.withNote ?? 0),
    },
  }
}

export { app as categoryRouter }
