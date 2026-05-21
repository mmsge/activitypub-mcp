import { getFollowActors } from '../config.js'
import { resolveActorByHandle } from '../lib/fetch-actor.js'
import { sendFollow } from '../activitypub/follow.js'
import { getDb } from '../db/client.js'
import { follows } from '../db/schema.js'
import { logger } from '../lib/logger.js'

export async function syncFollows(): Promise<void> {
  const handles = getFollowActors()
  if (handles.length === 0) {
    logger.info('No FOLLOW_ACTORS configured, skipping follow sync')
    return
  }

  const db = getDb()
  const existing = await db.select().from(follows)
  const existingByActorId = new Map(existing.map(f => [f.actorApId, f]))

  for (const handle of handles) {
    logger.info({ handle }, 'Resolving actor for follow sync')
    try {
      const actor = await resolveActorByHandle(handle)
      if (!actor) {
        logger.warn({ handle }, 'Could not resolve actor via WebFinger')
        continue
      }

      const current = existingByActorId.get(actor.apId)
      if (current && (current.status === 'pending' || current.status === 'accepted')) {
        logger.debug({ handle, status: current.status }, 'Already following, skipping')
        continue
      }

      if (!actor.inboxUrl) {
        logger.warn({ handle }, 'Actor has no inbox URL, skipping follow')
        continue
      }
      logger.info({ handle, actorApId: actor.apId }, 'Sending Follow request')
      await sendFollow(actor.apId, actor.inboxUrl, actor.sharedInboxUrl)
    } catch (e) {
      logger.error({ handle, error: e }, 'Error during follow sync')
    }
  }
}
