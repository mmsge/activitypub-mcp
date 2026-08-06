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
    endgameArmedAt: null,
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

  it('seeds a dead heat as still live — level is not won', () => {
    const d = decideRaceAlert(snap(10_439, 10_439), null, MILESTONES, NOW)
    expect(d.message).toBeNull()
    expect(d.state.overtakenAt).toBeNull()
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

describe('decideRaceAlert — the armed rungs', () => {
  // The scrobbler reports what finished playing, never what is about to start, so the
  // only honest "this one wins it" is one play early.
  it('warns at 1 that the next play levels it', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_437, lastMilestone: 10, lastAnnouncedGap: 2 })
    const d = decideRaceAlert(snap(10_439, 10_438), prev, MILESTONES, NOW)
    expect(d.kind).toBe('armed')
    expect(d.message?.priority).toBe('max')
    expect(d.message?.body).toContain('One more Maisie Peters play levels it')
  })

  it('arms you at a dead heat: the next play you choose takes #1', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_438, lastMilestone: 10, lastAnnouncedGap: 1 })
    const d = decideRaceAlert(snap(10_439, 10_439), prev, MILESTONES, NOW)
    expect(d.kind).toBe('level')
    expect(d.message?.title).toBe('Next Maisie Peters song wins it')
    expect(d.message?.body).toContain('play next takes the all-time #1')
    expect(d.message?.priority).toBe('max')
  })

  // The bug this replaced: a dead heat set overtakenAt, the watcher went inert, and
  // the actual overtake — the alert the whole feature exists for — never fired.
  it('stays live through a dead heat and still announces the real overtake', () => {
    const atOne = state({ leaderPlays: 10_439, challengerPlays: 10_438, lastMilestone: 10, lastAnnouncedGap: 1 })
    const level = decideRaceAlert(snap(10_439, 10_439), atOne, MILESTONES, NOW)
    expect(level.state.overtakenAt).toBeNull()

    const ahead = decideRaceAlert(snap(10_439, 10_440), level.state, MILESTONES, NOW)
    expect(ahead.kind).toBe('overtake')
    expect(ahead.state.overtakenAt).toEqual(NOW)
  })

  it('re-arms the dead heat if the leader answers and is caught again', () => {
    const level = state({ leaderPlays: 10_439, challengerPlays: 10_439, lastMilestone: 10, lastAnnouncedGap: 0 })
    const answered = decideRaceAlert(snap(10_440, 10_439), level, MILESTONES, NOW)
    expect(answered.kind).toBe('armed')

    const caught = decideRaceAlert(snap(10_440, 10_440), answered.state, MILESTONES, NOW)
    expect(caught.kind).toBe('level')
  })
})

describe('decideRaceAlert — the finish', () => {
  it('announces the overtake with the track that did it', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_439, lastMilestone: 10, lastAnnouncedGap: 0 })
    const d = decideRaceAlert(snap(10_439, 10_440), prev, MILESTONES, NOW)
    expect(d.kind).toBe('overtake')
    expect(d.message?.title).toContain('Maisie Peters')
    expect(d.message?.body).toContain('Body Better')
    expect(d.message?.body).toContain('new all-time #1')
    expect(d.message?.click).toBe('https://last.fm/t')
  })

  // The lead changed when the track was played, not when a sync happened to notice.
  // With a 60s poll those differ by up to a minute, and the ingest clock is the one
  // detail about the moment that isn't worth keeping.
  it('stamps overtaken_at with the causing play, not the time of the sync', () => {
    const PLAYED = new Date('2026-09-14T18:59:12Z')
    const INGESTED = new Date('2026-09-14T19:04:00Z')
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_439, lastMilestone: 10, lastAnnouncedGap: 0 })
    const d = decideRaceAlert(
      snap(10_439, 10_440, {
        latestChallengerPlay: { track: 'Body Better', url: null, playedAt: PLAYED },
      }),
      prev, MILESTONES, INGESTED,
    )
    expect(d.kind).toBe('overtake')
    expect(d.state.overtakenAt).toEqual(PLAYED)
    expect(d.state.overtakenAt).not.toEqual(INGESTED)
  })

  it('falls back to the sync time when the causing play cannot be identified', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_439, lastMilestone: 10, lastAnnouncedGap: 0 })
    const d = decideRaceAlert(
      snap(10_439, 10_440, { latestChallengerPlay: null }), prev, MILESTONES, NOW,
    )
    expect(d.kind).toBe('overtake')
    expect(d.state.overtakenAt).toEqual(NOW)
  })

  it('never overwrites overtaken_at once the race is run', () => {
    const FINISHED = new Date('2026-09-14T18:59:12Z')
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_440, overtakenAt: FINISHED })
    const d = decideRaceAlert(snap(10_439, 10_480), prev, MILESTONES, NOW)
    expect(d.kind).toBe('none')
    expect(d.state.overtakenAt).toEqual(FINISHED)
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

