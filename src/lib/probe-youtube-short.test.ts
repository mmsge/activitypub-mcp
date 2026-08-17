import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { interpretProbeResponse, parseRetryAfter, redirectHost, shortsUrl } from './probe-youtube-short.js'

describe('interpretProbeResponse', () => {
  // Both cases below were verified against live YouTube on 2026-08-17:
  //   oijqsP5wizI (a genuine Short) -> HTTP 200, no redirect
  //   fwLsCgibGw4 (Palindrome Ages) -> HTTP 303 -> https://www.youtube.com/watch?v=fwLsCgibGw4
  it('reads a 200 on /shorts/ as a confirmed Short', () => {
    expect(interpretProbeResponse(200, null)).toEqual({ kind: 'short' })
  })

  it('reads the 303 to /watch as not a Short', () => {
    expect(interpretProbeResponse(303, 'https://www.youtube.com/watch?v=fwLsCgibGw4')).toEqual({ kind: 'not_short' })
    expect(interpretProbeResponse(302, '/watch?v=abc')).toEqual({ kind: 'not_short' })
  })

  it('backs off on 429 rather than treating it as a verdict', () => {
    // YouTube 429s after two requests. A 429 read as "not a Short" would silently poison
    // the whole band the moment the rate limit bit.
    expect(interpretProbeResponse(429, null)).toEqual({ kind: 'rate_limited', retryAfterMs: null })
    expect(interpretProbeResponse(429, null, '30')).toEqual({ kind: 'rate_limited', retryAfterMs: 30_000 })
  })

  it('refuses to read an unrecognised redirect as a Short', () => {
    // This is what the box actually got, 200 times out of 200, before the consent cookie:
    // an EU IP is bounced to consent.youtube.com rather than to the video. Reading it as a
    // verdict would have written 200 wrong answers instead of 200 recorded failures.
    const outcome = interpretProbeResponse(
      302,
      'https://consent.youtube.com/m?continue=https%3A%2F%2Fwww.youtube.com%2Fshorts%2FoijqsP5wizI%3Fcbrd%3D1&gl=FI',
    )
    expect(outcome.kind).toBe('error')
  })

  it('records only the redirect HOST, so one cause groups as one row', () => {
    // The full URL carries a `continue=` holding the video id, so 200 identical failures
    // were stored as 200 distinct strings and GROUP BY returned a page of rows reading 1.
    const a = interpretProbeResponse(302, 'https://consent.youtube.com/m?continue=x%2Fshorts%2FAAA&gl=FI')
    const b = interpretProbeResponse(302, 'https://consent.youtube.com/m?continue=x%2Fshorts%2FBBB&gl=DE')
    expect(a).toEqual(b)
    expect(a).toEqual({ kind: 'error', status: 302, error: 'unexpected redirect to consent.youtube.com' })
  })

  it('treats a redirect with no Location as an error, not a Short', () => {
    expect(interpretProbeResponse(301, null).kind).toBe('error')
  })

  it('records 404 and 5xx as errors rather than fabricating a false', () => {
    expect(interpretProbeResponse(404, null).kind).toBe('error')
    expect(interpretProbeResponse(503, null).kind).toBe('error')
  })
})

describe('parseRetryAfter', () => {
  it('accepts the delay-seconds form', () => {
    expect(parseRetryAfter('120', 0)).toBe(120_000)
    expect(parseRetryAfter('0', 0)).toBe(0)
  })

  it('accepts the HTTP-date form', () => {
    const now = Date.parse('2026-08-17T12:00:00Z')
    expect(parseRetryAfter('Mon, 17 Aug 2026 12:01:00 GMT', now)).toBe(60_000)
  })

  it('never returns a negative delay for a date already past', () => {
    const now = Date.parse('2026-08-17T12:00:00Z')
    expect(parseRetryAfter('Mon, 17 Aug 2026 11:00:00 GMT', now)).toBe(0)
  })

  it('returns null when there is no usable header', () => {
    expect(parseRetryAfter(null, 0)).toBeNull()
    expect(parseRetryAfter('soon', 0)).toBeNull()
  })
})

describe('redirectHost', () => {
  it('reduces a Location to its host', () => {
    expect(redirectHost('https://consent.youtube.com/m?continue=x&gl=FI')).toBe('consent.youtube.com')
    expect(redirectHost('https://www.youtube.com/watch?v=abc')).toBe('www.youtube.com')
  })

  it('resolves a relative Location against YouTube, since a relative Location is legal', () => {
    expect(redirectHost('/watch?v=abc')).toBe('www.youtube.com')
    // Anything without a scheme is a path, so it resolves rather than failing. The base is
    // what makes this total for essentially every real header value.
    expect(redirectHost('::nonsense::')).toBe('www.youtube.com')
  })

  it('falls back to the raw value only for something that cannot parse at all', () => {
    expect(redirectHost('http://[')).toBe('http://[')
  })
})

describe('shortsUrl', () => {
  it('builds the /shorts/ URL the probe depends on', () => {
    expect(shortsUrl('oijqsP5wizI')).toBe('https://www.youtube.com/shorts/oijqsP5wizI')
  })
})

describe('the consent cookie', () => {
  it('is sent on every probe, or an EU IP never reaches a video', () => {
    // Measured from the box on 2026-08-17: with SOCS=CAI a Short returns 200 and a
    // non-Short returns 303 to /watch; with CONSENT=YES+cb, and with no cookie, both are
    // redirected to the consent wall. The predecessor cookie is dead — do not restore it.
    const source = readFileSync(new URL('./probe-youtube-short.ts', import.meta.url), 'utf8')
    expect(source).toContain("'SOCS=CAI'")
    expect(source).toMatch(/Cookie: CONSENT_COOKIE/)
  })
})
