import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchRecentScrobbles, fetchNowPlaying } from './fetch-lastfm.js'

/**
 * The Last.fm mapper had no tests at all, which is how a reported "now-playing is being
 * counted as a scrobble" bug cost a day of data forensics to disprove. These pin the two
 * facts the whole scrobble store rests on: the live entry never becomes a row, and
 * played_at is Last.fm's own timestamp rather than the clock. Decision record 0029.
 */

const NOW_PLAYING_ENTRY = {
  '@attr': { nowplaying: 'true' },
  name: 'Old Fashioned',
  artist: { '#text': 'Maisie Peters', mbid: 'a1' },
  album: { '#text': 'Florescence', mbid: 'b1' },
  url: 'https://last.fm/np',
  image: [{ '#text': 'small.jpg' }, { '#text': 'large.jpg' }],
}

const scrobbleEntry = (name: string, uts: number) => ({
  name,
  artist: { '#text': 'Maisie Peters', mbid: 'a1' },
  album: { '#text': 'Florescence', mbid: 'b1' },
  mbid: 'c1',
  url: `https://last.fm/${name}`,
  image: [{ '#text': 'small.jpg' }, { '#text': 'large.jpg' }],
  date: { uts: String(uts), '#text': 'whenever' },
})

function respond(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  })))
}

const page = (tracks: unknown, totalPages = '1') => ({
  recenttracks: { track: tracks, '@attr': { totalPages } },
})

beforeEach(() => { vi.useRealTimers() })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('fetchRecentScrobbles', () => {
  it('drops the now-playing entry and keeps the dated ones', async () => {
    respond(page([NOW_PLAYING_ENTRY, scrobbleEntry('qUeStIoNs', 1_770_375_415)]))

    const r = await fetchRecentScrobbles('k', 'mvrkws')

    expect(r.scrobbles).toHaveLength(1)
    expect(r.scrobbles[0].trackName).toBe('qUeStIoNs')
  })

  it('drops a dateless entry even when it forgets the nowplaying attribute', async () => {
    const { '@attr': _dropped, ...dateless } = NOW_PLAYING_ENTRY
    respond(page([dateless, scrobbleEntry('qUeStIoNs', 1_770_375_415)]))

    const r = await fetchRecentScrobbles('k', 'mvrkws')

    expect(r.scrobbles.map(s => s.trackName)).toEqual(['qUeStIoNs'])
  })

  it('stamps playedAt from date.uts, never from the clock', async () => {
    const uts = 1_770_375_415 // 2026-02-06T10:56:55Z
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2029-01-01T00:00:00Z'))
    respond(page([scrobbleEntry('Old Fashioned', uts)]))

    const [s] = (await fetchRecentScrobbles('k', 'mvrkws')).scrobbles

    expect(s.uts).toBe(uts)
    expect(s.playedAt.getTime()).toBe(uts * 1000)
    expect(s.playedAt.toISOString()).toBe('2026-02-06T10:56:55.000Z')
  })

  it('coerces a single-track response into an array', async () => {
    respond(page(scrobbleEntry('Mary Janes', 1_770_375_415)))

    expect((await fetchRecentScrobbles('k', 'mvrkws')).scrobbles).toHaveLength(1)
  })

  it('takes the largest image and the mbids off the nested objects', async () => {
    respond(page([scrobbleEntry('Mary Janes', 1_770_375_415)]))

    const [s] = (await fetchRecentScrobbles('k', 'mvrkws')).scrobbles

    expect(s.imageUrl).toBe('large.jpg')
    expect(s.artistMbid).toBe('a1')
    expect(s.albumMbid).toBe('b1')
    expect(s.albumName).toBe('Florescence')
  })

  it('skips a row whose uts is not a number', async () => {
    respond(page([{ ...scrobbleEntry('Mary Janes', 0), date: { uts: 'soon' } }]))

    expect((await fetchRecentScrobbles('k', 'mvrkws')).scrobbles).toEqual([])
  })

  it('returns an empty page on a network error, rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET') }))

    await expect(fetchRecentScrobbles('k', 'mvrkws')).resolves.toEqual({
      scrobbles: [], totalPages: 0, page: 1,
    })
  })

  it('returns an empty page on a non-OK status', async () => {
    respond({}, { ok: false, status: 503 })

    expect((await fetchRecentScrobbles('k', 'mvrkws')).totalPages).toBe(0)
  })

  it('returns an empty page on a Last.fm error body', async () => {
    respond({ error: 6, message: 'User not found' })

    expect((await fetchRecentScrobbles('k', 'mvrkws')).scrobbles).toEqual([])
  })
})

describe('fetchNowPlaying', () => {
  it('reads the live entry when one is there', async () => {
    respond(page([NOW_PLAYING_ENTRY]))

    expect(await fetchNowPlaying('k', 'mvrkws')).toEqual({
      ok: true,
      track: {
        track: 'Old Fashioned',
        artist: 'Maisie Peters',
        album: 'Florescence',
        image: 'large.jpg',
        url: 'https://last.fm/np',
      },
    })
  })

  it('says nothing is playing when the newest entry is a plain scrobble', async () => {
    respond(page([scrobbleEntry('qUeStIoNs', 1_770_375_415)]))

    expect(await fetchNowPlaying('k', 'mvrkws')).toEqual({ ok: true, track: null })
  })

  it('says nothing is playing for an empty history', async () => {
    respond(page(undefined))

    expect(await fetchNowPlaying('k', 'mvrkws')).toEqual({ ok: true, track: null })
  })

  // The distinction the tool's three-state contract is built on.
  it('reports a network failure as a failure, not as silence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET') }))

    expect(await fetchNowPlaying('k', 'mvrkws')).toEqual({ ok: false, reason: 'network' })
  })

  it('reports a non-OK status as a failure', async () => {
    respond({}, { ok: false, status: 503 })

    expect(await fetchNowPlaying('k', 'mvrkws')).toEqual({ ok: false, reason: 'http' })
  })

  it('reports a Last.fm error body as a failure', async () => {
    respond({ error: 29, message: 'Rate limit exceeded' })

    expect(await fetchNowPlaying('k', 'mvrkws')).toEqual({ ok: false, reason: 'api' })
  })
})
