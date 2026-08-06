import { z } from 'zod'
import { config } from '../../config.js'
import { fetchNowPlaying } from '../../lib/fetch-lastfm.js'

// No inputs: "what is playing right now" is a single live state.
export const getNowPlayingSchema = z.object({})

type NowPlayingResponse =
  | { nowPlaying: true; track: string; artist: string; album: string | null; image: string | null; url: string | null }
  | { nowPlaying: false }
  // Upstream never answered. Deliberately `null` rather than `false` with an extra field:
  // a consumer writing `if (!res.nowPlaying)` must not be able to read an outage as silence.
  | { nowPlaying: null; error: string }

// Short in-process cache so a frequently-polling consumer (e.g. a homepage music
// card refreshing every ~30s) doesn't hit Last.fm on every request. Only successful
// reads are cached — caching a failure would serve a momentary blip as "nothing
// playing" for the rest of the window, which is the bug this shape exists to avoid.
const CACHE_TTL_MS = 20_000
let cache: { at: number; value: NowPlayingResponse } | null = null

/** Test seam: drop the memoised read so cases don't leak into each other. */
export function resetNowPlayingCache(): void {
  cache = null
}

export async function getNowPlaying(
  _input?: z.infer<typeof getNowPlayingSchema>,
): Promise<NowPlayingResponse> {
  const { LASTFM_API_KEY, LASTFM_USERNAME } = config
  if (!LASTFM_API_KEY || !LASTFM_USERNAME) {
    return { nowPlaying: null, error: 'Last.fm is not configured' }
  }

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value

  const result = await fetchNowPlaying(LASTFM_API_KEY, LASTFM_USERNAME)
  if (!result.ok) {
    return { nowPlaying: null, error: `Last.fm unavailable (${result.reason})` }
  }

  const value: NowPlayingResponse = result.track
    ? { nowPlaying: true, ...result.track }
    : { nowPlaying: false }
  cache = { at: Date.now(), value }
  return value
}
