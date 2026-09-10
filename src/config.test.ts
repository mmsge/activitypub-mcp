import { describe, it, expect } from 'vitest'
import {
  getOwnerIdentity, getActorPublished, getBreakoutObjectTypes, getBreakoutWeights,
  breakoutEnabled, config, getEngagementSampleOrigins,
} from './config.js'

describe('getOwnerIdentity', () => {
  it('parses an @user@domain handle into a handle and a profile URL', () => {
    expect(getOwnerIdentity('@markus@skvip.lol')).toEqual({
      handle: '@markus@skvip.lol',
      url: 'https://skvip.lol/@markus',
    })
  })

  it('accepts a handle without the leading @', () => {
    expect(getOwnerIdentity('markus@skvip.lol')).toEqual({
      handle: '@markus@skvip.lol',
      url: 'https://skvip.lol/@markus',
    })
  })

  it('derives a handle from a Mastodon-style actor URL, keeping the URL as given', () => {
    expect(getOwnerIdentity('https://skvip.lol/@markus')).toEqual({
      handle: '@markus@skvip.lol',
      url: 'https://skvip.lol/@markus',
    })
  })

  it('derives a handle from a /users/ actor URL', () => {
    expect(getOwnerIdentity('https://skvip.lol/users/markus')).toEqual({
      handle: '@markus@skvip.lol',
      url: 'https://skvip.lol/users/markus',
    })
  })

  it('trims surrounding whitespace', () => {
    expect(getOwnerIdentity('  @markus@skvip.lol  ')?.handle).toBe('@markus@skvip.lol')
  })

  it('returns null when unset or unparseable', () => {
    expect(getOwnerIdentity('')).toBeNull()
    expect(getOwnerIdentity('   ')).toBeNull()
    expect(getOwnerIdentity('markus')).toBeNull()
    expect(getOwnerIdentity('not a url://')).toBeNull()
    expect(getOwnerIdentity('https://skvip.lol')).toBeNull()
  })
})

describe('getActorPublished', () => {
  it('normalises a date to an ISO timestamp', () => {
    expect(getActorPublished('2026-05-02')).toBe('2026-05-02T00:00:00.000Z')
  })

  it('returns null for an empty or invalid value', () => {
    expect(getActorPublished('')).toBeNull()
    expect(getActorPublished('  ')).toBeNull()
    expect(getActorPublished('not-a-date')).toBeNull()
  })
})

describe('getBreakoutObjectTypes', () => {
  it('drops blanks and duplicates', () => {
    expect(getBreakoutObjectTypes('Note, ,Image,Note')).toEqual(['Note', 'Image'])
  })

  it('falls back to the defaults rather than matching nothing', () => {
    // An empty list would look exactly like "he has not posted lately" — silence that
    // is indistinguishable from a working feature is the failure mode to avoid.
    expect(getBreakoutObjectTypes('')).toContain('Note')
    expect(getBreakoutObjectTypes(' , , ')).toContain('Note')
  })

  it('leaves BookWyrm boilerplate out of the default population', () => {
    // GeneratedNote is "Markus finished reading X" — near-zero engagement, and
    // including it drags that account's percentiles toward zero.
    expect(getBreakoutObjectTypes()).not.toContain('GeneratedNote')
  })
})

describe('getBreakoutWeights', () => {
  it('weights a boost above a reply above a favourite by default', () => {
    const w = getBreakoutWeights()
    expect(w.reblogs).toBeGreaterThan(w.replies)
    expect(w.replies).toBeGreaterThan(w.favourites)
  })
})

describe('breakoutEnabled', () => {
  it('is off out of the box, so the code can deploy before it is armed', () => {
    expect(config.BREAKOUT_ENABLED).toBe(false)
    expect(breakoutEnabled()).toBe(false)
  })

  it('stays off without an ntfy password, however enabled it looks', () => {
    // Arming a ladder that cannot notify would spend rungs nobody was told about.
    const prev = { enabled: config.BREAKOUT_ENABLED, pw: config.NTFY_PASSWORD }
    Object.assign(config, { BREAKOUT_ENABLED: true, NTFY_PASSWORD: '' })
    expect(breakoutEnabled()).toBe(false)
    Object.assign(config, { NTFY_PASSWORD: 'hunter2' })
    expect(breakoutEnabled()).toBe(true)
    Object.assign(config, { BREAKOUT_ENABLED: prev.enabled, NTFY_PASSWORD: prev.pw })
  })
})

describe('the trip-prune bounds', () => {
  it('default to a fifth of the window, with a floor that needs a populated one', () => {
    // The defaults are the safety property, so they are pinned rather than assumed:
    // a share alone is too blunt for a handful of corrections, and a floor alone
    // would empty a narrow window. See decision record 0054.
    expect(config.TRIP_PRUNE_MAX_SHARE).toBe(0.2)
    expect(config.TRIP_PRUNE_MIN_CANDIDATES).toBe(3)
    expect(config.TRIP_PRUNE_MIN_WINDOW).toBe(10)
  })

  it('reads the share as a fraction, not an integer percentage', () => {
    // The one non-integer number in the schema. Coerced to `.int()` by a reader
    // pattern-matching its neighbours, 0.2 would round to 0 and refuse everything.
    expect(Number.isInteger(config.TRIP_PRUNE_MAX_SHARE)).toBe(false)
  })
})

describe('getEngagementSampleOrigins', () => {
  it('parses a comma-separated list into lowercase bare hostnames', () => {
    expect(getEngagementSampleOrigins('Gigowl.social, https://rullen.no/ ,', 'skvip.lol'))
      .toEqual(new Set(['skvip.lol', 'gigowl.social', 'rullen.no']))
  })

  // The breakout ladder is built on his own account. A list that leaves the owner
  // instance out is a typo, not an instruction to stop watching it, so the host is
  // folded in whatever is configured.
  it('always includes the owner instance, even when the list omits it', () => {
    expect(getEngagementSampleOrigins('gigowl.social', 'skvip.lol').has('skvip.lol')).toBe(true)
    expect(getEngagementSampleOrigins('', 'skvip.lol')).toEqual(new Set(['skvip.lol']))
  })

  // Empty is "poll nothing", never "poll everything" — the sampler warns and stops.
  // Defaulting the other way is how an unattended job ends up on somebody else's box.
  it('is empty when nothing is configured and no owner instance is set', () => {
    expect(getEngagementSampleOrigins('', '')).toEqual(new Set())
  })

  it('does not admit a host merely because an account lives there', () => {
    const origins = getEngagementSampleOrigins('gigowl.social,rullen.no', 'skvip.lol')
    expect(origins.has('minreol.dk')).toBe(false)
    expect(origins.has('bookwyrm.social')).toBe(false)
  })
})
