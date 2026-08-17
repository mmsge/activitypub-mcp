import { config } from '../config.js'
import { logger } from './logger.js'

/**
 * The only thing that can confirm a Short.
 *
 * Request `https://www.youtube.com/shorts/<id>`. A real Short stays there; anything else
 * redirects to `/watch?v=<id>`. Nothing else available to us distinguishes the two — the
 * Data API exposes no Shorts flag and no aspect ratio, so every other stage in the pipeline
 * can only ever rule a Short OUT.
 *
 * **This is expensive and it is rate limited hard.** YouTube returned HTTP 429 after TWO
 * requests during investigation. Not two thousand. Assume single concurrency, several
 * seconds between requests, exponential backoff, and a run that spans days — which is why
 * the stage is separately switchable and off by default. The pacing lives in the job; this
 * module makes one request and says what happened.
 */

const FETCH_TIMEOUT_MS = 10_000
const USER_AGENT = `activitypub-mcp/1.0 (+https://${config.APP_DOMAIN})`

/**
 * Without this, every probe from an EU IP is answered with a 302 to
 * `consent.youtube.com/m?continue=…&gl=FI` and no probe ever reaches a video.
 *
 * `SOCS` is the cookie YouTube sets once the consent dialog has been answered, and `CAI` is
 * the "seen it" value; it is what yt-dlp sends for the same reason. Nothing is being
 * circumvented but a banner — this is a cookie-consent screen, not authentication, and the
 * pages behind it are public either way.
 *
 * The predecessor `CONSENT=YES+cb` is dead: measured from the box on 2026-08-17, it was
 * still redirected to the consent wall while `SOCS=CAI` returned 200 for a Short and 303 to
 * `/watch` for a non-Short. Do not "restore" it.
 *
 * This is invisible from anywhere that is not consent-walled, which is exactly how it got
 * shipped broken: probing by hand from a non-EU address returns 200 and 303 with no cookie
 * at all, so the bug cannot reproduce off the affected network.
 */
const CONSENT_COOKIE = 'SOCS=CAI'

export type ProbeOutcome =
  | { kind: 'short' }
  | { kind: 'not_short' }
  /** Back off. `retryAfterMs` is null when YouTube did not say. */
  | { kind: 'rate_limited'; retryAfterMs: number | null }
  | { kind: 'error'; status: number | null; error: string }

export const shortsUrl = (videoId: string) => `https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`

/** The host a Location points at, so failures with one cause group as one row. */
export function redirectHost(location: string): string {
  try {
    return new URL(location, 'https://www.youtube.com').host
  } catch {
    return location.slice(0, 100)
  }
}

/** `Retry-After` is either a delay in seconds or an HTTP date; both are legal. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null
}

/**
 * The whole decision, as a pure function of the response line — so the rule is assertable
 * without a network, and so nobody has to hit YouTube to find out what a 303 means here.
 */
export function interpretProbeResponse(status: number, location: string | null, retryAfter: string | null = null, nowMs = 0): ProbeOutcome {
  if (status === 429) return { kind: 'rate_limited', retryAfterMs: parseRetryAfter(retryAfter, nowMs) }

  if (status >= 300 && status < 400) {
    if (!location) return { kind: 'error', status, error: 'redirect without Location' }
    // The discriminator. A redirect to the watch page is YouTube saying "this is not a Short".
    if (/\/watch\b|[?&]v=/.test(location)) return { kind: 'not_short' }
    // Anything else is a consent or locale hop, not a verdict — recorded as an error so an
    // unrecognised redirect is never silently read as a Short.
    //
    // Only the HOST is kept. The full URL carries a `continue=` parameter containing the
    // video id, so 200 identical failures were stored as 200 distinct error strings and a
    // `GROUP BY is_short_error` returned a page of rows reading `1` — which is precisely
    // what hid a single systematic cause behind what looked like scattered noise.
    return { kind: 'error', status, error: `unexpected redirect to ${redirectHost(location)}` }
  }

  // Stayed on /shorts/ and served a page. That is the positive case, verified by hand.
  if (status === 200) return { kind: 'short' }

  // 404 is a deleted or private video; 5xx is YouTube having a moment. Both are recorded
  // as attempts rather than verdicts, so neither can turn into a fabricated `false`.
  return { kind: 'error', status, error: `HTTP ${status}` }
}

export async function probeYoutubeShort(videoId: string): Promise<ProbeOutcome> {
  try {
    const res = await fetch(shortsUrl(videoId), {
      // `manual` is the entire mechanism: the redirect IS the answer, so following it would
      // throw away the only signal there is and leave every video looking like a 200.
      redirect: 'manual',
      headers: {
        // Deliberately browser-shaped, and deliberately mentioning text/html — the opposite
        // of the rule that governs the Gigowl origin (see CLAUDE.md). Here we WANT the page
        // a browser would get, because it is a browser's redirect behaviour we are reading.
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en',
        'User-Agent': USER_AGENT,
        Cookie: CONSENT_COOKIE,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    // Never read: the body is a megabyte of player JavaScript and the answer is in the
    // status line. Cancelling releases the socket instead of leaving it draining.
    await res.body?.cancel().catch(() => {})

    return interpretProbeResponse(res.status, res.headers.get('location'), res.headers.get('retry-after'), Date.now())
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    logger.debug({ videoId, error }, 'YouTube Shorts probe threw')
    return { kind: 'error', status: null, error }
  }
}
