import { describe, it, expect, vi, beforeEach } from 'vitest'
import { type RaceDefinition } from '../lib/races-config.js'
import { type RaceSnapshot } from '../lib/scrobble-race.js'

/**
 * The notifier, now that it loops. The properties that matter are the ones a loop can
 * break: each race must be decided against ITS ladder, alerted on ITS topic, and saved
 * under ITS id — and one race going wrong must not take the others down with it.
 */

const loadRaceSnapshot = vi.fn<(race: RaceDefinition) => Promise<RaceSnapshot>>()
const loadRaceState = vi.fn()
const saveRaceState = vi.fn(async () => {})
vi.mock('../lib/race-store.js', () => ({ loadRaceSnapshot, loadRaceState, saveRaceState }))

const backfillOvertake = vi.fn(async () => null as null | { at: Date; track: string })
vi.mock('../lib/race-backfill.js', () => ({ backfillOvertake }))

vi.mock('../db/client.js', () => ({
  getDb: () => { throw new Error('the race job must go through race-store') },
}))

let races: RaceDefinition[] = []
vi.mock('../lib/races-config.js', async () => {
  const real = await vi.importActual<typeof import('../lib/races-config.js')>(
    '../lib/races-config.js',
  )
  return { ...real, activeRaces: () => races.filter(r => !r.archived), getRaces: () => races }
})

const { config } = await import('../config.js')
const { runScrobbleRace } = await import('./scrobble-race.js')

const artistSide = (name: string) =>
  ({ label: name, entity: { type: 'artist' as const, artist: name } })

function race(id: string, over: Partial<RaceDefinition> = {}): RaceDefinition {
  return {
    id,
    title: id,
    topic: `topic-${id}`,
    milestones: [300, 250, 150, 100, 50, 25, 10],
    endgameGap: 10,
    nowplayingGap: 0,
    archived: false,
    leader: artistSide(`${id}-leader`),
    challenger: artistSide(`${id}-challenger`),
    ...over,
  }
}

function snapshot(race: RaceDefinition, leaderPlays: number, challengerPlays: number): RaceSnapshot {
  return {
    leaderLabel: race.leader.label,
    challengerLabel: race.challenger.label,
    leaderPlays,
    challengerPlays,
    latestChallengerPlay: { track: `${race.id} track`, url: null, playedAt: new Date('2026-08-13T10:55:40Z') },
    latestLeaderPlay: { track: 'Cruel Summer', url: null, playedAt: new Date('2026-08-13T09:00:00Z') },
    challengerFirstPlayedAt: new Date('2023-04-23T09:15:53Z'),
    netPerDay: 6.7,
  }
}

/** Gap per race id, so the two races can be at genuinely different points. */
function gaps(byId: Record<string, number>) {
  loadRaceSnapshot.mockImplementation(async r => snapshot(r, 10_000, 10_000 - (byId[r.id] ?? 0)))
}

const stateAt = (gap: number, over: Record<string, unknown> = {}) => ({
  leaderPlays: 10_000,
  challengerPlays: 10_000 - gap,
  lastMilestone: null,
  lastAnnouncedGap: null,
  endgameArmedAt: null,
  overtakenAt: null,
  lastNowPlayingKey: null,
  lastNowPlayingAt: null,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(config, { NTFY_PASSWORD: 'hunter2', NTFY_TOPIC: 'scrobble-race' })
  races = []
  loadRaceState.mockResolvedValue(null)
  backfillOvertake.mockResolvedValue(null)
})

