import { describe, it, expect, vi, afterEach } from 'vitest'
import { mapNeodbItem } from './fetch-neodb-item.js'
import { refineWithTmdb, tmdbFetch, tmdbTargetOf, TMDB_TOP_ACTORS, type TmdbFetch } from './tmdb-refine.js'
import { catalogUpsertValues, hasCjk, tmdbOwed } from '../jobs/sync-neodb-metadata.js'
import { TMDB_MAX_ATTEMPTS } from './tmdb-refine.js'

// The neodb.social Vision Quest season as it arrives: Douban credits, Chinese copy.
const visionQuest = () => mapNeodbItem('https://neodb.social/tv/season/3QGyziSdHVJLTr7jipedWF', {
  type: 'TVSeason',
  category: 'tv',
  title: '幻视 第一季',
  description: '一部关于幻视的剧集。',
  director: ['特里·马塔拉斯'],
  actor: ['保罗·贝坦尼'],
  genre: ['剧情'],
  season_number: 1,
  episode_count: 8,
  external_resources: [
    { url: 'https://www.themoviedb.org/tv/213375/season/1' },
    { url: 'https://movie.douban.com/subject/1/' },
  ],
})

const seasonPayload = {
  name: 'Season 1',
  season_number: 1,
  air_date: '2026-10-01',
  overview: 'Vision sets out to find what he lost.',
  episodes: Array.from({ length: 8 }, (_, i) => ({ episode_number: i + 1 })),
  aggregate_credits: {
    cast: [
      { name: 'James Spader', order: 1 },
      { name: 'Paul Bettany', order: 0 },
    ],
    crew: [
      { name: 'Second Director', jobs: [{ job: 'Director' }], total_episode_count: 2 },
      { name: 'Lead Director', jobs: [{ job: 'Director' }], total_episode_count: 6 },
      { name: 'A Writer', jobs: [{ job: 'Writer' }], total_episode_count: 8 },
    ],
  },
}
const showPayload = {
  name: 'Vision Quest',
  original_name: 'Vision Quest',
  overview: 'The show overview.',
  genres: [{ name: 'Drama' }, { name: 'Sci-Fi & Fantasy' }],
  created_by: [{ name: 'Terry Matalas' }],
}

const fakeFetch = (routes: Record<string, { status: number; data?: unknown }>): TmdbFetch & { calls: string[] } => {
  const calls: string[] = []
  const f = (async (path: string) => {
    calls.push(path)
    const r = routes[path.split('?')[0]]
    if (!r) return { status: 404, data: null }
    return { status: r.status, data: r.data ?? null }
  }) as TmdbFetch & { calls: string[] }
  f.calls = calls
  return f
}

describe('refineWithTmdb on a season', () => {
  it('reads the season and the show, and lays English over the Chinese', async () => {
    const meta = visionQuest()
    const f = fakeFetch({
      '/tv/213375/season/1': { status: 200, data: seasonPayload },
      '/tv/213375': { status: 200, data: showPayload },
    })
    const out = await refineWithTmdb(meta, f)
    expect(out.status).toBe('refined')
    expect(f.calls).toEqual(['/tv/213375/season/1?append_to_response=aggregate_credits', '/tv/213375'])
    expect(meta.title).toBe('Vision Quest Season 1')
    expect(meta.description).toBe('Vision sets out to find what he lost.')
    expect(meta.genre).toEqual(['Drama', 'Sci-Fi & Fantasy'])
    expect(meta.director).toEqual(['Lead Director', 'Second Director'])
    expect(meta.actors).toEqual(['Paul Bettany', 'James Spader'])
    expect(meta.details.creators).toEqual(['Terry Matalas'])
    expect(meta.year).toBe(2026)
    for (const field of ['title', 'description', 'genre', 'director', 'actors', 'creators']) {
      expect(meta.sourceMap[field]).toBe('tmdb')
    }
    expect(hasCjk(meta.description) || hasCjk(meta.title)).toBe(false)
  })

  it('keeps season number and episode count when TMDB agrees, and follows TMDB when it does not', async () => {
    const agreed = visionQuest()
    await refineWithTmdb(agreed, fakeFetch({
      '/tv/213375/season/1': { status: 200, data: seasonPayload },
      '/tv/213375': { status: 200, data: showPayload },
    }))
    expect(agreed.episodeCount).toBe(8)
    expect(agreed.sourceMap.episode_count).toBe('neodb')

    const disagreed = visionQuest()
    await refineWithTmdb(disagreed, fakeFetch({
      '/tv/213375/season/1': { status: 200, data: { ...seasonPayload, episodes: [{}, {}, {}, {}, {}, {}] } },
      '/tv/213375': { status: 200, data: showPayload },
    }))
    expect(disagreed.episodeCount).toBe(6)
    expect(disagreed.sourceMap.episode_count).toBe('tmdb')
  })

  it('falls back to the show overview and creators when the season has none', async () => {
    const meta = visionQuest()
    await refineWithTmdb(meta, fakeFetch({
      '/tv/213375/season/1': { status: 200, data: { ...seasonPayload, overview: '', aggregate_credits: { cast: [], crew: [] } } },
      '/tv/213375': { status: 200, data: showPayload },
    }))
    expect(meta.description).toBe('The show overview.')
    expect(meta.director).toEqual(['Terry Matalas'])
    // TMDB had no actors: NeoDB's stay, with NeoDB's provenance.
    expect(meta.actors).toEqual(['保罗·贝坦尼'])
    expect(meta.sourceMap.actors).toBe('neodb')
  })
})

