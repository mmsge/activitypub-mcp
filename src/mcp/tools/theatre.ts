import { z } from 'zod'
import { sql, type SQL } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { encodeCursor, decodeCursor, keysetCondition, keysetOrderBy } from './pagination.js'

// Theatre: NeoDB `Performance` (a play) and `PerformanceProduction` (one staging of it)
// marks, which the mark store files under category `performance`. See ADR 0061.
//
// The unit is a VISIT — a live mark — not a catalogue item. A mark carries the things only
// the evening knows (the night, the comment, whether he finished it); the catalogue row is
// joined on for what the play is (troupe, venue, playwright, cast). An item nobody marked
// is not a theatre visit, so the query starts from `neodb_marks`.
//
// Every statement is raw SQL with the aliases `m` (neodb_marks) and `c` (catalog_metadata)
// written out by hand. The two tables share half their column names (title, cover_url,
// category, item_type, raw), so a bare column in a select-list expression would bind to
// whichever table Postgres liked — the ADR 0011 trap, twice over.

/** The `details` keys that name a person or a company, i.e. what `person` searches. */
export const CREDIT_KEYS = [
  'troupe', 'playwright', 'orig_creator', 'director', 'actor', 'performer',
  'composer', 'choreographer', 'crew',
] as const

const TITLE = sql`coalesce(c.display_title, c.title, m.title)`

/** A details array, or `[]` when the key is absent or not an array. */
function detailArray(key: string): SQL {
  return sql`CASE WHEN jsonb_typeof(c.details->${key}) = 'array' THEN c.details->${key} ELSE '[]'::jsonb END`
}

