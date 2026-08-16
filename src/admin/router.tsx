/** @jsxImportSource hono/jsx */
import { Hono, type Context } from 'hono'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { requireAuth } from './middleware.js'
import { verifyAdminPassword, createSession, deleteSession } from './auth.js'
import { getDb } from '../db/client.js'
import { activities, objects, follows, activityLog, actors, neodbMarks, linkedinPosts, linkedinPostMetrics } from '../db/schema.js'
import { and, desc, eq, gt, count, isNull, like, or, sql } from 'drizzle-orm'
import { LoginPage } from './views/login.js'
import { DashboardPage } from './views/dashboard.js'
import { ActivitiesPage } from './views/activities.js'
import { FollowsPage } from './views/follows.js'
import { LogsPage, LogRows } from './views/logs.js'
import { ObjectsPage } from './views/objects.js'
import { VisibilityPage } from './views/visibility.js'
import { BreakoutsPage } from './views/breakouts.js'
import { getPostBreakouts } from '../mcp/tools/post-breakouts.js'
import { config } from '../config.js'
import { streamEnabled } from '../stream/host.js'
import { parseSources } from '../stream/sources.js'
import { ImportPage, ImportResultPage, YoutubeImportResultPage } from './views/import.js'
import { ToolsPage, INFRA_ROUTES } from './views/tools.js'
import { endpoints } from '../rest/table.js'
import { mediaRouter } from './media-router.js'
import { mediaCounts } from './media-query.js'
import { parseYoutubeWatchHistory } from '../lib/parse-youtube-takeout.js'
import { importYoutubeWatches } from '../jobs/import-youtube-watches.js'
import {
  parseMastodonArchive,
  crawlOutbox,
  processActivityBatch,
  ensureActor,
  reprocessActivitiesByType,
  importTrainTrips,
  importLinkedinMetrics,
  BARE_OBJECT_TYPES,
} from './import.js'
import { repairNeodbIngest } from '../jobs/repair-neodb-ingest.js'
import { parseLinkedinExport } from '../lib/parse-linkedin-export.js'
import { deriveTokenStatus, getSourceHealth, LINKEDIN_SOURCE } from '../lib/source-health.js'
import { parseTrainTripsCsv } from '../lib/parse-trips-csv.js'
import { resolveActorByHandle } from '../lib/fetch-actor.js'
import { logger } from '../lib/logger.js'

const app = new Hono()

// Login
app.get('/login', (c) => c.html(<LoginPage />))

app.post('/login', async (c) => {
  const body = await c.req.parseBody()
  const password = body.password as string
  if (await verifyAdminPassword(password)) {
    const token = await createSession()
    setCookie(c, 'session', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      maxAge: 86400,
      path: '/',
    })
    return c.redirect('/admin')
  }
  return c.html(<LoginPage error="Invalid password" />)
})

app.get('/logout', async (c) => {
  const token = getCookie(c, 'session') ?? ''
  await deleteSession(token)
  deleteCookie(c, 'session')
  return c.redirect('/admin/login')
})

// Protected routes
app.use('/*', requireAuth)

