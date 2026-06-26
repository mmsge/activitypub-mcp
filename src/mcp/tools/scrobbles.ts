import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { scrobbles } from '../../db/schema.js'
import { and, gte, lte, ilike, count, sql, type SQL } from 'drizzle-orm'
import { type PgColumn } from 'drizzle-orm/pg-core'

// ---- shared filter handling ------------------------------------------------

function buildConditions(input: {
  artist?: string; album?: string; track?: string; from?: string; to?: string; since?: string
}): SQL[] {
  const conditions: SQL[] = []
  if (input.artist) conditions.push(ilike(scrobbles.artistName, `%${input.artist}%`))
  if (input.album) conditions.push(ilike(scrobbles.albumName, `%${input.album}%`))
  if (input.track) conditions.push(ilike(scrobbles.trackName, `%${input.track}%`))
  const from = input.from ?? input.since
  if (from) conditions.push(gte(scrobbles.playedAt, new Date(from)))
  if (input.to) conditions.push(lte(scrobbles.playedAt, new Date(input.to)))
  return conditions
}

// ---- playedAt-based keyset cursor ------------------------------------------
//
// playedAt alone isn't unique (the dedupe key is played_at + track + artist),
// so the cursor also carries the row id as a tiebreaker to give a strict total
// order. The cursor is an opaque base64url token; callers pass it back verbatim.

type Cursor = { p: string; id: string }

function encodeCursor(playedAt: Date, id: string): string {
  const payload: Cursor = { p: playedAt.toISOString(), id }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeCursor(token: string): Cursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Invalid cursor: not a valid token')
  }
  const c = parsed as Cursor
  if (!c || typeof c.p !== 'string' || typeof c.id !== 'string' || Number.isNaN(Date.parse(c.p))) {
    throw new Error('Invalid cursor: malformed payload')
  }
  return c
}

// ---- get_scrobbles: raw, filterable feed -----------------------------------

export const getScrobblesSchema = z.object({
  artist: z.string().optional().describe('Filter by artist name (case-insensitive, partial match)'),
  album: z.string().optional().describe('Filter by album name (case-insensitive, partial match)'),
  track: z.string().optional().describe('Filter by track name (case-insensitive, partial match)'),
  from: z.string().optional().describe('Only scrobbles played at or after this ISO datetime'),
  to: z.string().optional().describe('Only scrobbles played at or before this ISO datetime'),
  since: z.string().optional().describe('Alias for "from" — only scrobbles after this ISO datetime'),
  sort_order: z.enum(['asc', 'desc']).default('desc')
    .describe('Order by played_at. "desc" (default) is newest-first; "asc" is oldest-first — pair with limit:1 to fetch the earliest matching scrobble in one call.'),
  limit: z.number().int().min(1).max(200).default(50),
  page: z.number().int().min(1).default(1)
    .describe('Offset-based page (legacy). Ignored when "cursor" is supplied; prefer "cursor" for deep traversal.'),
  cursor: z.string().optional()
    .describe('Opaque pagination cursor from a previous response\'s next_cursor. When set, page/offset is ignored and traversal continues from where the last page ended (respecting sort_order and all filters).'),
})

