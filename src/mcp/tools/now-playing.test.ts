import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * get_now_playing is a *live* read, and its contract has three states, not two:
 * something is playing, nothing is playing, or we never got an answer. The third used
 * to collapse into the second — and worse, got cached there for twenty seconds, so one
 * failed request manufactured a window of "nothing is playing" out of nothing.
 * Decision record 0029.
 */

const fetchNowPlaying = vi.fn()
vi.mock('../../lib/fetch-lastfm.js', () => ({ fetchNowPlaying }))

const { config } = await import('../../config.js')
const { getNowPlaying, resetNowPlayingCache } = await import('./now-playing.js')

const TRACK = {
  track: 'Lost the Breakup',
  artist: 'Maisie Peters',
  album: 'The Good Witch',
  image: 'https://last.fm/i.jpg',
  url: 'https://last.fm/t',
}

beforeEach(() => {
  fetchNowPlaying.mockReset()
  resetNowPlayingCache()
  Object.assign(config, { LASTFM_API_KEY: 'k', LASTFM_USERNAME: 'mvrkws' })
})

describe('get_now_playing', () => {
  it('keeps the documented success shape exactly', async () => {
    fetchNowPlaying.mockResolvedValue({ ok: true, track: TRACK })
    expect(await getNowPlaying()).toEqual({ nowPlaying: true, ...TRACK })
  })

  it('reports genuine silence as { nowPlaying: false }, with no error key', async () => {
    fetchNowPlaying.mockResolvedValue({ ok: true, track: null })
    const r = await getNowPlaying()
    expect(r).toEqual({ nowPlaying: false })
    expect(r).not.toHaveProperty('error')
  })

  it('reports a failed read as null, never as false', async () => {
    fetchNowPlaying.mockResolvedValue({ ok: false, reason: 'http' })
    const r = await getNowPlaying()
    expect(r.nowPlaying).toBeNull()
    expect(r.nowPlaying).not.toBe(false)
    expect(r).toMatchObject({ error: expect.stringContaining('http') })
  })

  it('names each failure reason, so a blip is diagnosable from the response alone', async () => {
    for (const reason of ['network', 'http', 'api'] as const) {
      resetNowPlayingCache()
      fetchNowPlaying.mockResolvedValue({ ok: false, reason })
      expect(await getNowPlaying()).toMatchObject({ nowPlaying: null, error: expect.stringContaining(reason) })
    }
  })

  it('does not cache a failure — the very next call tries Last.fm again', async () => {
    fetchNowPlaying
      .mockResolvedValueOnce({ ok: false, reason: 'network' })
      .mockResolvedValueOnce({ ok: true, track: TRACK })

    expect((await getNowPlaying()).nowPlaying).toBeNull()
    expect((await getNowPlaying()).nowPlaying).toBe(true)
    expect(fetchNowPlaying).toHaveBeenCalledTimes(2)
  })

  it('caches a success, so a polling homepage card costs one call per window', async () => {
    fetchNowPlaying.mockResolvedValue({ ok: true, track: TRACK })

    await getNowPlaying()
    await getNowPlaying()

    expect(fetchNowPlaying).toHaveBeenCalledOnce()
  })

  it('caches silence too — it is an answer, just not an interesting one', async () => {
    fetchNowPlaying.mockResolvedValue({ ok: true, track: null })

    await getNowPlaying()
    await getNowPlaying()

    expect(fetchNowPlaying).toHaveBeenCalledOnce()
  })

  it('says so without calling Last.fm when it is not configured', async () => {
    Object.assign(config, { LASTFM_API_KEY: '', LASTFM_USERNAME: '' })
    const r = await getNowPlaying()

    expect(r.nowPlaying).toBeNull()
    expect(r).toMatchObject({ error: expect.stringContaining('not configured') })
    expect(fetchNowPlaying).not.toHaveBeenCalled()
  })
})
