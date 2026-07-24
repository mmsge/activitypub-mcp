// One-off: (re)populate the NeoDB mark store (neodb_marks) from already-stored activities
// and each mark-actor's live outbox. Safe to re-run — every write is idempotent. Forces the
// run regardless of the server_config marker the startup auto-run sets.
//
//   npm run backfill-neodb-marks
import { backfillNeodbMarks } from '../src/jobs/backfill-neodb-marks.js'
import { logger } from '../src/lib/logger.js'

try {
  await backfillNeodbMarks({ force: true })
  logger.info('NeoDB marks backfill (forced) complete')
  process.exit(0)
} catch (e) {
  logger.error(e, 'NeoDB marks backfill failed')
  process.exit(1)
}
