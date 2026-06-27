import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { trainTrips } from '../../db/schema.js'
import { and, or, eq, gte, lt, lte, ilike, count, sql, type SQL } from 'drizzle-orm'
import { type PgColumn } from 'drizzle-orm/pg-core'
import { encodeCursor, decodeCursor, keysetCondition, keysetOrderBy } from './pagination.js'

// ---- shared filter handling ------------------------------------------------

interface TripFilters {
  station?: string
  from_station?: string
  to_station?: string
  journey?: string
  operator?: string
  mode?: string
  status?: string
  tag?: string
  year?: number
  from?: string
  to?: string
}

function buildConditions(input: TripFilters): SQL[] {
  const conditions: SQL[] = []
  if (input.station) {
    conditions.push(
      or(
        ilike(trainTrips.fromStation, `%${input.station}%`),
        ilike(trainTrips.toStation, `%${input.station}%`),
      ) as SQL,
    )
  }
  if (input.from_station) conditions.push(ilike(trainTrips.fromStation, `%${input.from_station}%`))
  if (input.to_station) conditions.push(ilike(trainTrips.toStation, `%${input.to_station}%`))
  if (input.journey) conditions.push(ilike(trainTrips.journey, `%${input.journey}%`))
  if (input.operator) conditions.push(ilike(trainTrips.operator, `%${input.operator}%`))
  if (input.mode) conditions.push(eq(trainTrips.mode, input.mode))
  if (input.status) conditions.push(eq(trainTrips.status, input.status))
  if (input.tag) conditions.push(sql`${input.tag} = ANY(${trainTrips.tags})`)
  if (input.year != null) {
    conditions.push(gte(trainTrips.departureAt, new Date(`${input.year}-01-01T00:00:00Z`)))
    conditions.push(lt(trainTrips.departureAt, new Date(`${input.year + 1}-01-01T00:00:00Z`)))
  }
  if (input.from) conditions.push(gte(trainTrips.departureAt, new Date(input.from)))
  if (input.to) conditions.push(lte(trainTrips.departureAt, new Date(input.to)))
  return conditions
}

// ---- get_train_trips: raw, filterable feed ---------------------------------

export const getTrainTripsSchema = z.object({
  station: z.string().optional().describe('Filter where this is either the origin or destination station (case-insensitive, partial match)'),
  from_station: z.string().optional().describe('Filter by origin station (case-insensitive, partial match)'),
  to_station: z.string().optional().describe('Filter by destination station (case-insensitive, partial match)'),
  journey: z.string().optional().describe('Filter by journey/trip name (case-insensitive, partial match)'),
  operator: z.string().optional().describe('Filter by operator name (case-insensitive, partial match)'),
  mode: z.string().optional().describe('Filter by mode, e.g. "Train" or "Ferry" (exact match)'),
  status: z.string().optional().describe('Filter by status, e.g. "Completed" or "Planned" (exact match)'),
  tag: z.string().optional().describe('Filter to trips carrying this tag (exact match against the tag list)'),
  year: z.number().int().optional().describe('Filter to trips departing in this calendar year'),
  from: z.string().optional().describe('Only trips departing at or after this ISO datetime'),
  to: z.string().optional().describe('Only trips departing at or before this ISO datetime'),
  sort_order: z.enum(['asc', 'desc']).default('desc')
    .describe('Order by departure. "desc" (default) is newest-first; "asc" is oldest-first — pair with limit:1 to fetch the earliest matching trip in one call.'),
  limit: z.number().int().min(1).max(200).default(50),
  page: z.number().int().min(1).default(1)
    .describe('Offset-based page (legacy). Ignored when "cursor" is supplied; prefer "cursor" for deep traversal.'),
  cursor: z.string().optional()
    .describe('Opaque pagination cursor from a previous response\'s next_cursor. When set, page/offset is ignored and traversal continues from where the last page ended.'),
})

export async function getTrainTrips(input: z.infer<typeof getTrainTripsSchema>) {
  const db = getDb()
  const conditions = buildConditions(input)

  if (input.cursor) {
    conditions.push(keysetCondition(trainTrips.departureAt, trainTrips.id, decodeCursor(input.cursor), input.sort_order))
  }

  const where = conditions.length ? and(...conditions) : undefined
  const orderBy = keysetOrderBy(trainTrips.departureAt, trainTrips.id, input.sort_order)

  const baseQuery = db
    .select({
      id: trainTrips.id,
      departureAt: trainTrips.departureAt,
      arrivalAt: trainTrips.arrivalAt,
      from: trainTrips.fromStation,
      to: trainTrips.toStation,
      journey: trainTrips.journey,
      trainCode: trainTrips.trainCode,
      operator: trainTrips.operator,
      mode: trainTrips.mode,
      travelClass: trainTrips.travelClass,
      distanceKm: trainTrips.distanceKm,
      delay: trainTrips.delay,
      night: trainTrips.night,
      status: trainTrips.status,
      tags: trainTrips.tags,
    })
    .from(trainTrips)
    .where(where)
    .orderBy(orderBy)
    .limit(input.limit)

  const rows = input.cursor
    ? await baseQuery
    : await baseQuery.offset((input.page - 1) * input.limit)

  const last = rows[rows.length - 1]
  const nextCursor = rows.length === input.limit && last
    ? encodeCursor(last.departureAt, last.id)
    : null

  const tripRows = rows.map(({ id: _id, ...rest }) => rest)

  return {
    count: tripRows.length,
    page: input.cursor ? null : input.page,
    next_cursor: nextCursor,
    sort_order: input.sort_order,
    filters: {
      station: input.station ?? null,
      from_station: input.from_station ?? null,
      to_station: input.to_station ?? null,
      journey: input.journey ?? null,
      operator: input.operator ?? null,
      mode: input.mode ?? null,
      status: input.status ?? null,
      tag: input.tag ?? null,
      year: input.year ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
    },
    trips: tripRows,
  }
}

