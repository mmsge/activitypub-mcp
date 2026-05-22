import { runDeliveryWorker } from './deliver.js'
import { refreshStaleActors } from './refresh-actors.js'
import { runLinkedInPoll } from './linkedin-poll.js'
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

  // LinkedIn poll — every 6 hours (DMA snapshots are not real-time)
  setInterval(async () => {
    try { await runLinkedInPoll() } catch (e) { logger.error(e, 'LinkedIn poll error') }
  }, 6 * 60 * 60_000)

  logger.info('Scheduler started')
}
