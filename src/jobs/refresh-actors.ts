import { getDb } from '../db/client.js'
import { actors } from '../db/schema.js'
import { fetchActor } from '../lib/fetch-actor.js'
import { lt } from 'drizzle-orm'
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
}
