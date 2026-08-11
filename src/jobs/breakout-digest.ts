import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { publishNtfy, type Notifier } from '../lib/ntfy.js'
import { composeBreakoutDigest, isDigestDue } from '../lib/post-breakout.js'
import {
  loadBreakoutBaseline, loadDigestMovement, loadDigestRows,
  readDigestCursor, resolveBreakoutActors, writeDigestCursor,
} from '../lib/breakout-store.js'

/**
 * One evening push summarising what moved today. See decision record 0036.
 *
 * There is no cron: the job runs on every hourly tick and decides for itself whether it
 * is due, the same model `publishStatusNote` uses. The cursor is a `server_config` row,
 * because one timestamp does not deserve a table.
 *
 * The window is "since the last digest" rather than "since midnight", so a day the
 * service spent down is reported on the next run instead of being silently skipped.
 */
export async function runBreakoutDigest(
  notify: Notifier = publishNtfy,
  now: Date = new Date(),
): Promise<void> {
  if (!config.BREAKOUT_ENABLED) return
  if (!config.NTFY_PASSWORD) return
  if (config.BREAKOUT_DIGEST_HOUR < 0) return

  const lastSentAt = await readDigestCursor()
  if (!isDigestDue({ hour: config.BREAKOUT_DIGEST_HOUR, lastSentAt, now })) return

  const watched = await resolveBreakoutActors()
  if (watched.length === 0) return

  // A first run has no cursor; fall back to the last 24 hours rather than reporting
  // every rung ever announced as though it happened today.
  const since = lastSentAt ?? new Date(now.getTime() - 86_400_000)

  const [rows, movement, baselines] = await Promise.all([
    loadDigestRows(since),
    loadDigestMovement(watched.map(a => a.apId), since),
    Promise.all(watched.map(a => loadBreakoutBaseline(a.apId, a.label))),
  ])

  const message = composeBreakoutDigest(rows, movement, baselines, now)

  if (!message) {
    // Nothing crossed a rung and nothing came in. Advance the cursor anyway and stay
    // silent: a nightly "ingenting skjedde" would train him to mute the topic, which
    // would cost him the alerts that matter.
    //
    // This is the ONE place the cursor moves without a delivered push, and it is not a
    // hole in that rule: it is advancing past nothing to deliver, not past an
    // undelivered alert. Record 0036 spells the distinction out.
    await writeDigestCursor(now)
    logger.debug('Breakout digest: nothing to report, cursor advanced silently')
    return
  }

  const delivered = await notify(message, {
    url: config.NTFY_URL,
    topic: config.NTFY_TOPIC_BREAKOUT,
    user: config.NTFY_USER,
    password: config.NTFY_PASSWORD,
  })

  if (!delivered) {
    // A composed digest that failed to publish is an undelivered alert like any other:
    // leave the cursor alone so the next hourly tick retries it the same evening.
    logger.warn('Breakout digest not delivered — cursor left unchanged so it retries')
    return
  }

  await writeDigestCursor(now)
  logger.info({ rungs: rows.length }, 'Breakout digest sent')
}
