import { describe, it, expect, vi, beforeEach } from 'vitest'

// The whole point of the guard is that a race months away costs no Last.fm calls.
// Mocking the store lets us prove that without a database.
const loadRaceState = vi.fn()
const saveRaceState = vi.fn(async () => {})
vi.mock('../lib/race-store.js', () => ({ loadRaceState, saveRaceState }))
vi.mock('../db/client.js', () => ({
  getDb: () => { throw new Error('the now-playing watcher must go through race-store') },
}))

const { config } = await import('../config.js')
const { checkRaceNowPlaying } = await import('./scrobble-race-nowplaying.js')

// vitest.config.ts deliberately leaves the RACE_* vars unset — the defaults must make
// the feature inert — so arm them here for the tests that need a live race.
function arm(over: Partial<typeof config> = {}) {
  Object.assign(config, {
    RACE_LEADER_ARTIST: 'Taylor Swift',
    RACE_CHALLENGER_ARTIST: 'Maisie Peters',
    RACE_NOWPLAYING_GAP: 3,
    NTFY_PASSWORD: 'hunter2',
    LASTFM_API_KEY: 'k',
    LASTFM_USERNAME: 'mvrkws',
    ...over,
  })
}

function stored(gap: number, over: Record<string, unknown> = {}) {
  return {
    leaderPlays: 10_439,
    challengerPlays: 10_439 - gap,
    lastMilestone: 10,
    lastAnnouncedGap: gap,
    overtakenAt: null,
    lastNowPlayingKey: null,
    lastNowPlayingAt: null,
    ...over,
  }
}

const playing = { track: 'Lost the Breakup', artist: 'Maisie Peters', album: null, image: null, url: null }
/** fetchNowPlaying answers with a discriminated result: a failed read is not silence. */
const reads = (track: typeof playing | null = playing) => vi.fn(async () => ({ ok: true as const, track }))

beforeEach(() => {
  vi.clearAllMocks()
  arm()
})

describe('checkRaceNowPlaying', () => {
  it('makes no Last.fm call while the race is still far off', async () => {
    loadRaceState.mockResolvedValue(stored(374))
    const notify = vi.fn(async () => true)
    const fetchNP = reads()

    await checkRaceNowPlaying(notify, fetchNP)

    expect(fetchNP).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('alerts on the challenger’s track once the gap is inside the endgame', async () => {
    loadRaceState.mockResolvedValue(stored(0))
    const notify = vi.fn(async () => true)

    await checkRaceNowPlaying(notify, reads())

    expect(notify).toHaveBeenCalledOnce()
    const [message] = notify.mock.calls[0] as unknown as [{ title: string }]
    expect(message.title).toBe('THIS SONG TAKES THE LEAD')
    const [leader, challenger, values] = saveRaceState.mock.calls[0] as unknown as [string, string, Record<string, unknown>]
    expect([leader, challenger]).toEqual(['Taylor Swift', 'Maisie Peters'])
    expect(values.lastNowPlayingKey).toBe('maisie peters lost the breakup')
  })

  it('ignores the leader’s own tracks', async () => {
    loadRaceState.mockResolvedValue(stored(1))
    const notify = vi.fn(async () => true)

    await checkRaceNowPlaying(notify, reads({ ...playing, artist: 'Taylor Swift' }))

    expect(notify).not.toHaveBeenCalled()
  })

  it('leaves the key unset when the push fails, so the next poll retries', async () => {
    loadRaceState.mockResolvedValue(stored(1))

    await checkRaceNowPlaying(vi.fn(async () => false), reads())

    expect(saveRaceState).not.toHaveBeenCalled()
  })

  it('stands down once the race has been won', async () => {
    loadRaceState.mockResolvedValue(stored(-1, { overtakenAt: new Date() }))
    const fetchNP = reads()

    await checkRaceNowPlaying(vi.fn(async () => true), fetchNP)

    expect(fetchNP).not.toHaveBeenCalled()
  })

  it('is inert when no race is configured', async () => {
    arm({ RACE_CHALLENGER_ARTIST: '' })
    const fetchNP = reads()

    await checkRaceNowPlaying(vi.fn(async () => true), fetchNP)

    expect(loadRaceState).not.toHaveBeenCalled()
    expect(fetchNP).not.toHaveBeenCalled()
  })
})

/**
 * A failed Last.fm read used to arrive as the same `null` that means "nothing is
 * playing". In this one window of the race that conflation is expensive: an outage
 * looks like a quiet moment, and nothing says otherwise. Decision record 0030.
 */
describe('checkRaceNowPlaying — an outage is not silence', () => {
  beforeEach(() => { arm(); loadRaceState.mockReset(); saveRaceState.mockClear() })

  it('sends nothing when the Last.fm read fails', async () => {
    loadRaceState.mockResolvedValue(stored(0))
    const notify = vi.fn(async () => true)

    await checkRaceNowPlaying(notify, vi.fn(async () => ({ ok: false as const, reason: 'http' as const })))

    expect(notify).not.toHaveBeenCalled()
    expect(saveRaceState).not.toHaveBeenCalled()
  })

  it('alerts on the next tick once Last.fm recovers', async () => {
    loadRaceState.mockResolvedValue(stored(0))
    const notify = vi.fn(async () => true)
    const fetchNP = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'network' })
      .mockResolvedValueOnce({ ok: true, track: playing })

    await checkRaceNowPlaying(notify, fetchNP as never)
    await checkRaceNowPlaying(notify, fetchNP as never)

    expect(notify).toHaveBeenCalledOnce()
  })

  it('treats a genuinely quiet upstream as nothing playing, not as a failure', async () => {
    loadRaceState.mockResolvedValue(stored(0))
    const notify = vi.fn(async () => true)

    await checkRaceNowPlaying(notify, reads(null))

    expect(notify).not.toHaveBeenCalled()
  })
})
