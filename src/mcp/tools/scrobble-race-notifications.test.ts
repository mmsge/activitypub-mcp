import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The `notifications` block of get_scrobble_race, which is the public contract for the
 * endgame countdown. Kept in its own file because scrobble-race.test.ts deliberately
 * mocks the database into throwing, to prove projectCrossover never reaches for it.
 */

const loadRaceState = vi.fn()
const countRacePlays = vi.fn(async () => ({ leaderPlays: 10_439, challengerPlays: 10_142 }))
const countRacePlaysSince = vi.fn(async () => ({ leaderPlays: 86, challengerPlays: 1_374 }))
const latestPlay = vi.fn(async () => null)

vi.mock('../../lib/race-store.js', () => ({
  loadRaceState, countRacePlays, countRacePlaysSince, latestPlay,
}))

vi.mock('../../config.js', () => ({
  config: {
    NTFY_PASSWORD: 'hunter2',
    NTFY_TOPIC: 'scrobble-race',
    RACE_COUNTDOWN_GAP: 10,
    RACE_NOWPLAYING_GAP: 0,
  },
  getRaceMilestones: () => [300, 250, 200, 150, 100, 75, 50, 25, 20, 15, 10],
  getScrobbleRacers: () => ({ leader: 'Taylor Swift', challenger: 'Maisie Peters' }),
}))

const { getScrobbleRace } = await import('./scrobble-race.js')

const storedState = (over: Record<string, unknown> = {}) => ({
  leaderPlays: 10_439,
  challengerPlays: 10_142,
  lastMilestone: 300,
  lastAnnouncedGap: null,
  endgameArmedAt: null,
  overtakenAt: null,
  lastNowPlayingKey: null,
  lastNowPlayingAt: null,
  ...over,
})

beforeEach(() => { loadRaceState.mockReset() })

describe('get_scrobble_race — the notifications block', () => {
  it('reports the countdown band as endgame_gap, and the now-playing knob separately', async () => {
    loadRaceState.mockResolvedValue(storedState())
    const r = await getScrobbleRace({ pace_days: 90 })

    expect(r.notifications).toMatchObject({
      armed: true,
      topic: 'scrobble-race',
      last_milestone: 300,
      next_milestone: 250,
      endgame_gap: 10,
      endgame_armed: false,
      nowplaying_gap: 0,
      overtaken_at: null,
    })
  })

  // The whole reason the flag is a stored latch rather than a live comparison.
  it('reports armed from the stored latch, not from the current gap', async () => {
    const ARMED_AT = new Date('2026-08-20T18:22:00Z')
    // Gap is 297 — far outside the band — yet the race has been inside it before.
    loadRaceState.mockResolvedValue(storedState({ endgameArmedAt: ARMED_AT }))
    const r = await getScrobbleRace({ pace_days: 90 })

    expect(r.gap).toBe(297)
    expect(r.notifications?.endgame_armed).toBe(true)
  })

  it('keeps every field the previous response shape had', async () => {
    loadRaceState.mockResolvedValue(storedState())
    const r = await getScrobbleRace({ pace_days: 90 })

    expect(Object.keys(r.notifications ?? {})).toEqual(expect.arrayContaining([
      'armed', 'topic', 'last_milestone', 'next_milestone',
      'endgame_gap', 'endgame_armed', 'overtaken_at',
    ]))
  })

  it('surfaces overtaken_at once the race is run', async () => {
    const FINISHED = new Date('2026-08-26T21:14:03Z')
    loadRaceState.mockResolvedValue(storedState({ overtakenAt: FINISHED }))
    const r = await getScrobbleRace({ pace_days: 90 })
    expect(r.notifications?.overtaken_at).toEqual(FINISHED)
  })

  // An ad-hoc race between two other artists has no state of its own, but the band is
  // a config value and should still be reported honestly.
  it('reports the band but never armed for a pairing with no stored state', async () => {
    loadRaceState.mockResolvedValue(null)
    const r = await getScrobbleRace({ leader: 'ABBA', challenger: 'a-ha', pace_days: 90 })

    expect(loadRaceState).not.toHaveBeenCalled()
    expect(r.notifications).toMatchObject({
      armed: false,
      topic: null,
      endgame_gap: 10,
      endgame_armed: false,
      nowplaying_gap: 0,
      overtaken_at: null,
    })
  })
})