describe('decideRaceAlert — the configurable countdown band', () => {
  it('counts down from a band wider than the smallest milestone', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_399, lastMilestone: 50 })
    // gap 40 is far outside the default fine zone of 10, but inside a band of 50.
    const d = decideRaceAlert(snap(10_439, 10_400), prev, MILESTONES, NOW, 50) // gap 39
    expect(d.kind).toBe('per-play')
    expect(d.message?.title).toBe('39 to go')
  })

  // Narrowing the band hands the range back to the ladder rather than silencing it:
  // gap 8 is outside a band of 3, so the unspent "under 10" rung gets to speak.
  it('hands a narrowed band back to the ladder', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_428, lastMilestone: 15 })
    const d = decideRaceAlert(snap(10_439, 10_431), prev, MILESTONES, NOW, 3) // gap 8
    expect(d.kind).toBe('milestone')
    expect(d.message?.body).toContain('Under 10 for the first time')
  })

  it('says nothing outside the band once the ladder is spent', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_429, lastMilestone: 10 })
    const d = decideRaceAlert(snap(10_439, 10_431), prev, MILESTONES, NOW, 3) // gap 8
    expect(d.kind).toBe('none')
    expect(d.message).toBeNull()
  })

  it('defaults to the smallest milestone, so callers that omit it are unchanged', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_428, lastMilestone: 15 })
    const withDefault = decideRaceAlert(snap(10_439, 10_431), prev, MILESTONES, NOW)
    const explicit = decideRaceAlert(snap(10_439, 10_431), prev, MILESTONES, NOW, 10)
    expect(withDefault.kind).toBe('per-play')
    expect(withDefault).toStrictEqual(explicit)
  })

  // The band is the countdown, not the finish. Record 0016's decisive rungs work off
  // scrobbles alone and must survive any band, including one that switches the generic
  // countdown off entirely.
  it('still fires gap 1, gap 0 and the overtake with the band set to 0', () => {
    const atTwo = state({ leaderPlays: 10_439, challengerPlays: 10_437, lastMilestone: 10 })
    expect(decideRaceAlert(snap(10_439, 10_437), atTwo, MILESTONES, NOW, 0).kind).toBe('none')

    const armed = decideRaceAlert(snap(10_439, 10_438), atTwo, MILESTONES, NOW, 0)
    expect(armed.kind).toBe('armed')

    const level = decideRaceAlert(snap(10_439, 10_439), armed.state, MILESTONES, NOW, 0)
    expect(level.kind).toBe('level')

    const over = decideRaceAlert(snap(10_439, 10_440), level.state, MILESTONES, NOW, 0)
    expect(over.kind).toBe('overtake')
  })

  it('lets the ladder keep speaking above the band', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_339, lastMilestone: 150 })
    const d = decideRaceAlert(snap(10_439, 10_364), prev, MILESTONES, NOW, 10) // gap 75
    expect(d.kind).toBe('milestone')
    // Exactly ON the rung, so "at", not "under" — this assertion carried the very
    // off-by-one it was meant to pin until decision record 0029.
    expect(d.message?.body).toContain('At 75 for the first time')
  })
})

describe('decideRaceAlert — the arming latch', () => {
  it('latches on the first observation inside the band', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_420, lastMilestone: 20 })
    expect(prev.endgameArmedAt).toBeNull()
    const d = decideRaceAlert(snap(10_439, 10_429), prev, MILESTONES, NOW, 10) // gap 10
    expect(d.state.endgameArmedAt).toEqual(NOW)
  })

  it('does not arm while the gap is still above the band', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_400, lastMilestone: 50 })
    const d = decideRaceAlert(snap(10_439, 10_410), prev, MILESTONES, NOW, 10) // gap 29
    expect(d.state.endgameArmedAt).toBeNull()
  })

  // A level would flicker off here; a latch does not. The race got to its endgame, and
  // the leader answering back does not undo that.
  it('stays armed after the leader pushes the gap back out of the band', () => {
    const LATER = new Date('2026-09-15T08:00:00Z')
    const armed = state({
      leaderPlays: 10_439, challengerPlays: 10_431, lastMilestone: 10,
      lastAnnouncedGap: 8, endgameArmedAt: NOW,
    })
    const widened = decideRaceAlert(snap(10_479, 10_431), armed, MILESTONES, LATER, 10) // gap 48
    expect(widened.state.endgameArmedAt).toEqual(NOW)
  })

  it('survives the overtake rather than clearing at the finish', () => {
    const armed = state({
      leaderPlays: 10_439, challengerPlays: 10_439, lastMilestone: 10,
      lastAnnouncedGap: 0, endgameArmedAt: NOW,
    })
    const d = decideRaceAlert(snap(10_439, 10_440), armed, MILESTONES, NOW, 10)
    expect(d.kind).toBe('overtake')
    expect(d.state.endgameArmedAt).toEqual(NOW)
  })

  it('arms on seeding when the feature is switched on already inside the band', () => {
    const d = decideRaceAlert(snap(10_439, 10_435), null, MILESTONES, NOW, 10) // gap 4
    expect(d.kind).toBe('seeded')
    expect(d.state.endgameArmedAt).toEqual(NOW)
  })
})