export async function getScrobbles(input: z.infer<typeof getScrobblesSchema>) {
  const db = getDb()
  const conditions = buildConditions(input)

  const asc = input.sort_order === 'asc'

  // Keyset pagination: continue strictly past the cursor row using (played_at, id)
  // as the ordering key. Falls back to offset pagination when no cursor is given.
  if (input.cursor) {
    const c = decodeCursor(input.cursor)
    const cursorDate = new Date(c.p)
    conditions.push(
      asc
        ? sql`(${scrobbles.playedAt}, ${scrobbles.id}) > (${cursorDate}::timestamptz, ${c.id}::uuid)`
        : sql`(${scrobbles.playedAt}, ${scrobbles.id}) < (${cursorDate}::timestamptz, ${c.id}::uuid)`,
    )
  }

  const where = conditions.length ? and(...conditions) : undefined
  const orderBy = asc
    ? sql`${scrobbles.playedAt} ASC, ${scrobbles.id} ASC`
    : sql`${scrobbles.playedAt} DESC, ${scrobbles.id} DESC`

  const baseQuery = db
    .select({
      id: scrobbles.id,
      playedAt: scrobbles.playedAt,
      track: scrobbles.trackName,
      artist: scrobbles.artistName,
      album: scrobbles.albumName,
      url: scrobbles.trackUrl,
      loved: scrobbles.loved,
    })
    .from(scrobbles)
    .where(where)
    .orderBy(orderBy)
    .limit(input.limit)

  // Cursor traversal is offset-free; only the legacy offset path applies page.
  const rows = input.cursor
    ? await baseQuery
    : await baseQuery.offset((input.page - 1) * input.limit)

  // A full page may have more behind it; a short page is the end of the run.
  const last = rows[rows.length - 1]
  const nextCursor = rows.length === input.limit && last
    ? encodeCursor(last.playedAt, last.id)
    : null

  // Keep the id out of the returned rows — it's an internal keyset detail.
  const scrobbleRows = rows.map(({ id: _id, ...rest }) => rest)

  return {
    count: scrobbleRows.length,
    page: input.cursor ? null : input.page,
    next_cursor: nextCursor,
    sort_order: input.sort_order,
    filters: {
      artist: input.artist ?? null,
      album: input.album ?? null,
      track: input.track ?? null,
      from: input.from ?? input.since ?? null,
      to: input.to ?? null,
    },
    scrobbles: scrobbleRows,
  }
}

// ---- get_scrobble_stats: aggregate metrics ---------------------------------

export const getScrobbleStatsSchema = z.object({
  artist: z.string().optional().describe('Filter by artist name (case-insensitive, partial match). When set, totals and first/last played reflect only this artist.'),
  album: z.string().optional().describe('Filter by album name (case-insensitive, partial match). When set, totals and first/last played reflect only this album.'),
  track: z.string().optional().describe('Filter by track name (case-insensitive, partial match). When set, totals and first/last played reflect only this track.'),
  from: z.string().optional().describe('Only count scrobbles played at or after this ISO datetime'),
  to: z.string().optional().describe('Only count scrobbles played at or before this ISO datetime'),
  since: z.string().optional().describe('Alias for "from" — only count scrobbles after this ISO datetime'),
  group_by: z.enum(['artist', 'album', 'track']).default('artist'),
  limit: z.number().int().min(1).max(100).default(20),
})

export async function getScrobbleStats(input: z.infer<typeof getScrobbleStatsSchema>) {
  const db = getDb()
  const conditions = buildConditions(input)
  const where = conditions.length ? and(...conditions) : undefined

  const [totals] = await db
    .select({
      total: count(),
      first: sql<string | null>`min(${scrobbles.playedAt})`,
      last: sql<string | null>`max(${scrobbles.playedAt})`,
    })
    .from(scrobbles)
    .where(where)

  // Group by the requested dimension; for tracks, key on track + artist so
  // same-titled songs by different artists aren't merged.
  const groupCols: Record<string, PgColumn> =
    input.group_by === 'artist'
      ? { artist: scrobbles.artistName }
      : input.group_by === 'album'
        ? { artist: scrobbles.artistName, album: scrobbles.albumName }
        : { artist: scrobbles.artistName, track: scrobbles.trackName }

  const top = await db
    .select({ ...groupCols, plays: count() })
    .from(scrobbles)
    .where(where)
    .groupBy(...Object.values(groupCols))
    .orderBy(sql`count(*) DESC`)
    .limit(input.limit)

  return {
    total_scrobbles: Number(totals?.total ?? 0),
    first_played_at: totals?.first ?? null,
    last_played_at: totals?.last ?? null,
    group_by: input.group_by,
    top: top.map((r) => ({ ...r, plays: Number(r.plays) })),
    filters: {
      artist: input.artist ?? null,
      album: input.album ?? null,
      track: input.track ?? null,
    },
    range: { from: input.from ?? input.since ?? null, to: input.to ?? null },
  }
}
