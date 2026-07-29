import { describe, it, expect } from 'vitest'
import { getOwnerIdentity, getActorPublished } from './config.js'

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
