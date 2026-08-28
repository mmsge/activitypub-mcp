import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ContextStatus, ThreadNode, ThreadStats } from '../lib/thread-context.js'
import type { ContextOutcome } from '../lib/thread-fetch.js'
import type { RootToWalk, ThreadActorResolution, WalkMode } from '../lib/thread-store.js'

/**
 * The orchestration, not the arithmetic — `thread-context.test.ts` pins what a tree looks
 * like. What matters here is everything a scheduled run can get wrong: erasing a good
 * tree because a fetch failed, spinning against an instance that is rate limiting, or
 * walking the whole archive on a nightly timer.
 */

const resolveThreadActorsDetailed = vi.fn<() => Promise<ThreadActorResolution>>()
const loadRootsToWalk = vi.fn<(o: { mode: WalkMode; actorApIds: string[]; limit: number }) => Promise<RootToWalk[]>>()
const replaceThread = vi.fn<(r: RootToWalk, n: ThreadNode[], s: ThreadStats) => Promise<void>>(async () => {})
const recordWalkFailure = vi.fn(async () => {})

vi.mock('../lib/thread-store.js', () => ({
  resolveThreadActorsDetailed,
  loadRootsToWalk,
  replaceThread,
  recordWalkFailure,
}))

const fetchThreadContext = vi.fn<() => Promise<ContextOutcome>>()
vi.mock('../lib/thread-fetch.js', () => ({ fetchThreadContext }))

vi.mock('../db/client.js', () => ({
  getDb: () => { throw new Error('the thread walk must go through thread-store') },
}))

vi.mock('../config.js', async () => {
  const real = await vi.importActual<typeof import('../config.js')>('../config.js')
  return {
    ...real,
    getThreadSkipHosts: () => new Set<string>(),
    config: {
      ...real.config,
      // No real waiting in a unit test; the spacing itself is asserted through the
      // backoff arithmetic rather than the wall clock.
      THREAD_REQUEST_SPACING_MS: 0,
      THREAD_MAX_REQUESTS_PER_RUN: 50,
      THREAD_WALK_INTERVAL_HOURS: 24,
      THREAD_SETTLED_DAYS: 7,
    },
  }
})

const { walkThreads } = await import('./walk-threads.js')

const ACTOR = 'https://skvip.lol/users/markus'

function root(id: string, walkedAt: Date | null = null): RootToWalk {
  return {
    apId: `https://skvip.lol/users/markus/statuses/${id}`,
    actorApId: ACTOR,
    statusId: id,
    origin: 'skvip.lol',
    url: `https://skvip.lol/@markus/${id}`,
    publishedAt: new Date('2026-08-01T10:00:00Z'),
    walkedAt,
    newestNodeAt: null,
  }
}

function descendant(id: string, parent: string, acct: string): ContextStatus {
  return {
    id,
    uri: `https://chaos.social/users/${acct.split('@')[0]}/statuses/${id}`,
    url: `https://chaos.social/@${acct.split('@')[0]}/${id}`,
    in_reply_to_id: parent,
    visibility: 'public',
    created_at: '2026-08-02T10:00:00Z',
    account: { acct },
  } as ContextStatus
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveThreadActorsDetailed.mockResolvedValue({
    kind: 'ok',
    actors: [{ apId: ACTOR, handle: '@markus@skvip.lol', source: 'configured' }],
  })
  loadRootsToWalk.mockResolvedValue([])
  fetchThreadContext.mockResolvedValue({ ok: true, descendants: [], authenticated: false })
})

