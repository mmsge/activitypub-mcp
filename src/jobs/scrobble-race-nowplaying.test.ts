import { describe, it, expect, vi, beforeEach } from 'vitest'
import { type RaceDefinition } from '../lib/races-config.js'

// The whole point of the guard is that a race months away costs no Last.fm calls.
// Mocking the store lets us prove that without a database.
const loadRaceStates = vi.fn(async (_ids: string[]) => new Map<string, any>())
const saveRaceState = vi.fn(async () => {})
vi.mock('../lib/race-store.js', () => ({ loadRaceStates, saveRaceState }))
vi.mock('../db/client.js', () => ({
  getDb: () => { throw new Error('the now-playing watcher must go through race-store') },
}))

// The race list is data now, so the tests set it rather than setting env vars.
let races: RaceDefinition[] = []
vi.mock('../lib/races-config.js', async () => {
  const real = await vi.importActual<typeof import('../lib/races-config.js')>(
    '../lib/races-config.js',
  )
  return { ...real, activeRaces: () => races, getRaces: () => races }
})

const { config } = await import('../config.js')
const { checkRaceNowPlaying } = await import('./scrobble-race-nowplaying.js')

const artistSide = (name: string) =>
  ({ label: name, entity: { type: 'artist' as const, artist: name } })
const albumSide = (artist: string, ...albums: string[]) =>
  ({ label: albums.join(' + '), entity: { type: 'album' as const, artist, albums } })

function race(over: Partial<RaceDefinition> = {}): RaceDefinition {
  return {
    id: 'maisie-vs-taylor',
    title: 'Maisie Peters vs Taylor Swift',
    topic: 'scrobble-race',
    milestones: [300, 250, 100, 50, 25, 10],
    endgameGap: 10,
    nowplayingGap: 3,
    archived: false,
    leader: artistSide('Taylor Swift'),
    challenger: artistSide('Maisie Peters'),
    ...over,
  }
}

