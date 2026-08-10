// Clear every automatically geocoded station so the corrected geocoder redoes the
// work, and drop the weather that was fetched at those (possibly wrong) places.
// Hand-corrected rows (source = 'manual') are left alone.
//
// Run once after deploying the fix in ADR 0034, then `npm run sync-weather`
// repeatedly until nothing is pending.
//
//   npm run reset-geocodes
import { resetGeocodes } from '../src/jobs/reset-geocodes.js'
import { logger } from '../src/lib/logger.js'

try {
  const r = await resetGeocodes()
  logger.info({ ...r }, 'Geocode reset complete')
  console.log(
    `Cleared ${r.cleared} station(s) and dropped ${r.weatherDropped} weather row(s). ` +
    `${r.manualKept} hand-corrected station(s) kept.\n` +
    'Now run `npm run sync-weather` repeatedly until it reports nothing pending.',
  )
  process.exit(0)
} catch (e) {
  logger.error(e, 'Geocode reset failed')
  process.exit(1)
}
