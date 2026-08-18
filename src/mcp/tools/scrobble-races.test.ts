import { describe, it, expect, vi, beforeEach } from 'vitest'
import { type RaceDefinition } from '../../lib/races-config.js'

const countRacePlays = vi.fn(async (_leader: any, _challenger?: any) => ({ leaderPlays: 0, challengerPlays: 0 }))
const loadRaceStates = vi.fn(async () => new Map<string, any>())
vi.mock('../../lib/race-store.js', () => ({ countRacePlays, loadRaceStates }))
vi.mock('../../db/client.js', () => ({
  getDb: () => { throw new Error('list_scrobble_races must go through race-store') },
}))

let races: RaceDefinition[] = []
vi.mock('../../lib/races-config.js', async () => {
  const real = await vi.importActual<typeof import('../../lib/races-config.js')>(
    '../../lib/races-config.js',
  )
  return { ...real, getRaces: () => races }
})

const { listScrobbleRaces } = await import('./scrobble-races.js')

const artistSide = (name: string) =>
  ({ label: name, entity: { type: 'artist' as const, artist: name } })

const RACES: RaceDefinition[] = [
  {
    id: 'maisie-vs-taylor',
    title: 'Maisie Peters vs Taylor Swift',
    topic: 'scrobble-race',
    milestones: [300, 10],
    endgameGap: 10,
    nowplayingGap: 0,
    archived: true,
    leader: artistSide('Taylor Swift'),
    challenger: artistSide('Maisie Peters'),
  },
  {
    id: 'good-witch-vs-florescence',
    title: 'The Good Witch vs Florescence',
    topic: 'scrobble-race-album',
    milestones: [100, 10],
    endgameGap: 10,
    nowplayingGap: 0,
    archived: false,
    leader: {
      label: 'The Good Witch',
      entity: { type: 'album', artist: 'Maisie Peters', albums: ['The Good Witch'] },
    },
    challenger: {
      label: 'Florescence',
      entity: { type: 'album', artist: 'Maisie Peters', albums: ['Florescence'] },
    },
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  races = RACES
  countRacePlays.mockImplementation(async (leader: any) =>
    leader.type === 'artist'
      ? { leaderPlays: 10_439, challengerPlays: 10_512 }
      : { leaderPlays: 812, challengerPlays: 790 })
  loadRaceStates.mockResolvedValue(new Map())
})

describe('list_scrobble_races', () => {
  it('answers with standings, so a caller can pick a race without a second round trip', async () => {
    const r = await listScrobbleRaces({ include_archived: true })

    expect(r.total).toBe(2)
    expect(r.races.map(x => x.race_id)).toEqual(['maisie-vs-taylor', 'good-witch-vs-florescence'])
    expect(r.races[0]).toMatchObject({
      title: 'Maisie Peters vs Taylor Swift',
      archived: true,
      topic: 'scrobble-race',
      gap: -73,
      leader_ahead: false,
      plays_to_overtake: 0,
    })
    expect(r.races[1]).toMatchObject({ gap: 22, leader_ahead: true, plays_to_overtake: 23 })
  })

  it('echoes each side as the entity it actually is', async () => {
    const r = await listScrobbleRaces({ include_archived: true })
    expect(r.races[1]!.challenger).toMatchObject({
      artist: 'Maisie Peters',
      label: 'Florescence',
      entity: { type: 'album', artist: 'Maisie Peters', albums: ['Florescence'] },
      plays: 790,
    })
  })

  it('hides resolved races when asked to', async () => {
    const r = await listScrobbleRaces({ include_archived: false })
    expect(r.races.map(x => x.race_id)).toEqual(['good-witch-vs-florescence'])
  })

  it('reads every race’s state in ONE query, not one per race', async () => {
    await listScrobbleRaces({ include_archived: true })
    expect(loadRaceStates).toHaveBeenCalledOnce()
    expect(loadRaceStates).toHaveBeenCalledWith(['maisie-vs-taylor', 'good-witch-vs-florescence'])
  })

  it('reports the result of a race that has one', async () => {
    const won = new Date('2026-08-13T10:55:40Z')
    loadRaceStates.mockResolvedValue(new Map([['maisie-vs-taylor', { overtakenAt: won }]]))
    const r = await listScrobbleRaces({ include_archived: true })
    expect(r.races[0]!.overtaken_at).toEqual(won)
    expect(r.races[1]!.overtaken_at).toBeNull()
  })
})
