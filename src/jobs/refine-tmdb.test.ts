import { describe, it, expect, vi, afterEach } from 'vitest'
import { storedToMeta, tmdbOwed } from './refine-tmdb.js'
import { refineWithTmdb } from '../lib/tmdb-refine.js'
import { fetchNeodbItemResult } from '../lib/fetch-neodb-item.js'
import type { catalogMetadata } from '../db/schema.js'

const stored = (over: Partial<typeof catalogMetadata.$inferSelect> = {}) => ({
  id: 'x', itemUrl: 'https://minreol.dk/tv/season/407hZuyQw49WGm579QLf3Q', workKey: 'tmdb:tv/213375/season/1',
  category: 'tv', itemType: 'TVSeason', title: 'Vision Quest Season 1', displayTitle: 'Vision Quest Season 1',
  origTitle: null, description: 'Stored description', coverUrl: null, imdb: null, imdbUrl: null,
  tmdbUrl: 'https://www.themoviedb.org/tv/213375/season/1', externalResources: [{ url: 'https://www.themoviedb.org/tv/213375/season/1' }],
  year: 2026, seasonNumber: 1, episodeCount: 8, genre: ['Drama'], director: ['Terry Matalas'], actors: null,
  language: null, area: null, rating: '8.1', parentUuid: null, details: {}, markTitles: ['Vision Quest'],
  sourceMap: { title: 'neodb', mark_titles: 'activitypub' }, bookwyrmBookUrl: null, raw: {},
  fetchedAt: new Date(), enrichedAt: new Date(), fetchError: null, fetchAttempts: 0, lastAttemptAt: null,
  hiddenAt: null, tmdbRefinedAt: null, tmdbError: null, tmdbAttempts: 0, tmdbRaw: null, sourceGoneAt: new Date(),
  ...over,
})

describe('refining from the stored row (ADR 0077)', () => {
  it('rebuilds everything the refiner reads and falls back to, from the row alone', () => {
    const meta = storedToMeta(stored())
    expect(meta).toMatchObject({
      itemType: 'TVSeason', tmdbUrl: 'https://www.themoviedb.org/tv/213375/season/1',
      description: 'Stored description', director: ['Terry Matalas'], rating: 8.1,
      sourceMap: { title: 'neodb', mark_titles: 'activitypub' },
    })
  })

  it('does not share the stored source_map object, so refining cannot mutate the row read', async () => {
    const row = stored()
    const meta = storedToMeta(row)
    await refineWithTmdb(meta, async (path) => ({
      status: 200,
      data: path.includes('/season/') ? { name: 'Season 1', season_number: 1, overview: 'English.' } : { name: 'Vision Quest' },
    }))
    expect(meta.sourceMap.description).toBe('tmdb')
    expect((row.sourceMap as Record<string, string>).description).toBeUndefined()
  })

  it('owes a stored row whose instance has dropped it: a gone source is no reason to skip TMDB', () => {
    expect(tmdbOwed(stored(), true)).toBe(true)
  })
})

describe('fetchNeodbItemResult', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the 404 status, which is how an instance says an item is gone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })))
    expect(await fetchNeodbItemResult('https://minreol.dk/movie/x')).toEqual({ meta: null, status: 404 })
  })

  it('reports a network error with no status, so it stays an ordinary retryable failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET') }))
    expect(await fetchNeodbItemResult('https://minreol.dk/movie/x')).toEqual({ meta: null, status: null })
  })
})
