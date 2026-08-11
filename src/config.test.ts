import { describe, it, expect } from 'vitest'
import {
  getOwnerIdentity, getActorPublished, getBreakoutObjectTypes, getBreakoutWeights,
  breakoutEnabled, config,
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
