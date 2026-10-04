// Pull the StoryGraph journal from sidetal on demand, rather than waiting for the timer.
// Idempotent: it asks only for what changed since the newest stored row, and re-reading
// a row is an upsert. Run it right after arming the job to confirm the URL and token.
//
// No-op (and says so) when STORYGRAPH_API_URL or STORYGRAPH_API_TOKEN is unset.
//
//   npm run sync-storygraph
import { config } from '../src/config.js'
import { syncStorygraph } from '../src/jobs/sync-storygraph.js'
import { getSourceHealth, STORYGRAPH_SOURCE } from '../src/lib/source-health.js'
import { logger } from '../src/lib/logger.js'

try {
  if (!config.STORYGRAPH_API_URL.trim() || !config.STORYGRAPH_API_TOKEN.trim()) {
    console.log('STORYGRAPH_API_URL / STORYGRAPH_API_TOKEN not set — nothing to do. See .env.example.')
    process.exit(0)
  }

  await syncStorygraph()

  const health = await getSourceHealth(STORYGRAPH_SOURCE)
  console.table([
    {
      last_success: health?.lastSuccessAt?.toISOString() ?? '(never)',
      last_attempt: health?.lastAttemptAt?.toISOString() ?? '(never)',
      last_data: health?.lastDataAt?.toISOString() ?? '(never)',
      rows_upserted: health?.itemsLastRun ?? 0,
      consecutive_failures: health?.consecutiveFailures ?? 0,
      http_status: health?.lastHttpStatus ?? '',
      last_error: health?.lastError ?? '',
    },
  ])
  if (health?.lastNote) console.log(`\n${health.lastNote}\n`)

  // A failed run is recorded in the sync state rather than thrown, so exit non-zero on
  // it explicitly — otherwise a refused token looks like success to whatever ran this.
  if (health?.consecutiveFailures) {
    logger.error({ status: health.lastStatus, error: health.lastError }, 'StoryGraph sync did not complete')
    process.exit(1)
  }
  process.exit(0)
} catch (e) {
  logger.error(e, 'StoryGraph sync failed')
  process.exit(1)
}
