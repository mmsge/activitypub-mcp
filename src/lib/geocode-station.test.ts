import { describe, it, expect } from 'vitest'
import {
  chooseStationHit, offsetAgrees, parseNominatim, parseNominatimHits, timezoneForCountry,
  type GeocodeHit,
} from './geocode-station.js'

describe('timezoneForCountry', () => {
  it('maps the countries the trips reach to the zone their clocks keep', () => {
    expect(timezoneForCountry('no')).toBe('Europe/Oslo')
    expect(timezoneForCountry('se')).toBe('Europe/Stockholm')
    expect(timezoneForCountry('cz')).toBe('Europe/Prague')
    expect(timezoneForCountry('gb')).toBe('Europe/London')
  })

  it('is case-insensitive, because Nominatim and hand-pinned rows disagree on case', () => {
    expect(timezoneForCountry('NO')).toBe('Europe/Oslo')
  })

  it('leaves an unmapped or missing country without a zone rather than guessing', () => {
    expect(timezoneForCountry('us')).toBeNull()
    expect(timezoneForCountry(null)).toBeNull()
    expect(timezoneForCountry(undefined)).toBeNull()
    expect(timezoneForCountry('')).toBeNull()
  })
})

describe('offsetAgrees', () => {
  // viaduct.world writes Europe/Paris for every CET station. That must accept
  // Norway, Sweden and Czechia — it was rejecting nothing and selecting France.
  it('accepts every country on the same clock as the leg', () => {
    expect(offsetAgrees('Europe/Paris', 'no')).toBe(true)
    expect(offsetAgrees('Europe/Paris', 'se')).toBe(true)
    expect(offsetAgrees('Europe/Paris', 'cz')).toBe(true)
    expect(offsetAgrees('Europe/Paris', 'fr')).toBe(true)
  })

  it('refuses a country whose clock differs from the leg', () => {
    expect(offsetAgrees('Europe/Paris', 'gb')).toBe(false)
    expect(offsetAgrees('Europe/London', 'no')).toBe(false)
    expect(offsetAgrees('Europe/Paris', 'fi')).toBe(false)
  })

  it('treats UTC as unknown, not as the UK', () => {
    // 'UTC' is parse-trips-csv's fallback when the export carried no zone.
    expect(offsetAgrees('UTC', 'no')).toBe(true)
    expect(offsetAgrees('UTC', 'gb')).toBe(true)
  })

  it('accepts when either side is unknown or unreadable', () => {
    expect(offsetAgrees(null, 'no')).toBe(true)
    expect(offsetAgrees(undefined, 'no')).toBe(true)
    expect(offsetAgrees('Europe/Paris', null)).toBe(true)
    expect(offsetAgrees('Europe/Paris', 'us')).toBe(true)
    expect(offsetAgrees('Not/AZone', 'no')).toBe(true)
  })
})

describe('parseNominatim', () => {
  const hit = (over: Record<string, unknown> = {}) => [{
    lat: '60.3894', lon: '5.3327',
    display_name: 'Bergen stasjon, Bergen, Vestland, Noreg',
    category: 'railway', type: 'station',
    address: { country_code: 'NO' },
    ...over,
  }]

  it('takes the first usable result', () => {
    expect(parseNominatim(hit())).toEqual({
      latitude: 60.3894,
      longitude: 5.3327,
      displayName: 'Bergen stasjon, Bergen, Vestland, Noreg',
      countryCode: 'no',
      isStation: true,
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

  it('tolerates a missing display name, address and tags', () => {
    const out = parseNominatim([{ lat: '1', lon: '2' }])
    expect(out).toEqual({ latitude: 1, longitude: 2, displayName: '', countryCode: null, isStation: false })
  })

  it('tolerates junk', () => {
    expect(parseNominatim(null)).toBeNull()
    expect(parseNominatim({})).toBeNull()
    expect(parseNominatim([])).toBeNull()
    expect(parseNominatim(['nonsense', null])).toBeNull()
  })
})

describe('parseNominatimHits', () => {
  const tagged = (category: string, type: string) =>
    parseNominatimHits([{ lat: '1', lon: '2', category, type }])[0]?.isStation

  it('keeps every usable hit, in order', () => {
    const hits = parseNominatimHits([
      { lat: '60.39', lon: '5.33', address: { country_code: 'no' } },
      { lat: 'x', lon: 'y' },
      { lat: '50.45', lon: '3.95', address: { country_code: 'be' } },
    ])
    expect(hits.map((h) => h.countryCode)).toEqual(['no', 'be'])
  })

  it('knows a railway station from a town, a platform or a tram stop', () => {
    expect(tagged('railway', 'station')).toBe(true)
    expect(tagged('railway', 'halt')).toBe(true)
    expect(tagged('building', 'train_station')).toBe(true)
    expect(tagged('public_transport', 'station')).toBe(true)
    expect(tagged('boundary', 'administrative')).toBe(false)
    expect(tagged('railway', 'platform')).toBe(false)
    expect(tagged('railway', 'tram_stop')).toBe(false)
    expect(tagged('highway', 'bus_stop')).toBe(false)
  })
})

describe('chooseStationHit', () => {
  const h = (countryCode: string, isStation: boolean, displayName = countryCode): GeocodeHit =>
    ({ latitude: 1, longitude: 2, displayName, countryCode, isStation })

  it('takes the bare name outright when it lands on a station', () => {
    // Oslo S, Malmö C, Göteborgs central: Nominatim finds the station unaided.
    const oslo = h('no', true, 'Oslo S')
    expect(chooseStationHit([oslo], [])).toBe(oslo)
  })

  it('uses the bare name\'s country to pick between same-named stations', () => {
    // Searched as "Bergen station", Nominatim ranks Mons first — Bergen is its
    // Dutch name. The bare "Bergen" says Norway, and that decides it.
    const plain = [h('no', false, 'Bergen, Vestland'), h('be', false, 'Mons')]
    const station = [h('be', true, 'Mons'), h('no', true, 'Bergen stasjon'), h('us', true, 'Bergen Street')]
    expect(chooseStationHit(plain, station)?.displayName).toBe('Bergen stasjon')
  })

  it('finds the station behind a misleading bare name in the same country', () => {
    // Bare "Paris Nord" is a hamlet in Haute-Garonne; as a station it is Gare du Nord.
    const plain = [h('fr', false, 'Paris-Nord, Haute-Garonne')]
    const station = [h('fr', true, 'Paris Gare du Nord')]
    expect(chooseStationHit(plain, station)?.displayName).toBe('Paris Gare du Nord')
  })

  it('keeps the town over a station in another country', () => {
    const plain = [h('no', false, 'Ål')]
    const station = [h('al', true, 'somewhere in Albania')]
    expect(chooseStationHit(plain, station)?.displayName).toBe('Ål')
  })

  it('ignores non-station hits in the station search', () => {
    const plain = [h('no', false, 'Ål')]
    const station = [h('no', false, 'Ål, a village')]
    expect(chooseStationHit(plain, station)?.displayName).toBe('Ål')
  })

  it('falls back to the first station when the bare name finds nothing', () => {
    const station = [h('se', false, 'a street'), h('se', true, 'Lund C')]
    expect(chooseStationHit([], station)?.displayName).toBe('Lund C')
  })

  it('returns null when neither search found anything', () => {
    expect(chooseStationHit([], [])).toBeNull()
  })
})