describe('walkThreads', () => {
  it('asks the queue for the incremental slice by default, and the whole archive on a backfill', async () => {
    await walkThreads()
    expect(loadRootsToWalk).toHaveBeenCalledWith(expect.objectContaining({ mode: 'incremental' }))

    await walkThreads({ mode: 'backfill' })
    expect(loadRootsToWalk).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'backfill' }))
  })

  it('does nothing at all when no actor resolves, rather than walking every stored post', async () => {
    resolveThreadActorsDetailed.mockResolvedValue({ kind: 'unconfigured', stored: [], followed: [] })
    const result = await walkThreads()
    expect(result.stopped).toBe('not_configured')
    expect(loadRootsToWalk).not.toHaveBeenCalled()
  })

  it('says why the FALLBACK did not fire, not just that it did not', async () => {
    // "You follow nothing" and "you follow three accounts and none of them reported
    // Mastodon" are different problems with different fixes — the same defect this whole
    // change is about, one level down. A null software means the hourly NodeInfo probe
    // has not reached that host yet.
    resolveThreadActorsDetailed.mockResolvedValue({
      kind: 'unconfigured',
      stored: ['@markus@gigowl.social', '@markus@skvip.lol'],
      followed: [
        { handle: '@markus@skvip.lol', software: null },
        { handle: '@markus@gigowl.social', software: 'samklang' },
      ],
    })

    const result = await walkThreads()

    expect(result.stopped).toBe('not_configured')
    expect(result.followed).toEqual([
      { handle: '@markus@skvip.lol', software: null },
      { handle: '@markus@gigowl.social', software: 'samklang' },
    ])
  })

  it('says WHICH silence it hit, because the two have different fixes', async () => {
    // Nothing configured → set an env var. Configured but unmatched → the handle is
    // spelled differently from the way the archive spells it. One `no_actors` for both
    // sent a real backfill on the box to a psql session to find out which (ADR 0039).
    resolveThreadActorsDetailed.mockResolvedValue({
      kind: 'unmatched',
      configured: ['@markus@skvip.lol'],
      stored: ['@markus@bokwyrm.example', '@markus@gigowl.social'],
    })

    const result = await walkThreads()

    expect(result.stopped).toBe('no_match')
    // And it hands back what the archive DOES hold, so the fix needs no database.
    expect(result.storedHandles).toEqual(['@markus@bokwyrm.example', '@markus@gigowl.social'])
    expect(loadRootsToWalk).not.toHaveBeenCalled()
  })

  it('reports which actors it is walking and where they came from', async () => {
    resolveThreadActorsDetailed.mockResolvedValue({
      kind: 'ok',
      actors: [{ apId: ACTOR, handle: '@markus@skvip.lol', source: 'followed' }],
    })
    const result = await walkThreads()
    expect(result.actors).toEqual([
      { apId: ACTOR, handle: '@markus@skvip.lol', source: 'followed' },
    ])
  })

  it('writes the walked shape, with the root as node 0 and the replies under it', async () => {
    loadRootsToWalk.mockResolvedValue([root('100')])
    fetchThreadContext.mockResolvedValue({
      ok: true,
      authenticated: false,
      descendants: [
        descendant('201', '100', 'someone@chaos.social'),
        descendant('202', '201', 'other@chaos.social'),
      ],
    })

    const result = await walkThreads()

    expect(result.walked).toBe(1)
    const [, nodes, stats] = replaceThread.mock.calls[0]!
    expect(nodes.map(n => n.depth)).toEqual([0, 1, 2])
    expect(nodes[0]!.isMine).toBe(true)
    expect(stats).toMatchObject({ nodeCount: 3, externalNodeCount: 2, maxDepth: 2, externalParticipantCount: 2 })
  })

  it('passes the new node set whole, so a reply deleted at its origin simply stops existing', async () => {
    // Criterion 4 at this boundary: the job never diffs and never tombstones — it hands
    // over the current set and `replaceThread` swaps it in inside one transaction.
    loadRootsToWalk.mockResolvedValue([root('100')])
    fetchThreadContext.mockResolvedValue({
      ok: true,
      authenticated: false,
      descendants: [descendant('201', '100', 'someone@chaos.social')],
    })

    await walkThreads()

    const [, nodes] = replaceThread.mock.calls[0]!
    expect(nodes.map(n => n.statusId)).toEqual(['100', '201'])
    expect(nodes.some(n => 'deletedAt' in n || 'tombstone' in n)).toBe(false)
  })

  it('records a failed fetch WITHOUT writing an empty tree over a good one', async () => {
    loadRootsToWalk.mockResolvedValue([root('100')])
    fetchThreadContext.mockResolvedValue({ ok: false, code: 'fetch_failed', message: 'timeout' })

    const result = await walkThreads()

    expect(result.failed).toBe(1)
    expect(replaceThread).not.toHaveBeenCalled()
    expect(recordWalkFailure).toHaveBeenCalledWith(expect.objectContaining({ statusId: '100' }), expect.stringContaining('timeout'))
  })

  it('treats a 404 the same way — the root being gone is not the thread emptying', async () => {
    loadRootsToWalk.mockResolvedValue([root('100')])
    fetchThreadContext.mockResolvedValue({ ok: false, code: 'not_found', message: 'HTTP 404' })

    await walkThreads()

    expect(replaceThread).not.toHaveBeenCalled()
    expect(recordWalkFailure).toHaveBeenCalledOnce()
  })

  it('stops after three consecutive 429s instead of spinning against a refusing instance', async () => {
    loadRootsToWalk.mockResolvedValue([root('1'), root('2'), root('3'), root('4'), root('5')])
    fetchThreadContext.mockResolvedValue({
      ok: false, code: 'rate_limited', retryAfterMs: null, message: 'HTTP 429',
    })

    const result = await walkThreads()

    expect(result.stopped).toBe('rate_limited')
    expect(fetchThreadContext).toHaveBeenCalledTimes(3)
    // A rate limit is not the root's fault, so it does not count against that root.
    expect(recordWalkFailure).not.toHaveBeenCalled()
  })

  it('does not stop when a 429 is followed by a success — the counter is CONSECUTIVE', async () => {
    loadRootsToWalk.mockResolvedValue([root('1'), root('2'), root('3'), root('4'), root('5')])
    fetchThreadContext
      .mockResolvedValueOnce({ ok: false, code: 'rate_limited', retryAfterMs: 1, message: '429' })
      .mockResolvedValueOnce({ ok: true, descendants: [], authenticated: false })
      .mockResolvedValueOnce({ ok: false, code: 'rate_limited', retryAfterMs: 1, message: '429' })
      .mockResolvedValueOnce({ ok: false, code: 'rate_limited', retryAfterMs: 1, message: '429' })
      .mockResolvedValueOnce({ ok: true, descendants: [], authenticated: false })

    const result = await walkThreads()

    expect(result.stopped).toBeNull()
    expect(result.walked).toBe(2)
    expect(fetchThreadContext).toHaveBeenCalledTimes(5)
  })

  it('reports the request budget as the reason it stopped, so the script can say "run again"', async () => {
    loadRootsToWalk.mockResolvedValue([root('1'), root('2')])
    const result = await walkThreads({ maxRequests: 2 })
    expect(result.stopped).toBe('bounded')
    expect(loadRootsToWalk).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }))
  })

  it('walks nothing and writes nothing on a dry run', async () => {
    loadRootsToWalk.mockResolvedValue([root('1')])
    const result = await walkThreads({ dryRun: true })
    expect(result.stopped).toBe('dry_run')
    expect(fetchThreadContext).not.toHaveBeenCalled()
    expect(replaceThread).not.toHaveBeenCalled()
  })

  it('counts a thread with no replies as a walk, with the root as its only node', async () => {
    loadRootsToWalk.mockResolvedValue([root('100')])
    const result = await walkThreads()

    expect(result.walked).toBe(1)
    const [, nodes, stats] = replaceThread.mock.calls[0]!
    expect(nodes).toHaveLength(1)
    expect(stats.externalNodeCount).toBe(0)
    // The fallback that keeps a fresh toot in the daily queue for its first week.
    expect(stats.newestNodeAt).toEqual(new Date('2026-08-01T10:00:00Z'))
  })

  it('never lets one root\'s failure end the run', async () => {
    loadRootsToWalk.mockResolvedValue([root('1'), root('2')])
    fetchThreadContext
      .mockResolvedValueOnce({ ok: false, code: 'fetch_failed', message: 'boom' })
      .mockResolvedValueOnce({ ok: true, descendants: [], authenticated: false })

    const result = await walkThreads()

    expect(result.failed).toBe(1)
    expect(result.walked).toBe(1)
  })
})
