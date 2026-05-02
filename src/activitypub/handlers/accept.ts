import { getDb } from '../../db/client.js'
import { follows } from '../../db/schema.js'
import { eq } from 'drizzle-orm'
import { logger } from '../../lib/logger.js'

type AnyObject = Record<string, unknown>

export async function handleAccept(activity: AnyObject): Promise<void> {
  const obj = activity.object as AnyObject
  const followId = typeof obj === 'string' ? obj : obj?.id as string

  const db = getDb()
  // Find our follow by the follow activity id or the actor's ap_id
  const actorApId = activity.actor as string
  const updated = await db.update(follows)
    .set({ status: 'accepted', acceptedAt: new Date() })
    .where(eq(follows.actorApId, actorApId))
    .returning()

  if (updated.length > 0) {
    logger.info({ actorApId }, 'Follow accepted')
  } else {
    logger.warn({ actorApId, followId }, 'Received Accept but no matching follow found')
  }
}
