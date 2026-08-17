import { config } from '../config.js'
import { logger } from './logger.js'

/**
 * YouTube Data API v3 `videos.list` — the cheap half of Shorts classification.
 *
 * It answers one question the watch archive cannot: when was this video UPLOADED? The
 * archive records when it was WATCHED, which bounds the upload date from above and never
 * from below, so the era rules are only approximate offline and exact here.
 *
 * **Fifty ids per call, one quota unit per call.** That is the entire economics of this
 * stage: the whole ~92k backlog costs about 1,846 units against a 10,000/day quota, so it
 * fits inside one day with room to spare. One call per video would cost 92,292 units and
 * take nine days. If anything here ever starts issuing a call per id, the batching is
 * broken, not merely slow.
 */

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3/videos'
const FETCH_TIMEOUT_MS = 10_000
const USER_AGENT = `activitypub-mcp/1.0 (+https://${config.APP_DOMAIN})`

/** The API's own ceiling for `id`. Raising it does not fetch more, it 400s. */
export const YOUTUBE_VIDEOS_BATCH_SIZE = 50

/** `videos.list` costs one unit per CALL, not per id. See the note above. */
export const YOUTUBE_VIDEOS_QUOTA_UNITS_PER_CALL = 1

export interface YoutubeVideoMetadata {
  videoId: string
  publishedAt: string | null
  durationSeconds: number | null
  title: string | null
  channelId: string | null
  channelTitle: string | null
  categoryId: string | null
}

export type YoutubeVideosResult =
  | {
      ok: true
      /** Keyed by video id, in whatever order the API returned them. */
      found: Map<string, YoutubeVideoMetadata>
      /** Ids the API silently omitted: deleted, private or region-blocked. */
      missing: string[]
    }
  | { ok: false; quotaExceeded: boolean; status: number | null; error: string }

/**
 * Parse an ISO 8601 period as `contentDetails.duration` serves it: `PT1M30S`, `PT7S`,
 * `PT1H2M3S`, and `P1DT2H` for the rare very long upload.
 *
 * **A total of zero comes back as null, not as 0.** Live and upcoming streams are served as
 * `P0D`, and a zero-second video does not exist — treating it as a real duration would let
 * every livestream in the archive be classified as a Short on the strength of a length it
 * does not have.
 */
export function parseIso8601Duration(value: string | null | undefined): number | null {
  if (!value) return null
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value.trim())
  if (!m) return null
  const [, d, h, min, s] = m
  const total = Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(min ?? 0) * 60 + Number(s ?? 0)
  if (!Number.isFinite(total) || total <= 0) return null
  return Math.round(total)
}

/**
 * Built separately from the request so a test can assert the batching without a network
 * call — the quota criterion is a property of this URL, not of the response.
 */
export function buildVideosListUrl(ids: string[], apiKey: string): string {
  const url = new URL(YOUTUBE_API_BASE)
  url.searchParams.set('part', 'snippet,contentDetails')
  url.searchParams.set('id', ids.join(','))
  url.searchParams.set('maxResults', String(YOUTUBE_VIDEOS_BATCH_SIZE))
  url.searchParams.set('key', apiKey)
  return url.toString()
}

interface ApiItem {
  id?: unknown
  snippet?: { publishedAt?: unknown; title?: unknown; channelId?: unknown; channelTitle?: unknown; categoryId?: unknown }
  contentDetails?: { duration?: unknown }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

export function parseVideosListResponse(ids: string[], body: unknown): { found: Map<string, YoutubeVideoMetadata>; missing: string[] } {
  const items = Array.isArray((body as { items?: unknown })?.items) ? ((body as { items: ApiItem[] }).items) : []
  const found = new Map<string, YoutubeVideoMetadata>()

  for (const item of items) {
    const videoId = str(item?.id)
    if (!videoId) continue
    found.set(videoId, {
      videoId,
      publishedAt: str(item?.snippet?.publishedAt),
      durationSeconds: parseIso8601Duration(str(item?.contentDetails?.duration)),
      title: str(item?.snippet?.title),
      channelId: str(item?.snippet?.channelId),
      channelTitle: str(item?.snippet?.channelTitle),
      categoryId: str(item?.snippet?.categoryId),
    })
  }

  // The API does not report which ids it dropped — it simply returns fewer items than were
  // asked for. Absence IS the signal, and it has to be derived here or a dead id looks
  // exactly like one that was never requested.
  return { found, missing: ids.filter((id) => !found.has(id)) }
}

/**
 * Fetch metadata for up to {@link YOUTUBE_VIDEOS_BATCH_SIZE} ids in one call.
 *
 * Deviates from the repo's usual null-on-failure convention deliberately: a job that must
 * stop the moment the daily quota is gone needs to tell "quota exhausted" apart from "one
 * request timed out", and a bare null cannot.
 */
export async function fetchYoutubeVideos(ids: string[], apiKey: string): Promise<YoutubeVideosResult> {
  if (ids.length === 0) return { ok: true, found: new Map(), missing: [] }
  if (ids.length > YOUTUBE_VIDEOS_BATCH_SIZE) {
    // Loud rather than silently truncated: a caller that over-fills a batch is losing ids,
    // and losing them quietly would look like a backlog that never drains.
    return { ok: false, quotaExceeded: false, status: null, error: `batch of ${ids.length} exceeds ${YOUTUBE_VIDEOS_BATCH_SIZE}` }
  }

  try {
    const res = await fetch(buildVideosListUrl(ids, apiKey), {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      // 403 is both "bad key" and "quota exhausted"; only the reason string separates them,
      // and only the second one means "come back tomorrow" rather than "this is misconfigured".
      const quotaExceeded = res.status === 403 && /quotaExceeded|dailyLimitExceeded/i.test(text)
      logger.warn({ status: res.status, quotaExceeded, ids: ids.length }, 'YouTube videos.list failed')
      return { ok: false, quotaExceeded, status: res.status, error: text.slice(0, 500) || `HTTP ${res.status}` }
    }

    return { ok: true, ...parseVideosListResponse(ids, await res.json()) }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    logger.warn({ error, ids: ids.length }, 'YouTube videos.list threw')
    return { ok: false, quotaExceeded: false, status: null, error }
  }
}