describe('decideRaceAlert — quiet ticks', () => {
  it('returns immediately when neither count moved, changing nothing', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_065, lastMilestone: 300 })
    const d = decideRaceAlert(snap(10_439, 10_065), prev, MILESTONES, NOW)
    expect(d.kind).toBe('none')
    expect(d.message).toBeNull()
    expect(d.state).toStrictEqual(prev)
  })

  // The one thing a quiet tick DOES update. Widening the band should show up as armed
  // on the next tick rather than waiting for a play that may be hours away — the job
  // already persists state on every silent tick, so this costs no extra write.
  it('arms on a quiet tick when the band was widened to include the current gap', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_065, lastMilestone: 300 })
    const d = decideRaceAlert(snap(10_439, 10_065), prev, MILESTONES, NOW, 400) // gap 374
    expect(d.kind).toBe('none')
    expect(d.message).toBeNull()
    expect(d.state.endgameArmedAt).toEqual(NOW)
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

describe('decideRaceAlert — the exact boundaries', () => {
  // The rung comparison is inclusive on purpose (see tightestCrossed), which makes the
  // copy the thing that has to be right: at a gap of exactly 250, "Under 250" is simply
  // false, however correct the "250 to go" title is. Decision record 0029.
  it('says "At 250" when the gap lands exactly on the rung', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_188, lastMilestone: 300 })
    const d = decideRaceAlert(snap(10_439, 10_189), prev, MILESTONES, NOW) // gap exactly 250
    expect(d.kind).toBe('milestone')
    expect(d.message?.title).toBe('250 to go')
    expect(d.message?.body).toContain('At 250 for the first time')
    expect(d.message?.body).not.toContain('Under 250')
    expect(d.state.lastMilestone).toBe(250)
  })

  it('still says "Under 250" when the gap is genuinely inside the rung', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_185, lastMilestone: 300 })
    const d = decideRaceAlert(snap(10_439, 10_192), prev, MILESTONES, NOW) // gap 247
    expect(d.kind).toBe('milestone')
    expect(d.message?.title).toBe('247 to go')
    expect(d.message?.body).toContain('Under 250 for the first time')
  })

  it('treats a gap exactly equal to the countdown band as inside it', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_428, lastMilestone: 15, lastAnnouncedGap: 11 })
    const d = decideRaceAlert(snap(10_439, 10_429), prev, MILESTONES, NOW, 10) // gap exactly 10
    expect(d.kind).toBe('per-play')
    expect(d.message?.title).toBe('10 to go')
    expect(d.state.endgameArmedAt).toEqual(NOW)
  })

  it('at exactly 1 promises a level, never a win', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_437, lastMilestone: 10, lastAnnouncedGap: 2 })
    const d = decideRaceAlert(snap(10_439, 10_438), prev, MILESTONES, NOW)
    expect(d.kind).toBe('armed')
    expect(d.message?.title).toBe('1 to go — next one levels it')
    expect(d.message?.body).toContain('One more Maisie Peters play levels it')
    expect(d.state.overtakenAt).toBeNull()
  })

  it('at exactly 0 promises the lead, and a dead heat is still not the finish', () => {
    const prev = state({ leaderPlays: 10_439, challengerPlays: 10_438, lastMilestone: 10, lastAnnouncedGap: 1 })
    const d = decideRaceAlert(snap(10_439, 10_439), prev, MILESTONES, NOW)
    expect(d.kind).toBe('level')
    expect(d.message?.title).toBe('Next Maisie Peters song wins it')
    expect(d.state.overtakenAt).toBeNull()
  })
})

describe('tightestCrossed — the rung is inclusive', () => {
  it('is crossed on the number, not one play past it', () => {
    expect(tightestCrossed(251, MILESTONES)).toBe(300)
    expect(tightestCrossed(250, MILESTONES)).toBe(250)
    expect(tightestCrossed(249, MILESTONES)).toBe(250)
  })

  it('sits on the floor rung at and below a dead heat', () => {
    expect(tightestCrossed(10, MILESTONES)).toBe(10)
    expect(tightestCrossed(0, MILESTONES)).toBe(10)
  })
})
