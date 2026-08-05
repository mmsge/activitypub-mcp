import { z } from 'zod'
import { sql, type SQL } from 'drizzle-orm'
import { getDb } from '../../db/client.js'

/**
 * The trip↔post join (ADR 0022), readable from both ends: the posts made on a
 * given journey, and the trip a given post was made on.
 *
 * Reads `trip_posts`, which jobs/link-trip-posts.ts derives. If it looks empty
 * after a trip import, the derivation has not run yet — it is hourly, and
 * `npm run link-trip-posts` forces it.
 */

const RELATIONS = ['boarding', 'aboard', 'alighting'] as const

export const getTripPostsSchema = z.object({
  journey: z.string().optional()
    .describe('Filter by journey/trip name (case-insensitive, partial match), e.g. "Sjælland rundt"'),
  station: z.string().optional()
    .describe('Filter to trips where this is the origin or destination (case-insensitive, partial match)'),
  operator: z.string().optional()
    .describe('Filter by operator name (case-insensitive, partial match)'),
  relation: z.enum(RELATIONS).optional()
    .describe('Filter by how the post relates to the trip: boarding (the 30 min before departure), aboard (between departure and arrival), or alighting (the 30 min after arrival)'),
  tag: z.string().optional()
    .describe('Only posts carrying this hashtag (case-insensitive, leading # optional), e.g. "togselfie"'),
  object_ap_id: z.string().optional()
    .describe('Look up a single post by its ActivityPub id and return the trip it was made on'),
  year: z.number().int().optional().describe('Filter to trips departing in this calendar year'),
  from: z.string().optional().describe('Only trips departing at or after this ISO datetime'),
  to: z.string().optional().describe('Only trips departing at or before this ISO datetime'),
  with_media_only: z.boolean().default(false)
    .describe('Only posts carrying an image or video attachment — the togselfies rather than the text posts'),
  sort_order: z.enum(['asc', 'desc']).default('desc')
    .describe('Order by the post\'s published_at. "desc" (default) is newest-first.'),
  limit: z.number().int().min(1).max(200).default(50),
  page: z.number().int().min(1).default(1),
})

export async function getTripPosts(input: z.infer<typeof getTripPostsSchema>) {
  const db = getDb()
  const conds: SQL[] = [sql`o.deleted_at IS NULL`]

  if (input.journey) conds.push(sql`t.journey ILIKE ${`%${input.journey}%`}`)
  if (input.station) {
    conds.push(sql`(t.from_station ILIKE ${`%${input.station}%`} OR t.to_station ILIKE ${`%${input.station}%`})`)
  }
  if (input.operator) conds.push(sql`t.operator ILIKE ${`%${input.operator}%`}`)
  if (input.relation) conds.push(sql`tp.relation = ${input.relation}`)
  if (input.object_ap_id) conds.push(sql`tp.object_ap_id = ${input.object_ap_id}`)
  if (input.year != null) {
    conds.push(sql`t.departure_at >= ${new Date(`${input.year}-01-01T00:00:00Z`)}`)
    conds.push(sql`t.departure_at < ${new Date(`${input.year + 1}-01-01T00:00:00Z`)}`)
  }
  if (input.from) conds.push(sql`t.departure_at >= ${new Date(input.from)}`)
  if (input.to) conds.push(sql`t.departure_at <= ${new Date(input.to)}`)
  if (input.with_media_only) {
    conds.push(sql`jsonb_array_length(coalesce(o.attachments, '[]'::jsonb)) > 0`)
  }
  if (input.tag) {
    const tag = input.tag.trim().replace(/^#/, '').trim().toLowerCase()
    conds.push(sql`EXISTS (
      SELECT 1 FROM jsonb_array_elements(o.tags) AS t2
      WHERE lower(t2->>'type') = 'hashtag'
        AND lower(ltrim(t2->>'name', '#')) = ${tag}
    )`)
  }

  const where = sql.join(conds, sql` AND `)
  const order = input.sort_order === 'asc' ? sql`ASC` : sql`DESC`
  const offset = (input.page - 1) * input.limit

  const rows = (await db.execute(sql`
    SELECT
      o.ap_id, o.url, o.content_text, o.published_at, o.attachments,
      tp.relation, tp.offset_seconds,
      t.from_station, t.to_station, t.journey, t.operator, t.train_code,
      t.mode, t.distance_km, t.delay, t.night,
      t.departure_at, t.arrival_at
    FROM trip_posts tp
    JOIN objects o ON o.ap_id = tp.object_ap_id
    JOIN train_trips t ON t.id = tp.trip_id
    WHERE ${where}
    ORDER BY o.published_at ${order}
    LIMIT ${input.limit} OFFSET ${offset}`)) as unknown as Array<Record<string, unknown>>

  const [totals] = (await db.execute(sql`
    SELECT
      count(*)::int AS total,
      count(DISTINCT tp.trip_id)::int AS trips,
      count(*) FILTER (WHERE tp.relation = 'aboard')::int AS aboard,
      count(*) FILTER (WHERE tp.relation = 'boarding')::int AS boarding,
      count(*) FILTER (WHERE tp.relation = 'alighting')::int AS alighting
    FROM trip_posts tp
    JOIN objects o ON o.ap_id = tp.object_ap_id
    JOIN train_trips t ON t.id = tp.trip_id
    WHERE ${where}`)) as unknown as Array<{
      total: number; trips: number; aboard: number; boarding: number; alighting: number
    }>

  const num = (v: unknown): number | null => (v == null ? null : Number(v))

  return {
    count: rows.length,
    page: input.page,
    sort_order: input.sort_order,
    totals: {
      posts: totals?.total ?? 0,
      trips: totals?.trips ?? 0,
      by_relation: {
        boarding: totals?.boarding ?? 0,
        aboard: totals?.aboard ?? 0,
        alighting: totals?.alighting ?? 0,
      },
    },
    filters: {
      journey: input.journey ?? null,
      station: input.station ?? null,
      operator: input.operator ?? null,
      relation: input.relation ?? null,
      tag: input.tag ?? null,
      object_ap_id: input.object_ap_id ?? null,
      year: input.year ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      with_media_only: input.with_media_only,
    },
    posts: rows.map((r) => ({
      ap_id: r.ap_id,
      url: r.url,
      content: r.content_text,
      published_at: r.published_at,
      attachments: r.attachments ?? [],
      relation: r.relation,
      // Signed seconds from departure; negative while still boarding. The measured
      // togselfies sit in the tens of seconds.
      offset_seconds: num(r.offset_seconds),
      trip: {
        from: r.from_station,
        to: r.to_station,
        journey: r.journey,
        operator: r.operator,
        train_code: r.train_code,
        mode: r.mode,
        distance_km: num(r.distance_km),
        delay: num(r.delay),
        night: r.night,
        departure_at: r.departure_at,
        arrival_at: r.arrival_at,
      },
    })),
  }
}
