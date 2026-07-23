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

  it('records source_map = neodb for every populated field', () => {
    const m = mapNeodbItem(ITEM_URL, CONFLICT)
    expect(m.sourceMap.title).toBe('neodb')
    expect(m.sourceMap.imdb).toBe('neodb')
    expect(m.sourceMap.episode_count).toBe('neodb')
    // Empty arrays / blank strings must not appear in the provenance map.
    expect(m.sourceMap.genre).toBeUndefined()
    expect(m.sourceMap.year).toBeUndefined()
  })
})

// --- Non-film categories (real minreol.dk AP payload shapes) -----------------

describe('mapNeodbItem — non-film categories map to details', () => {
  it('maps a book (Edition): author/isbn/pages/publisher in details, year from pub_year', () => {
    const url = 'https://minreol.dk/book/6wVnEgPerssEOqlD8hvlLg'
    const m = mapNeodbItem(url, {
      id: url, type: 'Edition', category: 'book',
      title: 'Eventyret om ringen', display_title: 'Eventyret om ringen',
      author: ['J.R.R. Tolkien', 'Ida Nyrop Ludvigsen'], translator: [],
      isbn: '9788701010320', pages: 459, pub_house: 'Gyldendals Bogklub',
      pub_year: 1988, pub_month: 1, binding: 'Paperback', language: ['Danish'],
      cover_image_url: 'https://minreol.dk/m/x.jpg', brief: 'One Ring…',
    })
    expect(m.category).toBe('book')
    expect(m.itemType).toBe('Edition')
    expect(m.details).toMatchObject({
      author: ['J.R.R. Tolkien', 'Ida Nyrop Ludvigsen'],
      isbn: '9788701010320',
      pages: 459,
      publisher: 'Gyldendals Bogklub',
      pub_year: 1988,
      binding: 'Paperback',
    })
    expect(m.isbn).toBe('9788701010320') // pulled up for the BookWyrm dedup join
    expect(m.year).toBe(1988) // derived from pub_year (books carry no `year`)
    expect(m.description).toBe('One Ring…')
    // Film-only columns stay null for a book.
    expect(m.imdb).toBeNull()
    expect(m.director).toBeNull()
    expect(m.sourceMap.author).toBe('neodb')
    expect(m.sourceMap.isbn).toBe('neodb')
  })

  it('maps music (Album): artist/release_date/track_count/barcode in details', () => {
    const url = 'https://minreol.dk/album/5rx2ZPSzDRVkt7xBoKIp9B'
    const m = mapNeodbItem(url, {
      id: url, type: 'Album', category: 'music',
      title: 'Abbey Road (Remastered)', display_title: 'Abbey Road (Remastered)',
      artist: ['The Beatles'], genre: ['Rock'], company: [], barcode: null,
      release_date: '1969-09-26',
      track_list: '1. Come Together\n2. Something\n3. Maxwell\'s Silver Hammer',
      cover_image_url: 'https://minreol.dk/m/x.jpg',
    })
    expect(m.category).toBe('music')
    expect(m.details).toMatchObject({
      artist: ['The Beatles'],
      release_date: '1969-09-26',
      track_count: 3,
    })
    expect(m.details.barcode).toBeUndefined() // null → omitted
    expect(m.genre).toEqual(['Rock'])
    expect(m.year).toBe(1969) // from release_date
  })

  it('maps a game: publisher/platform/release_date in details, empty developer omitted', () => {
    const url = 'https://minreol.dk/game/2ef2Lw5VTxZ0DTjSqdKLus'
    const m = mapNeodbItem(url, {
      id: url, type: 'Game', category: 'game',
      title: 'The Legend of Zelda: Echoes of Wisdom',
      developer: [], publisher: ['Nintendo'], platform: ['Nintendo Switch'],
      genre: ['Adventure', 'Action'], release_date: '2024-09-26',
    })
    expect(m.category).toBe('game')
    expect(m.details).toMatchObject({
      publisher: ['Nintendo'],
      platform: ['Nintendo Switch'],
      release_date: '2024-09-26',
    })
    expect(m.details.developer).toBeUndefined() // empty array → omitted
    expect(m.year).toBe(2024)
  })

  it('maps a podcast: host + feed_url derived from external resources', () => {
    const url = 'https://minreol.dk/podcast/6KIHZx27KRIyy7JeQlwLns'
    const m = mapNeodbItem(url, {
      id: url, type: 'Podcast', category: 'podcast',
      title: 'The Andrew Klavan Show', host: ['The Daily Wire'], hosts: ['The Daily Wire'],
      external_resources: [{ url: 'https://feeds.simplecast.com/2Dy_5daq' }],
      official_site: 'https://www.dailywire.com/show/the-andrew-klavan-show',
    })
    expect(m.category).toBe('podcast')
    expect(m.details).toMatchObject({
      host: ['The Daily Wire'],
      feed_url: 'https://feeds.simplecast.com/2Dy_5daq',
      official_site: 'https://www.dailywire.com/show/the-andrew-klavan-show',
    })
  })

  it('maps a performance: playwright/venue/opening_date, venue from `location`', () => {
    const url = 'https://minreol.dk/performance/1eTzUtsyJewzcfRhtuFDdR'
    const m = mapNeodbItem(url, {
      id: url, type: 'Performance', category: 'performance',
      title: 'Queen Machine - Our Night At The Opera',
      playwright: ['William S.'], director: ['A. Director'], troupe: ['Some Troupe'],
      location: ['Det Kongelige Teater'], opening_date: '2025-03-24', closing_date: '2025-03-25',
      orig_creator: ['Queen'], performer: ['Queen Machine'], genre: ['Rock'],
    })
    expect(m.category).toBe('performance')
    expect(m.details).toMatchObject({
      playwright: ['William S.'],
      director: ['A. Director'],
      troupe: ['Some Troupe'],
      venue: ['Det Kongelige Teater'],
      opening_date: '2025-03-24',
      performer: ['Queen Machine'],
    })
    expect(m.year).toBe(2025) // from opening_date
    // Performance director lives in details, not the film column.
    expect(m.director).toBeNull()
  })

  it('maps an unknown/new category to common fields + raw, never throwing', () => {
    const url = 'https://minreol.dk/boardgame/abc123'
    const raw = {
      id: url, type: 'BoardGame', category: 'boardgame',
      title: 'Catan', display_title: 'Catan', genre: ['Strategy'], rating: 7.1,
    }
    const m = mapNeodbItem(url, raw)
    expect(m.category).toBe('boardgame')
    expect(m.title).toBe('Catan')
    expect(m.genre).toEqual(['Strategy'])
    expect(m.rating).toBe(7.1)
    expect(m.details).toEqual({}) // no category-specific mapping, but no failure
    expect(m.raw).toBe(raw)
    expect(m.sourceMap.title).toBe('neodb')
  })
})
