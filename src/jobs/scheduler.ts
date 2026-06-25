import { runDeliveryWorker } from './deliver.js'
import { refreshStaleActors } from './refresh-actors.js'
import { syncScrobbles } from './sync-scrobbles.js'
import { logger } from '../lib/logger.js'

export function startScheduler(): void {
  // Delivery queue — every 30 seconds
  setInterval(async () => {
    try { await runDeliveryWorker() } catch (e) { logger.error(e, 'Delivery worker error') }
  }, 30_000)

  // Actor refresh — every hour
  setInterval(async () => {
    try { await refreshStaleActors() } catch (e) { logger.error(e, 'Actor refresh error') }
  }, 60 * 60_000)

  // Last.fm scrobble sync — every 5 minutes
  setInterval(async () => {
    try { await syncScrobbles() } catch (e) { logger.error(e, 'Scrobble sync error') }
  }, 5 * 60_000)

  logger.info('Scheduler started')
}
