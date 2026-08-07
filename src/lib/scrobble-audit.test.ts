import { describe, it, expect, vi } from 'vitest'

// The classification must be decidable from numbers alone. Mocking the DB into throwing
// is how we prove it, in the style of scrobble-race.test.ts.
const getDb = vi.fn(() => { throw new Error('the audit classifier must not touch the database') })
vi.mock('../db/client.js', () => ({ getDb }))

const {
  classify, cutFor, tally, summarise, THRESHOLDS,
  SESSION_CEILING_SECONDS,
} = await import('./scrobble-audit.js')
type GapGroup = import('./scrobble-audit.js').GapGroup
type ThresholdId = import('./scrobble-audit.js').ThresholdId

const at = (id: ThresholdId) => THRESHOLDS.find(t => t.id === id)!

const group = (over: Partial<GapGroup> = {}): GapGroup => ({
  artistName: 'Maisie Peters',
  year: 2026,
  playSeconds: 210,
  estSeconds: 200,
  plays: 1,
  ...over,
})

describe('classify', () => {
  // The sequence that settled the diagnosis: "Mary Janes" played through once at 237s,
  // then restarted three times inside sixteen seconds. Only the first is a real play.
  const MARY_JANES = 237
  const played = (playSeconds: number) => group({ playSeconds, estSeconds: MARY_JANES })

  it('calls the full 237 s play genuine at every threshold', () => {
    for (const t of THRESHOLDS) expect(classify(played(MARY_JANES), t)).toBe('kept')
  })

  it('calls the two obvious restarts suspect at every threshold', () => {
    for (const seconds of [15, 1]) {
      for (const t of THRESHOLDS) {
        expect(classify(played(seconds), t), `${seconds}s at ${t.id}`).toBe('suspect')
      }
    }
  })

  // The whole reason the audit reports a spectrum: the 99 s restart of a 237 s track is
  // plainly not a play Last.fm should have counted, and the two absolute thresholds miss
  // it entirely. Where the line goes changes the answer.
  it('catches the 99 s restart only under the length-relative thresholds', () => {
    expect(classify(played(99), at('lt30s'))).toBe('kept')
    expect(classify(played(99), at('lt60s'))).toBe('kept')
    expect(classify(played(99), at('halfDuration'))).toBe('suspect')
    expect(classify(played(99), at('lastfmRule'))).toBe('suspect')
  })

  it('is exclusive on the number: exactly 30 s is not "under 30 s"', () => {
    expect(classify(played(29), at('lt30s'))).toBe('suspect')
    expect(classify(played(30), at('lt30s'))).toBe('kept')
  })

  it('halves the estimated length, so a 200 s track flips between 99 s and 100 s', () => {
    expect(classify(group({ playSeconds: 99, estSeconds: 200 }), at('halfDuration'))).toBe('suspect')
    expect(classify(group({ playSeconds: 100, estSeconds: 200 }), at('halfDuration'))).toBe('kept')
  })

  it('caps the Last.fm rule at four minutes, so a long track counts sooner', () => {
    // A 12-minute track: half is 360 s, but Last.fm stops asking at 240 s.
    const long = { playSeconds: 250, estSeconds: 720 }
    expect(classify(long, at('halfDuration'))).toBe('suspect')
    expect(classify(long, at('lastfmRule'))).toBe('kept')
  })

  it('agrees with half-duration for any ordinary song', () => {
    for (const t of ['halfDuration', 'lastfmRule'] as const) {
      expect(classify(group({ playSeconds: 90, estSeconds: 185 }), at(t))).toBe('suspect')
    }
  })

  it('calls the newest row in the history unbounded, never suspect', () => {
    expect(classify(group({ playSeconds: null }), at('lt30s'))).toBe('unbounded')
  })

  it('calls a gap past the session ceiling unbounded, however short the track', () => {
    expect(classify(group({ playSeconds: SESSION_CEILING_SECONDS + 1 }), at('lt30s'))).toBe('unbounded')
    expect(classify(group({ playSeconds: SESSION_CEILING_SECONDS }), at('lt30s'))).toBe('kept')
  })

  it('refuses to guess a length rather than inventing one', () => {
    expect(classify(group({ playSeconds: 5, estSeconds: null }), at('halfDuration'))).toBe('no-estimate')
    expect(classify(group({ playSeconds: 5, estSeconds: null }), at('lastfmRule'))).toBe('no-estimate')
  })

  it('never needs an estimate for a fixed threshold', () => {
    expect(classify(group({ playSeconds: 5, estSeconds: null }), at('lt30s'))).toBe('suspect')
    expect(classify(group({ playSeconds: 500, estSeconds: null }), at('lt60s'))).toBe('kept')
  })

  it('lets unknowable win over unestimated', () => {
    expect(classify(group({ playSeconds: null, estSeconds: null }), at('halfDuration'))).toBe('unbounded')
  })
})

