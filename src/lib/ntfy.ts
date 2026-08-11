import { config } from '../config.js'
import { logger } from './logger.js'

export type NtfyPriority = 'min' | 'low' | 'default' | 'high' | 'max'

export interface NtfyMessage {
  title: string
  body: string
  /** ntfy tag names — emoji shortcodes like 'trophy' render as the emoji. */
  tags?: string[]
  priority?: NtfyPriority
  /** URL opened when the notification is tapped. */
  click?: string
}

const PRIORITIES: Record<NtfyPriority, number> = {
  min: 1, low: 2, default: 3, high: 4, max: 5,
}

const TIMEOUT_MS = 10_000

export interface NtfyTarget {
  url: string
  topic: string
  user: string
  password: string
}

function currentTarget(): NtfyTarget {
  return {
    url: config.NTFY_URL,
    topic: config.NTFY_TOPIC,
    user: config.NTFY_USER,
    password: config.NTFY_PASSWORD,
  }
}

/**
 * Publish one notification to ntfy. Returns true on a 2xx.
 *
 * Two deliberate choices:
 *
 * 1. **JSON publishing** (POST the topic in the body) rather than the header form.
 *    ntfy header values must be ASCII, and track and artist names are full of curly
 *    quotes, accents and em dashes — the JSON body is UTF-8 throughout, so titles
 *    survive intact without RFC 2047 games.
 * 2. **Never throws, always logs a non-2xx loudly.** A failed push must not kill the
 *    job that called it, but it must not vanish either: hetzner-server ADR 0011
 *    records weeks of silently-401ing pushes caused by `curl -sf … || true`. The
 *    `NTFY PUBLISH FAILED` line is the thing that makes a password drift visible.
 */
export async function publishNtfy(
  msg: NtfyMessage,
  target: NtfyTarget = currentTarget(),
): Promise<boolean> {
  if (!target.url || !target.topic || !target.password) {
    logger.info({ topic: target.topic }, 'ntfy not configured, skipping push')
    return false
  }

  const payload = {
    topic: target.topic,
    title: msg.title,
    message: msg.body,
    tags: msg.tags,
    priority: PRIORITIES[msg.priority ?? 'default'],
    click: msg.click,
  }

  const auth = Buffer.from(`${target.user}:${target.password}`).toString('base64')

  let res: Response
  try {
    res = await fetch(target.url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    logger.error({ topic: target.topic, error: e }, 'NTFY PUBLISH FAILED (network)')
    return false
  }

  if (!res.ok) {
    logger.error(
      { topic: target.topic, status: res.status, title: msg.title },
      'NTFY PUBLISH FAILED',
    )
    return false
  }

  logger.info({ topic: target.topic, title: msg.title }, 'ntfy push sent')
  return true
}

/** The publisher, as a job dependency. Every notifying job takes one of these with
 *  `publishNtfy` as the default, so the alert decisions can be tested without a
 *  broker. Lives here rather than beside any one job now that two features need it. */
export type Notifier = typeof publishNtfy
