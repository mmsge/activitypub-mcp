import { describe, it, expect } from 'vitest'
import { weatherLabel, weatherSummary } from './weather-code.js'
import { countryForTimezone, parseNominatim } from './geocode-station.js'
import { parseArchive, isoDate, latestArchivedDate, ARCHIVE_LAG_DAYS } from './fetch-weather.js'

describe('weatherLabel', () => {
  it('names the conditions a Norwegian rail year actually produces', () => {
    expect(weatherLabel(0)?.text).toBe('klårvêr')
    expect(weatherLabel(3)?.text).toBe('overskya')
    expect(weatherLabel(63)?.text).toBe('regn')
    expect(weatherLabel(73)?.text).toBe('snø')
    expect(weatherLabel(45)?.text).toBe('skodde')
  })

  it('groups the intensities of one condition under one word', () => {
    // 51/53/55 are three grades of drizzle; at the resolution anyone reads this,
    // they are all "yr".
    expect(weatherLabel(51)).toBe(weatherLabel(53))
    expect(weatherLabel(53)).toBe(weatherLabel(55))
  })

  it('returns null for a code it does not know, rather than guessing', () => {
    // WMO defines codes this table deliberately does not cover. A wrong label on a
    // page is worse than no label.
    expect(weatherLabel(4)).toBeNull()
    expect(weatherLabel(999)).toBeNull()
    expect(weatherLabel(null)).toBeNull()
    expect(weatherLabel(undefined)).toBeNull()
    expect(weatherLabel(NaN)).toBeNull()
  })
})

describe('weatherSummary', () => {
  it('reads as one line', () => {
    expect(weatherSummary(63, 12.4)).toBe('🌧️ regn · 12°')
  })

  it('rounds to a whole degree — ERA5 is a 25 km reanalysis, not a thermometer', () => {
    expect(weatherSummary(0, 12.6)).toBe('☀️ klårvêr · 13°')
    expect(weatherSummary(0, -3.4)).toBe('☀️ klårvêr · -3°')
  })

  it('keeps whichever half it has', () => {
    expect(weatherSummary(73, null)).toBe('🌨️ snø')
    expect(weatherSummary(null, 8)).toBe('8°')
    expect(weatherSummary(4, 8)).toBe('8°')
  })

  it('is null when it knows nothing', () => {
    expect(weatherSummary(null, null)).toBeNull()
    expect(weatherSummary(undefined, undefined)).toBeNull()
  })

  it('does not lose a genuine zero degrees', () => {
    // 0°C is a real reading on these trips, and must not fall to the null branch.
    expect(weatherSummary(73, 0)).toBe('🌨️ snø · 0°')
  })
})

describe('countryForTimezone', () => {
  it('maps the zones the trips actually carry', () => {
    expect(countryForTimezone('Europe/Oslo')).toBe('no')
    expect(countryForTimezone('Europe/Stockholm')).toBe('se')
    expect(countryForTimezone('Europe/Copenhagen')).toBe('dk')
    expect(countryForTimezone('Europe/London')).toBe('gb')
  })

  it('treats UTC as unknown, not as a country', () => {
    // 'UTC' is parse-trips-csv's fallback when the export carried no zone. Biasing
    // a search on it would be inventing information.
    expect(countryForTimezone('UTC')).toBeNull()
  })

  it('falls back to an unqualified search for anything unmapped', () => {
    expect(countryForTimezone('America/New_York')).toBeNull()
    expect(countryForTimezone(null)).toBeNull()
    expect(countryForTimezone(undefined)).toBeNull()
    expect(countryForTimezone('')).toBeNull()
  })
})

