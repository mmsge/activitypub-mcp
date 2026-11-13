// Refine every stored film and TV item with English metadata from TMDB (ADR 0076), at
// once rather than 200 a sync pass. Reads the stored rows and asks TMDB only, never
// NeoDB (ADR 0077). Needs TMDB_API_TOKEN. Safe to re-run.
//
//   npm run refine-tmdb
//   DRY_RUN=1 npm run refine-tmdb   # count what is owed, change nothing
import { refineOwedItems } from '../src/jobs/refine-tmdb.js'
import { logger } from '../src/lib/logger.js'

const dryRun = ['1', 'true', 'yes', 'on'].includes((process.env.DRY_RUN ?? '').trim().toLowerCase())

try {
  const result = await refineOwedItems({ dryRun })
  if (!result.enabled) logger.warn('TMDB_API_TOKEN is blank: the refiner is off. Set it in /srv/bot/.env.')
  logger.info(result, dryRun ? 'TMDB refine (dry run): nothing was written' : 'TMDB refine complete')
  process.exit(0)
} catch (e) {
  logger.error(e, 'TMDB refine failed')
  process.exit(1)
}