// Dashboard
app.get('/', async (c) => {
  const db = getDb()
  const now = new Date()
  const day24 = new Date(now.getTime() - 86_400_000)
  const day7 = new Date(now.getTime() - 7 * 86_400_000)

  const [
    [{ cnt: totalActivities }],
    [{ cnt: activities24h }],
    [{ cnt: activities7d }],
    [{ cnt: totalObjects }],
    followsList,
    recentActs,
    lastAct,
    delivErrors,
    media,
    [{ cnt: liPosts }],
    [{ cnt: liMetrics }],
    liLatestExport,
    liHealth,
  ] = await Promise.all([
    db.select({ cnt: count() }).from(activities),
    db.select({ cnt: count() }).from(activities).where(gt(activities.receivedAt, day24)),
    db.select({ cnt: count() }).from(activities).where(gt(activities.receivedAt, day7)),
    db.select({ cnt: count() }).from(objects).where(isNull(objects.deletedAt)),
    db.select({ status: follows.status }).from(follows),
    db.select().from(activities).orderBy(desc(activities.receivedAt)).limit(15),
    db.select({ receivedAt: activities.receivedAt }).from(activities).orderBy(desc(activities.receivedAt)).limit(1),
    db.select({ cnt: count() }).from(activityLog)
      .where(and(eq(activityLog.direction, 'outbound'), gt(activityLog.responseStatus, 299))),
    mediaCounts(),
    db.select({ cnt: count() }).from(linkedinPosts),
    db.select({ cnt: count() }).from(linkedinPostMetrics),
    db.select({ latest: sql<string | null>`max(${linkedinPostMetrics.exportDate})` })
      .from(linkedinPostMetrics),
    getSourceHealth(LINKEDIN_SOURCE),
  ])

  // Twice the poll interval before calling it stale: one missed run is a blip.
  const linkedinStale = config.LINKEDIN_SYNC_INTERVAL_HOURS * 2 * 60 * 60_000

  return c.html(
    <DashboardPage data={{
      totalActivities: Number(totalActivities),
      activitiesLast24h: Number(activities24h),
      activitiesLast7d: Number(activities7d),
      totalObjects: Number(totalObjects),
      followsAccepted: followsList.filter(f => f.status === 'accepted').length,
      followsPending: followsList.filter(f => f.status === 'pending').length,
      recentActivities: recentActs,
      lastReceivedAt: lastAct[0]?.receivedAt ?? null,
      deliveryErrors: Number(delivErrors[0]?.cnt ?? 0),
      media,
      linkedin: {
        enabled: Boolean(config.LINKEDIN_DMA_TOKEN),
        status: deriveTokenStatus(liHealth, linkedinStale, now),
        lastSuccessAt: liHealth?.lastSuccessAt ?? null,
        lastDataAt: liHealth?.lastDataAt ?? null,
        lastError: liHealth?.lastError ?? null,
        lastNote: liHealth?.lastNote ?? null,
        lastHttpStatus: liHealth?.lastHttpStatus ?? null,
        posts: Number(liPosts),
        metricRows: Number(liMetrics),
        latestExport: liLatestExport[0]?.latest ?? null,
      },
    }} />
  )
})

// Activities browser
app.get('/activities', async (c) => {
  const db = getDb()
  const page = Number(c.req.query('page') ?? '0')
  const actor = c.req.query('actor')
  const type = c.req.query('type')
  const limit = 25

  const conditions = []
  if (actor) conditions.push(eq(activities.actorApId, actor))
  if (type) conditions.push(eq(activities.type, type))

  const rows = await db.select().from(activities)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(activities.receivedAt))
    .limit(limit + 1)
    .offset(page * limit)

  return c.html(
    <ActivitiesPage
      activities={rows.slice(0, limit)}
      page={page}
      hasMore={rows.length > limit}
      filters={{ actor, type }}
    />
  )
})

// Objects browser
app.get('/objects', async (c) => {
  const db = getDb()
  const page = Number(c.req.query('page') ?? '0')
  const actor = c.req.query('actor')
  const type = c.req.query('type')
  const q = c.req.query('q')
  const limit = 25

  const conditions = [isNull(objects.deletedAt)]
  if (actor) conditions.push(eq(objects.actorApId, actor))
  if (type) conditions.push(eq(objects.type, type))
  if (q) conditions.push(or(
    like(objects.contentText, `%${q}%`),
    like(objects.summary, `%${q}%`),
  )!)

  const rows = await db.select().from(objects)
    .where(and(...conditions))
    .orderBy(desc(objects.publishedAt))
    .limit(limit + 1)
    .offset(page * limit)

  return c.html(
    <ObjectsPage
      objects={rows.slice(0, limit)}
      page={page}
      hasMore={rows.length > limit}
      filters={{ actor, type, q }}
    />
  )
})

/**
 * The pre-launch check for the public stream.
 *
 * Publishing the archive is the one irreversible step in this feature — a post
 * that should not have been public is public the moment a crawler reads it. The
 * classifier fails closed and is heavily tested, but those tests assert what we
 * believe the five platforms send. This is where that meets the real rows, while
 * the site is still switched off.
 */
/**
 * The breakout notifier's own state. Calls the MCP tool directly rather than over HTTP,
 * so there is one implementation and one set of SQL behind the page and the API.
 *
 * No scope is passed: the admin IS the owner, so this sees the whole archive including
 * followers-only posts — unlike the REST endpoint, which is bound to public-only for
 * the reason ADR 0026 gives.
 */
app.get('/breakouts', async (c) => {
  const report = await getPostBreakouts({ days: 30, limit: 50 })
  if ('error' in report) return c.text(report.error as string, 404)
  return c.html(<BreakoutsPage report={report} />)
})

