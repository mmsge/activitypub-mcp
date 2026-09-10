import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NtfyMessage, NtfyTarget } from '../lib/ntfy.js'

const notifier = () => vi.fn(async (_m: NtfyMessage, _t?: NtfyTarget) => true)

// The gates are the point: an inert deployment must pay nothing for having the timer
// registered. Mocking the store and the engagement reader lets us prove no query and
// no remote call happens, without a database or a network.
const resolveBreakoutActors = vi.fn()
const loadFastLaneTargets = vi.fn()
vi.mock('../lib/breakout-store.js', () => ({ resolveBreakoutActors, loadFastLaneTargets }))

const getEngagement = vi.fn(async () => ({ ok: 0, failed: 0, results: [] }))
vi.mock('../mcp/tools/engagement.js', () => ({ getEngagement }))

const runPostBreakout = vi.fn(async () => {})
vi.mock('./post-breakout.js', () => ({ runPostBreakout }))

vi.mock('../db/client.js', () => ({
  getDb: () => { throw new Error('the fast lane must go through breakout-store') },
}))

const { config } = await import('../config.js')
const { runBreakoutFastLane } = await import('./breakout-fast-lane.js')

const ACTOR = 'https://skvip.lol/users/markus'

function arm(over: Record<string, unknown> = {}) {
  Object.assign(config, {
    BREAKOUT_ENABLED: true,
    NTFY_PASSWORD: 'hunter2',
    BREAKOUT_FAST_LANE_MINUTES: 10,
    BREAKOUT_FAST_LANE_HOURS: 24,
    BREAKOUT_FAST_LANE_MAX_POSTS: 10,
    ENGAGEMENT_MAX_BATCH: 50,
    // The lane dials remote hosts six times an hour, so it is bounded by the same
    // politeness list as the hourly sampler. Armed here with the two accounts the
    // window tests use; the gate itself is exercised below.
    OWNER_INSTANCE: 'skvip.lol',
    ENGAGEMENT_SAMPLE_ORIGINS: 'pixelfed.babb.no',
    ...over,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  arm()
  resolveBreakoutActors.mockResolvedValue([{ apId: ACTOR, label: '@markus@skvip.lol' }])
  loadFastLaneTargets.mockResolvedValue(['https://skvip.lol/x/1'])
})

describe('runBreakoutFastLane — costs nothing while inert', () => {
  it('makes no query and no remote call when the feature is off', async () => {
    arm({ BREAKOUT_ENABLED: false })
    await runBreakoutFastLane(notifier())
    expect(resolveBreakoutActors).not.toHaveBeenCalled()
    expect(getEngagement).not.toHaveBeenCalled()
  })

  it('makes no query and no remote call without an ntfy password', async () => {
    arm({ NTFY_PASSWORD: '' })
    await runBreakoutFastLane(notifier())
    expect(resolveBreakoutActors).not.toHaveBeenCalled()
    expect(getEngagement).not.toHaveBeenCalled()
  })

  it('makes no query and no remote call when the fast lane itself is disabled', async () => {
    // 0 turns the fast lane off and leaves the hourly pass running. The timer is not
    // even registered at that value, but the job must be inert if it is called anyway.
    arm({ BREAKOUT_FAST_LANE_MINUTES: 0 })
    await runBreakoutFastLane(notifier())
    expect(resolveBreakoutActors).not.toHaveBeenCalled()
    expect(getEngagement).not.toHaveBeenCalled()
  })

  it('spends nothing on a day he has not posted', async () => {
    loadFastLaneTargets.mockResolvedValue([])
    await runBreakoutFastLane(notifier())
    expect(getEngagement).not.toHaveBeenCalled()
    expect(runPostBreakout).not.toHaveBeenCalled()
  })
})

describe('runBreakoutFastLane — the young-post window', () => {
  it('asks the store for posts inside the configured hours, capped per actor', async () => {
    arm({ BREAKOUT_FAST_LANE_HOURS: 6, BREAKOUT_FAST_LANE_MAX_POSTS: 3 })

    await runBreakoutFastLane(notifier())

    expect(loadFastLaneTargets).toHaveBeenCalledWith({
      actorApId: ACTOR, hours: 6, limit: 3,
    })
  })

  it('re-reads counts, then runs the same ladder over just those posts', async () => {
    await runBreakoutFastLane(notifier())

    expect(getEngagement).toHaveBeenCalledWith(expect.objectContaining({
      statuses: ['https://skvip.lol/x/1'],
      snapshot: true,
      // Without skip_unchanged the snapshot table would grow by one row per post per
      // tick, forever, for posts that are doing nothing.
      skip_unchanged: true,
    }))
    expect(runPostBreakout).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ apIds: ['https://skvip.lol/x/1'], lane: 'fast' }),
    )
  })

  it('covers the whole fast-lane window when it is longer than a day', async () => {
    arm({ BREAKOUT_FAST_LANE_HOURS: 48 })

    await runBreakoutFastLane(notifier())

    expect(runPostBreakout).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ days: 2 }),
    )
  })

  it('gathers targets from every watched account', async () => {
    resolveBreakoutActors.mockResolvedValue([
      { apId: ACTOR, label: '@markus@skvip.lol' },
      { apId: 'https://pixelfed.babb.no/users/markus', label: '@markus@pixelfed.babb.no' },
    ])
    loadFastLaneTargets
      .mockResolvedValueOnce(['https://skvip.lol/x/1'])
      .mockResolvedValueOnce(['https://pixelfed.babb.no/p/1'])

    await runBreakoutFastLane(notifier())

    expect(getEngagement).toHaveBeenCalledWith(expect.objectContaining({
      statuses: ['https://skvip.lol/x/1', 'https://pixelfed.babb.no/p/1'],
    }))
  })
})

/**
 * The lane polls every ten minutes for a whole day per post, so an origin that is not
 * ours costs the most here. Dropping the post before the fetch also keeps the ladder
 * honest: scoring a post on counts we did not refresh would announce an old peak as
 * news (record 0058).
 */
describe('runBreakoutFastLane — the origin gate', () => {
  it('drops a post on an origin outside the list, and never scores it', async () => {
    loadFastLaneTargets.mockResolvedValue([
      'https://skvip.lol/x/1',
      'https://minreol.dk/@markus@minreol.dk/posts/1',
    ])

    await runBreakoutFastLane(notifier())

    expect(getEngagement).toHaveBeenCalledWith(expect.objectContaining({
      statuses: ['https://skvip.lol/x/1'],
    }))
    expect(runPostBreakout).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ apIds: ['https://skvip.lol/x/1'] }),
    )
  })

  it('spends nothing when every young post is on an excluded origin', async () => {
    loadFastLaneTargets.mockResolvedValue(['https://minreol.dk/@markus@minreol.dk/posts/1'])

    await runBreakoutFastLane(notifier())

    expect(getEngagement).not.toHaveBeenCalled()
    expect(runPostBreakout).not.toHaveBeenCalled()
  })

  it('polls nothing when the list is empty, rather than everything', async () => {
    arm({ OWNER_INSTANCE: '', ENGAGEMENT_SAMPLE_ORIGINS: '' })

    await runBreakoutFastLane(notifier())

    expect(getEngagement).not.toHaveBeenCalled()
    expect(runPostBreakout).not.toHaveBeenCalled()
  })
})
