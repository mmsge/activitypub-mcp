// The join between LinkedIn's two halves is a derived numeric id, not a URL and
// not a URN lookup (ADR 0033). That is the right call, and it has one failure mode
// with no symptom: if the snapshot emits an id from a different namespace than the
// export did — LinkedIn's share, ugcPost and activity URNs are not guaranteed to
// carry the same number for the same post — then both tables fill up, every query
// still returns rows, and `has_content` is false forever. Nothing errors.
//
// So the overlap is counted and the broken case is named. See ADR 0039.
import { describe, it, expect, vi } from 'vitest'

const getDb = vi.fn(() => {
  throw new Error('getDb() should not be called when judging counts that were already read')
})
vi.mock('../db/client.js', () => ({ getDb }))

const { joinWarning } = await import('./linkedin-join.js')

const h = (over: Record<string, number> = {}) => ({
  posts: 30,
  metric_keys: 50,
  matched: 28,
  orphan_posts: 2,
  orphan_metrics: 22,
  ...over,
})

describe('joinWarning', () => {
  it('says nothing while the join is working, however large the backlog', () => {
    expect(joinWarning(h())).toBeNull()
    // A big orphan_metrics count is the ordinary state before the poller catches
    // up; warning on it would train the reader to ignore the warning.
    expect(joinWarning(h({ matched: 1, orphan_metrics: 49 }))).toBeNull()
  })

  it('names the namespace mismatch when both sides are populated and nothing meets', () => {
    const warning = joinWarning(h({ matched: 0, orphan_posts: 30, orphan_metrics: 50 }))
    expect(warning).toContain('JOIN BROKEN')
    expect(warning).toMatch(/ugcPost/)
  })

  it('stays quiet while one side is still empty — that is not evidence of a mismatch', () => {
    // The state during the outage this work came out of: 50 metric keys, 0 posts.
    // Zero overlap there means the poller has not run, not that ids disagree.
    expect(joinWarning(h({ posts: 0, matched: 0, orphan_posts: 0 }))).toBeNull()
    expect(joinWarning(h({ metric_keys: 0, matched: 0, orphan_metrics: 0 }))).toBeNull()
  })
})
