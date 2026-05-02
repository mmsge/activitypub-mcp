/** @jsxImportSource hono/jsx */
import { Hono } from 'hono'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import { requireAuth } from './middleware.js'
import { verifyAdminPassword, createSession, deleteSession } from './auth.js'
import { getDb } from '../db/client.js'
import { activities, objects, follows, activityLog, actors } from '../db/schema.js'
import { and, desc, eq, gt, count, isNull, like, or } from 'drizzle-orm'
import { LoginPage } from './views/login.js'
import { DashboardPage } from './views/dashboard.js'
import { ActivitiesPage } from './views/activities.js'
import { FollowsPage } from './views/follows.js'
import { LogsPage } from './views/logs.js'
import { ObjectsPage } from './views/objects.js'

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

export { app as adminRouter }
