import { getDb } from '../../db/client.js'
import { deliveryQueue } from '../../db/schema.js'
import { config, getActorUrl } from '../../config.js'
import { logger } from '../../lib/logger.js'
import { fetchActor } from '../../lib/fetch-actor.js'
import { randomUUID } from 'crypto'

type AnyObject = Record<string, unknown>

// Auto-reject any incoming Follow — this actor is not followable
export async function handleIncomingFollow(activity: AnyObject): Promise<void> {
  const requesterActorId = activity.actor as string
  const activityId = activity.id as string
  logger.info({ requesterActorId }, 'Received Follow request — auto-rejecting')

  let inboxUrl: string
  try {
    const actor = await fetchActor(requesterActorId)
    const resolved = actor.sharedInboxUrl ?? actor.inboxUrl
    if (!resolved) throw new Error('Actor has no inbox URL')
    inboxUrl = resolved
  } catch (e) {
    logger.warn({ requesterActorId, error: e }, 'Could not fetch requester actor for Reject delivery')
    return
  }

  const actorUrl = getActorUrl()
  const rejectActivity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${actorUrl}#reject-${randomUUID()}`,
    type: 'Reject',
    actor: actorUrl,
    object: activity,
  }

  const db = getDb()
  await db.insert(deliveryQueue).values({
    inboxUrl,
    payload: rejectActivity,
  })
}
