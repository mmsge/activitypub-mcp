// The four states are all reachable and none collapses into another. The one that
// matters is `stale` vs `unauthorized`: a source can hold perfectly good data and
// a failing refresh at the same time, because the stored snapshot stays valid long
// after the token that fetched it dies. Reporting that as "failed" would suggest
// the data is untrustworthy; reporting it as "ok" would hide that it has stopped
// growing. See ADR 0033.
import { describe, it, expect, vi } from 'vitest'

const getDb = vi.fn(() => {
  throw new Error('getDb() should not be called when deriving status from a row')
})
vi.mock('../db/client.js', () => ({ getDb }))

const { deriveTokenStatus, successSet } = await import('./source-health.js')

const NOW = new Date('2026-08-10T12:00:00Z')
const WEEK = 7 * 24 * 60 * 60_000
const STALE_AFTER = 2 * WEEK

const health = (over: Record<string, unknown> = {}) => ({
  source: 'linkedin',
  lastAttemptAt: NOW,
  lastSuccessAt: NOW,
  lastError: null,
  lastStatus: null,
  consecutiveFailures: 0,
  itemsLastRun: 12,
  lastDataAt: NOW,
  notifiedAt: null,
  ...over,
}) as any

describe('deriveTokenStatus', () => {
  it('reports never_run before the poller has ever fired', () => {
    expect(deriveTokenStatus(null, STALE_AFTER, NOW)).toBe('never_run')
    expect(deriveTokenStatus(health({ lastAttemptAt: null, lastSuccessAt: null }), STALE_AFTER, NOW))
      .toBe('never_run')
  })

  it('reports ok on a recent success', () => {
    expect(deriveTokenStatus(health(), STALE_AFTER, NOW)).toBe('ok')
  })

  it('stays ok while a success is inside the window', () => {
    const recent = new Date(NOW.getTime() - WEEK)
    expect(deriveTokenStatus(health({ lastSuccessAt: recent }), STALE_AFTER, NOW)).toBe('ok')
  })

  it('reports unauthorized on a refused credential, even with good data behind it', () => {
    const row = health({
      lastSuccessAt: new Date(NOW.getTime() - 3 * 24 * 60 * 60_000),
      lastStatus: 401,
      lastError: 'Invalid access token',
      consecutiveFailures: 1,
    })
    // A success three days ago would otherwise read as `ok` — the refusal wins,
    // because it is the state a human has to act on.
    expect(deriveTokenStatus(row, STALE_AFTER, NOW)).toBe('unauthorized')
    expect(deriveTokenStatus({ ...row, lastStatus: 403 }, STALE_AFTER, NOW)).toBe('unauthorized')
  })

  it('reports stale when the last success has aged out, not failed', () => {
    const old = new Date(NOW.getTime() - 3 * WEEK)
    expect(deriveTokenStatus(health({ lastSuccessAt: old }), STALE_AFTER, NOW)).toBe('stale')
  })

  it('does not report a transient 5xx as unauthorized', () => {
    const row = health({ lastStatus: 503, lastError: 'upstream', consecutiveFailures: 1 })
    expect(deriveTokenStatus(row, STALE_AFTER, NOW)).toBe('ok')
  })

  it('reports attempts that have never once succeeded as unauthorized', () => {
    const row = health({ lastSuccessAt: null, lastStatus: 0, consecutiveFailures: 4 })
    expect(deriveTokenStatus(row, STALE_AFTER, NOW)).toBe('unauthorized')
  })
})

