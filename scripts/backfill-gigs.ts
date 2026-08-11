// One-off: build the gig store out of attendance Notes this server already holds, then
// enrich the concerts (and their venues and artists) they reference. Local-first and
// idempotent; nothing is re-federated and the origin is only asked about a concert we
// have no clean record for. Forces the run regardless of the server_config marker the
// startup auto-run sets.
//
//   npm run backfill-gigs
import { backfillGigs } from '../src/jobs/backfill-gigs.js'
import { logger } from '../src/lib/logger.js'

try {
  const result = await backfillGigs({ force: true })
  logger.info({ ...result }, 'Gig backfill (forced) complete')
  process.exit(0)
} catch (e) {
  logger.error(e, 'Gig backfill failed')
  process.exit(1)
}
