import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BreakoutState as BreakoutStateShape } from '../lib/post-breakout.js'
import type { NtfyMessage, NtfyTarget } from '../lib/ntfy.js'

/** The notifier, typed, so `notify.mock.calls[0][1]` is the target rather than never. */
const notifier = (result: boolean | boolean[]) => {
  const results = Array.isArray(result) ? [...result] : null
  return vi.fn(async (_m: NtfyMessage, _t?: NtfyTarget) =>
    results ? (results.shift() ?? true) : (result as boolean))
}

// Mocking the store lets us prove the job's contract — above all that a failed push
// leaves state untouched — without a database. getDb throws so a query that slipped
// past the store is a loud failure rather than a silent one.
const resolveBreakoutActors = vi.fn()
const loadBreakoutBaseline = vi.fn()
const loadBreakoutCandidates = vi.fn()
const loadBreakoutStates = vi.fn()
// Typed so the assertions can read mock.calls without tsc treating them as empty tuples.
const saveBreakoutState = vi.fn(
  async (_statusApId: string, _actorApId: string, _state: BreakoutStateShape) => {},
)
vi.mock('../lib/breakout-store.js', () => ({
  resolveBreakoutActors, loadBreakoutBaseline, loadBreakoutCandidates,
  loadBreakoutStates, saveBreakoutState,
}))
vi.mock('../db/client.js', () => ({
  getDb: () => { throw new Error('the breakout job must go through breakout-store') },
}))

const { config } = await import('../config.js')
const { runPostBreakout } = await import('./post-breakout.js')
const { breakoutWeightsKey } = await import('../lib/post-breakout.js')

const KEY = breakoutWeightsKey({ favourites: 1, reblogs: 3, replies: 2 })
const ACTOR = 'https://skvip.lol/users/markus'

/** vitest.config.ts leaves BREAKOUT_* at their defaults — the feature must be inert
 *  out of the box — so arm it here for the tests that need it live. */
function arm(over: Record<string, unknown> = {}) {
  Object.assign(config, {
    BREAKOUT_ENABLED: true,
    NTFY_PASSWORD: 'hunter2',
    NTFY_TOPIC_BREAKOUT: 'tut-treff',
    NTFY_TOPIC: 'scrobble-race',
    BREAKOUT_MIN_POSTS: 20,
    BREAKOUT_MIN_SCORE: 10,
    BREAKOUT_CANDIDATE_DAYS: 30,
    ...over,
  })
}

const baseline = (over = {}) => ({
  actorApId: ACTOR, actor: '@markus@skvip.lol',
  n: 200, windowDays: 90, median: 6, p90: 24, p99: 58,
  best: 88, bestApId: 'https://skvip.lol/x/old', secondBest: 74,
  ...over,
})

const post = (over = {}) => ({
  apId: 'https://skvip.lol/x/1', actorApId: ACTOR,
  url: 'https://skvip.lol/@markus/1',
  publishedAt: new Date('2026-08-10T09:00:00Z'),
  text: 'Toget står stille på Finse igjen.',
  visibility: 'public',
  favourites: 30, reblogs: 0, replies: 0,
  peak: 30, score: 30,
  ...over,
})

/** A post already seeded, so the next decision is a live one rather than a seed. */
const seeded = (over = {}) => ({
  score: 5, peakScore: 5, rung: null, rungScore: null,
  p90At: null, p99At: null, bestAt: null, weightsKey: KEY,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  arm()
  resolveBreakoutActors.mockResolvedValue([{ apId: ACTOR, label: '@markus@skvip.lol' }])
  loadBreakoutBaseline.mockResolvedValue(baseline())
  loadBreakoutCandidates.mockResolvedValue([post()])
  loadBreakoutStates.mockResolvedValue(new Map([[post().apId, seeded()]]))
})

