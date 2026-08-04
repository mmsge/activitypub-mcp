import { config } from '../config.js'

/**
 * Does this request belong to the public stream site?
 *
 * One process serves two sites on one port. The dispatcher in src/index.ts sends
 * a request to the stream app or to the bot app on this answer alone, so the two
 * surfaces never share a router: the ActivityPub actor is not merely shadowed on
 * meg.msge.no, it is not mounted there at all — and a route added to the bot app
 * later cannot leak onto the public host by accident.
 *
 * Reads the Host header, never X-Forwarded-Host: that one is caller-supplied and
 * would let anyone pick which site they get. Caddy passes Host through unchanged.
 *
 * Anything unrecognised — including no Host at all — is NOT the stream. That
 * matters beyond tidiness: the container healthcheck calls
 * http://127.0.0.1:3000/healthz, and if the default flipped, the probe would be
 * answered by the wrong app.
 */
export function isStreamHost(host: string | null | undefined): boolean {
  const domain = config.STREAM_DOMAIN.trim().toLowerCase()
  // Unset ⇒ the stream does not exist. This is the off-switch that lets the whole
  // feature ship and deploy before anything is publicly visible.
  if (!domain) return false
  if (!host) return false

  // Strip the port: a Host header legitimately carries one, and ":443" must not
  // make the domain stop matching.
  const bare = host.trim().toLowerCase().replace(/:\d+$/, '')
  return bare === domain
}

/** The stream's own origin, for canonical URLs, the feed and the sitemap. */
export function streamOrigin(): string {
  return `https://${config.STREAM_DOMAIN}`
}

/** True when the stream is configured at all. */
export function streamEnabled(): boolean {
  return config.STREAM_DOMAIN.trim() !== ''
}