describe('parseNominatim', () => {
  const hit = (over: Record<string, unknown> = {}) => [{
    lat: '60.3894', lon: '5.3327',
    display_name: 'Bergen stasjon, Bergen, Vestland, Noreg',
    address: { country_code: 'NO' },
    ...over,
  }]

  it('takes the first usable result', () => {
    expect(parseNominatim(hit())).toEqual({
      latitude: 60.3894,
      longitude: 5.3327,
      displayName: 'Bergen stasjon, Bergen, Vestland, Noreg',
      countryCode: 'no',
    })
  })

  it('never lets an absent coordinate coerce to Null Island', () => {
    expect(parseNominatim(hit({ lat: '', lon: '' }))).toBeNull()
    expect(parseNominatim(hit({ lat: null, lon: null }))).toBeNull()
    expect(parseNominatim(hit({ lat: '  ', lon: '5' }))).toBeNull()
  })

  it('rejects out-of-range coordinates', () => {
    expect(parseNominatim(hit({ lat: '120' }))).toBeNull()
    expect(parseNominatim(hit({ lon: '-200' }))).toBeNull()
  })

  it('skips a bad result to reach a good one', () => {
    expect(parseNominatim([{ lat: 'x', lon: 'y' }, ...hit()])?.latitude).toBe(60.3894)
  })

  it('tolerates a missing display name and address', () => {
    const out = parseNominatim([{ lat: '1', lon: '2' }])
    expect(out).toEqual({ latitude: 1, longitude: 2, displayName: '', countryCode: null })
  })

  it('tolerates junk', () => {
    expect(parseNominatim(null)).toBeNull()
    expect(parseNominatim({})).toBeNull()
    expect(parseNominatim([])).toBeNull()
    expect(parseNominatim(['nonsense', null])).toBeNull()
  })
})

describe('parseArchive', () => {
  const daily = (over: Record<string, unknown> = {}) => ({
    daily: {
      time: ['2026-06-05', '2026-06-06'],
      weather_code: [61, 0],
      temperature_2m_max: [12.4, 18.1],
      temperature_2m_min: [7.2, 9.9],
      temperature_2m_mean: [9.6, 13.4],
      precipitation_sum: [4.2, 0],
      snowfall_sum: [0, 0],
      wind_speed_10m_max: [22.3, 9.1],
      ...over,
    },
  })

  it('pairs the parallel arrays into one record per day', () => {
    const out = parseArchive(daily())
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      date: '2026-06-05', weatherCode: 61, tempMaxC: 12.4, tempMinC: 7.2,
      tempMeanC: 9.6, precipitationMm: 4.2, snowfallCm: 0, windMaxKmh: 22.3,
    })
  })

  it('keeps a genuine zero rather than nulling it', () => {
    // 0 mm of rain and 0°C are observations. Treating them as absent would make a
    // dry day indistinguishable from a day with no data.
    const out = parseArchive(daily())
    expect(out[1].precipitationMm).toBe(0)
    expect(out[0].snowfallCm).toBe(0)
  })

  it('drops a day the archive has nothing at all for', () => {
    const out = parseArchive(daily({
      weather_code: [61, null], temperature_2m_max: [12.4, null],
      temperature_2m_min: [7.2, null], temperature_2m_mean: [9.6, null],
      precipitation_sum: [4.2, null], snowfall_sum: [0, null],
      wind_speed_10m_max: [22.3, null],
    }))
    expect(out).toHaveLength(1)
    expect(out[0].date).toBe('2026-06-05')
  })

  it('truncates rather than mispairing when a column is short', () => {
    // A short array must never pair one date with another day's temperature.
    const out = parseArchive(daily({ temperature_2m_max: [12.4] }))
    expect(out).toHaveLength(2)
    expect(out[0].tempMaxC).toBe(12.4)
    expect(out[1].tempMaxC).toBeNull()
  })

  it('tolerates junk', () => {
    expect(parseArchive(null)).toEqual([])
    expect(parseArchive({})).toEqual([])
    expect(parseArchive({ daily: null })).toEqual([])
    expect(parseArchive({ daily: { time: 'nope' } })).toEqual([])
  })
})

describe('the archive horizon', () => {
  it('formats a date the API accepts', () => {
    expect(isoDate(new Date('2026-06-05T22:00:00Z'))).toBe('2026-06-05')
  })

  it('stays the documented lag behind now', () => {
    // ERA5 is a reanalysis, not a live feed. Asking for yesterday returns nulls,
    // so the job must not store them as if they were observations.
    const now = new Date('2026-08-05T12:00:00Z')
    expect(latestArchivedDate(now)).toBe('2026-07-29')
    expect(ARCHIVE_LAG_DAYS).toBe(7)
  })
})
