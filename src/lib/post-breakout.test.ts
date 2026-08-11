import { describe, it, expect } from 'vitest'
import {
  scoreOf, breakoutWeightsKey, breakoutThresholds, furthestRung, decideBreakout,
  isDigestDue, composeBreakoutDigest, excerpt, osloDayKey,
  type BreakoutBaseline, type BreakoutPost, type BreakoutState, type DigestRow,
} from './post-breakout.js'

const W = { favourites: 1, reblogs: 3, replies: 2 }
const KEY = breakoutWeightsKey(W)

function baseline(over: Partial<BreakoutBaseline> = {}): BreakoutBaseline {
  return {
    actorApId: 'https://skvip.lol/users/markus',
    actor: '@markus@skvip.lol',
    n: 200, windowDays: 90, median: 6, p90: 24, p99: 58,
    best: 88, bestApId: 'https://skvip.lol/x/older', secondBest: 74,
    ...over,
  }
}

function post(over: Partial<BreakoutPost> = {}): BreakoutPost {
  return {
    apId: 'https://skvip.lol/x/1',
    actorApId: 'https://skvip.lol/users/markus',
    url: 'https://skvip.lol/@markus/1',
    publishedAt: new Date('2026-08-10T09:00:00Z'),
    text: 'Toget står stille på Finse igjen.',
    visibility: 'public',
    favourites: 10, reblogs: 2, replies: 1,
    peak: 18, score: 18,
    ...over,
  }
}

function state(over: Partial<BreakoutState> = {}): BreakoutState {
  return {
    score: 18, peakScore: 18, rung: null, rungScore: null,
    p90At: null, p99At: null, bestAt: null, weightsKey: KEY,
    ...over,
  }
}

const T = (b = baseline(), candidateApId?: string) =>
  breakoutThresholds(b, { minPosts: 20, minScore: 10, candidateApId })

describe('scoreOf', () => {
  it('applies the weights', () => {
    expect(scoreOf({ favourites: 10, reblogs: 2, replies: 1 }, W)).toBe(18)
  })

  it('is zero for a post nobody touched', () => {
    expect(scoreOf({ favourites: 0, reblogs: 0, replies: 0 }, W)).toBe(0)
  })
})

describe('breakoutThresholds', () => {
  it('rounds percentiles up — a p90 of 23.4 fires at 24', () => {
    const t = T(baseline({ p90: 23.4, p99: 57.2 }))
    expect(t.p90).toBe(24)
    expect(t.p99).toBe(58)
  })

  it('lifts every rung to the floor when the account is quiet', () => {
    // The hazard this exists for: a fortnight of two-favourite posts puts p90 at 2.
    const t = breakoutThresholds(baseline({ p90: 2, p99: 3, best: 4, secondBest: 3 }),
      { minPosts: 20, minScore: 10 })
    expect(t.p90).toBe(10)
    expect(t.p99).toBe(11)
    expect(t.best).toBe(12)
  })

  it('forces the rungs strictly apart so the middle one is reachable', () => {
    // A flat population puts percentile_cont(0.9) and (0.99) on the same number; if
    // the rungs collided, a post would cross both at once and p99 could never fire
    // on its own.
    const t = T(baseline({ p90: 30, p99: 30, best: 30, secondBest: 30 }))
    expect(t.p99).toBeGreaterThan(t.p90)
    expect(t.best).toBeGreaterThan(t.p99)
  })

  it('makes the record rung one point past the current record', () => {
    expect(T(baseline({ best: 88 })).best).toBe(89)
  })

  it('does not make a post beat itself when it already holds the record', () => {
    const b = baseline({ best: 88, bestApId: 'https://skvip.lol/x/1', secondBest: 74 })
    // Judged against the runner-up, not against its own 88.
    expect(T(b, 'https://skvip.lol/x/1').best).toBe(75)
    // Any other post still has to clear the real record.
    expect(T(b, 'https://skvip.lol/x/2').best).toBe(89)
  })

  it('reports too few posts rather than arming a percentile over a handful', () => {
    const t = breakoutThresholds(baseline({ n: 8 }), { minPosts: 20, minScore: 10 })
    expect(t.established).toBe(false)
    expect(t.reason).toBe('too_few_posts')
  })
})

describe('furthestRung', () => {
  it('is inclusive on the threshold', () => {
    const t = T()
    expect(furthestRung(t.p90, t)).toBe('p90')
    expect(furthestRung(t.p90 - 1, t)).toBeNull()
  })

  it('returns the furthest rung, not the first', () => {
    const t = T()
    expect(furthestRung(t.p99, t)).toBe('p99')
    expect(furthestRung(t.best + 100, t)).toBe('best')
  })
})

