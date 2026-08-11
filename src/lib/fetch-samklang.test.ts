import { describe, it, expect } from 'vitest'
import {
  extractMusicEventJsonLd,
  mapArtist,
  mapConcertEvent,
  mapVenue,
  mergeJsonLd,
} from './fetch-samklang.js'

const CONCERT = 'https://samklang.msge.no/konsert/01KZPXDDJ4196FCHF4TQ24HKGW'

// The ActivityPub Event as the origin serves it once Gigowl's ADR 0026 is deployed.
const EVENT_WITH_EXTRAS = {
  '@context': ['https://www.w3.org/ns/activitystreams', { samklang: 'https://samklang.msge.no/ns#' }],
  id: CONCERT,
  type: 'Event',
  name: 'Synne Sørgjerd, Bergen kulturhus, Bergen, 2026-01-10',
  startTime: '2026-01-10T18:00:00Z',
  summary: 'Synne Sørgjerd (headliner)',
  location: { id: 'https://samklang.msge.no/stad/STAD', type: 'Place', name: 'Bergen kulturhus' },
  tag: 'https://samklang.msge.no/artist/A1',
  url: CONCERT,
  'samklang:date': '2026-01-10',
  'samklang:concertStatus': 'completed',
  'samklang:notes': 'Hovedsalen.',
  'samklang:tourName': 'Ei ferd',
  'samklang:venue': {
    id: 'https://samklang.msge.no/stad/STAD',
    name: 'Bergen kulturhus',
    city: 'Bergen',
    country: 'NO',
    timezone: 'Europe/Oslo',
  },
  'samklang:lineup': [
    { artist: 'https://samklang.msge.no/artist/A1', name: 'Synne Sørgjerd', role: 'headliner', position: 0 },
  ],
  'samklang:setlist': [
    {
      id: 'https://samklang.msge.no/setliste/S1',
      artist: 'https://samklang.msge.no/artist/A1',
      entries: [
        { position: 0, setNumber: 1, isEncore: false, songTitle: 'Sjalu', isCover: false },
        { position: 0, setNumber: 2, isEncore: true, songTitle: 'Sail On', isCover: true, coverOfArtist: 'The Beach Boys' },
      ],
    },
  ],
} as Record<string, unknown>

// The live shape of the same endpoint BEFORE that deploy, captured 2026-08-11. Thin: no
// date field of its own, no roles, no city, no setlist, and `tag` as a bare string.
const EVENT_WITHOUT_EXTRAS = {
  '@context': ['https://www.w3.org/ns/activitystreams'],
  id: CONCERT,
  type: 'Event',
  location: { id: 'https://samklang.msge.no/stad/STAD', type: 'Place', name: 'Bergen kulturhus' },
  name: 'Synne Sørgjerd, Bergen kulturhus, Bergen, 2026-01-10',
  startTime: '2026-01-10T18:00:00Z',
  summary: 'Synne Sørgjerd (headliner)',
  tag: 'https://samklang.msge.no/artist/A1',
  url: CONCERT,
} as Record<string, unknown>

// The schema.org block from the same concert's HTML page, captured 2026-08-11.
const MUSIC_EVENT_JSONLD = {
  '@context': 'https://schema.org',
  '@type': 'MusicEvent',
  '@id': CONCERT,
  url: CONCERT,
  name: 'Synne Sørgjerd, Bergen kulturhus, Bergen, 2026-01-10',
  startDate: '2026-01-10T19:00:00',
  eventStatus: 'https://schema.org/EventScheduled',
  location: {
    '@type': 'Place',
    '@id': 'https://samklang.msge.no/stad/STAD',
    name: 'Bergen kulturhus',
    address: { '@type': 'PostalAddress', addressLocality: 'Bergen', addressCountry: 'NO' },
  },
  performer: [
    { '@type': 'Person', '@id': 'https://samklang.msge.no/artist/A1', name: 'Synne Sørgjerd' },
  ],
  description: 'Hovedsalen.',
} as Record<string, unknown>

