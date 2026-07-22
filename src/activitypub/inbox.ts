import { Hono } from 'hono'
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { activities, activityLog, follows } from '../db/schema.js'
import { verifySignature } from '../crypto/signatures.js'
import { logger } from '../lib/logger.js'
import { handleCreate } from './handlers/create.js'
import { handleAnnounce } from './handlers/announce.js'
import { handleUpdate } from './handlers/update.js'
import { handleDelete } from './handlers/delete.js'
import { handleAccept } from './handlers/accept.js'
import { handleReject } from './handlers/reject.js'
import { handleIncomingFollow } from './handlers/follow.js'

type AnyObject = Record<string, unknown>

const app = new Hono()

export async function processActivity(activity: AnyObject): Promise<void> {
  const type = activity.type as string
  switch (type) {
    case 'Create':
      await handleCreate(activity)
      break
    case 'Announce':
      await handleAnnounce(activity)
      break
    case 'Update':
      await handleUpdate(activity)
      break
    case 'Delete':
      await handleDelete(activity)
      break
    case 'Accept':
      await handleAccept(activity)
      break
    case 'Reject':
      await handleReject(activity)
      break
    case 'Follow':
      await handleIncomingFollow(activity)
      break
    case 'Undo':
      // Undo of Follow, Like, etc. — just log it for now
      break
    case 'Note':
    case 'Article':
    case 'Image':
    case 'Video':
    case 'Audio':
    case 'Page':
    case 'Event':
    case 'Review':
    case 'Rating':
    case 'ReadThrough':
    case 'Edition':
    case 'Work':
    case 'ShelfBook':
    case 'Comment':
    case 'Quotation':
    case 'GeneratedNote':
      // Bare object from BookWyrm outbox — wrap in synthetic Create
      await handleCreate({
        type: 'Create',
        actor: (activity.attributedTo ?? activity.actor) as string,
        object: activity,
      })
      break
    default:
      logger.debug({ type }, 'Unhandled activity type')
  }
}

async function handleInbox(c: Context) {
  const body = await c.req.text()
  const headers: Record<string, string> = {}
  c.req.raw.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })

  const url = c.req.url
  const method = c.req.method

  let signatureValid: boolean | null = null
  let signatureError: string | null = null
  let actorApId: string | null = null

  const sigResult = await verifySignature(method, url, headers, body)
  signatureValid = sigResult.valid
  signatureError = sigResult.error ?? null
  actorApId = sigResult.actorApId ?? null

  // Log every request regardless of outcome
  const db = getDb()
  await db.insert(activityLog).values({
    direction: 'inbound',
    method,
    url,
    requestHeaders: headers,
    requestBody: body.slice(0, 10_000),
    signatureValid,
    error: signatureError,
    actorApId,
  })

  if (!signatureValid) {
    logger.warn({ url, error: signatureError }, 'Rejected inbox request: invalid signature')
    return c.json({ error: 'Signature verification failed' }, 401)
  }

  let activity: AnyObject
  try {
    activity = JSON.parse(body) as AnyObject
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const apId = activity.id as string
  if (!apId) return c.json({ error: 'Missing activity id' }, 400)

  const type = activity.type as string
  const obj = activity.object as AnyObject | string | null
  const objectApId = typeof obj === 'string' ? obj : (obj as AnyObject)?.id as string ?? null
  const objectType = typeof obj === 'object' && obj ? (obj as AnyObject).type as string ?? null : null

  // Only process content from followed accounts.
  // Control-plane types bypass the check:
  //   Accept/Reject — responses to our outgoing follows (still 'pending' at receipt time)
  //   Follow        — inbound follow requests we auto-reject regardless of sender
  const CONTROL_TYPES = new Set(['Accept', 'Reject', 'Follow'])
  if (!CONTROL_TYPES.has(type)) {
    // For bare objects (Note, Article, …) the actor lives in attributedTo, not actor
    const contentActor = (activity.actor as string)
      ?? (activity.attributedTo as string)
      ?? actorApId

    const [follow] = await db
      .select()
      .from(follows)
      .where(eq(follows.actorApId, contentActor))
      .limit(1)

    if (!follow || follow.status !== 'accepted') {
      logger.debug({ actorApId: contentActor, type }, 'Ignoring activity from unfollowed actor')
      return c.json({ status: 'accepted' }, 202)
    }
  }

  // Store raw activity
  await db.insert(activities).values({
    apId,
    type,
    actorApId: activity.actor as string,
    objectApId,
    objectType,
    raw: activity,
  }).onConflictDoNothing()

  // Process async (don't block the 202 response)
  setImmediate(async () => {
    try {
      await processActivity(activity)
      await db.update(activities)
        .set({ processed: true })
        .where(eq(activities.apId, apId))
    } catch (e) {
      logger.error({ apId, error: e }, 'Error processing activity')
      await db.update(activities)
        .set({ processingError: String(e) })
        .where(eq(activities.apId, apId))
    }
  })

  return c.json({ status: 'accepted' }, 202)
}

app.post('/', handleInbox)

export { app as inboxRouter }
