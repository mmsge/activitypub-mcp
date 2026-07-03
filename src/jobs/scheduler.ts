import { runDeliveryWorker } from './deliver.js'
import { refreshStaleActors } from './refresh-actors.js'
import { syncScrobbles } from './sync-scrobbles.js'
import { syncBookMetadata } from './sync-book-metadata.js'
import { syncReadingHistory } from './sync-reading-history.js'
import { syncGardenContent } from './sync-garden-content.js'
import { sampleEngagement } from './sample-engagement.js'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

const SIX_HOURS_MS = 6 * 60 * 60_000

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

  // Reading-history outbox backfill + book metadata enrichment — every 6 hours.
  // History first so newly-ingested books are present when metadata enrichment
  // collects the URLs to fetch.
  setInterval(async () => {
    try {
      await syncReadingHistory()
      await syncBookMetadata()
    } catch (e) { logger.error(e, 'Reading sync error') }
  }, SIX_HOURS_MS)

  // Garden note-body crawl — every 6 hours, its own interval so a slow or
  // failing Obsidian origin never couples with the reading chain.
  setInterval(async () => {
    try { await syncGardenContent() } catch (e) { logger.error(e, 'Garden content sync error') }
  }, SIX_HOURS_MS)

  // Engagement sampling for the owner's recent posts — skip_unchanged writes
  // keep this cheap, so an hourly default builds smooth trends without bloat.
  setInterval(async () => {
    try { await sampleEngagement() } catch (e) { logger.error(e, 'Engagement sampling error') }
  }, config.ENGAGEMENT_SAMPLE_INTERVAL_MINUTES * 60_000)

  logger.info({ scrobbleIntervalSeconds: config.LASTFM_SYNC_INTERVAL_SECONDS }, 'Scheduler started')
}
