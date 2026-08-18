import { and, eq, inArray, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { scrobbles } from '../db/schema.js'

/**
 * What counts as a play for one side of a race, in two forms that must agree: a SQL
 * predicate for the store, and an in-memory predicate for the backfill walk and the
 * tests. They are written side by side here so they cannot drift apart.
 *
 * Matching is EXACT — never the `ilike '%x%'` that get_scrobbles / get_scrobble_stats
 * use for their filters. Two reasons, both easy to "fix" back by accident:
 *
 *  - A countdown that reaches zero must not have its finish line moved by a stray
 *    "Taylor Swift feat. …" credit that a substring match would fold in.
 *  - `scrobbles_artist_idx` is a plain btree on artist_name, so plain equality is
 *    index-served. Wrapping it in `lower()` would seq-scan the whole table on every
 *    sync tick, forever.
 *
 * `albums` and `tracks` are LISTS rather than single names on purpose. Last.fm files a
 * single under its own album name, so "The Good Witch" and "Lost The Breakup" are
 * separate rows for one campaign; listing both folds them into one side. A row still
 * matches once however many of the names it could match, so a multi-name side sums its
 * parts without double counting.
 */

/** A side of a race: what counts as a play for it. The same schema validates both
 *  races.json and the ad-hoc entities get_scrobble_race accepts, so the file and the
 *  tool cannot drift apart. The required keys per type ARE the union, which is what
 *  makes "album with no albums" and "type: song" both plain zod errors. */
export const raceEntitySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('artist'), artist: z.string().min(1) }),
  z.object({
    type: z.literal('album'),
    artist: z.string().min(1),
    albums: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    type: z.literal('track'),
    artist: z.string().min(1),
    tracks: z.array(z.string().min(1)).min(1),
  }),
])

export type RaceEntity = z.infer<typeof raceEntitySchema>

/** A side of a race as the decision logic sees it: a display name and what it matches. */
export interface RaceSide {
  label: string
  entity: RaceEntity
}

/** The columns of a scrobble this module ever looks at. */
export interface PlayRow {
  artistName: string
  albumName: string | null
  trackName: string
}

/** How a side is named in alert copy and in the tool's `entity` echo. */
export function entityLabel(e: RaceEntity): string {
  switch (e.type) {
    case 'artist': return e.artist
    case 'album': return e.albums.join(' + ')
    case 'track': return e.tracks.join(' + ')
  }
}

/** The drizzle predicate for this side. */
export function entityCondition(e: RaceEntity): SQL {
  switch (e.type) {
    case 'artist':
      return eq(scrobbles.artistName, e.artist) as SQL
    case 'album':
      return and(
        eq(scrobbles.artistName, e.artist),
        inArray(scrobbles.albumName, e.albums),
      ) as SQL
    case 'track':
      return and(
        eq(scrobbles.artistName, e.artist),
        inArray(scrobbles.trackName, e.tracks),
      ) as SQL
  }
}

/** The same predicate over a row already in hand. */
export function matchesEntity(row: PlayRow, e: RaceEntity): boolean {
  if (row.artistName !== e.artist) return false
  switch (e.type) {
    case 'artist': return true
    case 'album': return row.albumName != null && e.albums.includes(row.albumName)
    case 'track': return e.tracks.includes(row.trackName)
  }
}

/** Plays matching this side, counted over rows in memory. */
export function countMatching(rows: PlayRow[], e: RaceEntity): number {
  return rows.reduce((n, row) => (matchesEntity(row, e) ? n + 1 : n), 0)
}

/**
 * Whether a LIVE now-playing entry belongs to this side.
 *
 * Case-insensitive on the artist, unlike the stored-row predicate above: this compares
 * what Last.fm reports mid-song against a hand-written name, not one stored row against
 * another, and the pre-existing now-playing check was case-insensitive too. Album and
 * track are compared the same way for the same reason.
 */
export function nowPlayingMatchesEntity(
  playing: { artist: string; track: string; album?: string | null },
  e: RaceEntity,
): boolean {
  const same = (a: string | null | undefined, b: string) =>
    a != null && a.toLowerCase() === b.toLowerCase()
  if (!same(playing.artist, e.artist)) return false
  switch (e.type) {
    case 'artist': return true
    case 'album': return e.albums.some(a => same(playing.album, a))
    case 'track': return e.tracks.some(t => same(playing.track, t))
  }
}

/** Whether two sides would count the same plays. A race between a side and itself has
 *  a gap of 0 forever and would announce a dead heat it can never leave. */
export function sameEntity(a: RaceEntity, b: RaceEntity): boolean {
  if (a.type !== b.type || a.artist !== b.artist) return false
  const names = (e: RaceEntity) =>
    e.type === 'album' ? [...e.albums].sort() : e.type === 'track' ? [...e.tracks].sort() : []
  return JSON.stringify(names(a)) === JSON.stringify(names(b))
}

/** A bare artist name as an entity — the shape every pre-existing caller means. */
export function artistEntity(artist: string): RaceEntity {
  return { type: 'artist', artist }
}

export function toSide(entity: RaceEntity): RaceSide {
  return { label: entityLabel(entity), entity }
}
