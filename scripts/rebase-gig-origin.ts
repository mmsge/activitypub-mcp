// One-off: move every stored Gigowl identifier from `samklang.msge.no` (Nynorsk paths) to
// `gigowl.social` (English paths), after the origin changed address — its ADR 0029 and
// 0030. Local only; nothing is fetched, nothing is re-federated. Idempotent, so a second
// run is a no-op. Also drops the follow row for the old address, so `syncFollows` sends a
// real Follow to @markus@gigowl.social on the next boot.
//
//   npm run rebase-gig-origin
//   DRY_RUN=1 npm run rebase-gig-origin   # count only, change nothing
import { countLegacyGigRows, rebaseGigOrigin } from '../src/jobs/rebase-gig-origin.js'
import { logger } from '../src/lib/logger.js'

const dryRun = ['1', 'true', 'yes', 'on'].includes((process.env.DRY_RUN ?? '').trim().toLowerCase())

try {
  const result = await rebaseGigOrigin({ dryRun })
  const remaining = await countLegacyGigRows()
  if (dryRun) {
    logger.info({ ...result, remaining }, 'Gig origin rebase (dry run) — nothing was written')
  } else if (remaining > 0) {
    // Not a crash: the rebase itself succeeded. But a row still naming the old address is
    // one this script does not know about, and finding out from a silent success later is
    // worse than being told now.
    logger.warn({ ...result, remaining }, 'Gig origin rebase complete, but rows still name the old origin')
  } else {
    logger.info({ ...result }, 'Gig origin rebase complete; nothing names the old origin')
  }
  process.exit(0)
} catch (e) {
  logger.error(e, 'Gig origin rebase failed')
  process.exit(1)
}
