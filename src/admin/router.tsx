/** @jsxImportSource hono/jsx */
import { Hono, type Context } from 'hono'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { requireAuth } from './middleware.js'
import { verifyAdminPassword, createSession, deleteSession } from './auth.js'
import { getDb } from '../db/client.js'
import { activities, objects, follows, activityLog, actors } from '../db/schema.js'
import { and, desc, eq, gt, count, isNull, like, or } from 'drizzle-orm'
import { LoginPage } from './views/login.js'
import { DashboardPage } from './views/dashboard.js'
import { ActivitiesPage } from './views/activities.js'
import { FollowsPage } from './views/follows.js'
import { LogsPage, LogRows } from './views/logs.js'
import { ObjectsPage } from './views/objects.js'
import { ImportPage, ImportResultPage } from './views/import.js'
import { ToolsPage, INFRA_ROUTES } from './views/tools.js'
import { endpoints } from '../rest/table.js'
import { mediaRouter } from './media-router.js'
import { mediaCounts } from './media-query.js'
import {
  parseMastodonArchive,
  crawlOutbox,
  processActivityBatch,
  ensureActor,
  reprocessActivitiesByType,
  importTrainTrips,
  BARE_OBJECT_TYPES,
} from './import.js'
import { repairNeodbIngest } from '../jobs/repair-neodb-ingest.js'
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
  ])

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
      skipped: String(result.skipped),
      errorCount: '0',
    })
    return c.redirect(`/admin/import/result?${params}`)
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
    skipped: Number(c.req.query('skipped') ?? '0'),
    errors: Number(c.req.query('errorCount') ?? '0') > 0
      ? [`${c.req.query('errorCount')} error(s) — see server logs for details`]
      : [],
  }
  return c.html(<ImportResultPage result={result} actor={actor} />)
})

export { app as adminRouter }
