import { describe, it, expect, vi, beforeEach } from 'vitest'
import { type NtfyMessage } from '../lib/ntfy.js'
import { type ConvergenceEvent, type Crossing } from '../lib/convergence.js'
import { type StoredState } from '../lib/convergence-store.js'

/**
 * The orchestration, not the arithmetic — `convergence.test.ts` pins which crossings
 * exist. What matters here is everything a second run can get wrong: announcing a
 * crossing twice, announcing one it was never configured to send, losing one to a
 * failed push, or resuming a walk from a watermark that does not describe the totals
 * it is paired with.
 */

const loadEvents = vi.fn<(after: Date | null) => Promise<ConvergenceEvent[]>>()
const loadState = vi.fn<() => Promise<StoredState | null>>()
const saveState = vi.fn(async () => {})
const recordCrossings = vi.fn(async () => {})
const loadUnannounced = vi.fn<() => Promise<{ crossing: Crossing; historical: boolean }[]>>()
const markNotified = vi.fn(async () => {})
const closeOpenEquality = vi.fn(async () => {})
const previousEqualityAt = vi.fn(async () => null as Date | null)
const currentTotals = vi.fn(async () => ({ scrobbles: 0, km: 0 }))

vi.mock('../lib/convergence-store.js', () => ({
  loadEvents,
  loadState,
  saveState,
  recordCrossings,
  loadUnannounced,
  markNotified,
  closeOpenEquality,
  previousEqualityAt,
  currentTotals,
  dailyRates: vi.fn(),
  listCrossings: vi.fn(),
}))

vi.mock('../db/client.js', () => ({
  getDb: () => { throw new Error('the convergence job must go through convergence-store') },
}))

let enabled = true
vi.mock('../config.js', async () => {
  const real = await vi.importActual<typeof import('../config.js')>('../config.js')
  return {
    ...real,
    convergenceEnabled: () => enabled,
    config: { ...real.config, NTFY_TOPIC_CONVERGENCE: 'konvergens', NTFY_PASSWORD: 'x' },
  }
})

const { runConvergenceWatch } = await import('./convergence.js')

const at = (iso: string) => new Date(iso)

function scrobbleEvent(iso: string): ConvergenceEvent {
  return {
    at: at(iso),
    key: iso,
    cause: { kind: 'scrobble', artist: 'Taylor Swift', track: 'London Boy', album: 'Lover', url: null },
  }
}

function equality(iso: string, value: number): Crossing {
  return {
    kind: 'equality',
    occurredAt: at(iso),
    value,
    gap: 0,
    leader: 'tie',
    scrobbles: value,
    km: value,
    cause: { kind: 'scrobble', artist: 'Taylor Swift', track: 'London Boy', album: 'Lover', url: null },
    endedAt: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  enabled = true
  loadEvents.mockResolvedValue([])
  loadState.mockResolvedValue(null)
  loadUnannounced.mockResolvedValue([])
  previousEqualityAt.mockResolvedValue(null)
})

