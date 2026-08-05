// Geocode the stations, then fetch the weather at them for the days Markus was
// there. Idempotent: already-geocoded stations are skipped and already-stored days
// are not refetched, so re-running only picks up what is missing.
//
// Both passes take a bounded bite per run — Nominatim allows one request a second,
// and there are 115 stations — so the first full backfill wants a few runs. Repeat
// until `pending` reaches 0.
//
//   npm run sync-weather
import { syncStations } from '../src/jobs/sync-stations.js'
import { syncStationWeather } from '../src/jobs/sync-station-weather.js'
import { logger } from '../src/lib/logger.js'

try {
  const stations = await syncStations()
  const weather = await syncStationWeather()
  logger.info({ stations, weather }, 'Weather sync complete')
  if (stations.pending > 0 || weather.pending > 0) {
    console.log(
      `Not finished: ${stations.pending} station(s) still need coordinates, ` +
      `${weather.pending} (station, date) pair(s) still need weather. Run again.`,
    )
  } else {
    console.log('Everything geocoded and every travel day has its weather.')
  }
  if (weather.tooRecent > 0) {
    console.log(`${weather.tooRecent} day(s) are still inside the ERA5 archive lag; they arrive in about a week.`)
  }
  process.exit(0)
} catch (e) {
  logger.error(e, 'Weather sync failed')
  process.exit(1)
}
