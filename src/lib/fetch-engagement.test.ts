import { describe, it, expect } from 'vitest'
import {
  parseStatusRef,
  classifyRestStatus,
  extractApCounts,
  mapPool,
  statusOrigin,
  type StatusRef,
} from './fetch-engagement.js'

const OWNER = 'skvip.lol'

const asRef = (v: ReturnType<typeof parseStatusRef>): StatusRef => {
  if ('error' in v) throw new Error(`expected a StatusRef, got error: ${v.message}`)
  return v
}

describe('parseStatusRef', () => {
  it('parses a Mastodon web permalink and synthesizes the AP candidate', () => {
    const ref = asRef(parseStatusRef('https://skvip.lol/@markus/116850934803868399', OWNER))
    expect(ref.origin).toBe('skvip.lol')
    expect(ref.statusId).toBe('116850934803868399')
    expect(ref.candidateApId).toBe('https://skvip.lol/users/markus/statuses/116850934803868399')
    expect(ref.restUrl).toBe('https://skvip.lol/api/v1/statuses/116850934803868399')
  })

  it('passes an AP id form through as its own candidate', () => {
    const ref = asRef(
      parseStatusRef('https://skvip.lol/users/markus/statuses/116850934803868399', OWNER),
    )
    expect(ref.candidateApId).toBe('https://skvip.lol/users/markus/statuses/116850934803868399')
    expect(ref.statusId).toBe('116850934803868399')
  })

  it('resolves a bare numeric id against OWNER_INSTANCE with no AP candidate', () => {
    const ref = asRef(parseStatusRef('116850934803868399', OWNER))
    expect(ref.origin).toBe('skvip.lol')
    expect(ref.candidateApId).toBeNull()
    expect(ref.restUrl).toBe('https://skvip.lol/api/v1/statuses/116850934803868399')
  })

  it('rejects a bare id when OWNER_INSTANCE is unset', () => {
    const r = parseStatusRef('116850934803868399', '')
    expect(r).toMatchObject({ error: 'unresolved_origin' })
  })

  it('rejects remote-view permalinks (/@user@otherhost/id)', () => {
    const r = parseStatusRef('https://mastodon.social/@markus@skvip.lol/1234', OWNER)
    expect(r).toMatchObject({ error: 'unresolved_origin' })
  })

  it('rejects strings that are neither URLs nor numeric ids', () => {
    expect(parseStatusRef('not a status', OWNER)).toMatchObject({ error: 'unresolved_origin' })
    expect(parseStatusRef('', OWNER)).toMatchObject({ error: 'unresolved_origin' })
    expect(parseStatusRef('ftp://host/1', OWNER)).toMatchObject({ error: 'unresolved_origin' })
  })

  it('accepts non-numeric ids in URL forms (GoToSocial ULIDs)', () => {
    const ref = asRef(
      parseStatusRef('https://gts.example/@sam/statuses/01H8XG071P6RJVRFC30ZMHW1GD', OWNER),
    )
    expect(ref.statusId).toBe('01H8XG071P6RJVRFC30ZMHW1GD')
    expect(ref.origin).toBe('gts.example')
  })

  it('accepts unknown URL shapes and keeps the URL as the AP candidate', () => {
    const ref = asRef(parseStatusRef('https://misskey.io/notes/9abcdef', OWNER))
    expect(ref.statusId).toBe('9abcdef')
    expect(ref.candidateApId).toBe('https://misskey.io/notes/9abcdef')
  })

  it('strips query, fragment, and trailing slashes from the AP candidate', () => {
    const ref = asRef(
      parseStatusRef('https://skvip.lol/users/markus/statuses/123/?utm=x#frag', OWNER),
    )
    expect(ref.candidateApId).toBe('https://skvip.lol/users/markus/statuses/123')
    expect(ref.statusId).toBe('123')
  })

  it('lowercases the origin host', () => {
    const ref = asRef(parseStatusRef('https://SKVIP.LOL/@markus/123', OWNER))
    expect(ref.origin).toBe('skvip.lol')
  })
})

describe('classifyRestStatus', () => {
  it('treats only a rate limit as terminal', () => {
    expect(classifyRestStatus(429)).toBe('rate_limited')
    expect(classifyRestStatus(404)).toBe('try_ap')
    expect(classifyRestStatus(410)).toBe('try_ap')
    expect(classifyRestStatus(500)).toBe('try_ap')
    expect(classifyRestStatus(503)).toBe('try_ap')
  })

  // /api/v1/statuses/:id is a Mastodon route. Software that doesn't implement it
  // answers however it answers an unknown path, and NeoDB — which gates its whole API
  // behind a token — says 401. Ending the read there reported "no counts" for
  // minreol.dk posts whose AP objects were serving a public reply count all along.
  // A genuinely private post refuses the AP object too, and fetchApLeg is what says so.
  it('falls through to AP on 401/403 rather than calling the post private', () => {
    expect(classifyRestStatus(401)).toBe('try_ap')
    expect(classifyRestStatus(403)).toBe('try_ap')
  })
})

describe('statusOrigin', () => {
  it('reads the host a reference would be dialled on, lowercased', () => {
    expect(statusOrigin('https://MinReol.dk/@markus@minreol.dk/posts/612600118463511440/'))
      .toBe('minreol.dk')
    expect(statusOrigin('https://skvip.lol/users/markus/statuses/1')).toBe('skvip.lol')
  })

  it("returns '' for anything that names no host, so a gate excludes it", () => {
    expect(statusOrigin('116850934803868399')).toBe('')
    expect(statusOrigin('')).toBe('')
    expect(statusOrigin('   ')).toBe('')
  })
})

describe('extractApCounts', () => {
  it('reads inline totalItems from likes/shares/replies', () => {
    expect(
      extractApCounts({
        likes: { totalItems: 6 },
        shares: { totalItems: 4 },
        replies: { totalItems: 1 },
      }),
    ).toEqual({ favourites: 6, reblogs: 4, replies: 1, quotes: null })
  })

  it('coalesces missing collections to 0 when at least one is present', () => {
    expect(extractApCounts({ likes: { totalItems: 3 } })).toEqual({
      favourites: 3,
      reblogs: 0,
      replies: 0,
      quotes: null,
    })
  })

  it('treats URL-string collections as absent (no page chasing)', () => {
    expect(
      extractApCounts({
        likes: 'https://host/x/likes',
        shares: { totalItems: 2 },
      }),
    ).toEqual({ favourites: 0, reblogs: 2, replies: 0, quotes: null })
  })

  it('returns unsupported when no collection carries a total', () => {
    expect(extractApCounts({ likes: 'https://host/x/likes' })).toBe('unsupported')
    expect(extractApCounts({ content: 'hi' })).toBe('unsupported')
    expect(extractApCounts(null)).toBe('unsupported')
    expect(extractApCounts('string')).toBe('unsupported')
  })

  it('ignores non-numeric totalItems', () => {
    expect(extractApCounts({ likes: { totalItems: 'many' } })).toBe('unsupported')
  })
})

describe('mapPool', () => {
  it('preserves input order in the results', async () => {
    const delays = [30, 5, 15, 1]
    const out = await mapPool(delays, 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms))
      return i * 10
    })
    expect(out).toEqual([0, 10, 20, 30])
  })

  it('never exceeds the concurrency cap', async () => {
    let inFlight = 0
    let maxInFlight = 0
    await mapPool([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    })
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })
})
