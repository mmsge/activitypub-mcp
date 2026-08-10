// Pull Markus' LinkedIn posts from the DMA Member Snapshot API on demand, rather
// than waiting for the weekly tick. Idempotent: the snapshot is historical and
// complete on every call, so posts already stored are upserted in place and
// re-running only picks up what is new.
//
// Useful after re-minting the token — it both backfills and clears the failure
// state that the admin dashboard and get_linkedin_stats report, so you can
// confirm the new token works without waiting a week to find out.
//
// No-op when LINKEDIN_DMA_TOKEN is unset.
//
//   npm run sync-linkedin
import { syncLinkedinPosts } from '../src/jobs/sync-linkedin-posts.js'
import { getSourceHealth, LINKEDIN_SOURCE } from '../src/lib/source-health.js'
import { logger } from '../src/lib/logger.js'

try {
  await syncLinkedinPosts()

  const health = await getSourceHealth(LINKEDIN_SOURCE)
  console.table([
    {
      last_success: health?.lastSuccessAt?.toISOString() ?? '(never)',
      last_attempt: health?.lastAttemptAt?.toISOString() ?? '(never)',
      posts_upserted: health?.itemsLastRun ?? 0,
      consecutive_failures: health?.consecutiveFailures ?? 0,
      last_error: health?.lastError ?? '',
    },
  ])

  // A failed run is reported through the sync state rather than by throwing, so
  // exit non-zero on it explicitly — otherwise a dead token looks like success to
  // whatever ran this.
  if (health?.consecutiveFailures) {
    logger.error(
      { status: health.lastStatus, error: health.lastError },
      'LinkedIn sync did not complete — the token may need re-minting',
    )
    process.exit(1)
  }

  logger.info({ upserted: health?.itemsLastRun ?? 0 }, 'LinkedIn sync complete')
  process.exit(0)
} catch (e) {
  logger.error(e, 'LinkedIn sync failed')
  process.exit(1)
}
