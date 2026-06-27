import { runDeliveryWorker } from './deliver.js'
import { refreshStaleActors } from './refresh-actors.js'
import { syncScrobbles } from './sync-scrobbles.js'
import { config } from '../config.js'
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

  // Last.fm scrobble sync — interval configurable via LASTFM_SYNC_INTERVAL_SECONDS (default 60s)
  const scrobbleIntervalMs = config.LASTFM_SYNC_INTERVAL_SECONDS * 1_000
  setInterval(async () => {
    try { await syncScrobbles() } catch (e) { logger.error(e, 'Scrobble sync error') }
  }, scrobbleIntervalMs)

  logger.info({ scrobbleIntervalSeconds: config.LASTFM_SYNC_INTERVAL_SECONDS }, 'Scheduler started')
}
