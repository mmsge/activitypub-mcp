import { logger } from './logger.js'

/**
 * The one implementation of "wake another service on this box".
 *
 * Two services now take a wake signal from here — `bartenderen`, which tends the
 * "Neste togtur" profile field, and `msge.no`, whose pages are built from pollers
 * that would otherwise not look again for up to six hours. What they want *said*
 * differs (one takes no body and encodes meaning in its path, the other takes a
 * topic), and that difference lives in the caller. What must not differ, and what
 * is easy to lose in a second copy, is how the request is made:
 *
 * 1. **Never throw.** A failed notification must not fail the thing that triggered
 *    it. The import is the durable act; the notification only changes how quickly
 *    someone else notices.
 * 2. **Never retry.** Every receiver already re-reads on its own schedule, so a
 *    dropped notification costs latency and nothing else. A retry loop here would
 *    be a second, worse implementation of a timer that already exists.
 * 3. **Never stay quiet about a failure.** naustet-server ADR 0011 records weeks of
 *    silently-401ing ntfy pushes hidden behind `curl -sf … || true`. A non-2xx is
 *    logged loudly for the same reason: a drifted secret answers 401 or 403, and
 *    that line is the only thing that makes it visible.
 *
 * The `label` is what keeps each caller's log lines its own, so "which webhook
 * failed" is answerable from the message alone.
 */

const TIMEOUT_MS = 5_000

export interface WebhookPost {
  url: string
  headerName: string
  secret: string
  /** Optional JSON body. Receivers that take a pure ping send none. */
  body?: string
  /** Log prefix, e.g. 'TRIP WEBHOOK' — rendered as `<label> FAILED`. */
  label: string
}

/** POST the wake signal. True on a 2xx, false on anything else. Never throws. */
export async function postWebhook(opts: WebhookPost): Promise<boolean> {
  const headers: Record<string, string> = { [opts.headerName]: opts.secret }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(opts.url, {
      method: 'POST',
      headers,
      ...(opts.body === undefined ? {} : { body: opts.body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    // The message only, never the error object: pino would serialise `cause`,
    // which on a connection failure carries the address we dialled. That is an IP
    // in a log line, which the box's logging convention forbids. undici's messages
    // here are "fetch failed" and the timeout's abort reason — neither names the
    // host.
    logger.error(
      { error: e instanceof Error ? e.message : String(e) },
      `${opts.label} FAILED (network)`,
    )
    return false
  }

  if (!res.ok) {
    // 401/403 means the secret drifted from the receiver's; 503 means the receiver
    // has none set, so its own webhook is disabled. Both are configuration, and
    // both stay silent forever if this line is not here.
    logger.error({ status: res.status }, `${opts.label} FAILED`)
    return false
  }
  return true
}
