import { describe, it, expect } from 'vitest'
import { isArchiveDomain } from './archive-actors.js'

describe('isArchiveDomain', () => {
  it('recognises the domain bare or inside a URL, in any case', () => {
    expect(isArchiveDomain('twitter.com')).toBe(true)
    expect(isArchiveDomain('Twitter.com')).toBe(true)
    expect(isArchiveDomain('https://twitter.com/MThorr')).toBe(true)
    expect(isArchiveDomain('https://twitter.com/MThorr/status/1')).toBe(true)
  })

  it('leaves every real server alone', () => {
    expect(isArchiveDomain('skvip.lol')).toBe(false)
    expect(isArchiveDomain('https://skvip.lol/users/markus')).toBe(false)
    // A lookalike is not the archive: the match is the whole hostname.
    expect(isArchiveDomain('https://twitter.com.evil.example/x')).toBe(false)
    expect(isArchiveDomain('https://mobile.twitter.com/x')).toBe(false)
  })

  it('is false, not a throw, for something that is not a URL', () => {
    expect(isArchiveDomain('http://')).toBe(false)
    expect(isArchiveDomain('')).toBe(false)
  })
})
