import { config } from '../config.js'
import { logger } from './logger.js'

/**
 * Tell `bartenderen` that the train-trip archive changed.
 *
 * `bartenderen` tends the "Neste togtur" field on @markus@skvip.lol. It has no
 * fixed poll interval — it computes when the field could next change and sleeps
 * until then — but nothing in the existing data predicts a leg that does not
 * exist yet, so it also caps every sleep at four hours and re-reads regardless.
 * This webhook is what turns that cap from the mechanism into a backstop: a leg
 * entered mid-journey shows up in the profile at once rather than within four
 * hours.
 *
 * Three things it deliberately does not do:
 *
 * 1. **Throw.** A failed notification must not fail the import that triggered it.
 *    The import is the durable thing; the notification only changes how quickly
 *    someone else notices.
 * 2. **Retry.** The receiver's four-hour cap already re-reads the source, so a
 *    dropped notification costs latency and nothing else. A retry loop here would
 *    be a second, worse implementation of a timer that already exists.
 * 3. **Stay quiet about failures.** hetzner-server ADR 0011 records weeks of
 *    silently-401ing ntfy pushes hidden behind `curl -sf … || true`. A non-2xx is
 *    logged loudly for the same reason: a drifted secret answers 403, and that
 *    line is the only thing that makes it visible.
 */

const TIMEOUT_MS = 5_000

export interface TripWebhookTarget {
  url: string
  secret: string
}

function currentTarget(): TripWebhookTarget {
  return {
    url: config.BARTENDEREN_WEBHOOK_URL,
    secret: config.BARTENDEREN_WEBHOOK_SECRET,
  }
}

/**
 * POST the wake signal. Returns true on a 2xx, false on anything else —
 * including "nothing changed" and "not configured", which are not failures.
 *
 * `changed` is inserted + updated. Zero means the CSV re-stated what was already
 * stored, which is the common case when re-uploading an export, and waking a
 * service to recompute an identical answer is pure noise: it would read the same
 * legs, render the same string, and write nothing.
 */
export async function notifyTripsChanged(
  changed: number,
  target: TripWebhookTarget = currentTarget(),
): Promise<boolean> {
  if (changed <= 0) {
    logger.info('trip webhook: import changed nothing, not waking bartenderen')
    return false
  }
  if (!target.url || !target.secret) {
    logger.info('trip webhook not configured, skipping')
    return false
  }

  let res: Response
  try {
    res = await fetch(target.url, {
      method: 'POST',
      headers: { 'X-Bartenderen-Token': target.secret },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    // The message only, never the error object: pino would serialise `cause`,
    // which on a connection failure carries the address we dialled. That is an
    // IP in a log line, which the box's logging convention forbids. undici's
    // messages here are "fetch failed" and the timeout's abort reason — neither
    // names the host.
    logger.error(
      { error: e instanceof Error ? e.message : String(e) },
      'TRIP WEBHOOK FAILED (network)',
    )
    return false
  }

  if (!res.ok) {
    // 403 means the secret drifted from bartenderen's WEBHOOK_SECRET; 503 means
    // bartenderen has none set, so its own webhook is disabled. Both are
    // configuration, and both stay silent forever if this line is not here.
    logger.error({ status: res.status }, 'TRIP WEBHOOK FAILED')
    return false
  }

  logger.info({ changed }, 'trip webhook sent — bartenderen will recompute')
  return true
}