describe('decideBreakout — seeding', () => {
  it('says nothing on the first sighting, however well the post is doing', () => {
    // The whole reason switching the feature on is not a notification storm.
    const d = decideBreakout(post({ peak: 500, score: 500 }), null, T(), baseline(), KEY)
    expect(d.kind).toBe('seeded')
    expect(d.message).toBeNull()
  })

  it('pre-marks the rung but stamps no time, so nothing counts as announced', () => {
    const d = decideBreakout(post({ peak: 500, score: 500 }), null, T(), baseline(), KEY)
    expect(d.state.rung).toBe('best')
    expect(d.state.bestAt).toBeNull()
    expect(d.state.p90At).toBeNull()
    expect(d.state.p99At).toBeNull()
  })

  it('re-seeds silently when the weights changed, keeping earlier stamps', () => {
    const fired = new Date('2026-07-01T10:00:00Z')
    const prev = state({ rung: 'p90', p90At: fired, weightsKey: 'f1-r1-y1' })
    const d = decideBreakout(post({ peak: 200, score: 200 }), prev, T(), baseline(), KEY)
    expect(d.kind).toBe('reseeded')
    expect(d.message).toBeNull()
    expect(d.state.p90At).toEqual(fired) // history is not lost, just not re-announced
    expect(d.state.weightsKey).toBe(KEY)
  })
})

describe('decideBreakout — the ladder', () => {
  const t = T()

  it('fires p90 once, then goes quiet on an identical tick', () => {
    const p = post({ peak: t.p90, score: t.p90 })
    const first = decideBreakout(p, state(), t, baseline(), KEY)
    expect(first.kind).toBe('p90')
    expect(first.message?.title).toBe('Dette innlegget går godt')
    expect(first.state.p90At).not.toBeNull()

    const second = decideBreakout(p, first.state, t, baseline(), KEY)
    expect(second.kind).toBe('none')
    expect(second.message).toBeNull()
  })

  it('announces only the furthest rung when several are crossed at once', () => {
    // Record 0015's rule: saying "over your p90" about a post that has just taken the
    // record is worse than saying nothing.
    const d = decideBreakout(post({ peak: t.best + 5, score: t.best + 5 }), state(), t, baseline(), KEY)
    expect(d.kind).toBe('best')
    expect(d.state.rung).toBe('best')
    expect(d.state.p90At).toBeNull()
    expect(d.state.p99At).toBeNull()
  })

  it('never announces a rung at or below one already spent', () => {
    const prev = state({ rung: 'p99', peakScore: t.p99, p99At: new Date() })
    const d = decideBreakout(post({ peak: t.p99, score: t.p99 }), prev, t, baseline(), KEY)
    expect(d.kind).toBe('none')
  })

  it('still climbs from a spent rung to a further one', () => {
    const prev = state({ rung: 'p90', peakScore: t.p90, p90At: new Date() })
    const d = decideBreakout(post({ peak: t.p99, score: t.p99 }), prev, t, baseline(), KEY)
    expect(d.kind).toBe('p99')
  })
})

describe('decideBreakout — counts going down', () => {
  const t = T()

  it('keeps the rung and the peak when engagement is withdrawn', () => {
    const fired = decideBreakout(post({ peak: t.p99, score: t.p99 }), state(), t, baseline(), KEY)
    expect(fired.kind).toBe('p99')

    // Someone un-favourites; the live score falls well under the rung.
    const dropped = decideBreakout(
      post({ peak: t.p99, score: t.p90 - 5 }), fired.state, t, baseline(), KEY,
    )
    expect(dropped.kind).toBe('none')
    expect(dropped.state.peakScore).toBe(t.p99)
    expect(dropped.state.rung).toBe('p99')
    // The live score is still recorded — the divergence is the interesting part.
    expect(dropped.state.score).toBe(t.p90 - 5)
  })

  it('does not re-fire when the post climbs back to a height it already announced', () => {
    const fired = decideBreakout(post({ peak: t.p99, score: t.p99 }), state(), t, baseline(), KEY)
    const dropped = decideBreakout(post({ peak: t.p99, score: 5 }), fired.state, t, baseline(), KEY)
    const back = decideBreakout(post({ peak: t.p99, score: t.p99 }), dropped.state, t, baseline(), KEY)
    expect(back.kind).toBe('none')
    expect(back.message).toBeNull()
  })
})

