import { describe, it, expect } from 'vitest'
import { assignWorkKeys, imdbKey, normaliseTmdbUrl, ownWorkKey, tmdbKey, type WorkKeyRow } from './work-key.js'

const row = (over: Partial<WorkKeyRow> & { itemUrl: string }): WorkKeyRow => ({
  category: null, itemType: null, tmdbUrl: null, imdb: null, ...over,
})

describe('normaliseTmdbUrl', () => {
  it('reduces a film, a show and a season to their ids', () => {
    expect(normaliseTmdbUrl('https://www.themoviedb.org/movie/603-the-matrix?language=en')).toBe('tmdb:movie/603')
    expect(normaliseTmdbUrl('https://www.themoviedb.org/tv/213375')).toBe('tmdb:tv/213375')
    expect(normaliseTmdbUrl('https://themoviedb.org/tv/213375/season/1/')).toBe('tmdb:tv/213375/season/1')
  })

  it('refuses an episode, another host and junk', () => {
    expect(normaliseTmdbUrl('https://www.themoviedb.org/tv/213375/season/1/episode/2')).toBeNull()
    expect(normaliseTmdbUrl('https://www.imdb.com/title/tt0133093/')).toBeNull()
    expect(normaliseTmdbUrl('not a url')).toBeNull()
    expect(normaliseTmdbUrl(null)).toBeNull()
  })
})

describe('the season rule', () => {
  it('never lets a season match on IMDb, since NeoDB gives seasons the show id', () => {
    expect(imdbKey(row({ itemUrl: 'a', itemType: 'TVSeason', imdb: 'tt1' }))).toBeNull()
    expect(imdbKey(row({ itemUrl: 'a', itemType: 'TVShow', imdb: 'tt1' }))).toBe('imdb:tv/tt1')
    expect(imdbKey(row({ itemUrl: 'a', itemType: 'Movie', imdb: 'tt1' }))).toBe('imdb:movie/tt1')
  })

  it('lets a season match only on a TMDB link naming its own season', () => {
    expect(tmdbKey(row({ itemUrl: 'a', itemType: 'TVSeason', tmdbUrl: 'https://www.themoviedb.org/tv/9' }))).toBeNull()
    expect(tmdbKey(row({ itemUrl: 'a', itemType: 'TVShow', tmdbUrl: 'https://www.themoviedb.org/tv/9/season/1' }))).toBeNull()
  })

  it('keeps season 1, season 2 and the show apart', () => {
    const keys = assignWorkKeys([
      row({ itemUrl: 's1', itemType: 'TVSeason', imdb: 'tt9', tmdbUrl: 'https://www.themoviedb.org/tv/9/season/1' }),
      row({ itemUrl: 's2', itemType: 'TVSeason', imdb: 'tt9', tmdbUrl: 'https://www.themoviedb.org/tv/9/season/2' }),
      row({ itemUrl: 'show', itemType: 'TVShow', imdb: 'tt9', tmdbUrl: 'https://www.themoviedb.org/tv/9' }),
    ])
    expect(new Set(keys.values()).size).toBe(3)
  })
})

describe('assignWorkKeys', () => {
  it('folds the Vision Quest season marked on two instances into one work', () => {
    const keys = assignWorkKeys([
      row({ itemUrl: 'https://minreol.dk/tv/season/407hZuyQw49WGm579QLf3Q', itemType: 'TVSeason', tmdbUrl: 'https://www.themoviedb.org/tv/213375/season/1' }),
      row({ itemUrl: 'https://neodb.social/tv/season/3QGyziSdHVJLTr7jipedWF', itemType: 'TVSeason', tmdbUrl: 'https://www.themoviedb.org/tv/213375/season/1' }),
    ])
    expect([...keys.values()]).toEqual(['tmdb:tv/213375/season/1', 'tmdb:tv/213375/season/1'])
  })

  it('joins through a bridge: TMDB+IMDb on one row, each alone on the others', () => {
    const keys = assignWorkKeys([
      row({ itemUrl: 'a', itemType: 'Movie', imdb: 'tt5' }),
      row({ itemUrl: 'b', itemType: 'Movie', imdb: 'tt5', tmdbUrl: 'https://www.themoviedb.org/movie/7' }),
      row({ itemUrl: 'c', itemType: 'Movie', tmdbUrl: 'https://www.themoviedb.org/movie/7-slug' }),
    ])
    expect(new Set(keys.values())).toEqual(new Set(['tmdb:movie/7']))
  })

  it('never merges on title alone: a row with no link is its own work', () => {
    const keys = assignWorkKeys([row({ itemUrl: 'x' }), row({ itemUrl: 'y' })])
    expect(keys.get('x')).toBe('url:x')
    expect(keys.get('y')).toBe('url:y')
  })

  it('does not merge a film and a show sharing an IMDb id', () => {
    const keys = assignWorkKeys([
      row({ itemUrl: 'm', itemType: 'Movie', imdb: 'tt1' }),
      row({ itemUrl: 't', itemType: 'TVShow', imdb: 'tt1' }),
    ])
    expect(keys.get('m')).not.toBe(keys.get('t'))
  })

  it('is deterministic whatever order the rows are read in, so a re-run writes nothing', () => {
    const rows = [
      row({ itemUrl: 'a', itemType: 'Movie', imdb: 'tt5' }),
      row({ itemUrl: 'b', itemType: 'Movie', imdb: 'tt5', tmdbUrl: 'https://www.themoviedb.org/movie/7' }),
      row({ itemUrl: 'c', itemType: 'Movie', imdb: 'tt6' }),
    ]
    const forward = assignWorkKeys(rows)
    const backward = assignWorkKeys([...rows].reverse())
    for (const r of rows) expect(backward.get(r.itemUrl)).toBe(forward.get(r.itemUrl))
  })

  it('names a lone row by its own key', () => {
    expect(ownWorkKey(row({ itemUrl: 'z', category: 'movie', imdb: 'tt3' }))).toBe('imdb:movie/tt3')
  })
})