describe('mapConcertEvent', () => {
  it('reads the structured extras and marks them as coming from ActivityPub', () => {
    const meta = mapConcertEvent(CONCERT, EVENT_WITH_EXTRAS)
    expect(meta.gigDate).toBe('2026-01-10')
    expect(meta.concertStatus).toBe('completed')
    expect(meta.tourName).toBe('Ei ferd')
    expect(meta.notes).toBe('Hovedsalen.')
    expect(meta.venueCity).toBe('Bergen')
    expect(meta.venueCountry).toBe('NO')
    expect(meta.lineup).toEqual([
      { artistUrl: 'https://samklang.msge.no/artist/A1', name: 'Synne Sørgjerd', role: 'headliner', position: 0 },
    ])
    expect(meta.artistNames).toEqual(['Synne Sørgjerd'])
    expect(meta.sourceMap.gigDate).toBe('samklang-ap')
    expect(meta.sourceMap.concertStatus).toBe('samklang-ap')
  })

  it('keeps the setlist, its encore flag and its cover attribution', () => {
    const meta = mapConcertEvent(CONCERT, EVENT_WITH_EXTRAS)
    expect(meta.songCount).toBe(2)
    expect(meta.setlists[0]!.entries[1]).toMatchObject({
      songTitle: 'Sail On',
      isEncore: true,
      isCover: true,
      coverOfArtist: 'The Beach Boys',
    })
  })

  it('accepts tag as a bare string and as an array', () => {
    // The live trap: one artist yields a string, several yield an array. Reading only
    // the array shape works for every festival and fails for every solo show.
    expect(mapConcertEvent(CONCERT, EVENT_WITH_EXTRAS).details.artistUris).toEqual([
      'https://samklang.msge.no/artist/A1',
    ])
    const many = mapConcertEvent(CONCERT, {
      ...EVENT_WITH_EXTRAS,
      tag: ['https://samklang.msge.no/artist/A1', 'https://samklang.msge.no/artist/A2'],
    })
    expect(many.details.artistUris).toHaveLength(2)
  })

  it('falls back to the startTime instant for the date when the origin serves no extras', () => {
    const meta = mapConcertEvent(CONCERT, EVENT_WITHOUT_EXTRAS)
    expect(meta.gigDate).toBe('2026-01-10')
    expect(meta.lineup).toEqual([])
    expect(meta.concertStatus).toBeNull()
    expect(meta.setlists).toEqual([])
  })

  it('leaves the date null when there is neither an extra nor a start time', () => {
    // Most of a backfilled archive: the origin omits startTime entirely unless the venue
    // has a zone AND the concert a start time. Enrichment must not invent one.
    const meta = mapConcertEvent(CONCERT, { ...EVENT_WITHOUT_EXTRAS, startTime: undefined })
    expect(meta.gigDate).toBeNull()
    expect(meta.startAt).toBeNull()
  })

  it('never parses the summary prose for the line-up, but keeps it as provenance', () => {
    const meta = mapConcertEvent(CONCERT, EVENT_WITHOUT_EXTRAS)
    expect(meta.details.summary).toBe('Synne Sørgjerd (headliner)')
    expect(meta.artistNames).toEqual([])
  })
})

describe('mergeJsonLd', () => {
  it('fills only the gaps, and records that it did', () => {
    const thin = mapConcertEvent(CONCERT, EVENT_WITHOUT_EXTRAS)
    const merged = mergeJsonLd(thin, MUSIC_EVENT_JSONLD)

    expect(merged.venueCity).toBe('Bergen')
    expect(merged.venueCountry).toBe('NO')
    expect(merged.notes).toBe('Hovedsalen.')
    expect(merged.lineup[0]).toMatchObject({ name: 'Synne Sørgjerd', role: null })
    expect(merged.artistNames).toEqual(['Synne Sørgjerd'])
    expect(merged.sourceMap.venueCity).toBe('samklang-jsonld')
    expect(merged.sourceMap.lineup).toBe('samklang-jsonld')
    // What the AP document already said stays AP-sourced and unchanged.
    expect(merged.gigDate).toBe('2026-01-10')
    expect(merged.sourceMap.gigDate).toBe('samklang-ap')
  })

  it('never overwrites what the ActivityPub document already stated', () => {
    const rich = mapConcertEvent(CONCERT, EVENT_WITH_EXTRAS)
    const merged = mergeJsonLd(rich, MUSIC_EVENT_JSONLD)
    // 'completed' has no schema.org equivalent, so the page reports the gig as still
    // scheduled. Letting the fallback win here would mark every past gig as upcoming.
    expect(merged.concertStatus).toBe('completed')
    expect(merged.lineup[0]!.role).toBe('headliner')
    expect(merged.setlists).toHaveLength(1)
  })

  it('maps the schema.org status IRIs it can, and nothing it cannot', () => {
    const thin = mapConcertEvent(CONCERT, EVENT_WITHOUT_EXTRAS)
    const status = (iri: string) =>
      mergeJsonLd(thin, { ...MUSIC_EVENT_JSONLD, eventStatus: iri }).concertStatus
    expect(status('https://schema.org/EventCancelled')).toBe('cancelled')
    expect(status('https://schema.org/EventPostponed')).toBe('postponed')
    expect(status('https://schema.org/EventScheduled')).toBe('scheduled')
    expect(status('https://schema.org/SomethingElse')).toBeNull()
  })

  it('is a no-op when the page has no MusicEvent', () => {
    const thin = mapConcertEvent(CONCERT, EVENT_WITHOUT_EXTRAS)
    expect(mergeJsonLd(thin, null)).toEqual(thin)
  })
})

