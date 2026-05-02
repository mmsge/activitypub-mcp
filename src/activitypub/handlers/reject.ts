import { getDb } from '../../db/client.js'
import { follows } from '../../db/schema.js'
import { eq } from 'drizzle-orm'
import { logger } from '../../lib/logger.js'

type AnyObject = Record<string, unknown>

export async function handleReject(activity: AnyObject): Promise<void> {
  const actorApId = activity.actor as string
  const db = getDb()
  await db.update(follows)
    .set({ status: 'rejected', rejectedAt: new Date() })
    .where(eq(follows.actorApId, actorApId))
  logger.info({ actorApId }, 'Follow rejected by remote')
}
