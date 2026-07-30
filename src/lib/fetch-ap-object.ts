import { logger } from './logger.js'

type AnyObject = Record<string, unknown>

const AP_ACCEPT =
  'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"'
const TIMEOUT_MS = 10_000

/**
 * Dereference an ActivityPub object by id.
 *
 * A boost (`Announce`) usually carries only the boosted post's URI, so the object has to
 * be fetched before it can be stored — the alternative is a row with no text and no tags,
 * which is exactly how a batch of NeoDB marks once landed contentless. Returns null on
 * any failure (non-OK, non-JSON, timeout); the caller logs and moves on rather than
 * failing the whole activity.
 */
export async function fetchApObject(url: string): Promise<AnyObject | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null
  try {
    const res = await fetch(url, {
      headers: { Accept: AP_ACCEPT },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      logger.debug({ url, status: res.status }, 'Could not dereference AP object')
      return null
    }
    const data = (await res.json()) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    return data as AnyObject
  } catch (e) {
    logger.debug({ url, error: String(e) }, 'Failed to dereference AP object')
    return null
  }
}