describe('excerpt', () => {
  it('flattens whitespace and truncates', () => {
    expect(excerpt('a\n\n  b', 80)).toBe('a b')
    expect(excerpt('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`)
  })

  it('has something to say about a post with no text', () => {
    expect(excerpt(null)).toBe('(utan tekst)')
  })
})

describe('isDigestDue', () => {
  const at = (iso: string) => new Date(iso)

  it('is never due when disabled', () => {
    expect(isDigestDue({ hour: -1, lastSentAt: null, now: at('2026-08-10T23:00:00Z') })).toBe(false)
  })

  it('waits for the Oslo hour', () => {
    // 18:00 UTC in August is 20:00 in Oslo — one hour early for a 21:00 digest.
    expect(isDigestDue({ hour: 21, lastSentAt: null, now: at('2026-08-10T18:00:00Z') })).toBe(false)
    expect(isDigestDue({ hour: 21, lastSentAt: null, now: at('2026-08-10T19:00:00Z') })).toBe(true)
  })

  it('goes out once per Oslo day', () => {
    const sent = at('2026-08-10T19:30:00Z')
    expect(isDigestDue({ hour: 21, lastSentAt: sent, now: at('2026-08-10T20:30:00Z') })).toBe(false)
    expect(isDigestDue({ hour: 21, lastSentAt: sent, now: at('2026-08-11T19:30:00Z') })).toBe(true)
  })

  it('keys the day in Oslo, not UTC — CEST and CET both', () => {
    // 22:30 UTC on 10 Aug is already 00:30 on 11 Aug in Oslo (CEST, UTC+2)…
    expect(osloDayKey(at('2026-08-10T22:30:00Z'))).toBe('2026-08-11')
    // …while in January Oslo is UTC+1, so the same clock time is still 10 January.
    // A UTC day key would get one of these two wrong for half the year.
    expect(osloDayKey(at('2026-01-10T22:30:00Z'))).toBe('2026-01-10')
  })

  it('does not re-fire just past Oslo midnight, when the new day is only minutes old', () => {
    // 22:30 UTC = 00:30 Oslo on the 11th. The day key HAS rolled over, so the
    // once-per-day guard no longer suppresses it — the hour check is the only thing
    // standing between this and a second digest half an hour after the first.
    expect(isDigestDue({
      hour: 21, lastSentAt: at('2026-08-10T19:30:00Z'), now: at('2026-08-10T22:30:00Z'),
    })).toBe(false)
  })

  it('fires again the next evening, ~21 hours after the last one', () => {
    expect(isDigestDue({
      hour: 21, lastSentAt: at('2026-08-10T19:30:00Z'), now: at('2026-08-11T19:00:00Z'),
    })).toBe(true)
  })

  it('catches up after downtime rather than skipping the day', () => {
    // Booted at 23:00 Oslo having missed 21:00: still due, because the guard is
    // "not yet today", not "exactly at the hour".
    expect(isDigestDue({
      hour: 21, lastSentAt: at('2026-08-08T19:30:00Z'), now: at('2026-08-10T21:00:00Z'),
    })).toBe(true)
  })
})

describe('composeBreakoutDigest', () => {
  const row = (over: Partial<DigestRow> = {}): DigestRow => ({
    actor: '@markus@skvip.lol',
    rung: 'p90',
    firedAt: new Date('2026-08-10T12:00:00Z'),
    score: 30,
    text: 'Eit innlegg',
    url: 'https://skvip.lol/@markus/1',
    ...over,
  })

  it('says nothing at all on a day where nothing moved', () => {
    const d = composeBreakoutDigest([], { favourites: 0, reblogs: 0, replies: 0 }, [baseline()])
    expect(d).toBeNull()
  })

  it('still reports a day where nothing crossed a rung but engagement came in', () => {
    const d = composeBreakoutDigest([], { favourites: 12, reblogs: 1, replies: 3 }, [baseline()])
    expect(d).not.toBeNull()
    expect(d!.body).toContain('+12 hjarte')
  })

  it('names the rungs and the day\'s best post', () => {
    const d = composeBreakoutDigest(
      [row({ score: 30 }), row({ rung: 'best', score: 92, text: 'Toppinnlegget' })],
      { favourites: 41, reblogs: 6, replies: 3 },
      [baseline()],
    )
    expect(d!.title).toContain('2 innlegg')
    expect(d!.body).toContain('ny rekord')
    expect(d!.body).toContain('Dagens beste: «Toppinnlegget»')
    expect(d!.priority).toBe('low') // lands in the list without buzzing
  })
})