/** Case-insensitive partial match against any name under one of `keys`. */
function nameMatch(keys: readonly string[], needle: string): SQL {
  const pat = `%${needle}%`
  const parts = keys.map((k) => sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(${detailArray(k)}) AS n(name) WHERE n.name ILIKE ${pat}
  )`)
  return sql`(${sql.join(parts, sql` OR `)})`
}

export interface TheatreFilters {
  title?: string
  troupe?: string
  venue?: string
  person?: string
  q?: string
  status?: 'wishlist' | 'progress' | 'complete' | 'dropped'
  item_type?: 'Performance' | 'PerformanceProduction'
  year?: number
  from?: string
  to?: string
  seen_date_unknown?: boolean
  has_comment?: boolean
  include_hidden?: boolean
  // Every shelf status, wishlist included. Only get_theatre_details sets it.
  any_status?: boolean
}

/**
 * The WHERE conditions shared by the list and the stats, so a breakdown can never
 * disagree with the rows it summarises. Exported for the SQL-shape tests.
 */
export function buildTheatreConditions(f: TheatreFilters): SQL[] {
  const c: SQL[] = [
    sql`m.category = 'performance'`,
    sql`m.deleted_at IS NULL`,
  ]
  // "I want to see this" is intent, not a visit — out unless asked for by name.
  if (f.status) c.push(sql`m.status = ${f.status}`)
  else if (!f.any_status) c.push(sql`m.status IS DISTINCT FROM 'wishlist'`)
  // LEFT JOIN: a mark whose item has not been enriched yet has no catalogue row, and is
  // still a visit. Only a row an admin hid drops out (ADR 0013).
  if (!f.include_hidden) c.push(sql`c.hidden_at IS NULL`)
  if (f.item_type) c.push(sql`coalesce(c.item_type, m.item_type) = ${f.item_type}`)
  if (f.title) {
    const pat = `%${f.title}%`
    c.push(sql`(${TITLE} ILIKE ${pat} OR c.orig_title ILIKE ${pat})`)
  }
  if (f.troupe) c.push(nameMatch(['troupe'], f.troupe))
  if (f.venue) c.push(nameMatch(['venue'], f.venue))
  if (f.person) c.push(nameMatch(CREDIT_KEYS, f.person))
  if (f.q) {
    const pat = `%${f.q}%`
    c.push(sql`(${TITLE} ILIKE ${pat} OR c.orig_title ILIKE ${pat} OR c.description ILIKE ${pat} OR m.comment ILIKE ${pat})`)
  }
  // The window is on the NIGHT (the shelf date), never on when the mark was posted. A
  // visit with an unknown date has no night, so any window excludes it (ADR 0060).
  const from = f.from ?? (f.year ? `${f.year}-01-01` : null)
  const to = f.to ?? (f.year ? `${f.year}-12-31` : null)
  if (from) c.push(sql`m.watched_at >= ${from}::date`)
  if (to) c.push(sql`m.watched_at < (${to}::date + 1)`)
  if (f.seen_date_unknown != null) c.push(sql`m.watched_date_unknown = ${f.seen_date_unknown}`)
  if (f.has_comment) c.push(sql`coalesce(m.comment, '') <> ''`)
  return c
}

const FROM = sql`neodb_marks m LEFT JOIN catalog_metadata c ON c.item_url = m.item_url`

/** The select list for one visit. */
const VISIT_COLUMNS = sql`
  m.id AS mark_id,
  m.item_url,
  coalesce(c.item_type, m.item_type) AS item_type,
  ${TITLE} AS title,
  c.orig_title,
  c.description,
  coalesce(c.cover_url, m.cover_url) AS cover_url,
  c.year,
  c.language,
  c.details,
  m.status,
  m.watched_at,
  m.watched_date_unknown,
  m.comment,
  m.mark_url,
  m.actor_ap_id,
  m.published_at,
  c.enriched_at,
  c.fetch_error,
  c.hidden_at
`

type VisitRow = {
  mark_id: string
  item_url: string
  item_type: string | null
  title: string | null
  orig_title: string | null
  description: string | null
  cover_url: string | null
  year: number | null
  language: unknown
  details: unknown
  status: string | null
  watched_at: Date | string | null
  watched_date_unknown: boolean
  comment: string | null
  mark_url: string | null
  actor_ap_id: string
  published_at: Date | string | null
  enriched_at: Date | string | null
  fetch_error: string | null
  hidden_at: Date | string | null
}

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? [])
}

function iso(v: unknown): string | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function names(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** One visit, shaped for output. Pure, so it is tested without a database. */
export function shapeVisit(r: VisitRow) {
  const d = obj(r.details)
  return {
    mark_id: r.mark_id,
    item_url: r.item_url,
    // Performance = the play; PerformanceProduction = one staging of it by one company.
    item_type: r.item_type,
    title: r.title,
    orig_title: r.orig_title,
    // The night he was there. null when the mark carried no date, or when he marked it
    // as seen with the date explicitly unknown (then seen_date_unknown is true).
    seen_at: iso(r.watched_at),
    seen_date_unknown: r.watched_date_unknown,
    status: r.status,
    // His own words about the evening, verbatim, never parsed.
    comment: r.comment,
    troupe: names(d.troupe),
    venue: names(d.venue),
    playwright: names(d.playwright),
    orig_creator: names(d.orig_creator),
    director: names(d.director),
    actor: names(d.actor),
    // [{ name, role }] where NeoDB knows the part. [] when it does not.
    cast: Array.isArray(d.cast) ? d.cast : [],
    composer: names(d.composer),
    choreographer: names(d.choreographer),
    performer: names(d.performer),
    opening_date: typeof d.opening_date === 'string' ? d.opening_date : null,
    closing_date: typeof d.closing_date === 'string' ? d.closing_date : null,
    official_site: typeof d.official_site === 'string' ? d.official_site : null,
    // A production's play, as a catalogue URL. null for a play, or an unlinked production.
    play_url: typeof d.play_url === 'string' ? d.play_url : null,
    year: r.year,
    language: names(r.language),
    description: r.description,
    cover_url: r.cover_url,
    mark_url: r.mark_url,
    // The account that marked it.
    marked_by: r.actor_ap_id,
    // When the mark was posted — the paperwork, not the night.
    marked_at: iso(r.published_at),
    enriched: r.enriched_at != null,
    ...(r.fetch_error ? { fetch_error: r.fetch_error } : {}),
    ...(r.hidden_at ? { hidden: true } : {}),
  }
}

// ---- get_theatre -------------------------------------------------------------

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const getTheatreSchema = z.object({
  title: z.string().optional().describe('Filter by title (case-insensitive, partial; also matches the original title)'),
  troupe: z.string().optional().describe('Filter by theatre company / troupe, e.g. "Riksteatret" (case-insensitive, partial)'),
  venue: z.string().optional().describe('Filter by venue (case-insensitive, partial). Only as complete as NeoDB records it: a touring production often has none.'),
  person: z.string().optional().describe('Anyone credited — playwright, original creator, director, actor, performer, composer, choreographer, crew or troupe (case-insensitive, partial)'),
  q: z.string().optional().describe('Free text over title, description and his comment on the visit'),
  status: z.enum(['wishlist', 'progress', 'complete', 'dropped']).optional()
    .describe('Only visits with this shelf status. Omitted, wishlist marks are left out: wanting to see a play is not a visit. "dropped" is leaving at the interval.'),
  item_type: z.enum(['Performance', 'PerformanceProduction']).optional()
    .describe('Performance = marked against the play; PerformanceProduction = marked against one staging of it'),
  year: z.number().int().min(1000).max(9999).optional()
    .describe('Sugar for from/to spanning one calendar year (UTC) of the NIGHT. An explicit from/to overrides it on that edge.'),
  from: DATE.optional().describe('Only visits on or after this date (YYYY-MM-DD), by the night'),
  to: DATE.optional().describe('Only visits on or before this date (YYYY-MM-DD), by the night'),
  seen_date_unknown: z.boolean().optional()
    .describe('true → only visits marked with the date explicitly unknown (minreol\'s 2000-01-01 sentinel); false → drop those. Omit for both.'),
  has_comment: z.boolean().default(false).describe('Only visits he wrote something about'),
  include_hidden: z.boolean().default(false).describe('Include items an admin has hidden'),
  sort_by: z.enum(['seen_at', 'marked_at']).default('seen_at')
    .describe('"seen_at" (default) is the night; "marked_at" is when the mark was posted. Undated visits sort last either way.'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.number().int().min(1).max(200).default(50),
  page: z.number().int().min(1).default(1)
    .describe('Offset-based page (legacy). Ignored when "cursor" is supplied.'),
  cursor: z.string().optional().describe('Opaque cursor from a previous response\'s next_cursor'),
})

export async function getTheatre(input: z.infer<typeof getTheatreSchema>) {
  const db = getDb()
  const filters = buildTheatreConditions(input)
  const where = sql.join(filters, sql` AND `)

  const [totals] = rowsOf<{ total: number }>(await db.execute(sql`
    SELECT count(*)::int AS total FROM ${FROM} WHERE ${where}
  `))

  const sortKey = input.sort_by === 'marked_at' ? sql`m.published_at` : sql`m.watched_at`
  const idKey = sql`m.id`
  const conditions = [...filters]
  if (input.cursor) {
    conditions.push(keysetCondition(sortKey, idKey, decodeCursor(input.cursor), input.sort_order))
  }

  const rows = rowsOf<VisitRow & { sort_value: Date | string | null }>(await db.execute(sql`
    SELECT ${VISIT_COLUMNS}, ${sortKey} AS sort_value
    FROM ${FROM}
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY ${keysetOrderBy(sortKey, idKey, input.sort_order)}
    LIMIT ${input.limit}
    OFFSET ${input.cursor ? 0 : (input.page - 1) * input.limit}
  `))

  const last = rows[rows.length - 1]
  const lastSort = last?.sort_value != null ? new Date(iso(last.sort_value)!) : null
  const nextCursor = last && rows.length === input.limit ? encodeCursor(lastSort, last.mark_id) : null

  return {
    count: rows.length,
    total: totals?.total ?? 0,
    page: input.cursor ? null : input.page,
    next_cursor: nextCursor,
    sort_by: input.sort_by,
    sort_order: input.sort_order,
    filters: {
      title: input.title ?? null,
      troupe: input.troupe ?? null,
      venue: input.venue ?? null,
      person: input.person ?? null,
      q: input.q ?? null,
      status: input.status ?? null,
      item_type: input.item_type ?? null,
      year: input.year ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      seen_date_unknown: input.seen_date_unknown ?? null,
      has_comment: input.has_comment,
    },
    visits: rows.map(shapeVisit),
  }
}

// ---- get_theatre_details -------------------------------------------------------

export const getTheatreDetailsSchema = z.object({
  item_url: z.string().optional().describe('The NeoDB catalogue URL of the play or production, exactly as get_theatre returns it'),
  title: z.string().optional().describe('Alternatively, a partial title (case-insensitive). The most recently seen match wins.'),
  include_hidden: z.boolean().default(false).describe('Allow resolving an item an admin has hidden'),
})

export async function getTheatreDetails(input: z.infer<typeof getTheatreDetailsSchema>) {
  if (!input.item_url && !input.title) return { error: 'Supply either item_url or title' }
  const db = getDb()

  // Any shelf status resolves here, wishlist included: asking about one play by name is
  // asking what is known about it.
  const filters = buildTheatreConditions({ include_hidden: input.include_hidden, title: input.title, any_status: true })
  if (input.item_url) filters.push(sql`m.item_url = ${input.item_url.replace(/\/+$/, '')}`)

  const [hit] = rowsOf<{ item_url: string }>(await db.execute(sql`
    SELECT m.item_url FROM ${FROM}
    WHERE ${sql.join(filters, sql` AND `)}
    ORDER BY m.watched_at DESC NULLS LAST, m.published_at DESC NULLS LAST
    LIMIT 1
  `))
  if (!hit) return { error: `No theatre visit found for ${input.item_url ?? input.title}` }

  const visits = rowsOf<VisitRow>(await db.execute(sql`
    SELECT ${VISIT_COLUMNS} FROM ${FROM}
    WHERE m.item_url = ${hit.item_url} AND m.deleted_at IS NULL
    ORDER BY m.watched_at DESC NULLS LAST, m.id DESC
  `)).map(shapeVisit)

  const [item] = rowsOf<{
    source_map: unknown; external_resources: unknown; raw: unknown
    fetched_at: Date | string | null; enriched_at: Date | string | null
    fetch_error: string | null; fetch_attempts: number
  }>(await db.execute(sql`
    SELECT c.source_map, c.external_resources, c.fetched_at, c.enriched_at, c.fetch_error, c.fetch_attempts
    FROM catalog_metadata c WHERE c.item_url = ${hit.item_url}
  `))

  // A play links DOWN to the productions of it he has marked; a production links UP to
  // its play, when the play's own record is cached.
  const head = visits[0]
  const productions = head?.item_type === 'Performance'
    ? rowsOf<{ item_url: string; title: string | null; troupe: unknown }>(await db.execute(sql`
        SELECT c.item_url, coalesce(c.display_title, c.title) AS title, c.details->'troupe' AS troupe
        FROM catalog_metadata c
        WHERE c.details->>'play_url' = ${hit.item_url}
        ORDER BY c.item_url
      `)).map((p) => ({ item_url: p.item_url, title: p.title, troupe: names(p.troupe) }))
    : []
  const play = head?.play_url
    ? rowsOf<{ item_url: string; title: string | null }>(await db.execute(sql`
        SELECT c.item_url, coalesce(c.display_title, c.title) AS title
        FROM catalog_metadata c WHERE c.item_url = ${head.play_url}
      `))[0] ?? { item_url: head.play_url, title: null }
    : null

  return {
    ...head,
    visits,
    visit_count: visits.filter((v) => v.status !== 'wishlist').length,
    play,
    productions,
    external_resources: item?.external_resources ?? null,
    source_map: obj(item?.source_map),
    enrichment: item
      ? {
          fetched_at: iso(item.fetched_at),
          enriched_at: iso(item.enriched_at),
          fetch_error: item.fetch_error,
          fetch_attempts: item.fetch_attempts,
        }
      : null,
  }
}

// ---- get_theatre_stats ---------------------------------------------------------

export const getTheatreStatsSchema = z.object({
  status: z.enum(['wishlist', 'progress', 'complete', 'dropped']).optional()
    .describe('Count only visits with this shelf status. Omitted, every visit except wishlist marks.'),
  year: z.number().int().min(1000).max(9999).optional().describe('Sugar for from/to spanning one calendar year of the night'),
  from: DATE.optional().describe('Only visits on or after this date (YYYY-MM-DD)'),
  to: DATE.optional().describe('Only visits on or before this date (YYYY-MM-DD)'),
  top: z.number().int().min(1).max(50).default(10).describe('How many entries in each top-N breakdown'),
  include_hidden: z.boolean().default(false).describe('Include items an admin has hidden'),
})

/** A top-N over the names under `keys`, counting each visit once per name. */
function topNames(where: SQL, keys: readonly string[], top: number): SQL {
  const arrays = keys.map((k) => detailArray(k))
  const union = arrays.length === 1 ? arrays[0] : sql`(${sql.join(arrays, sql` || `)})`
  return sql`
    SELECT n.name AS name, count(DISTINCT m.id)::int AS visits
    FROM ${FROM}, jsonb_array_elements_text(${union}) AS n(name)
    WHERE ${where}
    GROUP BY 1 ORDER BY visits DESC, name ASC LIMIT ${top}
  `
}

export async function getTheatreStats(input: z.infer<typeof getTheatreStatsSchema>) {
  const db = getDb()
  const where = sql.join(buildTheatreConditions(input), sql` AND `)

  const [totals] = rowsOf<{
    visits: number; plays: number; productions: number; with_comment: number
    date_unknown: number; undated: number; first_seen: Date | string | null; last_seen: Date | string | null
  }>(await db.execute(sql`
    SELECT
      count(*)::int AS visits,
      count(DISTINCT m.item_url)::int AS plays,
      count(*) FILTER (WHERE coalesce(c.item_type, m.item_type) = 'PerformanceProduction')::int AS productions,
      count(*) FILTER (WHERE coalesce(m.comment, '') <> '')::int AS with_comment,
      count(*) FILTER (WHERE m.watched_date_unknown)::int AS date_unknown,
      count(*) FILTER (WHERE m.watched_at IS NULL AND NOT m.watched_date_unknown)::int AS undated,
      min(m.watched_at) AS first_seen,
      max(m.watched_at) AS last_seen
    FROM ${FROM} WHERE ${where}
  `))

  const [byYear, byStatus, troupes, venues, playwrights, creators, directors, actors] = await Promise.all([
    db.execute(sql`
      SELECT to_char(m.watched_at AT TIME ZONE 'UTC', 'YYYY') AS year, count(*)::int AS visits
      FROM ${FROM} WHERE ${where} AND m.watched_at IS NOT NULL
      GROUP BY 1 ORDER BY 1 DESC
    `),
    db.execute(sql`
      SELECT m.status, count(*)::int AS visits FROM ${FROM} WHERE ${where}
      GROUP BY 1 ORDER BY visits DESC
    `),
    db.execute(topNames(where, ['troupe'], input.top)),
    db.execute(topNames(where, ['venue'], input.top)),
    db.execute(topNames(where, ['playwright'], input.top)),
    db.execute(topNames(where, ['orig_creator'], input.top)),
    db.execute(topNames(where, ['director'], input.top)),
    db.execute(topNames(where, ['actor', 'performer'], input.top)),
  ])

  type Named = { name: string; visits: number }
  return {
    filters: {
      status: input.status ?? null,
      year: input.year ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      include_hidden: input.include_hidden,
    },
    totals: {
      visits: totals?.visits ?? 0,
      // Distinct catalogue items. A play and a production of it are two items.
      plays: totals?.plays ?? 0,
      productions: totals?.productions ?? 0,
      with_comment: totals?.with_comment ?? 0,
      // Marked as seen with the date explicitly unknown: in every total, in no year.
      date_unknown: totals?.date_unknown ?? 0,
      // No date at all (not the deliberate unknown above).
      undated: totals?.undated ?? 0,
      first_seen: iso(totals?.first_seen),
      last_seen: iso(totals?.last_seen),
    },
    by_year: rowsOf<{ year: string; visits: number }>(byYear),
    by_status: rowsOf<{ status: string | null; visits: number }>(byStatus),
    top_troupes: rowsOf<Named>(troupes),
    top_venues: rowsOf<Named>(venues),
    top_playwrights: rowsOf<Named>(playwrights),
    // Whose work the play is based on — Nora Dåsnes for a stage adaptation of her novel.
    top_original_creators: rowsOf<Named>(creators),
    top_directors: rowsOf<Named>(directors),
    top_actors: rowsOf<Named>(actors),
  }
}
