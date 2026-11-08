import { describe, it, expect } from 'vitest'
import { parseFollowInput, isEnvFollow } from './follow-admin.js'

describe('parseFollowInput', () => {
  it('takes a handle with or without the leading @, lower-casing the host', () => {
    expect(parseFollowInput('@markus@neodb.social')).toEqual({ kind: 'handle', handle: '@markus@neodb.social' })
    expect(parseFollowInput('  markus@NeoDB.Social ')).toEqual({ kind: 'handle', handle: '@markus@neodb.social' })
  })

  it('takes an https actor URL as it is', () => {
    expect(parseFollowInput('https://neodb.social/users/markus')).toEqual({ kind: 'url', url: 'https://neodb.social/users/markus' })
  })

  it('refuses what is neither', () => {
    expect(parseFollowInput('')).toBeNull()
    expect(parseFollowInput('markus')).toBeNull()
    expect(parseFollowInput('@markus@localhost')).toBeNull()
    expect(parseFollowInput('http://neodb.social/users/markus')).toBeNull()
    expect(parseFollowInput('@a@b@c.social')).toBeNull()
  })
})

describe('isEnvFollow', () => {
  const list = ['@markus@minreol.dk', 'Markus@Skvip.lol']
  it('matches regardless of the leading @ and case', () => {
    expect(isEnvFollow('@markus@minreol.dk', list)).toBe(true)
    expect(isEnvFollow('@markus@skvip.lol', list)).toBe(true)
  })
  it('is false for an account only followed from the admin, or with no handle', () => {
    expect(isEnvFollow('@markus@neodb.social', list)).toBe(false)
    expect(isEnvFollow(null, list)).toBe(false)
  })
})