describe('refineWithTmdb on a film', () => {
  it('takes directors off the crew and the top-billed cast in billing order', async () => {
    const meta = mapNeodbItem('https://neodb.social/movie/abc', {
      type: 'Movie', category: 'movie', title: '黑客帝国', director: ['沃卓斯基'],
      external_resources: [{ url: 'https://www.themoviedb.org/movie/603-the-matrix' }],
    })
    const cast = Array.from({ length: 15 }, (_, i) => ({ name: `Actor ${i}`, order: 14 - i }))
    const out = await refineWithTmdb(meta, fakeFetch({
      '/movie/603': {
        status: 200,
        data: {
          title: 'The Matrix', original_title: 'The Matrix', release_date: '1999-03-31',
          overview: 'A hacker learns the truth.', genres: [{ name: 'Action' }],
          credits: { cast, crew: [{ name: 'Lana Wachowski', job: 'Director' }, { name: 'Lilly Wachowski', job: 'Director' }, { name: 'X', job: 'Producer' }] },
        },
      },
    }))
    expect(out.status).toBe('refined')
    expect(meta.title).toBe('The Matrix')
    expect(meta.year).toBe(1999)
    expect(meta.director).toEqual(['Lana Wachowski', 'Lilly Wachowski'])
    expect(meta.actors).toHaveLength(TMDB_TOP_ACTORS)
    expect(meta.actors?.[0]).toBe('Actor 14')
  })
})

describe('refineWithTmdb never blocks', () => {
  it('reports a rate limit as retryable and leaves NeoDB values alone', async () => {
    const meta = visionQuest()
    const out = await refineWithTmdb(meta, fakeFetch({ '/tv/213375/season/1': { status: 429 } }))
    expect(out).toMatchObject({ status: 'failed', retry: true })
    expect(meta.title).toBe('幻视 第一季')
    expect(meta.sourceMap.title).toBe('neodb')
  })

  it('reports an unknown link (404) as final', async () => {
    const out = await refineWithTmdb(visionQuest(), fakeFetch({}))
    expect(out).toMatchObject({ status: 'failed', retry: false })
  })

  it('turns a thrown network error into a retryable failure', async () => {
    const out = await refineWithTmdb(visionQuest(), async () => { throw new Error('ECONNRESET') })
    expect(out).toMatchObject({ status: 'failed', retry: true })
  })

  it('skips when the refiner is off, and for items with no usable TMDB link', async () => {
    expect(await refineWithTmdb(visionQuest(), null)).toEqual({ status: 'skipped' })
    const play = mapNeodbItem('https://neodb.social/performance/x', { type: 'Performance', category: 'performance', title: 'Ubesvart anrop' })
    const f = fakeFetch({})
    expect(await refineWithTmdb(play, f)).toEqual({ status: 'skipped' })
    expect(f.calls).toEqual([])
  })

  it('never gives a season the show metadata off a show-level link', () => {
    const meta = mapNeodbItem('https://neodb.social/tv/season/y', {
      type: 'TVSeason', category: 'tv', title: 'S2',
      external_resources: [{ url: 'https://www.themoviedb.org/tv/213375' }],
    })
    expect(tmdbTargetOf(meta)).toBeNull()
  })
})

describe('tmdbFetch', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends a v4 token as Bearer and asks for en-US', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await tmdbFetch('aaa.bbb.ccc', 'https://api.example/3')('/movie/1?append_to_response=credits')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('https://api.example/3/movie/1?append_to_response=credits&language=en-US')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer aaa.bbb.ccc')
  })

  it('sends a v3 key as api_key and no Authorization header', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await tmdbFetch('plainkey', 'https://api.example/3')('/tv/2')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.searchParams.get('api_key')).toBe('plainkey')
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })
})

describe('the bookkeeping columns', () => {
  it('stamps a refinement, and clears it on a pass that did not refine', () => {
    const now = new Date()
    const refined = catalogUpsertValues(visionQuest(), [], {}, now, 'k', { status: 'refined', raw: { a: 1 } })
    expect(refined).toMatchObject({ tmdbRefinedAt: now, tmdbError: null, tmdbAttempts: 0, tmdbRaw: { a: 1 } })
    const skipped = catalogUpsertValues(visionQuest(), [], {}, now, 'k')
    expect(skipped).toMatchObject({ tmdbRefinedAt: null, tmdbError: null, tmdbRaw: null })
  })

  it('spends every attempt on a 404, one on anything else', () => {
    const now = new Date()
    expect(catalogUpsertValues(visionQuest(), [], {}, now, 'k', { status: 'failed', error: 'x', retry: false }).tmdbAttempts).toBe(TMDB_MAX_ATTEMPTS)
    expect(catalogUpsertValues(visionQuest(), [], {}, now, 'k', { status: 'failed', error: 'x', retry: true }).tmdbAttempts).toBe(1)
  })
})

describe('tmdbOwed', () => {
  const row = {
    itemUrl: 'https://neodb.social/tv/season/x', category: 'tv', itemType: 'TVSeason',
    tmdbUrl: 'https://www.themoviedb.org/tv/213375/season/1', imdb: null,
    tmdbRefinedAt: null as Date | null, tmdbAttempts: 0,
  }
  it('owes an unrefined film or TV row with a usable link, while attempts last', () => {
    expect(tmdbOwed(row, true)).toBe(true)
    expect(tmdbOwed({ ...row, tmdbRefinedAt: new Date() }, true)).toBe(false)
    expect(tmdbOwed({ ...row, tmdbAttempts: TMDB_MAX_ATTEMPTS }, true)).toBe(false)
    expect(tmdbOwed({ ...row, tmdbUrl: null }, true)).toBe(false)
  })
  it('owes nothing while the refiner is off', () => {
    expect(tmdbOwed(row, false)).toBe(false)
  })
})