// vitest.config.ts deliberately leaves the RACE_* vars unset — the defaults must make
// the feature inert — so arm the credentials here for the tests that need a live race.
function arm(over: Partial<typeof config> = {}) {
  Object.assign(config, {
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
    endgameArmedAt: null,
    overtakenAt: null,
    lastNowPlayingKey: null,
    lastNowPlayingAt: null,
    ...over,
  }
}

/** The state read the job actually does: one query for every race it watches. */
const states = (entries: Record<string, ReturnType<typeof stored>>) =>
  loadRaceStates.mockResolvedValue(new Map(Object.entries(entries)))

const playing = { track: 'Lost the Breakup', artist: 'Maisie Peters', album: null as string | null, image: null, url: null }
/** fetchNowPlaying answers with a discriminated result: a failed read is not silence. */
const reads = (track: typeof playing | null = playing) => vi.fn(async () => ({ ok: true as const, track }))

beforeEach(() => {
  vi.clearAllMocks()
  races = [race()]
  arm()
})

describe('checkRaceNowPlaying', () => {
  it('makes no Last.fm call while the race is still far off', async () => {
    states({ 'maisie-vs-taylor': stored(374) })
    const notify = vi.fn(async () => true)
    const fetchNP = reads()

    await checkRaceNowPlaying(notify, fetchNP)

    expect(fetchNP).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('alerts on the challenger’s track once the gap is inside the endgame', async () => {
    states({ 'maisie-vs-taylor': stored(0) })
    const notify = vi.fn(async () => true)

    await checkRaceNowPlaying(notify, reads())

    expect(notify).toHaveBeenCalledOnce()
    const [message, target] = notify.mock.calls[0] as unknown as [{ title: string }, { topic: string }]
    expect(message.title).toBe('THIS SONG TAKES THE LEAD')
    expect(target.topic).toBe('scrobble-race')
    const [raceId, values] = saveRaceState.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(raceId).toBe('maisie-vs-taylor')
    expect(values.lastNowPlayingKey).toBe('maisie peters lost the breakup')
  })

  it('ignores the leader’s own tracks', async () => {
    states({ 'maisie-vs-taylor': stored(1) })
    const notify = vi.fn(async () => true)

    await checkRaceNowPlaying(notify, reads({ ...playing, artist: 'Taylor Swift' }))

    expect(notify).not.toHaveBeenCalled()
  })

  it('leaves the key unset when the push fails, so the next poll retries', async () => {
    states({ 'maisie-vs-taylor': stored(1) })

    await checkRaceNowPlaying(vi.fn(async () => false), reads())

    expect(saveRaceState).not.toHaveBeenCalled()
  })

  it('stands down once the race has been won', async () => {
    states({ 'maisie-vs-taylor': stored(-1, { overtakenAt: new Date() }) })
    const fetchNP = reads()

    await checkRaceNowPlaying(vi.fn(async () => true), fetchNP)

    expect(fetchNP).not.toHaveBeenCalled()
  })

  it('is inert when no race arms the live watcher', async () => {
    races = [race({ nowplayingGap: 0 })]
    const fetchNP = reads()

    await checkRaceNowPlaying(vi.fn(async () => true), fetchNP)

    expect(loadRaceStates).not.toHaveBeenCalled()
    expect(fetchNP).not.toHaveBeenCalled()
  })

  it('is inert for a race the main watcher has not seeded yet', async () => {
    states({})
    const fetchNP = reads()

    await checkRaceNowPlaying(vi.fn(async () => true), fetchNP)

    expect(fetchNP).not.toHaveBeenCalled()
  })
})

/**
 * Several races share one poll. The read is what has to stay singular: moving the
 * Last.fm call inside the loop would multiply the API traffic by the number of races
 * for no new information, and this job runs every 30 seconds.
 */
describe('checkRaceNowPlaying — several races, one read', () => {
  const other = () => race({
    id: 'good-witch-vs-florescence',
    topic: 'scrobble-race-album',
    leader: albumSide('Maisie Peters', 'The Good Witch'),
    challenger: albumSide('Maisie Peters', 'Florescence'),
  })

  it('reads Last.fm once however many races are armed', async () => {
    races = [race(), other()]
    states({
      'maisie-vs-taylor': stored(0),
      'good-witch-vs-florescence': stored(0),
    })
    const fetchNP = reads({ ...playing, album: 'Florescence' })

    await checkRaceNowPlaying(vi.fn(async () => true), fetchNP)

    expect(fetchNP).toHaveBeenCalledOnce()
  })

  it('alerts each armed race on its own topic, against its own entity', async () => {
    races = [race(), other()]
    states({
      'maisie-vs-taylor': stored(0),
      'good-witch-vs-florescence': stored(0),
    })
    const notify = vi.fn(async () => true)

    await checkRaceNowPlaying(notify, reads({ ...playing, album: 'Florescence' }))

    const topics = notify.mock.calls.map(c => (c as unknown as [unknown, { topic: string }])[1].topic)
    expect(topics).toEqual(['scrobble-race', 'scrobble-race-album'])
    const savedIds = saveRaceState.mock.calls.map(c => (c as unknown as [string])[0])
    expect(savedIds).toEqual(['maisie-vs-taylor', 'good-witch-vs-florescence'])
  })

  /**
   * The trap the entity model exists to avoid. Both sides of the album race are Maisie
   * Peters, so "is this the challenger's artist?" is true for a track off the LEADER's
   * record — and this alert says "this song wins it".
   */
  it('does not alert an album race on a track from the other side of it', async () => {
    races = [other()]
    states({ 'good-witch-vs-florescence': stored(0) })
    const notify = vi.fn(async () => true)

    await checkRaceNowPlaying(notify, reads({ ...playing, album: 'The Good Witch' }))

    expect(notify).not.toHaveBeenCalled()
  })

  /**
   * Many scrobblers omit the album on track.updateNowPlaying. Silence is the right
   * answer: falling back to the artist would fire the decisive alert for either side of
   * a same-artist race, and the scrobble-side alerts at gap 1 and 0 cover this anyway.
   */
  it('stays quiet for an album race when the live read reports no album', async () => {
    races = [other()]
    states({ 'good-witch-vs-florescence': stored(0) })
    const notify = vi.fn(async () => true)

    await checkRaceNowPlaying(notify, reads({ ...playing, album: null }))

    expect(notify).not.toHaveBeenCalled()
  })
})

/**
 * A failed Last.fm read used to arrive as the same `null` that means "nothing is
 * playing". In this one window of the race that conflation is expensive: an outage
 * looks like a quiet moment, and nothing says otherwise. Decision record 0030.
 */
describe('checkRaceNowPlaying — an outage is not silence', () => {
  beforeEach(() => { races = [race()]; arm(); saveRaceState.mockClear() })

  it('sends nothing when the Last.fm read fails', async () => {
    states({ 'maisie-vs-taylor': stored(0) })
    const notify = vi.fn(async () => true)

    await checkRaceNowPlaying(notify, vi.fn(async () => ({ ok: false as const, reason: 'http' as const })))

    expect(notify).not.toHaveBeenCalled()
    expect(saveRaceState).not.toHaveBeenCalled()
  })

  it('alerts on the next tick once Last.fm recovers', async () => {
    states({ 'maisie-vs-taylor': stored(0) })
    const notify = vi.fn(async () => true)
    const fetchNP = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'network' })
      .mockResolvedValueOnce({ ok: true, track: playing })

    await checkRaceNowPlaying(notify, fetchNP as never)
    await checkRaceNowPlaying(notify, fetchNP as never)

    expect(notify).toHaveBeenCalledOnce()
  })

  it('treats a genuinely quiet upstream as nothing playing, not as a failure', async () => {
    states({ 'maisie-vs-taylor': stored(0) })
    const notify = vi.fn(async () => true)

    await checkRaceNowPlaying(notify, reads(null))

    expect(notify).not.toHaveBeenCalled()
  })
})