describe('runScrobbleRace — one race at a time', () => {
  it('does nothing at all when no race is live', async () => {
    const notify = vi.fn(async () => true)
    await runScrobbleRace(notify)
    expect(loadRaceSnapshot).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('refuses to advance any race when it cannot notify', async () => {
    // Spending milestones nobody was ever told about is the silent failure hetzner-server
    // ADR 0011 exists to forbid.
    races = [race('a')]
    Object.assign(config, { NTFY_PASSWORD: '' })
    await runScrobbleRace(vi.fn(async () => true))
    expect(loadRaceSnapshot).not.toHaveBeenCalled()
    expect(saveRaceState).not.toHaveBeenCalled()
  })

  it('seeds a race it has never seen without alerting', async () => {
    races = [race('a')]
    gaps({ a: 120 })

    const notify = vi.fn(async () => true)
    await runScrobbleRace(notify)

    expect(notify).not.toHaveBeenCalled()
    const [id, values] = saveRaceState.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(id).toBe('a')
    // Pre-marking the rung the gap has already passed is what stops a deploy at gap 120
    // from firing 300, 250 and 150 in one breath.
    expect(values.lastMilestone).toBe(150)
  })
})

describe('runScrobbleRace — two live races do not contaminate each other', () => {
  beforeEach(() => {
    races = [race('a'), race('b'), race('c', { archived: true })]
  })

  it('alerts each race on its own topic and saves under its own id', async () => {
    gaps({ a: 250, b: 100 })
    loadRaceState.mockImplementation(async (id: string) =>
      id === 'a' ? stateAt(300) : stateAt(150))

    const notify = vi.fn(async () => true)
    await runScrobbleRace(notify)

    const sent = notify.mock.calls.map(c => {
      const [message, target] = c as unknown as [{ title: string }, { topic: string }]
      return { title: message.title, topic: target.topic }
    })
    expect(sent).toEqual([
      { title: '250 to go', topic: 'topic-a' },
      { title: '100 to go', topic: 'topic-b' },
    ])

    const saved = saveRaceState.mock.calls.map(c => c as unknown as [string, Record<string, unknown>])
    expect(saved.map(([id]) => id)).toEqual(['a', 'b'])
    // Each race's ladder position is its own: a is at 250, b at 100. A shared variable
    // anywhere in the loop would show up right here.
    expect(saved[0]![1].lastMilestone).toBe(250)
    expect(saved[1]![1].lastMilestone).toBe(100)
    expect(saved[0]![1].challengerPlays).toBe(10_000 - 250)
    expect(saved[1]![1].challengerPlays).toBe(10_000 - 100)
  })

  it('never touches an archived race', async () => {
    gaps({ a: 250, b: 100 })
    loadRaceState.mockResolvedValue(stateAt(300))
    await runScrobbleRace(vi.fn(async () => true))
    const seen = loadRaceSnapshot.mock.calls.map(c => (c[0] as RaceDefinition).id)
    expect(seen).toEqual(['a', 'b'])
  })

  it('carries on with the next race when one throws', async () => {
    gaps({ a: 250, b: 100 })
    loadRaceState.mockImplementation(async (id: string) => {
      if (id === 'a') throw new Error('artist renamed upstream')
      return stateAt(150)
    })

    const notify = vi.fn(async () => true)
    await runScrobbleRace(notify)

    expect(notify).toHaveBeenCalledOnce()
    expect((notify.mock.calls[0] as unknown as [unknown, { topic: string }])[1].topic).toBe('topic-b')
    expect(saveRaceState.mock.calls.map(c => (c as unknown as [string])[0])).toEqual(['b'])
  })

  it('saves nothing for a race whose push failed, and everything for the one that landed', async () => {
    gaps({ a: 250, b: 100 })
    loadRaceState.mockImplementation(async (id: string) =>
      id === 'a' ? stateAt(300) : stateAt(150))

    // a's push fails; b's lands.
    const notify = vi.fn(async (_m: unknown, target?: { topic: string }) => target?.topic !== 'topic-a')
    await runScrobbleRace(notify as never)

    expect(saveRaceState.mock.calls.map(c => (c as unknown as [string])[0])).toEqual(['b'])
  })
})

describe('runScrobbleRace — a rung is spent once, and the finish is final', () => {
  beforeEach(() => { races = [race('a')] })

  it('does not re-fire a milestone already announced', async () => {
    gaps({ a: 249 })
    loadRaceState.mockResolvedValue(stateAt(250, { lastMilestone: 250 }))

    const notify = vi.fn(async () => true)
    await runScrobbleRace(notify)

    expect(notify).not.toHaveBeenCalled()
    const [, values] = saveRaceState.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(values.lastMilestone).toBe(250)
  })

  it('does not re-fire, or clear, an overtake that has already happened', async () => {
    const won = new Date('2026-08-13T10:55:40Z')
    // The challenger has fallen back behind since winning.
    gaps({ a: 40 })
    loadRaceState.mockResolvedValue(stateAt(-5, { overtakenAt: won, lastMilestone: 10 }))

    const notify = vi.fn(async () => true)
    await runScrobbleRace(notify)

    expect(notify).not.toHaveBeenCalled()
    const [, values] = saveRaceState.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(values.overtakenAt).toEqual(won)
  })

  /**
   * A race added after its crossover seeds as already-run. decideRaceAlert can only
   * stamp the challenger's LATEST play there, which is wherever the archive happens to
   * end — so the seed asks the archive when the lead actually changed.
   */
  it('reconstructs the crossover when it seeds a race that is already won', async () => {
    const crossedAt = new Date('2026-08-22T18:03:11Z')
    gaps({ a: -5 })
    loadRaceState.mockResolvedValue(null)
    backfillOvertake.mockResolvedValue({ at: crossedAt, track: 'Body Better' })

    const notify = vi.fn(async () => true)
    await runScrobbleRace(notify)

    expect(backfillOvertake).toHaveBeenCalledOnce()
    expect(notify).not.toHaveBeenCalled()
    const [, values] = saveRaceState.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(values.overtakenAt).toEqual(crossedAt)
  })

  it('does not go looking for a crossover in a race still being led', async () => {
    gaps({ a: 120 })
    loadRaceState.mockResolvedValue(null)
    await runScrobbleRace(vi.fn(async () => true))
    expect(backfillOvertake).not.toHaveBeenCalled()
  })
})
