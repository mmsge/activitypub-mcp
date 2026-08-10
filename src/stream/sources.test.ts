import { describe, it, expect } from 'vitest'
import {
  parseSources, platformInfo, isPlatform, isApPlatform,
  lanesForPlatform, SourceConfigError, AP_PLATFORMS, LOCAL_PLATFORMS, KINDS,
} from './sources.js'

const REAL = [
  '@markus@skvip.lol|mastodon',
  '@mvrkws@bookwyrm.social|bookwyrm',
  '@markus@pixelfed.babb.no|pixelfed',
  '@markus@loops.video|loops',
  '@markus@minreol.dk|neodb',
  '@markus@rullen.no|rullen',
  '@markus@samklang.msge.no|samklang',
].join(',')

describe('parseSources', () => {
  it('parses the seven real accounts', () => {
    const sources = parseSources(REAL)
    expect(sources).toHaveLength(7)
    expect(sources.map((s) => s.platform)).toEqual([...AP_PLATFORMS])
    expect(sources[0]).toEqual({ handle: '@markus@skvip.lol', platform: 'mastodon', apId: null })
  })

  it('tolerates whitespace and a missing leading @', () => {
    expect(parseSources(' markus@skvip.lol | mastodon ')[0].handle).toBe('@markus@skvip.lol')
  })

  it('treats an empty setting as no sources', () => {
    expect(parseSources('')).toEqual([])
    expect(parseSources('  ,  ')).toEqual([])
  })

  it('throws on a malformed entry rather than skipping it', () => {
    // A skipped entry silently changes which accounts are publishable. Better to
    // refuse to start than to serve a page built from a typo.
    for (const bad of [
      '@markus@skvip.lol',
      'mastodon',
      '@markus@skvip.lol|',
      '|mastodon',
      '@markus@skvip.lol|mastodon|extra',
    ]) {
      expect(() => parseSources(bad)).toThrow(SourceConfigError)
    }
  })

  it('throws on an unknown platform', () => {
    expect(() => parseSources('@a@b.social|twitter')).toThrow(/unknown platform/)
    // Local sources are not configurable — they are not accounts.
    expect(() => parseSources('@a@b.social|lastfm')).toThrow(SourceConfigError)
  })

  it('throws on an unusable handle', () => {
    for (const bad of ['@markus|mastodon', '@@|mastodon', '@a b@c|mastodon']) {
      expect(() => parseSources(bad)).toThrow(SourceConfigError)
    }
  })

  it('throws on a duplicate handle', () => {
    expect(() => parseSources('@a@b.social|mastodon,@A@B.social|pixelfed')).toThrow(/more than once/)
  })
})

describe('platform registry', () => {
  // Read off the registry rather than a hand-kept list: a platform added to
  // AP_PLATFORMS without an entry in PLATFORM_INFO renders as undefined and takes
  // the page down, and a list repeated here would be the thing left un-updated.
  it('gives every platform a lane and a Nynorsk label', () => {
    for (const p of [...AP_PLATFORMS, ...LOCAL_PLATFORMS]) {
      const info = platformInfo(p)
      expect(info.lane).toBeTruthy()
      expect(info.label).toBeTruthy()
      expect(info.linkLabel).toBeTruthy()
    }
  })

  it('keeps the post platforms in one lane and the rest apart', () => {
    // Lanes must be disjoint by actor or a post is counted twice in the merge.
    expect(platformInfo('mastodon').lane).toBe('posts')
    expect(platformInfo('pixelfed').lane).toBe('posts')
    expect(platformInfo('loops').lane).toBe('posts')
    // Markus' own server, for railway clips — posts, like the others.
    expect(platformInfo('rullen').lane).toBe('posts')
    // His concert log federates an attendance note per gig — also an ordinary post.
    expect(platformInfo('samklang').lane).toBe('posts')
    expect(platformInfo('bookwyrm').lane).toBe('reading')
    expect(platformInfo('neodb').lane).toBe('marks')
  })

  it('separates federated platforms from local ones', () => {
    expect(isApPlatform('mastodon')).toBe(true)
    expect(isApPlatform('lastfm')).toBe(false)
    expect(isPlatform('lastfm')).toBe(true)
    expect(isPlatform('twitter')).toBe(false)
  })
})

describe('lanesForPlatform', () => {
  it('runs every lane when unfiltered', () => {
    expect(lanesForPlatform(null)).toHaveLength(6)
  })

  it('runs exactly one lane when filtered', () => {
    expect(lanesForPlatform('bookwyrm')).toEqual(['reading'])
    expect(lanesForPlatform('lastfm')).toEqual(['music'])
  })
})

describe('KINDS', () => {
  it('has no duplicates', () => {
    expect(new Set(KINDS).size).toBe(KINDS.length)
  })
})
