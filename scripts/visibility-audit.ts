// What the REST API stops serving now that it is pinned to public-only (ADR 0026).
// Read-only: counts posts per visibility class, per watched hashtag, and across the
// trip↔post join, so any shrinkage in a downstream gallery is a number you have
// seen rather than something you notice weeks later.
//
//   npm run visibility-audit
import { auditVisibility } from '../src/jobs/visibility-audit.js'
import { logger } from '../src/lib/logger.js'

try {
  const r = await auditVisibility()
  console.table(r.byVisibility)
  if (r.byTag.length > 0) console.table(r.byTag)
  console.log('trip-linked posts:', r.tripPosts)
  console.log(
    r.withheldTotal === 0
      ? 'Nothing is withheld — every stored post of yours is public, so REST returns exactly what it did before.'
      : `${r.withheldTotal} post(s) are no longer served over REST.`,
  )
  process.exit(0)
} catch (e) {
  logger.error(e, 'Visibility audit failed')
  process.exit(1)
}
