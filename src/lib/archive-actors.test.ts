import { describe, it, expect } from 'vitest'
import { isArchiveDomain } from './archive-actors.js'

describe('isArchiveDomain', () => {
  it('recognises the domain bare or inside a URL, in any case', () => {
    expect(isArchiveDomain('twitter.com')).toBe(true)
    expect(isArchiveDomain('Twitter.com')).toBe(true)
    expect(isArchiveDomain('https://twitter.com/MThorr')).toBe(true)
    expect(isArchiveDomain('https://twitter.com/MThorr/status/1')).toBe(true)
  })

  it('knows TikTok on both its hosts: the handle on tiktok.com, every page on www', () => {
    expect(isArchiveDomain('tiktok.com')).toBe(true)
    expect(isArchiveDomain('www.tiktok.com')).toBe(true)
    expect(isArchiveDomain('https://www.tiktok.com/@markusrote')).toBe(true)
    expect(isArchiveDomain('https://www.tiktok.com/@markusrote/video/7052580526875495686')).toBe(true)
    expect(isArchiveDomain('https://www.tiktok.com/@markusrote#arkiv-20220505T120000Z')).toBe(true)
    // Other TikTok hosts are not where an archived post lives.
    expect(isArchiveDomain('https://vm.tiktok.com/x')).toBe(false)
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
