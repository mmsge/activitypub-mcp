import { describe, it, expect } from 'vitest'
import { interpretProbeResponse, parseRetryAfter, shortsUrl } from './probe-youtube-short.js'

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
    const outcome = interpretProbeResponse(302, 'https://consent.youtube.com/m?continue=x')
    expect(outcome.kind).toBe('error')
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

describe('shortsUrl', () => {
  it('builds the /shorts/ URL the probe depends on', () => {
    expect(shortsUrl('oijqsP5wizI')).toBe('https://www.youtube.com/shorts/oijqsP5wizI')
  })
})
