import { config } from '../config.js'
import { logger } from './logger.js'
import { postWebhook } from './webhook-post.js'

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
 * 3. **Stay quiet about failures.** naustet-server ADR 0011 records weeks of
 *    silently-401ing ntfy pushes hidden behind `curl -sf … || true`. A non-2xx is
 *    logged loudly for the same reason: a drifted secret answers 403, and that
 *    line is the only thing that makes it visible.
 *
 * All three now live in `postWebhook`, shared with the msge.no notifier. Decision
 * record 0053 predicted that a second consumer would want its own config pair and
 * its own call rather than a generalised fan-out, and that held — what it did not
 * anticipate is that the three rules above are transport, not policy, and a second
 * copy of them is a second chance to lose one. See decision record 0055.
 */

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
 * `changed` is inserted + updated on an import, and deleted on a confirmed prune.
 * Zero means the CSV re-stated what was already stored, which is the common case
 * when re-uploading an export, and waking a service to recompute an identical
 * answer is pure noise: it would read the same legs, render the same string, and
 * write nothing.
 *
 * A deletion is the case this matters most for. bartenderen advertises the next
 * departure, so the row a prune removes is very often the exact row it is
 * advertising — a leg deleted or re-timed in viaduct that has not happened yet.
 * Left alone it would keep advertising a train that does not exist for up to four
 * hours. See decision records 0053 and 0054.
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

  const ok = await postWebhook({
    url: target.url,
    headerName: 'X-Bartenderen-Token',
    secret: target.secret,
    label: 'TRIP WEBHOOK',
  })
  if (!ok) return false

  logger.info({ changed }, 'trip webhook sent — bartenderen will recompute')
  return true
}
