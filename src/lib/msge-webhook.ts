import { config } from '../config.js'
import { logger } from './logger.js'
import { postWebhook } from './webhook-post.js'

/**
 * Tell `msge.no` that something it builds a page from has changed.
 *
 * msge.no is a reshaping layer: sixteen pollers read this API on fixed intervals
 * and cache the result as the `/data/*.json` the site serves. The slow ones run
 * every six hours — and because the jobs on THIS side are periodic too, the
 * worst-case wait from "Markus imports a CSV" to "the site shows it" is the sum of
 * both. This collapses that to seconds.
 *
 * Same three non-behaviours as the bartenderen notifier, and for the same reasons:
 * never throw, never retry, never quiet about a failure. They live in
 * `postWebhook`, shared between the two.
 *
 * A topic names the UPSTREAM EVENT, not the page it feeds — "a trip import landed",
 * not "refresh /tog". Which pollers that wakes is msge.no's business, declared in
 * its own POLLERS registry, so a page can be added there without touching this.
 */

/** The vocabulary msge.no publishes. `alle` exists but is for a human with curl. */
export type MsgeTopic = 'tog' | 'tuben' | 'bok' | 'film' | 'tut' | 'bilete' | 'tankehav' | 'lyttar' | 'poppis'

export interface MsgeWebhookTarget {
  url: string
  secret: string
}

function currentTarget(): MsgeWebhookTarget {
  return { url: config.MSGE_WEBHOOK_URL, secret: config.MSGE_WEBHOOK_SECRET }
}

/**
 * POST the wake signal for one topic. Returns true on a 2xx, false on anything
 * else — including "nothing changed" and "not configured", which are not failures.
 *
 * `changed` is the count the caller already has. Zero means the upload re-stated
 * what was already stored, which is the common case when re-uploading an export,
 * and waking a service to re-read an identical answer is pure noise.
 */
export async function notifyMsgeChanged(
  topic: MsgeTopic,
  changed: number,
  target: MsgeWebhookTarget = currentTarget(),
): Promise<boolean> {
  if (changed <= 0) {
    logger.info({ topic }, 'msge webhook: nothing changed, not waking msge.no')
    return false
  }
  if (!target.url || !target.secret) {
    logger.info('msge webhook not configured, skipping')
    return false
  }

  const ok = await postWebhook({
    url: `${target.url.replace(/\/+$/, '')}/${topic}`,
    headerName: 'X-Msge-Token',
    secret: target.secret,
    label: 'MSGE WEBHOOK',
  })
  if (!ok) return false

  logger.info({ topic, changed }, 'msge webhook sent — msge.no will refresh')
  return true
}

// ── Debouncing the ingest path ───────────────────────────────────────────────
// The two admin imports are single events and notify directly. `ingestObject` is
// not: it fires once per object, and an outbox re-crawl or a NeoDB repair pushes
// hundreds through in seconds. That burst is collapsed HERE, where it happens —
// absorbing it in msge.no's rate limiter instead would leave that limiter
// saturated for everything else that happened during the backfill.

const DEBOUNCE_MS = 10_000
// A trailing debounce with no ceiling never fires during a long backfill: every new
// object pushes the timer out again, so a thirty-minute repair would send nothing
// at all. This is the ceiling, and it is not optional.
const MAX_DELAY_MS = 60_000

const timers = new Map<MsgeTopic, ReturnType<typeof setTimeout>>()
const armedAt = new Map<MsgeTopic, number>()

/**
 * Coalesce a burst into one notification per topic.
 *
 * Trailing rather than leading: the last object of a batch is the one whose arrival
 * makes the batch worth refreshing for, and firing on the first would send msge.no
 * to read an archive still being written.
 */
export function notifyMsgeDebounced(
  topic: MsgeTopic,
  now = Date.now(),
  target?: MsgeWebhookTarget,
): void {
  const first = armedAt.get(topic) ?? now
  armedAt.set(topic, first)

  const existing = timers.get(topic)
  if (existing) clearTimeout(existing)

  const wait = Math.min(DEBOUNCE_MS, Math.max(0, first + MAX_DELAY_MS - now))
  const t = setTimeout(() => {
    timers.delete(topic)
    armedAt.delete(topic)
    // The count is 1 rather than the real number: this path is "at least one thing
    // arrived", and msge.no re-reads whatever is there regardless of how much moved.
    void notifyMsgeChanged(topic, 1, target ?? currentTarget())
  }, wait)
  // MUST unref. Without it a pending debounce keeps a short-lived process alive for
  // ten seconds — a script hangs on exit, and vitest hangs after the last assertion.
  t.unref?.()
  timers.set(topic, t)
}

/** Test seam: drop any armed timers so one case cannot leak into the next. */
export function resetMsgeDebounce(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  armedAt.clear()
}