describe('cutFor', () => {
  it('reads a fixed threshold straight off the spec', () => {
    expect(cutFor(at('lt60s'), 200)).toBe(60)
  })

  it('has no cut at all without a trusted length', () => {
    expect(cutFor(at('halfDuration'), null)).toBeNull()
    expect(cutFor(at('lastfmRule'), null)).toBeNull()
  })
})

describe('tally', () => {
  it('counts a grouped row once per play, not once per group', () => {
    const t = tally([group({ playSeconds: 5, plays: 37 })], at('lt30s'))
    expect(t.plays).toBe(37)
    expect(t.suspect).toBe(37)
  })

  it('keeps unbounded plays inside the total and outside the suspect count', () => {
    const t = tally([group({ playSeconds: null, plays: 4 }), group({ playSeconds: 5, plays: 2 })], at('lt30s'))
    expect(t).toMatchObject({ plays: 6, suspect: 2, unbounded: 4, kept: 0 })
  })

  it('reports untrusted-estimate plays separately, and as kept', () => {
    const t = tally([group({ playSeconds: 5, estSeconds: null, plays: 3 })], at('halfDuration'))
    expect(t).toMatchObject({ kept: 3, noEstimate: 3, suspect: 0 })
  })

  it('never lets suspect plus unbounded plus kept drift from the total', () => {
    const rows = [
      group({ playSeconds: 5, plays: 3 }),
      group({ playSeconds: null, plays: 2 }),
      group({ playSeconds: 300, plays: 7 }),
      group({ playSeconds: 5, estSeconds: null, plays: 4 }),
    ]
    for (const t of THRESHOLDS) {
      const o = tally(rows, t)
      expect(o.suspect + o.unbounded + o.kept + o.collisions).toBe(o.plays)
    }
  })
})

describe('summarise — the corrected race', () => {
  const opts = { leader: 'Taylor Swift', challenger: 'Maisie Peters' }
  const rows: GapGroup[] = [
    { artistName: 'Taylor Swift', year: 2024, playSeconds: 200, estSeconds: 200, plays: 100 },
    { artistName: 'Taylor Swift', year: 2026, playSeconds: 10, estSeconds: 200, plays: 5 },
    { artistName: 'Maisie Peters', year: 2026, playSeconds: 200, estSeconds: 200, plays: 60 },
    { artistName: 'Maisie Peters', year: 2026, playSeconds: 10, estSeconds: 200, plays: 40 },
  ]

  it('leaves the raw totals untouched and subtracts only suspect plays', () => {
    const line = summarise(rows, opts).race.find(l => l.threshold === 'lt30s')!
    expect(line.leaderPlays).toBe(105)
    expect(line.challengerPlays).toBe(100)
    expect(line.gap).toBe(5)
    expect(line.correctedGap).toBe(100 - 60) // 105−5 leader, 100−40 challenger
    expect(line.gapDelta).toBe(35)
  })

  it('reports a line for every threshold, so the sensitivity is visible', () => {
    expect(summarise(rows, opts).race.map(l => l.threshold))
      .toEqual(THRESHOLDS.map(t => t.id))
  })

  it('measures every delta against the raw gap, not against the previous threshold', () => {
    for (const l of summarise(rows, opts).race) {
      expect(l.gapDelta).toBe(l.correctedGap - l.gap)
      expect(l.gap).toBe(5)
    }
  })

  it('reports zeroes rather than omitting a racer with no plays at all', () => {
    const s = summarise([rows[2]], opts)
    expect(s.perArtist[0]).toMatchObject({ artist: 'Taylor Swift' })
    expect(s.perArtist[0].totals.lt30s.plays).toBe(0)
    expect(s.race[0].leaderPlays).toBe(0)
  })

  it('always lists both racers first, whatever their volume', () => {
    const withOther: GapGroup[] = [
      ...rows,
      { artistName: 'Lorde', year: 2026, playSeconds: 200, estSeconds: 200, plays: 9_000 },
    ]
    expect(summarise(withOther, opts).perArtist.map(a => a.artist).slice(0, 3))
      .toEqual(['Taylor Swift', 'Maisie Peters', 'Lorde'])
  })
})

