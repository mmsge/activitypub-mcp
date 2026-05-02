import { Hono } from 'hono'
import { getDb } from '../db/client.js'
import { activities } from '../db/schema.js'
import { eq, desc } from 'drizzle-orm'
import { getActorUrl } from '../config.js'
import { AP_HEADERS } from '../lib/content-type.js'

const app = new Hono()

app.get('/', async (c) => {
  const db = getDb()
  const actorUrl = getActorUrl()
  const page = Number(c.req.query('page') ?? '0')
  const limit = 20

  const items = await db.select()
    .from(activities)
    .orderBy(desc(activities.receivedAt))
    .limit(limit)
    .offset(page * limit)

  return c.json({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${actorUrl}/outbox${page > 0 ? `?page=${page}` : ''}`,
    type: 'OrderedCollectionPage',
    partOf: `${actorUrl}/outbox`,
    orderedItems: items.map(i => i.raw),
    next: items.length === limit ? `${actorUrl}/outbox?page=${page + 1}` : undefined,
  }, 200, AP_HEADERS)
})

export { app as outboxRouter }