describe('extractMusicEventJsonLd', () => {
  it('picks the MusicEvent out of a page carrying several ld+json blocks', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"WebSite","name":"Gigowl"}</script>
      <script type="application/ld+json">${JSON.stringify(MUSIC_EVENT_JSONLD)}</script>
    </head></html>`
    expect(extractMusicEventJsonLd(html)?.['@id']).toBe(CONCERT)
  })

  it('survives an unparseable block rather than giving up on the page', () => {
    const html = `<script type="application/ld+json">{not json</script>
      <script type="application/ld+json">${JSON.stringify(MUSIC_EVENT_JSONLD)}</script>`
    expect(extractMusicEventJsonLd(html)?.['@type']).toBe('MusicEvent')
  })

  it('returns null when there is no event on the page', () => {
    expect(extractMusicEventJsonLd('<html><body>nothing</body></html>')).toBeNull()
    expect(
      extractMusicEventJsonLd('<script type="application/ld+json">{"@type":"WebSite"}</script>'),
    ).toBeNull()
  })
})

describe('mapArtist and mapVenue', () => {
  it('maps an artist record', () => {
    const artist = mapArtist('https://samklang.msge.no/artist/A1', {
      id: 'https://samklang.msge.no/artist/A1',
      type: 'Organization',
      name: 'Motorpsycho',
      summary: 'Norwegian band',
      'samklang:artistType': 'group',
      'samklang:mbid': '8d7d9b73',
      'samklang:country': 'NO',
      'samklang:beginYear': 1989,
    })
    expect(artist.name).toBe('Motorpsycho')
    expect(artist.artistType).toBe('group')
    expect(artist.disambiguation).toBe('Norwegian band')
    expect(artist.mbid).toBe('8d7d9b73')
    expect(artist.beginYear).toBe(1989)
    expect(artist.endYear).toBeNull()
    expect(artist.sourceMap.mbid).toBe('samklang-ap')
    expect(artist.sourceMap.endYear).toBeUndefined()
  })

  it('maps a venue record, keeping coordinates as strings for the numeric column', () => {
    const venue = mapVenue('https://samklang.msge.no/stad/STAD', {
      id: 'https://samklang.msge.no/stad/STAD',
      type: 'Place',
      name: 'Rockefeller',
      latitude: 59.9,
      longitude: 10.75,
      'samklang:city': 'Oslo',
      'samklang:country': 'NO',
      'samklang:capacity': 1350,
      'samklang:timezone': 'Europe/Oslo',
      'samklang:aka': ['Torggata 16'],
    })
    expect(venue.name).toBe('Rockefeller')
    expect(venue.city).toBe('Oslo')
    expect(venue.capacity).toBe(1350)
    expect(venue.timezone).toBe('Europe/Oslo')
    expect(venue.aka).toEqual(['Torggata 16'])
    expect(venue.latitude).toBe('59.9')
    expect(venue.isPlaceholder).toBe(false)
  })

  it('treats a placeholder venue as a stated fact, not as missing data', () => {
    const venue = mapVenue('https://samklang.msge.no/stad/TBA', {
      name: 'Ikkje kunngjort',
      'samklang:isPlaceholder': true,
    })
    expect(venue.isPlaceholder).toBe(true)
  })
})