describe('runConvergenceWatch', () => {
  it('refuses to run when it cannot notify, and records nothing', async () => {
    enabled = false
    const notify = vi.fn(async () => true)

    expect(await runConvergenceWatch({}, notify)).toBe('disabled')
    expect(notify).not.toHaveBeenCalled()
    expect(recordCrossings).not.toHaveBeenCalled()
    // The crucial half: no state is written either. The row IS the "already announced"
    // mark, so seeding while unarmed would bury the crossing for good.
    expect(saveState).not.toHaveBeenCalled()
  })

  it('walks the whole archive on the first run', async () => {
    loadEvents.mockResolvedValue([scrobbleEvent('2020-01-11T11:06:35Z')])

    expect(await runConvergenceWatch({}, vi.fn(async () => true))).toBe('seeded')
    expect(loadEvents).toHaveBeenCalledWith(null)
  })

  it('resumes from the watermark on an ordinary tick', async () => {
    loadState.mockResolvedValue({
      scrobbles: 51_959, km: 49_914, watermarkAt: at('2026-08-20T14:05:24Z'), seededAt: at('2026-08-01T00:00:00Z'),
    })

    await runConvergenceWatch({}, vi.fn(async () => true))
    expect(loadEvents).toHaveBeenCalledWith(at('2026-08-20T14:05:24Z'))
  })

  it('walks the whole archive again after an import, because a leg can land in the past', async () => {
    loadState.mockResolvedValue({
      scrobbles: 51_959, km: 49_914, watermarkAt: at('2026-08-20T14:05:24Z'), seededAt: at('2026-08-01T00:00:00Z'),
    })

    await runConvergenceWatch({ recompute: true }, vi.fn(async () => true))
    expect(loadEvents).toHaveBeenCalledWith(null)
  })

  it('never resumes from a state row that has no watermark', async () => {
    // Totals without a watermark would replay the whole archive on top of counts that
    // already include it.
    loadState.mockResolvedValue({
      scrobbles: 51_959, km: 49_914, watermarkAt: null, seededAt: at('2026-08-01T00:00:00Z'),
    })

    await runConvergenceWatch({}, vi.fn(async () => true))
    expect(loadEvents).toHaveBeenCalledWith(null)
  })

  it('announces what is owed and stamps it', async () => {
    const crossing = equality('2020-01-11T11:06:35Z', 3298)
    loadUnannounced.mockResolvedValue([{ crossing, historical: true }])
    const notify = vi.fn(async () => true)

    expect(await runConvergenceWatch({}, notify)).toBe('announced')
    expect(notify).toHaveBeenCalledTimes(1)
    const [message, target] = notify.mock.calls[0] as unknown as [NtfyMessage, { topic: string }]
    expect(message.title).toContain('Likt')
    expect(message.priority).toBe('high')
    expect(target.topic).toBe('konvergens')
    expect(markNotified).toHaveBeenCalledWith([crossing])
    expect(saveState).toHaveBeenCalled()
  })

  it('says nothing at all when nothing is owed', async () => {
    loadState.mockResolvedValue({
      scrobbles: 10, km: 20, watermarkAt: at('2026-08-20T14:05:24Z'), seededAt: at('2026-08-01T00:00:00Z'),
    })
    const notify = vi.fn(async () => true)

    expect(await runConvergenceWatch({}, notify)).toBe('quiet')
    expect(notify).not.toHaveBeenCalled()
    expect(markNotified).not.toHaveBeenCalled()
  })

  it('keeps a failed push owed, and does not advance the watermark', async () => {
    loadUnannounced.mockResolvedValue([{ crossing: equality('2020-01-11T11:06:35Z', 3298), historical: true }])
    const notify = vi.fn(async () => false)

    expect(await runConvergenceWatch({}, notify)).toBe('undelivered')
    expect(markNotified).not.toHaveBeenCalled()
    // Neither stamped nor moved on: the next run re-reads the queue and tries again.
    expect(saveState).not.toHaveBeenCalled()
  })

  it('collapses a backfilled burst into one push', async () => {
    loadUnannounced.mockResolvedValue([
      { crossing: equality('2020-01-11T11:06:35Z', 3298), historical: true },
      { crossing: equality('2021-03-02T09:00:00Z', 4100), historical: true },
      { crossing: equality('2022-06-06T18:30:00Z', 5200), historical: true },
    ])
    const notify = vi.fn(async () => true)

    await runConvergenceWatch({ recompute: true }, notify)
    expect(notify).toHaveBeenCalledTimes(1)
    expect((notify.mock.calls[0] as unknown as [NtfyMessage])[0].title).toContain('kryssingar')
  })

  it('closes an equality window that was already open, silently', async () => {
    loadState.mockResolvedValue({
      scrobbles: 3298, km: 3298, watermarkAt: at('2020-01-11T11:06:35Z'), seededAt: at('2020-01-01T00:00:00Z'),
    })
    loadEvents.mockResolvedValue([scrobbleEvent('2020-01-11T11:09:45Z')])
    const notify = vi.fn(async () => true)

    expect(await runConvergenceWatch({}, notify)).toBe('quiet')
    expect(closeOpenEquality).toHaveBeenCalledWith(at('2020-01-11T11:09:45Z'))
    expect(notify).not.toHaveBeenCalled()
  })

  it('marks a crossing historical against the walk end on a first run', async () => {
    // 2020 is not "breaking news" the first time the watcher looks at a ten-year
    // archive — the threshold is where the walk ends, not where it started.
    loadEvents.mockResolvedValue([
      scrobbleEvent('2020-01-11T11:06:35Z'),
      scrobbleEvent('2026-08-20T14:05:24Z'),
    ])

    await runConvergenceWatch({}, vi.fn(async () => true))
    expect(recordCrossings).toHaveBeenCalledWith(
      expect.anything(),
      { historicalBefore: at('2026-08-20T14:05:24Z') },
    )
  })
})