// ---- get_train_stats: aggregate metrics ------------------------------------

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

export const getTrainStatsSchema = z.object({
  journey: z.string().optional().describe('Filter by journey/trip name (case-insensitive, partial match)'),
  operator: z.string().optional().describe('Filter by operator name (case-insensitive, partial match)'),
  mode: z.string().optional().describe('Filter by mode, e.g. "Train" or "Ferry" (exact match)'),
  status: z.string().optional().describe('Filter by status, e.g. "Completed" or "Planned" (exact match)'),
  tag: z.string().optional().describe('Filter to trips carrying this tag (exact match against the tag list)'),
  year: z.number().int().optional().describe('Scope all totals to trips departing in this calendar year. Omit for all-time.'),
  from: z.string().optional().describe('Only count trips departing at or after this ISO datetime'),
  to: z.string().optional().describe('Only count trips departing at or before this ISO datetime'),
  group_by: z.enum(['journey', 'operator', 'mode', 'year']).default('journey')
    .describe('Dimension for the top-N breakdown returned in "top".'),
  limit: z.number().int().min(1).max(100).default(20),
})

export async function getTrainStats(input: z.infer<typeof getTrainStatsSchema>) {
  const db = getDb()
  const conditions = buildConditions(input)
  const where = conditions.length ? and(...conditions) : undefined

  const [totals] = await db
    .select({
      total: count(),
      km: sql<string | null>`sum(${trainTrips.distanceKm})`,
      durationSeconds: sql<string | null>`extract(epoch from coalesce(sum(${trainTrips.arrivalAt} - ${trainTrips.departureAt}), interval '0'))`,
      operators: sql<string>`count(distinct ${trainTrips.operator})`,
      journeys: sql<string>`count(distinct ${trainTrips.journey})`,
      first: sql<string | null>`min(${trainTrips.departureAt})`,
      last: sql<string | null>`max(${trainTrips.departureAt})`,
    })
    .from(trainTrips)
    .where(where)

  // Distinct stations span both origin and destination, so union the two columns.
  const stationRows = await db
    .selectDistinct({ from: trainTrips.fromStation, to: trainTrips.toStation })
    .from(trainTrips)
    .where(where)
  const stationSet = new Set<string>()
  for (const r of stationRows) {
    if (r.from) stationSet.add(r.from)
    if (r.to) stationSet.add(r.to)
  }

  // Top-N breakdown by the requested dimension.
  const groupExpr: SQL = input.group_by === 'year'
    ? sql`extract(year from ${trainTrips.departureAt})`
    : (input.group_by === 'operator'
        ? trainTrips.operator
        : input.group_by === 'mode'
          ? trainTrips.mode
          : trainTrips.journey) as unknown as SQL
  const top = await db
    .select({
      key: sql<string | null>`(${groupExpr})::text`,
      trips: count(),
      km: sql<string | null>`sum(${trainTrips.distanceKm})`,
    })
    .from(trainTrips)
    .where(where)
    .groupBy(groupExpr)
    .orderBy(sql`count(*) DESC`)
    .limit(input.limit)

  const durationSeconds = Number(totals?.durationSeconds ?? 0)

  // Next planned trip from now — independent of the filters above so the
  // "upcoming" card keeps showing even when stats are scoped to a past year.
  const [upcomingRow] = await db
    .select({
      from: trainTrips.fromStation,
      to: trainTrips.toStation,
      date: sql<string>`to_char(${trainTrips.departureLocal}, 'YYYY-MM-DD')`,
      durationSeconds: sql<string | null>`extract(epoch from (${trainTrips.arrivalAt} - ${trainTrips.departureAt}))`,
    })
    .from(trainTrips)
    .where(and(eq(trainTrips.status, 'Planned'), gte(trainTrips.departureAt, sql`now()`)))
    .orderBy(sql`${trainTrips.departureAt} ASC`)
    .limit(1)

  const upcoming = upcomingRow
    ? {
        from: upcomingRow.from,
        to: upcomingRow.to,
        date: upcomingRow.date,
        duration: upcomingRow.durationSeconds != null
          ? formatDuration(Number(upcomingRow.durationSeconds))
          : null,
      }
    : null

  return {
    total_trips: Number(totals?.total ?? 0),
    total_km: Number(totals?.km ?? 0),
    total_duration_seconds: durationSeconds,
    hours: Math.floor(durationSeconds / 3600),
    minutes: Math.round((durationSeconds % 3600) / 60),
    distinct_stations: stationSet.size,
    distinct_operators: Number(totals?.operators ?? 0),
    distinct_journeys: Number(totals?.journeys ?? 0),
    first_trip_at: totals?.first ?? null,
    last_trip_at: totals?.last ?? null,
    group_by: input.group_by,
    top: top.map((r) => ({ key: r.key, trips: Number(r.trips), km: Number(r.km ?? 0) })),
    upcoming,
    filters: {
      journey: input.journey ?? null,
      operator: input.operator ?? null,
      mode: input.mode ?? null,
      status: input.status ?? null,
      tag: input.tag ?? null,
      year: input.year ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
    },
  }
}
