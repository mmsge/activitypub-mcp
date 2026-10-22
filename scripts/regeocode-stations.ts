// Geocode the stations again and repair the ones the old timezone-as-country
// filter put in the wrong place (ADR 0065). Manual rows are left alone.
//
// Look first, then write:
//
//   npm run regeocode-stations -- --dry-run
//   npm run regeocode-stations
//   npm run regeocode-stations -- --station "Paris Nord" --station Bergen
//
// One Nominatim request a second, up to two per station, so the whole set takes a
// few minutes. Stations that moved lose their stored weather; `npm run sync-weather`
// (or the six-hourly scheduler) fetches it again for the new coordinates.
import { regeocodeStations, type RegeocodeChange } from '../src/jobs/regeocode-stations.js'
import { logger } from '../src/lib/logger.js'

function parseArgs(argv: string[]): { dryRun: boolean; names: string[] } {
  const names: string[] = []
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') dryRun = true
    else if (a === '--station') names.push(argv[++i] ?? '')
    else if (a.startsWith('--station=')) names.push(a.slice('--station='.length))
    else throw new Error(`Unknown argument: ${a}`)
  }
  return { dryRun, names: names.filter(Boolean) }
}

const fmt = (lat: number | null, lon: number | null) =>
  lat == null || lon == null ? '—' : `${lat.toFixed(4)},${lon.toFixed(4)}`

function line(c: RegeocodeChange): string {
  const was = `${fmt(c.before.latitude, c.before.longitude)} ${c.before.countryCode ?? '??'}`
  if (!c.after) return `  MISS   ${c.name}: kept ${was}`
  const now = `${fmt(c.after.latitude, c.after.longitude)} ${c.after.countryCode ?? '??'}`
  const km = c.movedKm == null ? 'new' : `${c.movedKm.toFixed(0)} km`
  return `  ${km.padStart(8)}  ${c.name}: ${was} → ${now}  (${c.after.displayName.slice(0, 60)})`
}

try {
  const { dryRun, names } = parseArgs(process.argv.slice(2))
  const result = await regeocodeStations({ dryRun, names })

  for (const c of result.changes) console.log(line(c))
  console.log(
    `${dryRun ? '[dry run] ' : ''}${result.considered} station(s): ${result.moved} moved, `
    + `${result.unchanged} unchanged, ${result.missed} missed.`,
  )
  if (!dryRun) {
    console.log(
      `${result.weatherDropped} weather row(s) dropped for refetch; `
      + `${result.manualZoned} manual station(s) given a timezone.`,
    )
    if (result.weatherDropped > 0) console.log('Run `npm run sync-weather` until it reports nothing pending.')
  }
  if (result.missed > 0) {
    console.log('A missed station kept its old coordinates. Pin it by hand with source = \'manual\' if it is wrong.')
  }
  process.exit(0)
} catch (e) {
  logger.error(e, 'Station re-geocode failed')
  process.exit(1)
}