describe('runPostBreakout — the guards', () => {
  it('does nothing at all when the feature is switched off', async () => {
    arm({ BREAKOUT_ENABLED: false })
    const notify = notifier(true)

    await runPostBreakout(notify)

    expect(resolveBreakoutActors).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('refuses to run a ladder that cannot notify', async () => {
    // Spending rungs while every push 401s is the silent no-op hetzner-server ADR 0011
    // exists to forbid — the ladder would march past alerts nobody was ever told about.
    arm({ NTFY_PASSWORD: '' })
    const notify = notifier(true)

    await runPostBreakout(notify)

    expect(notify).not.toHaveBeenCalled()
    expect(saveBreakoutState).not.toHaveBeenCalled()
  })

  it('writes nothing for an account with too little history to judge', async () => {
    loadBreakoutBaseline.mockResolvedValue(baseline({ n: 8 }))
    const notify = notifier(true)

    await runPostBreakout(notify)

    expect(notify).not.toHaveBeenCalled()
    // Not even a seed: seeding here would spend the ladder against a bar we do not
    // believe in, and the post could then never announce once the account establishes.
    expect(saveBreakoutState).not.toHaveBeenCalled()
    expect(loadBreakoutCandidates).not.toHaveBeenCalled()
  })
})

describe('runPostBreakout — delivery', () => {
  it('pushes to the breakout topic, not the race topic', async () => {
    const notify = notifier(true)

    await runPostBreakout(notify)

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][1]).toMatchObject({ topic: 'tut-treff' })
  })

  it('persists the advanced rung once the push is delivered', async () => {
    const notify = notifier(true)

    await runPostBreakout(notify)

    expect(saveBreakoutState).toHaveBeenCalledTimes(1)
    const [statusApId, actorApId, state] = saveBreakoutState.mock.calls[0]
    expect(statusApId).toBe(post().apId)
    expect(actorApId).toBe(ACTOR)
    expect(state.rung).toBe('p90')
    expect(state.p90At).toBeInstanceOf(Date)
  })

  it('persists NOTHING when the push fails, so the next run retries it', async () => {
    // The single most important behaviour in the feature. Record 0015: a drifted ntfy
    // password must cost a delayed alert and a loud log line, never a lost one.
    const notify = notifier(false)

    await runPostBreakout(notify)

    expect(notify).toHaveBeenCalledTimes(1)
    expect(saveBreakoutState).not.toHaveBeenCalled()

    // Same inputs next tick ⇒ same decision, and this time it lands.
    const second = notifier(true)
    await runPostBreakout(second)
    expect(second).toHaveBeenCalledTimes(1)
    expect(saveBreakoutState).toHaveBeenCalledTimes(1)
  })

  it('lets one failed push not stall the rest of the run', async () => {
    const a = post({ apId: 'https://skvip.lol/x/a' })
    const b = post({ apId: 'https://skvip.lol/x/b' })
    loadBreakoutCandidates.mockResolvedValue([a, b])
    loadBreakoutStates.mockResolvedValue(new Map([[a.apId, seeded()], [b.apId, seeded()]]))

    const notify = notifier([false, true])  // a fails, b lands

    await runPostBreakout(notify)

    expect(saveBreakoutState).toHaveBeenCalledTimes(1)
    expect(saveBreakoutState.mock.calls[0][0]).toBe(b.apId)
  })
})

describe('runPostBreakout — seeding', () => {
  it('says nothing on the first sighting but records where the post is', async () => {
    // Switching the feature on must not replay a year of history into his phone.
    loadBreakoutStates.mockResolvedValue(new Map())
    loadBreakoutCandidates.mockResolvedValue([post({ peak: 500, score: 500 })])
    const notify = notifier(true)

    await runPostBreakout(notify)

    expect(notify).not.toHaveBeenCalled()
    expect(saveBreakoutState).toHaveBeenCalledTimes(1)
    const state = saveBreakoutState.mock.calls[0][2]
    expect(state.rung).toBe('best')   // the ladder is spent…
    expect(state.bestAt).toBeNull()   // …but nothing was ever announced
  })

  it('keeps persisting a quiet post so the next tick short-circuits', async () => {
    loadBreakoutCandidates.mockResolvedValue([post({ favourites: 1, peak: 1, score: 1 })])
    const notify = notifier(true)

    await runPostBreakout(notify)

    expect(notify).not.toHaveBeenCalled()
    expect(saveBreakoutState).toHaveBeenCalledTimes(1)
  })
})

describe('runPostBreakout — the fast lane\'s scope', () => {
  it('passes the restricted id set straight through to the store', async () => {
    const notify = notifier(true)
    const apIds = ['https://skvip.lol/x/1']

    await runPostBreakout(notify, { apIds, days: 1, lane: 'fast' })

    expect(loadBreakoutCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ apIds, days: 1 }),
    )
  })
})