app.get('/visibility', async (c) => {
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

  const withheld = await db
    .select(sampleCols)
    .from(objects)
    .where(and(isNull(objects.deletedAt), sql`coalesce(${objects.visibility}, 'unknown') <> 'public'`))
    .orderBy(desc(objects.publishedAt))
    .limit(25)

  const publishable = await db
    .select(sampleCols)
    .from(objects)
    .where(and(isNull(objects.deletedAt), eq(objects.visibility, 'public')))
    .orderBy(desc(objects.publishedAt))
    .limit(15)

  // A mark's visibility lives on the Note it federated with; without that Note it
  // is withheld. Surfaced as a number so it is a known quantity, not a mystery.
  const [markStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withNote: sql<number>`count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM objects o WHERE o.ap_id = ${neodbMarks.markApId}))::int`,
    })
    .from(neodbMarks)
    .where(isNull(neodbMarks.deletedAt))

  let configuredHandles: string[] = []
  try {
    configuredHandles = parseSources(config.STREAM_SOURCES).map((s) => s.handle)
  } catch (e) {
    configuredHandles = [`(STREAM_SOURCES is invalid: ${e instanceof Error ? e.message : String(e)})`]
  }
  const knownHandles = new Set(
    (await db.select({ handle: actors.handle }).from(actors))
      .map((r) => (r.handle ?? '').toLowerCase()),
  )
  const unresolvedHandles = configuredHandles.filter((h) => !knownHandles.has(h.toLowerCase()))

  return c.html(
    <VisibilityPage
      counts={counts}
      withheld={withheld}
      publishable={publishable}
      unknownTotal={counts.filter((x) => x.visibility === 'unknown').reduce((s, x) => s + x.count, 0)}
      streamEnabled={streamEnabled()}
      streamDomain={config.STREAM_DOMAIN}
      includeUnlisted={config.STREAM_INCLUDE_UNLISTED}
      configuredHandles={configuredHandles}
      unresolvedHandles={unresolvedHandles}
      markCounts={{
        total: markStats?.total ?? 0,
        withNote: markStats?.withNote ?? 0,
        withoutNote: (markStats?.total ?? 0) - (markStats?.withNote ?? 0),
      }}
    />,
  )
})

// Follows
app.get('/follows', async (c) => {
  const db = getDb()
  const rows = await db
    .select({
      actorApId: follows.actorApId,
      status: follows.status,
      followedAt: follows.followedAt,
      acceptedAt: follows.acceptedAt,
      handle: actors.handle,
      displayName: actors.displayName,
      iconUrl: actors.iconUrl,
    })
    .from(follows)
    .leftJoin(actors, eq(follows.actorApId, actors.apId))
    .orderBy(desc(follows.followedAt))

  return c.html(<FollowsPage follows={rows} />)
})

// Logs. The page and its 10s poll run the same query, so it lives in one place.
const LOGS_LIMIT = 50

async function queryLogs(c: Context) {
  const db = getDb()
  const page = Number(c.req.query('page') ?? '0')
  const direction = c.req.query('direction')
  const sigValid = c.req.query('sigValid')
  const actor = c.req.query('actor')

  const conditions = []
  if (direction) conditions.push(eq(activityLog.direction, direction))
  if (sigValid === 'true') conditions.push(eq(activityLog.signatureValid, true))
  if (sigValid === 'false') conditions.push(eq(activityLog.signatureValid, false))
  if (actor) conditions.push(eq(activityLog.actorApId, actor))

  const rows = await db.select().from(activityLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(activityLog.createdAt))
    .limit(LOGS_LIMIT + 1)
    .offset(page * LOGS_LIMIT)

  return {
    logs: rows.slice(0, LOGS_LIMIT),
    page,
    hasMore: rows.length > LOGS_LIMIT,
    filters: { direction, sigValid, actor },
  }
}

app.get('/logs', async (c) => c.html(<LogsPage {...(await queryLogs(c))} />))

// The tbody fragment the page polls every 10s. Without this route the poll was a 404
// every 10 seconds and the "auto-refreshes" label was simply untrue.
app.get('/logs/rows', async (c) => {
  const { logs } = await queryLogs(c)
  return c.html(<LogRows logs={logs} />)
})

// Media. Mounted below `app.use('/*', requireAuth)` above, so it inherits the session gate.
app.route('/media', mediaRouter)

// Tools & endpoints
app.get('/tools', (c) => c.html(<ToolsPage endpoints={endpoints} infra={INFRA_ROUTES} />))

// Import
app.get('/import', (c) => c.html(<ImportPage />))

