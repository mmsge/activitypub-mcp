import { describe, it, expect } from 'vitest'
import {
  decideRaceAlert, decideNowPlayingAlert, tightestCrossed,
  NOWPLAYING_REARM_MS,
  type RaceSnapshot, type RaceState,
} from './scrobble-race.js'

const MILESTONES = [300, 250, 200, 150, 100, 75, 50, 25, 20, 15, 10]
const NOW = new Date('2026-09-14T19:04:00Z')

function snap(leaderPlays: number, challengerPlays: number, over: Partial<RaceSnapshot> = {}): RaceSnapshot {
  return {
    leaderArtist: 'Taylor Swift',
    challengerArtist: 'Maisie Peters',
    leaderPlays,
    challengerPlays,
    latestChallengerPlay: { track: 'Body Better', url: 'https://last.fm/t', playedAt: NOW },
    latestLeaderPlay: { track: 'Cruel Summer', url: null, playedAt: NOW },
    challengerFirstPlayedAt: new Date('2023-04-23T09:15:53Z'),
    netPerDay: 6.7,
    ...over,
  }
}

function state(over: Partial<RaceState> = {}): RaceState {
  return {
    leaderPlays: 10_439,
    challengerPlays: 10_065,
    lastMilestone: null,
    lastAnnouncedGap: null,
    overtakenAt: null,
    ...over,
  }
}

describe('decideRaceAlert — seeding', () => {
  it('says nothing on the first sighting, and banks the gap it found', () => {
    const d = decideRaceAlert(snap(10_439, 10_065), null, MILESTONES, NOW)
    expect(d.kind).toBe('seeded')
    expect(d.message).toBeNull()
    // 374 is past no rung yet, so the 300 rung is still live.
    expect(d.state.lastMilestone).toBeNull()
    expect(d.state.leaderPlays).toBe(10_439)
  })

  it('pre-fires every rung already passed, so switching on mid-race never storms', () => {
    const d = decideRaceAlert(snap(10_439, 10_319), null, MILESTONES, NOW) // gap 120
    expect(d.message).toBeNull()
    expect(d.state.lastMilestone).toBe(150)
  })

  it('seeds an already-decided race as decided, and stays quiet about it', () => {
    const d = decideRaceAlert(snap(10_439, 10_500), null, MILESTONES, NOW)
    expect(d.message).toBeNull()
    expect(d.state.overtakenAt).toEqual(NOW)
  })
})

describe('decideRaceAlert — milestones', () => {
  it('stays quiet one play above a rung and fires exactly on it', () => {
    const above = decideRaceAlert(snap(10_439, 10_138), state(), MILESTONES, NOW) // gap 301
    expect(above.kind).toBe('none')

    const on = decideRaceAlert(snap(10_439, 10_139), state(), MILESTONES, NOW) // gap 300
    expect(on.kind).toBe('milestone')
    expect(on.message?.title).toBe('300 to go')
    expect(on.state.lastMilestone).toBe(300)
  })

  it('does not fire the same rung twice', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_139, lastMilestone: 300 })
    const d = decideRaceAlert(snap(10_439, 10_140), prev, MILESTONES, NOW) // gap 299
    expect(d.kind).toBe('none')
  })

  it('collapses several rungs crossed at once into one alert for the tightest', () => {
    // The app was down for a week; the sync lands a pile of plays in one tick.
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_179, lastMilestone: 300 })
    const d = decideRaceAlert(snap(10_439, 10_399), prev, MILESTONES, NOW) // gap 260 → 40
    expect(d.kind).toBe('milestone')
    expect(d.state.lastMilestone).toBe(50)
    expect(d.message?.body).toContain('Under 50')
  })

  it('never re-arms a rung when the leader pulls back ahead', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_417, lastMilestone: 25 })
    // Taylor binges back out past 25, then Maisie closes to 22 again.
    const out = decideRaceAlert(snap(10_460, 10_420), prev, MILESTONES, NOW) // gap 40
    expect(out.kind).toBe('none')
    expect(out.state.lastMilestone).toBe(25)

    const back = decideRaceAlert(snap(10_460, 10_438), out.state, MILESTONES, NOW) // gap 22
    expect(back.kind).toBe('none')
  })

  it('quotes an ETA from the closing rate', () => {
    const d = decideRaceAlert(snap(10_439, 10_139), state(), MILESTONES, NOW)
    expect(d.message?.body).toMatch(/~4[0-9] days/)
  })
})

describe('decideRaceAlert — endgame', () => {
  const inZone = (gap: number, prevGap: number, prevOver: Partial<RaceState> = {}) =>
    decideRaceAlert(
      snap(10_439, 10_439 - gap),
      state({ leaderPlays: 10_439, challengerPlays: 10_439 - prevGap, lastMilestone: 10, lastAnnouncedGap: prevGap, ...prevOver }),
      MILESTONES,
      NOW,
    )

  it('alerts on every play that moves the number, naming the track', () => {
    const d = inZone(7, 8)
    expect(d.kind).toBe('per-play')
    expect(d.message?.title).toBe('7 to go')
    expect(d.message?.body).toContain('Body Better')
    expect(d.message?.priority).toBe('high')
  })

  it('says nothing when the gap has not moved', () => {
    const d = decideRaceAlert(
      snap(10_439, 10_432),
      state({ leaderPlays: 10_439, challengerPlays: 10_432, lastMilestone: 10, lastAnnouncedGap: 7 }),
      MILESTONES,
      NOW,
    )
    expect(d.kind).toBe('none')
  })

  it('reports the leader answering back, with the leader’s track', () => {
    const d = inZone(9, 8)
    expect(d.kind).toBe('leader-answered')
    expect(d.message?.title).toBe('Back to 9')
    expect(d.message?.body).toContain('Cruel Summer')
  })

  it('prefers the rung alert to a per-play one when entering the zone', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_424, lastMilestone: 15 })
    const d = decideRaceAlert(snap(10_439, 10_429), prev, MILESTONES, NOW) // gap 15 → 10
    expect(d.kind).toBe('per-play') // 10 is the fine zone floor, so it counts as a play
    expect(d.message?.title).toBe('10 to go')
  })
})

