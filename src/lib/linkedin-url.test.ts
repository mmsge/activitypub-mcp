// The join between LinkedIn's two sources rests entirely on this function. The
// brief said the post URL is the join key and no URN mapping is needed — true in
// that no lookup is required, but the two sources do not emit the same string for
// the same post. The engagement log built from .xlsx exports holds
// `/posts/markus-mg_..._ugcPost-<id>-<hash>`; the API emits
// `/feed/update/urn:li:activity:<id>`. If these ever stop reducing to the same key
// the join matches nothing and does so silently, so each form is pinned here.
import { describe, it, expect } from 'vitest'
import { canonicalPostKey, canonicalPostUrl } from './linkedin-url.js'

describe('canonicalPostKey', () => {
  it('reduces the API form and the export form of one post to the same key', () => {
    const fromApi = 'https://www.linkedin.com/feed/update/urn:li:activity:7462903540748034050'
    const fromExport =
      'https://www.linkedin.com/posts/markus-mg_ki-buzzwords-ugcPost-7462903540748034050-dUyv'

    expect(canonicalPostKey(fromApi)).toBe('7462903540748034050')
    expect(canonicalPostKey(fromExport)).toBe(canonicalPostKey(fromApi))
  })

  it('reads every URN type the snapshot emits', () => {
    expect(canonicalPostKey('urn:li:activity:7462903540748034050')).toBe('7462903540748034050')
    expect(canonicalPostKey('urn:li:share:7375836775962996737')).toBe('7375836775962996737')
    expect(canonicalPostKey('urn:li:ugcPost:7432061927004028928')).toBe('7432061927004028928')
  })

  it('reads a percent-encoded URN, as it appears inside some permalinks', () => {
    expect(canonicalPostKey('https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A7459859906901479425'))
      .toBe('7459859906901479425')
  })

  it('is not fooled by digits in the slug', () => {
    // A real export URL whose slug carries its own numbers before the id.
    const url =
      'https://www.linkedin.com/posts/markus-mg_2024-oppsummering-share-7382322778395369472-yR1a'
    expect(canonicalPostKey(url)).toBe('7382322778395369472')
  })

  it('survives percent-encoding and a query string on the export URL', () => {
    const url =
      'https://www.linkedin.com/posts/markus-mg_etter-fleire-%C3%A5r-i-same-prosjekt-pr%C3%B8var-eg-ugcPost-7432061927004028928-1jyr?utm_source=share'
    expect(canonicalPostKey(url)).toBe('7432061927004028928')
  })

  it('passes a bare id through, so callers can hand the get-one tool either form', () => {
    expect(canonicalPostKey('7462903540748034050')).toBe('7462903540748034050')
  })

  it('returns null rather than a wrong key when there is no id to find', () => {
    expect(canonicalPostKey('https://www.linkedin.com/in/markus-mg')).toBeNull()
    expect(canonicalPostKey('')).toBeNull()
    expect(canonicalPostKey(null)).toBeNull()
    expect(canonicalPostKey(undefined)).toBeNull()
    // Too short to be a post id — a year, a follower count, a row number.
    expect(canonicalPostKey('https://example.com/2026')).toBeNull()
  })
})

describe('canonicalPostUrl', () => {
  it('round-trips through canonicalPostKey', () => {
    const key = '7462903540748034050'
    expect(canonicalPostKey(canonicalPostUrl(key))).toBe(key)
  })
})
