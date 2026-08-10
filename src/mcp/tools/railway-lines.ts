import { z } from 'zod'
import { sql, type SQL } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { resolveLineName, suggestLines } from '../../lib/line-name.js'
import { allEntries, registryVersion } from '../../lib/railway-registry.js'
import { registryLengths } from '../../lib/line-attribution.js'

/**
 * Travel statistics by named railway line and named crossing.
 *
 * The trip store has no concept of a line, so these read the cache
 * `resolve-trip-lines.ts` writes: one row per (trip, line) with the portion of that
 * trip which ran on it. See ADR 0035 for how the portions are worked out.
 *
 * Two things every response here does deliberately:
 *
 * - **It states coverage.** A line whose trips have not been resolved yet must read
 *   as "not resolved" and never as "he never went there" — the same discipline
 *   `get_trip_weather` adopted in ADR 0028, and it matters most in the minutes after
 *   a deploy while the resolver is still catching up.
 *
 * - **It shows its overrides.** A number produced by a pinned routing says which
 *   routing and why, so it can be argued with rather than merely believed.
 *
 * Planned trips are out of the totals by default and reported separately. The gate is
 * `departure_at <= now()` rather than `status`, per ADR 0031 — a trip is activity once
 * it has left the platform, which also means the trip Markus is on right now counts.
 */

// ---- shared filtering ------------------------------------------------------

const filterShape = {
  journey: z.string().optional().describe('Filter by journey/trip name (case-insensitive, partial match)'),
  operator: z.string().optional().describe('Filter by operator name (case-insensitive, partial match)'),
  station: z.string().optional().describe('Filter to trips where this is the origin or destination (case-insensitive, partial)'),
  mode: z.string().optional().describe('Filter by mode, e.g. "Train" or "Ferry" (exact match)'),
  status: z.string().optional().describe('Filter by status, e.g. "Completed" or "Planned" (exact match)'),
  tag: z.string().optional().describe('Filter to trips carrying this tag (exact match against the tag list)'),
  year: z.number().int().optional().describe('Scope to trips departing in this calendar year. Omit for all-time.'),
  from: z.string().optional().describe('Only trips departing at or after this ISO datetime'),
  to: z.string().optional().describe('Only trips departing at or before this ISO datetime'),
  include_planned: z.boolean().default(false)
    .describe('Include trips that have not departed yet. Off by default; they are reported separately under "upcoming".'),
}

export type TripFilters = {
  journey?: string
  operator?: string
  station?: string
  mode?: string
  status?: string
  tag?: string
  year?: number
  from?: string
  to?: string
  include_planned: boolean
}

/**
 * The filter vocabulary the train tools already use, as raw-SQL conditions against
 * `train_trips t`. Shared by all three tools here so a line can be scoped to one
 * journey or one year exactly the way `get_train_stats` scopes a total.
 */
export function tripConditions(input: TripFilters): SQL[] {
  const conds: SQL[] = []
  if (!input.include_planned) conds.push(sql`t.departure_at <= now()`)
  if (input.journey) conds.push(sql`t.journey ILIKE ${`%${input.journey}%`}`)
  if (input.operator) conds.push(sql`t.operator ILIKE ${`%${input.operator}%`}`)
  if (input.station) {
    conds.push(sql`(t.from_station ILIKE ${`%${input.station}%`} OR t.to_station ILIKE ${`%${input.station}%`})`)
  }
  if (input.mode) conds.push(sql`t.mode = ${input.mode}`)
  if (input.status) conds.push(sql`t.status = ${input.status}`)
  if (input.tag) conds.push(sql`${input.tag} = ANY(t.tags)`)
  if (input.year != null) {
    conds.push(sql`t.departure_at >= ${isoOrThrow(`${input.year}-01-01T00:00:00Z`)}`)
    conds.push(sql`t.departure_at < ${isoOrThrow(`${input.year + 1}-01-01T00:00:00Z`)}`)
  }
  if (input.from) conds.push(sql`t.departure_at >= ${isoOrThrow(input.from)}`)
  if (input.to) conds.push(sql`t.departure_at <= ${isoOrThrow(input.to)}`)
  return conds
}

/**
 * Timestamps go into raw SQL as ISO strings, never as `Date`.
 *
 * `db.execute(sql\`…\`)` hands its parameters straight to postgres.js, which rejects a
 * `Date` outright (`ERR_INVALID_ARG_TYPE`) — unlike Drizzle's query builder, which
 * serialises them for you. Postgres infers timestamptz for the text parameter, so the
 * comparison is unchanged.
 */