describe('decideRaceAlert — the finish', () => {
  it('calls a dead heat when the counts level', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_438, lastMilestone: 10, lastAnnouncedGap: 1 })
    const d = decideRaceAlert(snap(10_439, 10_439), prev, MILESTONES, NOW)
    expect(d.kind).toBe('overtake')
    expect(d.message?.title).toBe('Dead heat')
    expect(d.message?.priority).toBe('max')
    expect(d.state.overtakenAt).toEqual(NOW)
  })

  it('announces the overtake with the track that did it', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_439, lastMilestone: 10, lastAnnouncedGap: 0 })
    const d = decideRaceAlert(snap(10_439, 10_440), prev, MILESTONES, NOW)
    expect(d.kind).toBe('overtake')
    expect(d.message?.title).toContain('Maisie Peters')
    expect(d.message?.body).toContain('Body Better')
    expect(d.message?.body).toContain('new all-time #1')
    expect(d.message?.click).toBe('https://last.fm/t')
  })

  it('goes inert once the race is run, however the numbers move afterwards', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_440, overtakenAt: NOW })
    expect(decideRaceAlert(snap(10_439, 10_460), prev, MILESTONES, NOW).kind).toBe('none')
    expect(decideRaceAlert(snap(10_500, 10_460), prev, MILESTONES, NOW).kind).toBe('none')
  })

  it('collapses a downtime that spans the whole ladder into one overtake alert', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_099, lastMilestone: null })
    const d = decideRaceAlert(snap(10_439, 10_442), prev, MILESTONES, NOW) // gap 340 → -3
    expect(d.kind).toBe('overtake')
  })
})

describe('decideRaceAlert — quiet ticks', () => {
  it('returns immediately when neither count moved', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_065, lastMilestone: 300 })
    const d = decideRaceAlert(snap(10_439, 10_065), prev, MILESTONES, NOW)
    expect(d.kind).toBe('none')
    expect(d.state).toBe(prev)
  })
})

describe('tightestCrossed', () => {
  it('picks the smallest rung the gap is inside', () => {
    expect(tightestCrossed(374, MILESTONES)).toBeNull()
    expect(tightestCrossed(300, MILESTONES)).toBe(300)
    expect(tightestCrossed(120, MILESTONES)).toBe(150)
    expect(tightestCrossed(0, MILESTONES)).toBe(10)
  })
})

describe('decideNowPlayingAlert', () => {
  const playing = { artist: 'Maisie Peters', track: 'The Song That Made Me Believe', url: 'https://last.fm/x' }
  const none = { key: null, at: null }

  it('ignores anything that is not the challenger', () => {
    expect(decideNowPlayingAlert(null, 1, 'Maisie Peters', 'Taylor Swift', none, NOW)).toBeNull()
    expect(decideNowPlayingAlert(
      { artist: 'Taylor Swift', track: 'Cruel Summer', url: null },
      1, 'Maisie Peters', 'Taylor Swift', none, NOW,
    )).toBeNull()
  })

  it('says the song levels it when the gap is 1', () => {
    const a = decideNowPlayingAlert(playing, 1, 'Maisie Peters', 'Taylor Swift', none, NOW)
    expect(a?.message.body).toContain('draws level')
    expect(a?.message.priority).toBe('max')
  })

  it('shouts only at gap 0, where the next play actually takes the lead', () => {
    const a = decideNowPlayingAlert(playing, 0, 'Maisie Peters', 'Taylor Swift', none, NOW)
    expect(a?.message.title).toBe('THIS SONG TAKES THE LEAD')
    expect(a?.message.body).toContain('passes Taylor Swift')
    expect(a?.message.click).toBe('https://last.fm/x')
  })

  it('fires once per track, not once per poll', () => {
    const first = decideNowPlayingAlert(playing, 0, 'Maisie Peters', 'Taylor Swift', none, NOW)!
    const again = decideNowPlayingAlert(
      playing, 0, 'Maisie Peters', 'Taylor Swift',
      { key: first.key, at: NOW }, new Date(NOW.getTime() + 30_000),
    )
    expect(again).toBeNull()
  })

  it('re-arms for a genuine repeat play later on', () => {
    const first = decideNowPlayingAlert(playing, 0, 'Maisie Peters', 'Taylor Swift', none, NOW)!
    const later = decideNowPlayingAlert(
      playing, 0, 'Maisie Peters', 'Taylor Swift',
      { key: first.key, at: NOW }, new Date(NOW.getTime() + NOWPLAYING_REARM_MS + 1_000),
    )
    expect(later).not.toBeNull()
  })
})
