// Group the NeoDB catalogue into works, so a title marked on more than one instance is
// served as one row (ADR 0075). Local only; nothing is fetched. Safe to re-run: a second
// run reports `updated: 0`.
//
//   npm run backfill-work-keys
//   DRY_RUN=1 npm run backfill-work-keys   # count only, change nothing
import { backfillWorkKeys } from '../src/jobs/backfill-work-keys.js'
import { logger } from '../src/lib/logger.js'

const dryRun = ['1', 'true', 'yes', 'on'].includes((process.env.DRY_RUN ?? '').trim().toLowerCase())

try {
  const result = await backfillWorkKeys({ dryRun })
  logger.info(result, dryRun ? 'Work-key backfill (dry run): nothing was written' : 'Work-key backfill complete')
  process.exit(0)
} catch (e) {
  logger.error(e, 'Work-key backfill failed')
  process.exit(1)
}
