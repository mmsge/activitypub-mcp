import { describe, it, expect } from 'vitest'
import { mapNeodbItem } from './fetch-neodb-item.js'

const ITEM_URL = 'https://minreol.dk/tv/season/2mHcVZbJprJFqdIYBwnjTU'

// Trimmed real NeoDB catalog payload for the "Conflict"/"Konflikt" TV season.
const CONFLICT = {
  id: ITEM_URL,
  type: 'TVSeason',
  uuid: '2mHcVZbJprJFqdIYBwnjTU',
  category: 'tv',
  parent_uuid: '7ZBWspAdRYt907IlI3uUiC',
  display_title: 'Konflikt',
  external_resources: [{ url: 'https://www.themoviedb.org/tv/240253/season/1' }],
  title: 'Konflikt',
  description: 'Midsommarfirandet i den finska skärgården är i full gång.',
  cover_image_url: 'https://minreol.dk/m/item/tmdb_tvseason/2026/07/23/x.jpg',
  rating: null,
  brief: 'Midsommarfirandet i den finska skärgården är i full gång.',
  season_number: 1,
  orig_title: '',
  director: [],
  actor: [],
  genre: [],
  language: [],
  area: [],
  year: null,
  episode_count: 6,
  imdb: 'tt27579939',
}

describe('mapNeodbItem — NeoDB catalog JSON → metadata', () => {
  it('maps the Conflict TV season, deriving the IMDb URL from the bare id', () => {
    const m = mapNeodbItem(ITEM_URL, CONFLICT)
    expect(m).toMatchObject({
      itemUrl: ITEM_URL,
      category: 'tv',
      itemType: 'TVSeason',
      title: 'Konflikt',
      displayTitle: 'Konflikt',
      seasonNumber: 1,
      episodeCount: 6,
      imdb: 'tt27579939',
      imdbUrl: 'https://www.imdb.com/title/tt27579939/',
      tmdbUrl: 'https://www.themoviedb.org/tv/240253/season/1',
      parentUuid: '7ZBWspAdRYt907IlI3uUiC',
    })
    expect(m.externalResources).toEqual([{ url: 'https://www.themoviedb.org/tv/240253/season/1' }])
  })

  it('falls back to `brief` for description and empties arrays/blank strings to null', () => {
    const m = mapNeodbItem(ITEM_URL, { ...CONFLICT, description: undefined })
    expect(m.description).toBe(CONFLICT.brief)
    // empty arrays and "" collapse to null, not [] / ""
    expect(m.genre).toBeNull()
    expect(m.director).toBeNull()
    expect(m.origTitle).toBeNull()
    expect(m.year).toBeNull()
    expect(m.rating).toBeNull()
  })

  it('recovers the IMDb id from an external resource when `imdb` is absent', () => {
    const { imdb: _omit, ...noImdb } = CONFLICT
    const m = mapNeodbItem(ITEM_URL, {
      ...noImdb,
      external_resources: [{ url: 'https://www.imdb.com/title/tt99998888/' }],
    })
    expect(m.imdb).toBe('tt99998888')
    expect(m.imdbUrl).toBe('https://www.imdb.com/title/tt99998888/')
  })

  it('keeps real string-array fields and coerces numeric fields', () => {
    const m = mapNeodbItem(ITEM_URL, {
      ...CONFLICT,
      genre: ['Drama', 'Thriller'],
      language: ['Swedish'],
      year: '2024',
      rating: '7.4',
    })
    expect(m.genre).toEqual(['Drama', 'Thriller'])
    expect(m.language).toEqual(['Swedish'])
    expect(m.year).toBe(2024)
    expect(m.rating).toBe(7.4)
  })
})