describe('summarise — the time series', () => {
  it('buckets by year in order, so the year the behaviour started is visible', () => {
    const s = summarise([
      { artistName: 'A', year: 2026, playSeconds: 10, estSeconds: 200, plays: 7 },
      { artistName: 'A', year: 2024, playSeconds: 200, estSeconds: 200, plays: 93 },
      { artistName: 'A', year: 2026, playSeconds: 200, estSeconds: 200, plays: 93 },
    ], { leader: 'A', challenger: 'B' })

    expect(s.byYear.map(y => y.year)).toEqual([2024, 2026])
    expect(s.byYear[0]).toMatchObject({ plays: 93, suspectUnder60s: 0, pct: 0 })
    expect(s.byYear[1]).toMatchObject({ plays: 100, suspectUnder60s: 7 })
    expect(s.byYear[1].pct).toBeCloseTo(7)
  })

  it('keeps a clean year in the series rather than dropping it', () => {
    const s = summarise([
      { artistName: 'A', year: 2016, playSeconds: 200, estSeconds: 200, plays: 12 },
    ], { leader: 'A', challenger: 'B' })
    expect(s.byYear).toHaveLength(1)
    expect(s.byYear[0].suspectUnder60s).toBe(0)
  })
})

describe('the audit classifier is read-only', () => {
  it('folds a whole history without ever reaching for a database', () => {
    summarise(
      Array.from({ length: 500 }, (_, i) => group({ playSeconds: i, plays: i })),
      { leader: 'Taylor Swift', challenger: 'Maisie Peters' },
    )
    expect(getDb).not.toHaveBeenCalled()
  })
})

/**
 * A gap of exactly zero is two scrobbles carrying the same timestamp — a batch submission
 * with a collided `uts`. It cannot be a repeat of the same track, because the dedupe index
 * would have collapsed that on insert. The first production run counted these as plays
 * that were cut short, which they are not: the timestamp is wrong, the play may well have
 * run to the end.
 */
describe('classify — a collided timestamp is not a short play', () => {
  it('calls a zero gap a collision at every threshold', () => {
    for (const t of THRESHOLDS) {
      expect(classify({ playSeconds: 0, estSeconds: 200 }, t), t.id).toBe('collision')
    }
  })

  it('does not need a duration estimate to recognise one', () => {
    expect(classify({ playSeconds: 0, estSeconds: null }, at('halfDuration'))).toBe('collision')
  })

  // The boundary that keeps this from swallowing genuine instant skips.
  it('still calls a one-second gap suspect', () => {
    expect(classify({ playSeconds: 1, estSeconds: 200 }, at('lt30s'))).toBe('suspect')
  })

  it('lets unknowable still win — a null gap is unbounded, not a collision', () => {
    expect(classify({ playSeconds: null, estSeconds: 200 }, at('lt30s'))).toBe('unbounded')
  })
})

describe('tally — collisions are their own bucket', () => {
  it('counts them apart from suspect and from kept', () => {
    const t = tally([group({ playSeconds: 0, plays: 12 })], at('lt30s'))
    expect(t).toMatchObject({ plays: 12, collisions: 12, suspect: 0, kept: 0, unbounded: 0 })
  })

  it('keeps the four buckets summing to the total', () => {
    const rows = [
      group({ playSeconds: 0, plays: 12 }),
      group({ playSeconds: 5, plays: 3 }),
      group({ playSeconds: null, plays: 2 }),
      group({ playSeconds: 300, plays: 7 }),
    ]
    for (const t of THRESHOLDS) {
      const o = tally(rows, t)
      expect(o.suspect + o.kept + o.unbounded + o.collisions).toBe(o.plays)
    }
  })
})

describe('summarise — collisions never move the race', () => {
  it('leaves the corrected gap untouched when both sides collide', () => {
    const base: GapGroup[] = [
      { artistName: 'Taylor Swift', year: 2026, playSeconds: 200, estSeconds: 200, plays: 100 },
      { artistName: 'Maisie Peters', year: 2026, playSeconds: 200, estSeconds: 200, plays: 90 },
    ]
    const withCollisions: GapGroup[] = [
      ...base,
      { artistName: 'Taylor Swift', year: 2026, playSeconds: 0, estSeconds: 200, plays: 25 },
      { artistName: 'Maisie Peters', year: 2026, playSeconds: 0, estSeconds: 200, plays: 40 },
    ]
    const opts = { leader: 'Taylor Swift', challenger: 'Maisie Peters' }

    const before = summarise(base, opts).race.find(l => l.threshold === 'lt30s')!
    const after = summarise(withCollisions, opts).race.find(l => l.threshold === 'lt30s')!

    // The raw gap moves, because collisions are still real stored rows Last.fm counts.
    expect(before.gap).toBe(10)
    expect(after.gap).toBe(-5)
    // But the *correction* is zero on both sides: no collision is ever called suspect.
    expect(after.leaderSuspect).toBe(0)
    expect(after.challengerSuspect).toBe(0)
    expect(after.gapDelta).toBe(0)
    expect(before.gapDelta).toBe(0)
  })
})
