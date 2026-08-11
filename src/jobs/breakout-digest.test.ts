import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NtfyMessage, NtfyTarget } from '../lib/ntfy.js'

/** Typed so `notify.mock.calls[0][1]` is the target rather than never. */
const notifier = (result: boolean) =>
  vi.fn(async (_m: NtfyMessage, _t?: NtfyTarget) => result)

const resolveBreakoutActors = vi.fn()
const loadBreakoutBaseline = vi.fn()
const loadDigestRows = vi.fn()
const loadDigestMovement = vi.fn()
const readDigestCursor = vi.fn()
const writeDigestCursor = vi.fn(async () => {})
vi.mock('../lib/breakout-store.js', () => ({
  resolveBreakoutActors, loadBreakoutBaseline, loadDigestRows,
  loadDigestMovement, readDigestCursor, writeDigestCursor,
}))
vi.mock('../db/client.js', () => ({
  getDb: () => { throw new Error('the digest must go through breakout-store') },
}))

const { config } = await import('../config.js')
const { runBreakoutDigest } = await import('./breakout-digest.js')

const ACTOR = 'https://skvip.lol/users/markus'
/** 19:00 UTC in August is 21:00 in Oslo — the digest hour. */
const EVENING = new Date('2026-08-10T19:00:00Z')

function arm(over: Record<string, unknown> = {}) {
  Object.assign(config, {
    BREAKOUT_ENABLED: true,
    NTFY_PASSWORD: 'hunter2',
    NTFY_TOPIC_BREAKOUT: 'tut-treff',
    BREAKOUT_DIGEST_HOUR: 21,
    ...over,
  })
}

const baseline = () => ({
  actorApId: ACTOR, actor: '@markus@skvip.lol',
  n: 200, windowDays: 90, median: 6, p90: 24, p99: 58,
  best: 88, bestApId: 'https://skvip.lol/x/old', secondBest: 74,
})

const rung = () => ({
  actor: '@markus@skvip.lol',
  rung: 'p90' as const,
  firedAt: new Date('2026-08-10T12:00:00Z'),
  score: 30,
  text: 'Toget står stille på Finse igjen.',
  url: 'https://skvip.lol/@markus/1',
})

beforeEach(() => {
  vi.clearAllMocks()
  arm()
  resolveBreakoutActors.mockResolvedValue([{ apId: ACTOR, label: '@markus@skvip.lol' }])
  loadBreakoutBaseline.mockResolvedValue(baseline())
  loadDigestRows.mockResolvedValue([rung()])
  loadDigestMovement.mockResolvedValue({ favourites: 41, reblogs: 6, replies: 3 })
  readDigestCursor.mockResolvedValue(new Date('2026-08-09T19:00:00Z'))
})

describe('runBreakoutDigest — when it runs at all', () => {
  it('stays silent when the feature is off', async () => {
    arm({ BREAKOUT_ENABLED: false })
    const notify = notifier(true)
    await runBreakoutDigest(notify, EVENING)
    expect(notify).not.toHaveBeenCalled()
    expect(readDigestCursor).not.toHaveBeenCalled()
  })

  it('stays silent when the digest is disabled', async () => {
    arm({ BREAKOUT_DIGEST_HOUR: -1 })
    const notify = notifier(true)
    await runBreakoutDigest(notify, EVENING)
    expect(notify).not.toHaveBeenCalled()
  })

  it('does nothing and touches no cursor before the hour', async () => {
    const notify = notifier(true)
    // 15:00 UTC = 17:00 Oslo, four hours early.
    await runBreakoutDigest(notify, new Date('2026-08-10T15:00:00Z'))
    expect(notify).not.toHaveBeenCalled()
    expect(writeDigestCursor).not.toHaveBeenCalled()
  })

  it('does not go out twice on the same Oslo day', async () => {
    readDigestCursor.mockResolvedValue(new Date('2026-08-10T19:05:00Z'))
    const notify = notifier(true)
    await runBreakoutDigest(notify, new Date('2026-08-10T20:05:00Z'))
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('runBreakoutDigest — delivery', () => {
  it('sends the day\'s summary to the breakout topic and advances the cursor', async () => {
    const notify = notifier(true)

    await runBreakoutDigest(notify, EVENING)

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][1]).toMatchObject({ topic: 'tut-treff' })
    expect(notify.mock.calls[0][0].body).toContain('+41 hjarte')
    expect(writeDigestCursor).toHaveBeenCalledWith(EVENING)
  })

  it('leaves the cursor alone when a composed digest fails to publish', async () => {
    // An undelivered alert like any other — the next hourly tick retries it the same
    // evening rather than the day being lost.
    const notify = notifier(false)

    await runBreakoutDigest(notify, EVENING)

    expect(notify).toHaveBeenCalledTimes(1)
    expect(writeDigestCursor).not.toHaveBeenCalled()
  })

  it('reads the window from the cursor, not from midnight', async () => {
    // So a day the service spent down is reported on the next run instead of skipped.
    const cursor = new Date('2026-08-08T19:00:00Z')
    readDigestCursor.mockResolvedValue(cursor)

    await runBreakoutDigest(notifier(true), EVENING)

    expect(loadDigestRows).toHaveBeenCalledWith(cursor)
    expect(loadDigestMovement).toHaveBeenCalledWith([ACTOR], cursor)
  })

  it('looks back only a day on the very first run', async () => {
    // With no cursor, "everything ever" would report a year of rungs as today's news.
    readDigestCursor.mockResolvedValue(null)

    await runBreakoutDigest(notifier(true), EVENING)

    const since = loadDigestRows.mock.calls[0][0] as Date
    expect(EVENING.getTime() - since.getTime()).toBe(86_400_000)
  })
})

describe('runBreakoutDigest — a quiet day', () => {
  it('sends nothing but still advances the cursor', async () => {
    // The one deliberate exception to "state advances only on a delivered push": the
    // cursor is moving past nothing to deliver, not past an undelivered alert. A
    // nightly "ingenting skjedde" would train him to mute the topic.
    loadDigestRows.mockResolvedValue([])
    loadDigestMovement.mockResolvedValue({ favourites: 0, reblogs: 0, replies: 0 })
    const notify = notifier(true)

    await runBreakoutDigest(notify, EVENING)

    expect(notify).not.toHaveBeenCalled()
    expect(writeDigestCursor).toHaveBeenCalledWith(EVENING)
  })

  it('still reports a day where engagement came in without any rung crossing', async () => {
    loadDigestRows.mockResolvedValue([])
    loadDigestMovement.mockResolvedValue({ favourites: 12, reblogs: 0, replies: 1 })
    const notify = notifier(true)

    await runBreakoutDigest(notify, EVENING)

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0].body).toContain('+12 hjarte')
  })
})
