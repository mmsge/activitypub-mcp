import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { scrobbles } from '../../db/schema.js'
import { and, gte, lte, ilike, count, sql, type SQL } from 'drizzle-orm'
import { type PgColumn } from 'drizzle-orm/pg-core'

// ---- get_scrobbles: raw, filterable feed -----------------------------------

export const getScrobblesSchema = z.object({
  artist: z.string().optional().describe('Filter by artist name (case-insensitive, partial match)'),
  album: z.string().optional().describe('Filter by album name (case-insensitive, partial match)'),
  track: z.string().optional().describe('Filter by track name (case-insensitive, partial match)'),
  from: z.string().optional().describe('Only scrobbles played at or after this ISO datetime'),
  to: z.string().optional().describe('Only scrobbles played at or before this ISO datetime'),
  since: z.string().optional().describe('Alias for "from" — only scrobbles after this ISO datetime'),
  limit: z.number().int().min(1).max(200).default(50),
  page: z.number().int().min(1).default(1),
})

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

export async function getScrobbles(input: z.infer<typeof getScrobblesSchema>) {
  const db = getDb()
  const conditions = buildConditions(input)

  const rows = await db
    .select({
      playedAt: scrobbles.playedAt,
      track: scrobbles.trackName,
      artist: scrobbles.artistName,
      album: scrobbles.albumName,
      url: scrobbles.trackUrl,
      loved: scrobbles.loved,
    })
    .from(scrobbles)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(sql`${scrobbles.playedAt} DESC`)
    .limit(input.limit)
    .offset((input.page - 1) * input.limit)

  return {
    count: rows.length,
    page: input.page,
    filters: {
      artist: input.artist ?? null,
      album: input.album ?? null,
      track: input.track ?? null,
      from: input.from ?? input.since ?? null,
      to: input.to ?? null,
    },
    scrobbles: rows,
  }
}

// ---- get_scrobble_stats: aggregate metrics ---------------------------------

export const getScrobbleStatsSchema = z.object({
  from: z.string().optional().describe('Only count scrobbles played at or after this ISO datetime'),
  to: z.string().optional().describe('Only count scrobbles played at or before this ISO datetime'),
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
    range: { from: input.from ?? null, to: input.to ?? null },
  }
}