app.post(
  '/import/archive',
  bodyLimit({ maxSize: 50 * 1024 * 1024 }),
  async (c) => {
    const body = await c.req.parseBody()
    const file = body['archive']
    if (!file || typeof file === 'string') {
      return c.html(<ImportPage error="No file uploaded" />)
    }
    let text: string
    try {
      text = await (file as File).text()
    } catch {
      return c.html(<ImportPage error="Could not read file" />)
    }

    let items: unknown[]
    try {
      items = parseMastodonArchive(text)
    } catch (e) {
      return c.html(<ImportPage error={String(e)} />)
    }

    const firstActivity = items[0] as Record<string, unknown> | undefined
    const actorUrl =
      firstActivity && typeof firstActivity.actor === 'string'
        ? firstActivity.actor
        : null
    if (!actorUrl) {
      return c.html(<ImportPage error="Could not determine actor from archive" />)
    }

    try {
      await ensureActor(actorUrl)
    } catch (e) {
      return c.html(<ImportPage error={`Failed to fetch actor: ${e}`} />)
    }

    const result = await processActivityBatch(items, (n) => {
      logger.info({ n, total: items.length }, 'Archive import progress')
    })

    const params = new URLSearchParams({
      actor: actorUrl,
      total: String(result.total),
      imported: String(result.imported),
      skipped: String(result.skipped),
      errorCount: String(result.errors.length),
    })
    return c.redirect(`/admin/import/result?${params}`)
  },
)

app.post(
  '/import/trips',
  bodyLimit({ maxSize: 25 * 1024 * 1024 }),
  async (c) => {
    const body = await c.req.parseBody()
    const file = body['file']
    if (!file || typeof file === 'string') {
      return c.html(<ImportPage error="No file uploaded" />)
    }
    let text: string
    try {
      text = await (file as File).text()
    } catch {
      return c.html(<ImportPage error="Could not read file" />)
    }

    let rows
    try {
      rows = parseTrainTripsCsv(text)
    } catch (e) {
      return c.html(<ImportPage error={String(e)} />)
    }

    const result = await importTrainTrips(rows)
    logger.info({ ...result }, 'Train trips import complete')

    const params = new URLSearchParams({
      actor: 'train trips (CSV)',
      total: String(result.total),
      imported: String(result.inserted),
      updated: String(result.updated),
      skipped: String(result.unchanged),
      errorCount: '0',
    })
    return c.redirect(`/admin/import/result?${params}`)
  },
)

// LinkedIn monthly analytics export. An upload rather than a watched directory:
// the file is produced by hand on Markus' laptop once a month, so the browser he
// exported it in is where it already is, and docker-compose deliberately uses
// named volumes with no bind mount for the app to watch. See ADR 0033.
app.post(
  '/import/linkedin',
  bodyLimit({ maxSize: 25 * 1024 * 1024 }),
  async (c) => {
    const body = await c.req.parseBody()
    const file = body['file']
    if (!file || typeof file === 'string') {
      return c.html(<ImportPage error="No file uploaded" />)
    }

    // arrayBuffer(), not text(): an .xlsx is a zip, and decoding it as UTF-8
    // would corrupt it before the parser ever saw it.
    let bytes: ArrayBuffer
    try {
      bytes = await (file as File).arrayBuffer()
    } catch {
      return c.html(<ImportPage error="Could not read file" />)
    }

    let parsed
    try {
      parsed = await parseLinkedinExport(bytes)
    } catch (e) {
      return c.html(<ImportPage error={e instanceof Error ? e.message : String(e)} />)
    }

    const result = await importLinkedinMetrics(parsed)
    logger.info({ ...result }, 'LinkedIn metrics import complete')

    const params = new URLSearchParams({
      actor: `LinkedIn analytics — export dated ${result.exportDate}`,
      total: String(result.total),
      imported: String(result.inserted),
      skipped: String(result.skipped),
      errorCount: '0',
    })
    return c.redirect(`/admin/import/result?${params}`)
  },
)

