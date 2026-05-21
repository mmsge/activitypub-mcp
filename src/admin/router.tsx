/** @jsxImportSource hono/jsx */
import { Hono } from 'hono'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { requireAuth } from './middleware.js'
import { verifyAdminPassword, createSession, deleteSession } from './auth.js'
import { getDb } from '../db/client.js'
import { activities, objects, follows, activityLog, actors, linkedinAuth } from '../db/schema.js'
import { and, desc, eq, gt, count, isNull, like, or } from 'drizzle-orm'
import { LoginPage } from './views/login.js'
import { DashboardPage } from './views/dashboard.js'
import { ActivitiesPage } from './views/activities.js'
import { FollowsPage } from './views/follows.js'
import { LogsPage } from './views/logs.js'
import { ObjectsPage } from './views/objects.js'
import { ImportPage, ImportResultPage } from './views/import.js'
import { LinkedInPage } from './views/linkedin.js'
import {
  parseMastodonArchive,
  crawlOutbox,
  processActivityBatch,
  ensureActor,
  reprocessActivitiesByType,
  BARE_OBJECT_TYPES,
} from './import.js'
import { resolveActorByHandle } from '../lib/fetch-actor.js'
import { logger } from '../lib/logger.js'
import { buildAuthUrl, exchangeCode } from '../linkedin/oauth.js'
import { runLinkedInPoll } from '../jobs/linkedin-poll.js'
import { isLinkedInConfigured } from '../config.js'
import { randomBytes } from 'node:crypto'

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
  const source = c.req.query('source')
  const limit = 25

  const conditions = [isNull(objects.deletedAt)]
  if (actor) conditions.push(eq(objects.actorApId, actor))
  if (type) conditions.push(eq(objects.type, type))
  if (source) conditions.push(eq(objects.source, source))
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
      objects={rows.slice(0, limit) as any}
      page={page}
      hasMore={rows.length > limit}
      filters={{ actor, type, q, source }}
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

// Logs
app.get('/logs', async (c) => {
  const db = getDb()
  const page = Number(c.req.query('page') ?? '0')
  const direction = c.req.query('direction')
  const sigValid = c.req.query('sigValid')
  const actor = c.req.query('actor')
  const limit = 50

  const conditions = []
  if (direction) conditions.push(eq(activityLog.direction, direction))
  if (sigValid === 'true') conditions.push(eq(activityLog.signatureValid, true))
  if (sigValid === 'false') conditions.push(eq(activityLog.signatureValid, false))
  if (actor) conditions.push(eq(activityLog.actorApId, actor))

  const rows = await db.select().from(activityLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(activityLog.createdAt))
    .limit(limit + 1)
    .offset(page * limit)

  return c.html(
    <LogsPage
      logs={rows.slice(0, limit)}
      page={page}
      hasMore={rows.length > limit}
      filters={{ direction, sigValid, actor }}
    />
  )
})

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

// ─── LinkedIn ──────────────────────────────────────────────────────────────

app.get('/linkedin', async (c) => {
  const configured = isLinkedInConfigured()
  const db = getDb()
  const authRows = await db.select().from(linkedinAuth).limit(1)
  const auth = authRows[0] ?? null

  let postCount = 0
  if (auth) {
    const [{ cnt }] = await db.select({ cnt: count() }).from(objects)
      .where(eq(objects.source, 'linkedin'))
    postCount = Number(cnt)
  }

  // Resolve display name from actors table
  let displayName: string | undefined
  if (auth) {
    const actorRows = await db.select().from(actors)
      .where(eq(actors.apId, auth.memberUrn))
      .limit(1)
    displayName = actorRows[0]?.displayName ?? undefined
  }

  return c.html(
    <LinkedInPage data={{
      configured,
      connected: Boolean(auth),
      memberUrn: auth?.memberUrn,
      displayName,
      accessTokenExpiresAt: auth?.accessTokenExpiresAt,
      refreshTokenExpiresAt: auth?.refreshTokenExpiresAt ?? null,
      lastPolledAt: auth?.lastPolledAt ?? null,
      postCount,
      scopes: auth?.scopes,
    }} />
  )
})

app.get('/linkedin/connect', (c) => {
  if (!isLinkedInConfigured()) {
    return c.html(<LinkedInPage data={{ configured: false, connected: false, postCount: 0 }} />)
  }
  const state = randomBytes(16).toString('hex')
  setCookie(c, 'li_oauth_state', state, {
    httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 600, path: '/',
  })
  return c.redirect(buildAuthUrl(state))
})

app.get('/linkedin/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const storedState = getCookie(c, 'li_oauth_state')

  if (!code) {
    const error = c.req.query('error_description') ?? c.req.query('error') ?? 'No code returned'
    return c.html(<LinkedInPage data={{ configured: true, connected: false, postCount: 0 }} pollResult={{ memberUrn: '', total: 0, imported: 0, skipped: 0, errors: [error] }} />)
  }
  if (state !== storedState) {
    return c.html(<LinkedInPage data={{ configured: true, connected: false, postCount: 0 }} pollResult={{ memberUrn: '', total: 0, imported: 0, skipped: 0, errors: ['OAuth state mismatch'] }} />)
  }
  deleteCookie(c, 'li_oauth_state')

  let memberUrn: string
  try {
    memberUrn = await exchangeCode(code)
  } catch (e) {
    return c.html(<LinkedInPage data={{ configured: true, connected: false, postCount: 0 }} pollResult={{ memberUrn: '', total: 0, imported: 0, skipped: 0, errors: [String(e)] }} />)
  }

  // Run initial poll
  const results = await runLinkedInPoll()
  return c.redirect('/admin/linkedin')
})

app.post('/linkedin/poll', async (c) => {
  const results = await runLinkedInPoll()
  const result = results[0] ?? { memberUrn: '', total: 0, imported: 0, skipped: 0, errors: ['No connected account'] }

  const db = getDb()
  const authRows = await db.select().from(linkedinAuth).limit(1)
  const auth = authRows[0] ?? null
  const [{ cnt }] = await db.select({ cnt: count() }).from(objects).where(eq(objects.source, 'linkedin'))
  const actorRows = auth
    ? await db.select().from(actors).where(eq(actors.apId, auth.memberUrn)).limit(1)
    : []

  return c.html(
    <LinkedInPage
      data={{
        configured: isLinkedInConfigured(),
        connected: Boolean(auth),
        memberUrn: auth?.memberUrn,
        displayName: actorRows[0]?.displayName ?? undefined,
        accessTokenExpiresAt: auth?.accessTokenExpiresAt,
        refreshTokenExpiresAt: auth?.refreshTokenExpiresAt ?? null,
        lastPolledAt: auth?.lastPolledAt ?? null,
        postCount: Number(cnt),
        scopes: auth?.scopes,
      }}
      pollResult={result}
    />
  )
})

app.post('/linkedin/disconnect', async (c) => {
  const db = getDb()
  await db.delete(linkedinAuth)
  return c.redirect('/admin/linkedin')
})

export { app as adminRouter }
