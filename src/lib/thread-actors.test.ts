import { describe, it, expect, vi } from 'vitest'

// The matcher must not need a database — a handle that does not match is the whole
// failure this reports on, and it has to be assertable without one.
vi.mock('../db/client.js', () => ({
  getDb: () => { throw new Error('matchThreadActors must not touch the database') },
}))

const { matchThreadActors } = await import('./thread-store.js')

const ROWS = [
  { apId: 'https://skvip.lol/users/markus', handle: '@markus@skvip.lol' },
  { apId: 'https://gigowl.social/users/markus', handle: '@markus@gigowl.social' },
  // A row the ingest stored without a handle. The actor id still names it.
  { apId: 'https://bokwyrm.example/user/markus', handle: null },
]

describe('matchThreadActors', () => {
  it('matches a handle as the archive spells it', () => {
    expect(matchThreadActors(['@markus@skvip.lol'], ROWS)).toEqual([
      { apId: 'https://skvip.lol/users/markus', handle: '@markus@skvip.lol', source: 'configured' },
    ])
  })

  it('matches without the leading @, which is how people write .env files', () => {
    expect(matchThreadActors(['markus@skvip.lol'], ROWS).map(a => a.handle))
      .toEqual(['@markus@skvip.lol'])
  })

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(matchThreadActors([' @Markus@SKVIP.lol '], ROWS).map(a => a.handle))
      .toEqual(['@markus@skvip.lol'])
  })

  it('matches an actor URL exactly', () => {
    expect(matchThreadActors(['https://skvip.lol/users/markus'], ROWS).map(a => a.handle))
      .toEqual(['@markus@skvip.lol'])
  })

  it('derives a handle for a row that has none, so it is still matchable and still mine', () => {
    expect(matchThreadActors(['https://bokwyrm.example/user/markus'], ROWS)).toEqual([
      { apId: 'https://bokwyrm.example/user/markus', handle: '@markus@bokwyrm.example', source: 'configured' },
    ])
  })

  it('takes several accounts at once', () => {
    expect(matchThreadActors(['@markus@skvip.lol', '@markus@gigowl.social'], ROWS)).toHaveLength(2)
  })

  it('matches the PROFILE url a person copies out of a browser, not just the actor id', () => {
    // `https://skvip.lol/@markus` is what the address bar shows; the archive keys on
    // `https://skvip.lol/users/markus`. String equality alone makes that a silent miss.
    expect(matchThreadActors(['https://skvip.lol/@markus'], ROWS).map(a => a.apId))
      .toEqual(['https://skvip.lol/users/markus'])
  })

  it('returns nothing for a handle the archive does not hold — the reportable case', () => {
    // This is the failure that used to be indistinguishable from "nothing configured".
    expect(matchThreadActors(['@markus@mastodon.social'], ROWS)).toEqual([])
  })

  it('does not match a bare username against a handle', () => {
    // `markus` is not `@markus@skvip.lol`; guessing the domain would pick an arbitrary
    // account on a server holding several of his.
    expect(matchThreadActors(['markus'], ROWS)).toEqual([])
  })
})
