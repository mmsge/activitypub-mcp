// One-off: rebuild everything stored NeoDB marks should have produced — post text,
// neodb_marks rows, and the catalog_metadata entries get_watched reads. Local-first and
// idempotent; nothing is re-marked on NeoDB and no post is re-federated. Forces the run
// regardless of the server_config marker the startup auto-run sets.
//
//   npm run repair-neodb-ingest
import { repairNeodbIngest } from '../src/jobs/repair-neodb-ingest.js'
import { logger } from '../src/lib/logger.js'

try {
  const result = await repairNeodbIngest({ force: true })
  logger.info({ ...result }, 'NeoDB ingest repair (forced) complete')
  process.exit(0)
} catch (e) {
  logger.error(e, 'NeoDB ingest repair failed')
  process.exit(1)
}
