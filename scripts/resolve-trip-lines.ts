// Work out which named railway lines each trip ran on, and cache the answer.
//
// Idempotent and cheap: no external calls, no bounded bite, no rate limit. A run
// with nothing stale writes nothing; a curation change in src/lib/railway-registry.ts
// re-resolves the whole archive in one go, because the registry fingerprint every row
// carries changes at the same moment.
//
// Run it after importing trips, and after editing the registry:
//
//   npm run resolve-lines
import { resolveTripLines } from '../src/jobs/resolve-trip-lines.js'
import { logger } from '../src/lib/logger.js'

try {
  const result = await resolveTripLines()
  logger.info(result, 'Line resolution complete')

  if (result.considered === 0) {
    console.log('Nothing stale — every trip is already resolved against this registry.')
  } else {
    console.log(
      `${result.considered} trip(s) considered: ${result.resolved} resolved, `
      + `${result.ambiguous} ambiguous, ${result.unresolved} unresolved. `
      + `${result.legs} line/crossing row(s) written.`,
    )
  }
  if (result.ambiguous > 0) {
    console.log(
      `${result.ambiguous} trip(s) have two comparable routings and need an override in `
      + 'src/lib/railway-registry.ts. get_line_trips names them and says why.',
    )
  }
  if (result.scaleSuspect > 0) {
    console.log(
      `${result.scaleSuspect} trip(s) needed a scale factor outside 0.8–1.25 — the registry's `
      + 'kilometre posts and the export disagree by more than rounding explains. Worth a look.',
    )
  }
  process.exit(0)
} catch (e) {
  logger.error(e, 'Line resolution failed')
  process.exit(1)
}