// The fifth state, and the one the four above could not express. LinkedIn signals
// "this domain is not collated yet" with the SAME 404 body it uses for "you have
// reached the end of the data" — and the crawl is required to treat that as the end,
// because paging.total under-reports. So a first run against a not-yet-ready domain
// records a clean success with zero rows and is indistinguishable, at the HTTP layer,
// from a healthy one. It showed as a green OK badge on a source that had never
// produced a single post. See ADR 0034.
describe('deriveTokenStatus — awaiting_data', () => {
  it('reports a succeeding source that has never returned a row as awaiting_data', () => {
    expect(deriveTokenStatus(health({ lastDataAt: null, itemsLastRun: 0 }), STALE_AFTER, NOW))
      .toBe('awaiting_data')
  })

  it('reports ok once data has arrived, even if the latest run brought nothing new', () => {
    const row = health({ lastDataAt: new Date(NOW.getTime() - WEEK), itemsLastRun: 0 })
    expect(deriveTokenStatus(row, STALE_AFTER, NOW)).toBe('ok')
  })

  it('lets a refused token win over awaiting_data — the credential is the real problem', () => {
    const row = health({ lastDataAt: null, lastStatus: 401, consecutiveFailures: 1 })
    expect(deriveTokenStatus(row, STALE_AFTER, NOW)).toBe('unauthorized')
  })

  it('reports a stalled poller as stale, not as awaiting_data', () => {
    // Both are true — it has never had data AND it has stopped running. "Stale" is
    // the more actionable of the two, and "waiting" would imply something is trying.
    const row = health({ lastDataAt: null, lastSuccessAt: new Date(NOW.getTime() - 3 * WEEK) })
    expect(deriveTokenStatus(row, STALE_AFTER, NOW)).toBe('stale')
  })

  it('still reports never_run before the first attempt, not awaiting_data', () => {
    const row = health({ lastAttemptAt: null, lastSuccessAt: null, lastDataAt: null })
    expect(deriveTokenStatus(row, STALE_AFTER, NOW)).toBe('never_run')
  })
})

// The update does `set: successSet(...)`, so every key present is rewritten on every
// run. Including lastDataAt unconditionally would erase the record that this source
// has ever produced data the first time a run legitimately returned nothing —
// flipping a working source to a permanent awaiting_data. Same shape as ADR 0013's
// hiddenAt and ADR 0033's firstSeenAt.
describe('successSet', () => {
  it('omits lastDataAt entirely on an empty run', () => {
    const set = successSet(0, NOW)
    expect(set).not.toHaveProperty('lastDataAt')
    expect(set.itemsLastRun).toBe(0)
    expect(set.lastSuccessAt).toBe(NOW)
  })

  it('sets lastDataAt when the run actually brought rows back', () => {
    expect(successSet(31, NOW)).toMatchObject({ lastDataAt: NOW, itemsLastRun: 31 })
  })

  it('clears the failure state either way', () => {
    for (const items of [0, 31]) {
      expect(successSet(items, NOW)).toMatchObject({
        lastError: null, lastStatus: null, consecutiveFailures: 0, notifiedAt: null,
      })
    }
  })
})

// `lastStatus` and `lastError` are failure-only on purpose — `deriveTokenStatus`
// reads `lastStatus` to decide `unauthorized`, so a 404 from a perfectly healthy
// end-of-crawl must never land there. The cost of that, unnoticed until this source
// spent days succeeding and producing nothing, is that a run which never fails
// leaves no evidence at all. So the trace is stored alongside, on every attempt.
// See ADR 0039.
describe('successSet — the attempt trace', () => {
  const trace = { status: 404, body: 'No data found for this domain and memberId', note: 'nothing yet' }

  it('records the terminal status and body even though the run succeeded', () => {
    const set = successSet(0, NOW, trace) as Record<string, unknown>

    expect(set.lastHttpStatus).toBe(404)
    expect(set.lastHttpBody).toContain('No data found')
    expect(set.lastNote).toBe('nothing yet')
    // Still a success: the failure fields stay cleared, so a 404 that is only the
    // end of the data cannot make the badge red.
    expect(set.lastStatus).toBeNull()
    expect(set.lastError).toBeNull()
    expect(set.consecutiveFailures).toBe(0)
  })

  it('STILL omits lastDataAt on an empty run, trace or no trace', () => {
    // The trap ADR 0034 exists for: any key present here is rewritten every run, so
    // writing lastDataAt unconditionally would erase the record that this source has
    // ever produced data the first time a run legitimately came back empty.
    expect(successSet(0, NOW, trace)).not.toHaveProperty('lastDataAt')
    expect(successSet(3, NOW, trace)).toHaveProperty('lastDataAt', NOW)
  })

  it('writes nothing trace-shaped when there is no trace, rather than nulling it', () => {
    const set = successSet(1, NOW) as Record<string, unknown>
    expect(set).not.toHaveProperty('lastHttpStatus')
    expect(set).not.toHaveProperty('lastNote')
  })

  it('clips a body that would otherwise bloat the row', () => {
    const set = successSet(0, NOW, { ...trace, body: 'y'.repeat(9000) }) as Record<string, unknown>
    expect((set.lastHttpBody as string).length).toBeLessThan(4200)
    expect(set.lastHttpBody).toContain('9000 bytes')
  })
})
