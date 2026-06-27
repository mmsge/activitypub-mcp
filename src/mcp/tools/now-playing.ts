import { z } from 'zod'
import { config } from '../../config.js'
import { fetchNowPlaying } from '../../lib/fetch-lastfm.js'

// No inputs: "what is playing right now" is a single live state.
export const getNowPlayingSchema = z.object({})

type NowPlayingResponse =
  | { nowPlaying: true; track: string; artist: string; album: string | null; image: string | null; url: string | null }
  | { nowPlaying: false }

// Short in-process cache so a frequently-polling consumer (e.g. a homepage music
// card refreshing every ~30s) doesn't hit Last.fm on every request.
const CACHE_TTL_MS = 20_000
let cache: { at: number; value: NowPlayingResponse } | null = null

export async function getNowPlaying(
  _input?: z.infer<typeof getNowPlayingSchema>,
): Promise<NowPlayingResponse> {
  const { LASTFM_API_KEY, LASTFM_USERNAME } = config
  if (!LASTFM_API_KEY || !LASTFM_USERNAME) return { nowPlaying: false }

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value

  const track = await fetchNowPlaying(LASTFM_API_KEY, LASTFM_USERNAME)
  const value: NowPlayingResponse = track
    ? { nowPlaying: true, ...track }
    : { nowPlaying: false }
  cache = { at: Date.now(), value }
  return value
}
