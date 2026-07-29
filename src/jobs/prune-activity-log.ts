import { lt } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { activityLog } from '../db/schema.js'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

/**
 * Deletes activity-log rows older than ACTIVITY_LOG_RETENTION_DAYS.
 *
 * The inbox logs every inbound request before it decides whether to act on it —
 * request headers plus the first 10 kB of the body — so the log necessarily holds
 * traffic from actors we do not follow, and from senders whose signature failed.
 * That is deliberate (it is what makes federation debuggable), but it must not be
 * indefinite: the actor's profile promises it keeps nothing about people it does
 * not follow, and an unbounded request log would quietly make that false.
 *
 * Only the log is pruned. The archive itself — objects from followed accounts — is
 * the point of the service and is kept.
 */
export async function pruneActivityLog(
  days: number = config.ACTIVITY_LOG_RETENTION_DAYS,
): Promise<number> {
  if (days <= 0) {
    logger.debug('Activity-log pruning disabled (ACTIVITY_LOG_RETENTION_DAYS=0)')
    return 0
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const deleted = await getDb()
    .delete(activityLog)
    .where(lt(activityLog.createdAt, cutoff))
    .returning({ id: activityLog.id })

  if (deleted.length > 0) {
    logger.info({ deleted: deleted.length, cutoff, days }, 'Pruned activity log')
  }
  return deleted.length
}
