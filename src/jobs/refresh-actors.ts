import { getDb } from '../db/client.js'
import { actors } from '../db/schema.js'
import { fetchActor } from '../lib/fetch-actor.js'
import { fetchSoftwareName } from '../lib/fetch-nodeinfo.js'
import { lt, isNull, eq } from 'drizzle-orm'
import { logger } from '../lib/logger.js'

const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

export async function refreshStaleActors(): Promise<void> {
  const db = getDb()
  const cutoff = new Date(Date.now() - REFRESH_AFTER_MS)
  const stale = await db.select({ apId: actors.apId })
    .from(actors)
    .where(lt(actors.fetchedAt, cutoff))
    .limit(20)

  for (const { apId } of stale) {
    try {
      await fetchActor(apId)
      logger.debug({ apId }, 'Refreshed actor profile')
    } catch (e) {
      logger.warn({ apId, error: e }, 'Failed to refresh actor')
    }
  }

  // Backfill `software` for actors that predate the NodeInfo probe (or where it hasn't
  // resolved yet). fetchActor's 24h cache would short-circuit these without re-probing,
  // so probe NodeInfo directly and patch just this column.
  const missing = await db.select({ apId: actors.apId, domain: actors.domain })
    .from(actors)
    .where(isNull(actors.software))
    .limit(20)

  for (const { apId, domain } of missing) {
    try {
      const software = await fetchSoftwareName(domain)
      if (software) {
        await db.update(actors)
          .set({ software, updatedAt: new Date() })
          .where(eq(actors.apId, apId))
        logger.debug({ apId, software }, 'Backfilled actor software')
      }
    } catch (e) {
      logger.warn({ apId, error: e }, 'Failed to backfill actor software')
    }
  }
}