// YouTube watch history. An upload rather than a sync: there is no API to poll, only a
// file exported by hand — same reasoning as the LinkedIn analytics import above.
//
// The limit is generous enough for the full ~46 MB archive, but the page says plainly
// that the command line is the better path for it: this handler parses inside the SERVER
// process, so a file big enough to exhaust the heap takes the server down with it, where
// `npm run import-youtube-watches` only loses its own process. This form is for the
// incremental exports that follow the first one.
app.post(
  '/import/youtube',
  bodyLimit({ maxSize: 64 * 1024 * 1024 }),
  async (c) => {
    const body = await c.req.parseBody()
    const file = body['file']
    if (!file || typeof file === 'string') {
      return c.html(<ImportPage error="No file uploaded" />)
    }
    const trimmed = (v: unknown) => {
      const s = typeof v === 'string' ? v.trim() : ''
      return s === '' ? undefined : s
    }

    let text: string
    try {
      text = await (file as File).text()
    } catch {
      return c.html(<ImportPage error="Could not read file" />)
    }

    let entries: unknown
    try {
      entries = JSON.parse(text)
    } catch (e) {
      return c.html(<ImportPage error={`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`} />)
    }
    if (!Array.isArray(entries)) {
      return c.html(<ImportPage error="Expected a JSON array of watch entries" />)
    }

    const { total, rows, problems, normalisations } = parseYoutubeWatchHistory(entries, {
      defaultAccount: trimmed(body['account']),
      defaultSource: trimmed(body['source']),
    })

    const result = await importYoutubeWatches(rows)
    logger.info(
      { ...result, failed: result.failed.length, problems: problems.length, normalisations: normalisations.length },
      'YouTube watch import complete (admin upload)',
    )

    // Rendered rather than redirected, unlike the other importers: the problem,
    // normalisation and refusal lists are the substance of this report and will not
    // survive a query string. Re-POSTing on refresh is harmless here — the import is
    // idempotent, so a resubmit inserts zero.
    return c.html(
      <YoutubeImportResultPage
        total={total}
        parsed={rows.length}
        inserted={result.inserted}
        skipped={result.skipped}
        problems={problems}
        normalisations={normalisations}
        failed={result.failed}
      />,
    )
  },
)

app.post('/import/crawl', async (c) => {
  const body = await c.req.parseBody()
  const handle = (body['handle'] as string | undefined)?.trim()
  if (!handle) return c.html(<ImportPage error="Handle is required" />)

  const actor = await resolveActorByHandle(handle)
  if (!actor) {
    return c.html(<ImportPage error={`Actor not found: ${handle}`} />)
  }

  let items: unknown[]
  try {
    items = await crawlOutbox(actor.apId)
  } catch (e) {
    return c.html(<ImportPage error={`Outbox crawl failed: ${e}`} />)
  }

  const result = await processActivityBatch(items, (n) => {
    logger.info({ n, total: items.length }, 'Outbox import progress')
  })

  const params = new URLSearchParams({
    actor: handle,
    total: String(result.total),
    imported: String(result.imported),
    skipped: String(result.skipped),
    errorCount: String(result.errors.length),
  })
  return c.redirect(`/admin/import/result?${params}`)
})

app.post('/import/reprocess', async (c) => {
  const result = await reprocessActivitiesByType(BARE_OBJECT_TYPES, (n) => {
    logger.info({ n }, 'Reprocess progress')
  })
  const params = new URLSearchParams({
    actor: 'stored bare objects',
    total: String(result.total),
    imported: String(result.imported),
    skipped: String(result.skipped),
    errorCount: String(result.errors.length),
  })
  return c.redirect(`/admin/import/result?${params}`)
})

// Rebuild what stored NeoDB marks should have produced: post text, mark-store rows, and
// the catalogue entries get_watched reads. Nothing is re-marked on NeoDB and no post is
// re-federated, so this is safe to press repeatedly.
app.post('/import/repair-neodb', async (c) => {
  const r = await repairNeodbIngest({ force: true })
  const summary = r
    ? `${r.postsRepaired} post(s) re-texted, ${r.postsRefetched} refetched, ${r.marksUpserted} mark(s) reprocessed, ${r.watchDatesFilled} watch date(s) filled, ${r.itemsSkipped} item(s) already enriched`
    : 'nothing to do'

  const params = new URLSearchParams({
    actor: `NeoDB ingest repair — ${summary}`,
    total: String((r?.itemsEnriched ?? 0) + (r?.itemsFailed ?? 0) + (r?.itemsSkipped ?? 0)),
    imported: String(r?.itemsEnriched ?? 0),
    skipped: String(r?.itemsSkipped ?? 0),
    errorCount: String(r?.itemsFailed ?? 0),
  })
  return c.redirect(`/admin/import/result?${params}`)
})

app.get('/import/result', (c) => {
  const actor = c.req.query('actor') ?? ''
  const result = {
    total: Number(c.req.query('total') ?? '0'),
    imported: Number(c.req.query('imported') ?? '0'),
    // Only the trips importer matches and updates in place; the others omit it.
    updated: c.req.query('updated') === undefined ? undefined : Number(c.req.query('updated')),
    skipped: Number(c.req.query('skipped') ?? '0'),
    errors: Number(c.req.query('errorCount') ?? '0') > 0
      ? [`${c.req.query('errorCount')} error(s) — see server logs for details`]
      : [],
  }
  return c.html(<ImportResultPage result={result} actor={actor} />)
})

export { app as adminRouter }
