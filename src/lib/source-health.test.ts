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

const { deriveTokenStatus } = await import('./source-health.js')

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