function isoOrThrow(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid datetime: ${value}`)
  return date.toISOString()
}

const whereOf = (conds: SQL[]): SQL =>
  conds.length > 0 ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``

const num = (v: unknown): number => (v == null ? 0 : Number(v))
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v))
const round2 = (n: number): number => Math.round(n * 100) / 100

function echoFilters(input: TripFilters) {
  return {
    journey: input.journey ?? null,
    operator: input.operator ?? null,
    station: input.station ?? null,
    mode: input.mode ?? null,
    status: input.status ?? null,
    tag: input.tag ?? null,
    year: input.year ?? null,
    from: input.from ?? null,
    to: input.to ?? null,
    include_planned: input.include_planned,
  }
}

/**
 * How much of the archive has actually been placed on a line.
 *
 * Reported on every response so a thin answer is legible. `unresolved_reasons` is the
 * important half: "a ferry has no railway line" and "that corner of Europe is not
 * curated yet" are both honest answers, and neither is zero kilometres.
 */
async function coverageFor(conds: SQL[]) {
  const db = getDb()
  const where = whereOf(conds)

  const [totals] = (await db.execute(sql`
    SELECT
      count(*)::int AS trips,
      count(r.id) FILTER (WHERE r.status = 'resolved')::int AS resolved,
      count(r.id) FILTER (WHERE r.status = 'ambiguous')::int AS ambiguous,
      count(r.id) FILTER (WHERE r.status = 'unresolved')::int AS unresolved,
      count(*) FILTER (WHERE r.id IS NULL)::int AS not_yet_resolved,
      count(r.id) FILTER (WHERE r.registry_version <> ${registryVersion()})::int AS stale
    FROM train_trips t
    LEFT JOIN trip_routes r ON r.trip_id = t.id
    ${where}`)) as unknown as Array<Record<string, unknown>>

  const reasons = (await db.execute(sql`
    SELECT r.status, r.reason, count(*)::int AS trips
    FROM train_trips t
    JOIN trip_routes r ON r.trip_id = t.id
    ${where}
    ${conds.length > 0 ? sql`AND` : sql`WHERE`} r.status <> 'resolved'
    GROUP BY r.status, r.reason
    ORDER BY count(*) DESC
    LIMIT 20`)) as unknown as Array<Record<string, unknown>>

  return {
    trips: num(totals?.trips),
    resolved: num(totals?.resolved),
    ambiguous: num(totals?.ambiguous),
    unresolved: num(totals?.unresolved),
    /** Imported but the resolver has not reached them — not the same as "no line". */
    not_yet_resolved: num(totals?.not_yet_resolved),
    /** Resolved against an older registry; the next resolver tick will redo them. */
    stale: num(totals?.stale),
    unresolved_reasons: reasons.map((r) => ({
      status: r.status,
      reason: r.reason,
      trips: num(r.trips),
    })),
  }
}

/** Resolve a typed line name, or explain what was meant instead. */
function lookUp(name: string) {
  const hit = resolveLineName(name)
  if (hit) return { hit }
  return {
    error: `No railway line or crossing matching "${name}".`,
    did_you_mean: suggestLines(name),
  }
}

// ---- list_railway_lines ----------------------------------------------------

export const listRailwayLinesSchema = z.object({
  kind: z.enum(['line', 'crossing']).optional()
    .describe('Restrict to railway lines, or to named bridges and tunnels.'),
  country: z.string().optional()
    .describe('ISO 3166-1 alpha-2 country code, e.g. "NO", "SE", "GB" (case-insensitive).'),
  travelled: z.boolean().optional()
    .describe('true for entries Markus has been on, false for the rest. Omit for both.'),
  q: z.string().optional().describe('Free-text filter over names and aliases.'),
  limit: z.number().int().min(1).max(200).default(100),
})

export async function listRailwayLines(input: z.infer<typeof listRailwayLinesSchema>) {
  const db = getDb()

  const totals = (await db.execute(sql`
    SELECT
      l.line_slug,
      count(*)::int AS trips,
      sum(l.on_line_km) AS km,
      sum(l.on_line_seconds) AS seconds,
      min(t.departure_at) AS first_at,
      max(t.departure_at) AS last_at
    FROM trip_line_legs l
    JOIN train_trips t ON t.id = l.trip_id
    WHERE t.departure_at <= now()
    GROUP BY l.line_slug`)) as unknown as Array<Record<string, unknown>>

  const bySlug = new Map(totals.map((r) => [String(r.line_slug), r]))
  const lengths = registryLengths()
  const wanted = input.q?.trim().toLowerCase()
  const country = input.country?.trim().toUpperCase()

  const entries = allEntries()
    .filter((e) => (input.kind ? e.kind === input.kind : true))
    .filter((e) => (country ? e.countries.includes(country) : true))
    .filter((e) => {
      if (!wanted) return true
      return [e.name, e.slug, ...e.aliases].some((s) => s.toLowerCase().includes(wanted))
    })
    .map((e) => {
      const row = bySlug.get(e.slug)
      const trips = num(row?.trips)
      return {
        slug: e.slug,
        name: e.name,
        kind: e.kind,
        aliases: e.aliases,
        countries: e.countries,
        registry_length_km: lengths.get(e.slug) ?? null,
        travelled: trips > 0,
        trips,
        // A crossing's kilometres are inside its carrier line's; they are reported
        // here for completeness but the count is the number that means anything.
        km: row ? round2(num(row.km)) : 0,
        seconds: num(row?.seconds),
        first_at: row?.first_at ?? null,
        last_at: row?.last_at ?? null,
        carrier: e.kind === 'crossing' ? e.carrier : null,
        notes: e.notes ?? null,
      }
    })
    .filter((e) => (input.travelled == null ? true : e.travelled === input.travelled))

  entries.sort((a, b) => b.km - a.km || a.name.localeCompare(b.name))

  return {
    count: Math.min(entries.length, input.limit),
    total_entries: entries.length,
    registry_version: registryVersion(),
    coverage: await coverageFor([sql`t.departure_at <= now()`]),
    filters: {
      kind: input.kind ?? null,
      country: input.country ?? null,
      travelled: input.travelled ?? null,
      q: input.q ?? null,
    },
    lines: entries.slice(0, input.limit),
  }
}

// ---- get_line_stats --------------------------------------------------------

export const getLineStatsSchema = z.object({
  line: z.string()
    .describe('Line or crossing name. Aliases, case and diacritics all resolve: "Bergensbanen", "Bergen Line" and "bergensbana" are one line, as are "Öresundsbron", "Øresundsbroen" and "Öresundsbroa".'),
  group_by: z.enum(['year', 'operator', 'journey']).default('year')
    .describe('Dimension for the breakdown returned in "by".'),
  limit: z.number().int().min(1).max(100).default(20),
  ...filterShape,
})

export async function getLineStats(input: z.infer<typeof getLineStatsSchema>) {
  const db = getDb()
  const found = lookUp(input.line)
  if ('error' in found) return found
  const { hit } = found

  const conds = tripConditions(input)
  const where = whereOf([...conds, sql`l.line_slug = ${hit.slug}`])

  const [totals] = (await db.execute(sql`
    SELECT
      count(*)::int AS trips,
      sum(l.on_line_km) AS km,
      sum(l.on_line_seconds) AS seconds,
      count(*) FILTER (WHERE l.crossed)::int AS crossings,
      min(t.departure_at) AS first_at,
      max(t.departure_at) AS last_at,
      count(*) FILTER (WHERE r.method LIKE 'override%')::int AS by_override
    FROM trip_line_legs l
    JOIN train_trips t ON t.id = l.trip_id
    LEFT JOIN trip_routes r ON r.trip_id = t.id
    ${where}`)) as unknown as Array<Record<string, unknown>>

  const groupExpr = input.group_by === 'year'
    ? sql`extract(year from t.departure_at)::text`
    : input.group_by === 'operator' ? sql`t.operator` : sql`t.journey`

  const by = (await db.execute(sql`
    SELECT
      (${groupExpr}) AS key,
      count(*)::int AS trips,
      sum(l.on_line_km) AS km,
      sum(l.on_line_seconds) AS seconds,
      count(*) FILTER (WHERE l.crossed)::int AS crossings
    FROM trip_line_legs l
    JOIN train_trips t ON t.id = l.trip_id
    ${where}
    GROUP BY (${groupExpr})
    ORDER BY ${input.group_by === 'year' ? sql`(${groupExpr}) ASC` : sql`sum(l.on_line_km) DESC`}
    LIMIT ${input.limit}`)) as unknown as Array<Record<string, unknown>>

  // Every distinct pinned routing behind these numbers, so the totals can be argued
  // with. An answer that leans on an override should never look like raw arithmetic.
  const overrides = (await db.execute(sql`
    SELECT DISTINCT t.from_station, t.to_station, r.method, r.reason
    FROM trip_line_legs l
    JOIN train_trips t ON t.id = l.trip_id
    JOIN trip_routes r ON r.trip_id = t.id
    ${where}
    AND r.method LIKE 'override%'`)) as unknown as Array<Record<string, unknown>>

  // Trips still to come on this line, kept out of the totals above (ADR 0031).
  const upcoming = (await db.execute(sql`
    SELECT t.from_station, t.to_station, t.journey,
           to_char(t.departure_local, 'YYYY-MM-DD') AS date,
           l.on_line_km
    FROM trip_line_legs l
    JOIN train_trips t ON t.id = l.trip_id
    WHERE l.line_slug = ${hit.slug} AND t.departure_at > now()
    ORDER BY t.departure_at ASC
    LIMIT 10`)) as unknown as Array<Record<string, unknown>>

  const seconds = num(totals?.seconds)

  return {
    line: {
      slug: hit.slug,
      name: hit.name,
      kind: hit.kind,
      matched: hit.matched,
      registry_length_km: registryLengths().get(hit.slug) ?? null,
    },
    trips: num(totals?.trips),
    km: round2(num(totals?.km)),
    seconds,
    hours: Math.floor(seconds / 3600),
    minutes: Math.round((seconds % 3600) / 60),
    // For a crossing this is the number that matters: each traversal counted once,
    // in either direction, so an out-and-back day trip counts two.
    crossings: num(totals?.crossings),
    first_at: totals?.first_at ?? null,
    last_at: totals?.last_at ?? null,
    group_by: input.group_by,
    by: by.map((r) => ({
      key: r.key ?? null,
      trips: num(r.trips),
      km: round2(num(r.km)),
      seconds: num(r.seconds),
      crossings: num(r.crossings),
    })),
    overrides_applied: overrides.map((o) => ({
      from: o.from_station,
      to: o.to_station,
      method: o.method,
      reason: o.reason,
    })),
    trips_by_override: num(totals?.by_override),
    upcoming: upcoming.map((u) => ({
      from: u.from_station,
      to: u.to_station,
      journey: u.journey,
      date: u.date,
      km: round2(num(u.on_line_km)),
    })),
    coverage: await coverageFor(conds),
    filters: echoFilters(input),
  }
}

// ---- get_line_trips --------------------------------------------------------

export const getLineTripsSchema = z.object({
  line: z.string().describe('Line or crossing name; aliases, case and diacritics all resolve.'),
  sort_order: z.enum(['asc', 'desc']).default('desc')
    .describe('Order by departure. "desc" (default) is newest-first.'),
  limit: z.number().int().min(1).max(200).default(50),
  page: z.number().int().min(1).default(1),
  ...filterShape,
})

export async function getLineTrips(input: z.infer<typeof getLineTripsSchema>) {
  const db = getDb()
  const found = lookUp(input.line)
  if ('error' in found) return found
  const { hit } = found

  const conds = tripConditions(input)
  const where = whereOf([...conds, sql`l.line_slug = ${hit.slug}`])
  const order = input.sort_order === 'asc' ? sql`ASC` : sql`DESC`
  const offset = (input.page - 1) * input.limit

  const rows = (await db.execute(sql`
    SELECT
      t.from_station, t.to_station, t.journey, t.operator, t.mode, t.status,
      t.departure_at, t.arrival_at, t.distance_km,
      l.on_line_km, l.on_line_seconds, l.crossed,
      r.method, r.reason, r.raw_km, r.scale_factor
    FROM trip_line_legs l
    JOIN train_trips t ON t.id = l.trip_id
    LEFT JOIN trip_routes r ON r.trip_id = t.id
    ${where}
    ORDER BY t.departure_at ${order}
    LIMIT ${input.limit} OFFSET ${offset}`)) as unknown as Array<Record<string, unknown>>

  const [count] = (await db.execute(sql`
    SELECT count(*)::int AS n
    FROM trip_line_legs l
    JOIN train_trips t ON t.id = l.trip_id
    ${where}`)) as unknown as Array<{ n: number }>

  return {
    line: { slug: hit.slug, name: hit.name, kind: hit.kind, matched: hit.matched },
    count: rows.length,
    total: num(count?.n),
    page: input.page,
    sort_order: input.sort_order,
    coverage: await coverageFor(conds),
    filters: echoFilters(input),
    trips: rows.map((r) => {
      const onLineKm = round2(num(r.on_line_km))
      const tripKm = numOrNull(r.distance_km)
      return {
        from: r.from_station,
        to: r.to_station,
        journey: r.journey,
        operator: r.operator,
        mode: r.mode,
        status: r.status,
        departure_at: r.departure_at,
        arrival_at: r.arrival_at,
        /** The trip's whole recorded distance, for auditing the share below. */
        trip_distance_km: tripKm,
        on_line_km: onLineKm,
        on_line_seconds: numOrNull(r.on_line_seconds),
        /** This line's fraction of the trip. Null when the trip has no distance. */
        share_of_trip: tripKm && tripKm > 0 ? Math.round((onLineKm / tripKm) * 1000) / 1000 : null,
        crossed: r.crossed === true,
        resolved_via: r.method ?? null,
        /** The pinned routing's justification, when one decided this leg. */
        override_reason: String(r.method ?? '').startsWith('override') ? r.reason : null,
        /** Registry kilometres before scaling, and the factor applied to reach the recorded distance. */
        raw_route_km: numOrNull(r.raw_km),
        scale_factor: numOrNull(r.scale_factor),
      }
    }),
  }
}
