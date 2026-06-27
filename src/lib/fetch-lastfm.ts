import { logger } from './logger.js'

type AnyObject = Record<string, unknown>

export interface Scrobble {
  trackName: string
  artistName: string
  artistMbid: string | null
  albumName: string | null
  albumMbid: string | null
  trackMbid: string | null
  trackUrl: string | null
  imageUrl: string | null
  playedAt: Date
  uts: number
  loved: boolean
  raw: AnyObject
}

export interface RecentScrobblesPage {
  scrobbles: Scrobble[]
  totalPages: number
  page: number
}

const API_BASE = 'https://ws.audioscrobbler.com/2.0/'

function pickText(value: unknown): string | null {
  if (typeof value === 'string') return value || null
  if (value && typeof value === 'object') {
    const t = (value as AnyObject)['#text']
    if (typeof t === 'string') return t || null
  }
  return null
}

function pickMbid(value: unknown): string | null {
  if (value && typeof value === 'object') {
    const m = (value as AnyObject).mbid
    if (typeof m === 'string') return m || null
  }
  return null
}

function largestImage(images: unknown): string | null {
  if (!Array.isArray(images)) return null
  // Last.fm returns images small→extralarge; the last with a URL is the largest.
  for (let i = images.length - 1; i >= 0; i--) {
    const url = pickText((images[i] as AnyObject)?.['#text'] ?? images[i])
    if (url) return url
  }
  return null
}

function mapTrack(track: AnyObject): Scrobble | null {
  const date = track.date as AnyObject | undefined
  // The "now playing" entry has no date — skip it; it isn't a scrobble yet.
  if ((track['@attr'] as AnyObject)?.nowplaying === 'true' || !date) return null

  const utsRaw = date.uts
  const uts = typeof utsRaw === 'string' ? parseInt(utsRaw, 10) : Number(utsRaw)
  if (!Number.isFinite(uts)) return null

  const trackName = pickText(track.name)
  const artistName = pickText(track.artist)
  if (!trackName || !artistName) return null

  return {
    trackName,
    artistName,
    artistMbid: pickMbid(track.artist),
    albumName: pickText(track.album),
    albumMbid: pickMbid(track.album),
    trackMbid: typeof track.mbid === 'string' ? track.mbid || null : null,
    trackUrl: typeof track.url === 'string' ? track.url || null : null,
    imageUrl: largestImage(track.image),
    playedAt: new Date(uts * 1000),
    uts,
    loved: track.loved === '1' || track.loved === 1,
    raw: track,
  }
}

/**
 * Fetch one page of a user's recent scrobbles from the Last.fm REST API.
 * Mirrors the non-throwing, logger.warn style of fetchBookwyrmShelf — on any
 * failure it returns an empty page rather than throwing.
 */
export async function fetchRecentScrobbles(
  apiKey: string,
  username: string,
  opts: { from?: number; page?: number; limit?: number } = {},
): Promise<RecentScrobblesPage> {
  const page = opts.page ?? 1
  const limit = opts.limit ?? 200

  const url = new URL(API_BASE)
  url.searchParams.set('method', 'user.getrecenttracks')
  url.searchParams.set('user', username)
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('format', 'json')
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('page', String(page))
  if (opts.from != null) url.searchParams.set('from', String(opts.from))

  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch (e) {
    logger.warn({ page, error: e }, 'Failed to fetch Last.fm recent tracks')
    return { scrobbles: [], totalPages: 0, page }
  }
  if (!res.ok) {
    logger.warn({ page, status: res.status }, 'Last.fm recent tracks returned non-OK status')
    return { scrobbles: [], totalPages: 0, page }
  }

  const data = (await res.json()) as AnyObject
  if (data.error) {
    logger.warn({ page, error: data.error, message: data.message }, 'Last.fm API returned an error')
    return { scrobbles: [], totalPages: 0, page }
  }

  const recent = data.recenttracks as AnyObject | undefined
  const rawTracks = recent?.track
  const tracks: AnyObject[] = Array.isArray(rawTracks)
    ? (rawTracks as AnyObject[])
    : rawTracks
      ? [rawTracks as AnyObject]
      : []

  const scrobbles = tracks
    .map(mapTrack)
    .filter((s): s is Scrobble => s !== null)

  const totalPages = parseInt(String((recent?.['@attr'] as AnyObject)?.totalPages ?? '0'), 10) || 0

  return { scrobbles, totalPages, page }
}

export interface NowPlayingTrack {
  track: string
  artist: string
  album: string | null
  image: string | null
  url: string | null
}

/**
 * Fetch the user's currently-playing track, if any. Unlike a scrobble, the live
 * "now playing" entry has no date and is dropped by the sync (see mapTrack), so
 * this is a separate live read of user.getrecenttracks. Returns null when nothing
 * is playing or on any API failure (non-throwing, like fetchRecentScrobbles).
 */
export async function fetchNowPlaying(
  apiKey: string,
  username: string,
): Promise<NowPlayingTrack | null> {
  const url = new URL(API_BASE)
  url.searchParams.set('method', 'user.getrecenttracks')
  url.searchParams.set('user', username)
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('format', 'json')
  url.searchParams.set('limit', '1')

  let res: Response
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch (e) {
    logger.warn({ error: e }, 'Failed to fetch Last.fm now playing')
    return null
  }
  if (!res.ok) {
    logger.warn({ status: res.status }, 'Last.fm now playing returned non-OK status')
    return null
  }

  const data = (await res.json()) as AnyObject
  if (data.error) {
    logger.warn({ error: data.error, message: data.message }, 'Last.fm API returned an error')
    return null
  }

  const recent = data.recenttracks as AnyObject | undefined
  const rawTracks = recent?.track
  const first = (Array.isArray(rawTracks) ? rawTracks[0] : rawTracks) as AnyObject | undefined
  if (!first) return null
  // Only the live entry carries @attr.nowplaying; a plain recent scrobble does not.
  if ((first['@attr'] as AnyObject)?.nowplaying !== 'true') return null

  const track = pickText(first.name)
  const artist = pickText(first.artist)
  if (!track || !artist) return null

  return {
    track,
    artist,
    album: pickText(first.album),
    image: largestImage(first.image),
    url: typeof first.url === 'string' ? first.url || null : null,
  }
}
