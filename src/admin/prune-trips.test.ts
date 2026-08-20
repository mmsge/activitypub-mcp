import { describe, it, expect, vi, beforeEach } from 'vitest'

// A DB-free test of the one thing that must never happen by accident: a delete. The
// mocked client throws on any use, so "nothing to do" reaching Postgres at all is a
// failure — the shape prune-activity-log.test.ts uses, for the same reason.

const getDb = vi.fn(() => {
  throw new Error('getDb() must not be called when there is nothing to prune')
})
vi.mock('../db/client.js', () => ({ getDb }))

const linkTripPosts = vi.fn(async () => ({}))
vi.mock('../jobs/link-trip-posts.js', () => ({ linkTripPosts }))

const { applyTripPrune } = await import('./prune-trips.js')

const WINDOW = { from: new Date('2026-08-20T00:00:00Z'), to: new Date('2026-08-21T00:00:00Z') }

beforeEach(() => {
  getDb.mockClear()
  linkTripPosts.mockClear()
})

/**
 * A chained select/delete stub. Each awaited chain takes the next queued result, so a
 * test states what the database answers in the order the function asks.
 */
function fakeDb(results: unknown[]) {
  const del = vi.fn(() => {
    throw new Error('a refused prune must not reach a delete')
  })
  const chain = (): Record<string, unknown> => {
    const link: Record<string, unknown> = {}
    for (const method of ['from', 'where', 'orderBy', 'returning']) {
      link[method] = () => link
    }
    link.then = (resolve: (v: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(resolve)
    return link
  }
  return { select: () => chain(), delete: del, _delete: del }
}

const storedTrip = (id: string, createdAt = new Date('2026-01-01T00:00:00Z')) => ({
  id,
  fromStation: 'Oslo S',
  toStation: 'Hamar',
  key: '2026-08-20 05:34:00',
  departureAt: new Date('2026-08-20T05:34:00Z'),
  departureLocal: new Date('2026-08-20T07:34:00Z'),
  arrivalAt: null,
  journey: 'Roros 2026',
  trainCode: null,
  status: 'Planned',
  distanceKm: 125,
  createdAt,
})

describe('applyTripPrune', () => {
  it('does nothing, and touches no connection, when the confirm named no trips', async () => {
    await expect(
      applyTripPrune({ ids: [], window: WINDOW, derivedAt: new Date() }),
    ).resolves.toEqual({ deleted: 0, refusal: null, rejected: [], orphaned: [] })
    expect(getDb).not.toHaveBeenCalled()
    // …and in particular does not re-derive the trip/post join for a no-op.
    expect(linkTripPosts).not.toHaveBeenCalled()
  })

  it('refuses without deleting when the plan is too large for its window', async () => {
    // Two of the four trips in the range are missing from the export. That is 50%, and
    // 2 <= the floor of 3 — the case the floor must NOT wave through, because a narrow
    // window is where a filtered export looks exactly like a correction.
    const db = fakeDb([[storedTrip('a'), storedTrip('b')], [{ n: 4 }]])
    getDb.mockReturnValue(db as never)

    const result = await applyTripPrune({
      ids: ['a', 'b'],
      window: WINDOW,
      derivedAt: new Date('2026-08-20T12:00:00Z'),
    })

    expect(result.deleted).toBe(0)
    expect(result.refusal).toContain('2 of the 4')
    expect(db._delete).not.toHaveBeenCalled()
    // Nothing was unbound, so nothing needs re-binding.
    expect(linkTripPosts).not.toHaveBeenCalled()
  })

  it('declines a trip stored after the plan was drawn rather than deleting it', async () => {
    // Re-added in viaduct and re-imported between the two clicks. It was never on the
    // page the admin read, so it is not what they confirmed.
    const db = fakeDb([[storedTrip('a', new Date('2026-08-20T18:00:00Z'))]])
    getDb.mockReturnValue(db as never)

    const result = await applyTripPrune({
      ids: ['a'],
      window: WINDOW,
      derivedAt: new Date('2026-08-20T12:00:00Z'),
    })

    expect(result.deleted).toBe(0)
    expect(result.rejected).toEqual([{ id: 'a', reason: 'stored after the plan was drawn' }])
    expect(db._delete).not.toHaveBeenCalled()
  })

  it('declines an id the window no longer holds', async () => {
    const db = fakeDb([[]])
    getDb.mockReturnValue(db as never)

    const result = await applyTripPrune({
      ids: ['gone'],
      window: WINDOW,
      derivedAt: new Date('2026-08-20T12:00:00Z'),
    })

    expect(result.deleted).toBe(0)
    expect(result.rejected[0].reason).toContain('no longer stored inside the range')
    expect(db._delete).not.toHaveBeenCalled()
  })
})
