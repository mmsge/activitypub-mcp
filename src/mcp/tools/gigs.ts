import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { gigCatalog, gigVenues } from '../../db/schema.js'
import { and, count, eq, getTableColumns, isNull, sql, type SQL } from 'drizzle-orm'
import { encodeCursor, decodeCursor, keysetCondition, keysetOrderBy } from './pagination.js'

// ---- shared helpers --------------------------------------------------------
//
// Every correlated subquery below writes its join condition **table-qualified by hand**
// (`a.concert_url = gig_catalog.concert_url`, not an interpolated column). Drizzle
// qualifies a bare column reference inside WHERE but NOT inside a select-list expression,
// where `concert_url` would bind to the subquery's own table instead — an always-true
// self-comparison that silently hands every row every other row's data. That bug shipped
// once already, in get_watched's mark_comments (ADR 0011); the tests assert the rendered
// SQL so it cannot come back.

/** Only attendances that have not been tombstoned count towards anything. */
const LIVE = sql`a.deleted_at IS NULL`

/** The newest live attendance's RSVP state — the scalar convenience field. */
export const rsvpStatusExpr = sql<string | null>`(
  SELECT a.status FROM gig_attendances a
  WHERE a.concert_url = gig_catalog.concert_url AND ${LIVE} AND a.status IS NOT NULL
  ORDER BY a.published_at DESC NULLS LAST
  LIMIT 1
)`

/**
 * Where that state came from: 'tag' and 'property' are stated by the origin, 'template'
 * is derived from the generated opening sentence. Surfaced rather than hidden because the
 * difference is real — a caller counting "gigs I actually attended" should be able to see
 * which of those are inferences.
 */
export const rsvpSourceExpr = sql<string | null>`(
  SELECT a.status_source FROM gig_attendances a
  WHERE a.concert_url = gig_catalog.concert_url AND ${LIVE} AND a.status IS NOT NULL
  ORDER BY a.published_at DESC NULLS LAST
  LIMIT 1
)`

/**
 * The write-ups on this gig, newest first, duplicates collapsed.
 *
 * Plural for the same reason get_watched's mark_comments is: the catalogue is shared, so
 * a gig can carry an attendance from more than one followed account, each with its own
 * write-up. `[]` when nobody wrote anything.
 */
export const reviewsExpr = sql<string[]>`(
  SELECT coalesce(jsonb_agg(r.review ORDER BY r.published_at DESC NULLS LAST), '[]'::jsonb)
  FROM (
    SELECT DISTINCT ON (a.review) a.review, a.published_at
    FROM gig_attendances a
    WHERE a.concert_url = gig_catalog.concert_url AND a.deleted_at IS NULL
      AND coalesce(a.review, '') <> ''
    ORDER BY a.review, a.published_at DESC NULLS LAST
  ) r
)`

/** Every photo across the gig's live attendances, alt text included. */
export const photosExpr = sql<unknown[]>`(
  SELECT coalesce(jsonb_agg(p.photo), '[]'::jsonb)
  FROM gig_attendances a, jsonb_array_elements(a.photos) AS p(photo)
  WHERE a.concert_url = gig_catalog.concert_url AND a.deleted_at IS NULL
    AND jsonb_typeof(a.photos) = 'array'
)`

/**
 * When the gig was logged — the newest live attendance's `published`.
 *
 * Emphatically NOT the night of the gig. The origin stamps a Note with the attendance's
 * updatedAt, so an archive imported in 2026 logs a 2022 gig in 2026. `gig_date` is the
 * night; this is the paperwork.
 */
export const loggedAtExpr = sql<Date | null>`(
  SELECT max(a.published_at) FROM gig_attendances a
  WHERE a.concert_url = gig_catalog.concert_url AND a.deleted_at IS NULL
)`

/** The gig date as a timestamp, for the keyset. Qualified by hand, as above. */
const gigDateExpr = sql`gig_catalog.gig_date::timestamptz`

/** Case-insensitive partial match against any name in the line-up. */
function artistMatch(artist: string): SQL {
  const pat = `%${artist}%`
  return sql`(
    jsonb_typeof(${gigCatalog.artistNames}) = 'array' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(${gigCatalog.artistNames}) AS n(name)
      WHERE n.name ILIKE ${pat}
    )
  )`
}

/** Case-insensitive partial match against any song in any of the gig's setlists. */
function songMatch(song: string): SQL {
  const pat = `%${song}%`
  return sql`(
    jsonb_typeof(${gigCatalog.setlists}) = 'array' AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${gigCatalog.setlists}) AS s(setlist),
           jsonb_array_elements(s.setlist->'entries') AS e(entry)
      WHERE jsonb_typeof(s.setlist->'entries') = 'array'
        AND e.entry->>'songTitle' ILIKE ${pat}
    )
  )`
}

/** Free text over the gig's title, its notes and any write-up on it. */
function textMatch(q: string): SQL {
  const pat = `%${q}%`
  return sql`(
    ${gigCatalog.title} ILIKE ${pat}
    OR ${gigCatalog.notes} ILIKE ${pat}
    OR EXISTS (
      SELECT 1 FROM gig_attendances a
      WHERE a.concert_url = ${gigCatalog.concertUrl} AND a.deleted_at IS NULL
        AND a.review ILIKE ${pat}
    )
  )`
}

function rsvpMatch(status: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM gig_attendances a
    WHERE a.concert_url = ${gigCatalog.concertUrl} AND a.deleted_at IS NULL
      AND a.status = ${status}
  )`
}

function buildConditions(input: {
  artist?: string
  venue?: string
  city?: string
  country?: string
  festival?: string
  tour?: string
  song?: string
  q?: string
  status?: string
  concert_status?: string
  year?: number
  from?: string
  to?: string
  has_review?: boolean
  has_setlist?: boolean
  include_unenriched?: boolean
  include_hidden?: boolean
}): SQL[] {
  const conditions: SQL[] = []

  // Admin-hidden rows are out by default; `include_hidden` opts back in (ADR 0013).
  if (!input.include_hidden) conditions.push(isNull(gigCatalog.hiddenAt))

  if (input.artist) conditions.push(artistMatch(input.artist))
  if (input.song) conditions.push(songMatch(input.song))
  if (input.q) conditions.push(textMatch(input.q))
  if (input.status) conditions.push(rsvpMatch(input.status))
  if (input.venue) conditions.push(sql`${gigCatalog.venueName} ILIKE ${'%' + input.venue + '%'}`)
  if (input.city) conditions.push(sql`${gigCatalog.venueCity} ILIKE ${'%' + input.city + '%'}`)
  if (input.country) conditions.push(sql`upper(${gigCatalog.venueCountry}) = ${input.country.toUpperCase()}`)
  if (input.festival) conditions.push(sql`${gigCatalog.festivalName} ILIKE ${'%' + input.festival + '%'}`)
  if (input.tour) conditions.push(sql`${gigCatalog.tourName} ILIKE ${'%' + input.tour + '%'}`)
  if (input.concert_status) conditions.push(eq(gigCatalog.concertStatus, input.concert_status))

  // The date window is on the NIGHT of the gig, never on when it was logged. `year` is
  // sugar; an explicit from/to overrides it on that edge.
  const from = input.from ?? (input.year ? `${input.year}-01-01` : null)
  const to = input.to ?? (input.year ? `${input.year}-12-31` : null)
  if (from) conditions.push(sql`${gigCatalog.gigDate} >= ${from}::date`)
  if (to) conditions.push(sql`${gigCatalog.gigDate} <= ${to}::date`)

  if (input.has_review) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM gig_attendances a
      WHERE a.concert_url = ${gigCatalog.concertUrl} AND a.deleted_at IS NULL
        AND coalesce(a.review, '') <> ''
    )`)
  }
  if (input.has_setlist) {
    conditions.push(sql`coalesce(${gigCatalog.songCount}, 0) > 0`)
  }

  // Rows that have never enriched are stubs — a failed or pending fetch with no title,
  // date or line-up. Out by default, like get_watched's include_unenriched.
  if (!input.include_unenriched) {
    conditions.push(sql`${gigCatalog.enrichedAt} IS NOT NULL`)
  }

  // Respect tombstones: a gig whose every attendance has been deleted drops out. A gig
  // we track no attendance for is grandfathered in rather than vanishing, matching
  // get_watched — the filter must never hide a row that has no delete behind it.
  conditions.push(sql`(
    NOT EXISTS (SELECT 1 FROM gig_attendances a WHERE a.concert_url = ${gigCatalog.concertUrl})
    OR EXISTS (SELECT 1 FROM gig_attendances a WHERE a.concert_url = ${gigCatalog.concertUrl} AND a.deleted_at IS NULL)
  )`)

  return conditions
}

function asArray<T>(v: unknown): T[] | null {
  return Array.isArray(v) ? (v as T[]) : null
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

// ---- get_gigs: the paginated gig log ---------------------------------------

export const getGigsSchema = z.object({
  artist: z.string().optional()
    .describe('Filter by artist (case-insensitive, partial match against any name in the line-up, headliners and support alike)'),
  venue: z.string().optional().describe('Filter by venue name (case-insensitive, partial match)'),
  city: z.string().optional().describe('Filter by city (case-insensitive, partial match)'),
  country: z.string().optional().describe('Filter by ISO 3166-1 alpha-2 country code, e.g. "NO" or "DE" (case-insensitive, exact)'),
  festival: z.string().optional().describe('Filter by festival name (case-insensitive, partial match). A festival day is an ordinary gig with many artists, not a separate kind of thing.'),
  tour: z.string().optional().describe('Filter by tour name (case-insensitive, partial match)'),
  song: z.string().optional()
    .describe('Only gigs whose setlist contains this song (case-insensitive, partial match). Setlists arrive only from an origin serving them; a gig with no setlist can never match.'),
  q: z.string().optional().describe('Free-text search over the gig title, its notes, and any write-up about it'),
  status: z.enum(['interested', 'going', 'attended']).optional()
    .describe('Filter by RSVP state. Note that for gigs logged before the origin published this as data, the state is derived from the generated opening sentence — check status_source on the results.'),
  concert_status: z.enum(['scheduled', 'cancelled', 'postponed', 'completed']).optional()
    .describe('Filter by the concert\'s own status, which is about the event and not about attending it.'),
  year: z.number().int().min(1000).max(9999).optional()
    .describe('Sugar for from/to spanning one calendar year, e.g. 2023 for "every gig I went to in 2023". Applies to the NIGHT of the gig, not to when it was logged. An explicit from/to overrides it on that edge.'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Only gigs on or after this date (YYYY-MM-DD), by the night of the gig'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Only gigs on or before this date (YYYY-MM-DD), by the night of the gig'),
  has_review: z.boolean().default(false).describe('Only gigs somebody wrote up'),
  has_setlist: z.boolean().default(false).describe('Only gigs with at least one song recorded'),
  include_unenriched: z.boolean().default(false)
    .describe('Include rows whose concert record has not been fetched successfully yet (pending or failed, carrying fetch_error/fetch_attempts). Off by default; such a row has no title, date or line-up.'),
  include_hidden: z.boolean().default(false)
    .describe('Include gigs an admin has hidden from the served catalogue. Off by default. Hidden gigs still exist and are still enriched; they are suppressed from listings, not deleted.'),
  sort_by: z.enum(['gig_date', 'logged_at']).default('gig_date')
    .describe('Which date to order by. "gig_date" (default) is the night of the gig — the one you almost always want. "logged_at" is when the attendance was posted, which for an imported archive is the order the import ran in and says nothing about when anything happened. Gigs with no date sort last in both directions.'),
  sort_order: z.enum(['asc', 'desc']).default('desc')
    .describe('Direction for sort_by. "desc" (default) is most recent first; "asc" is oldest first.'),
  limit: z.number().int().min(1).max(200).default(50),
  page: z.number().int().min(1).default(1)
    .describe('Offset-based page (legacy). Ignored when "cursor" is supplied; prefer "cursor" for deep traversal.'),
  cursor: z.string().optional()
    .describe('Opaque pagination cursor from a previous response\'s next_cursor. When set, page/offset is ignored and traversal continues from where the last page ended (respecting sort_order and all filters).'),
})

export async function getGigs(input: z.infer<typeof getGigsSchema>) {
  const db = getDb()
  const filterConditions = buildConditions(input)
  const filterWhere = filterConditions.length ? and(...filterConditions) : undefined

  const [totals] = await db.select({ total: count() }).from(gigCatalog).where(filterWhere)

  const sortKey = input.sort_by === 'logged_at' ? loggedAtExpr : gigDateExpr
  const conditions = [...filterConditions]
  if (input.cursor) {
    conditions.push(keysetCondition(sortKey, gigCatalog.id, decodeCursor(input.cursor), input.sort_order))
  }

  const rows = await db
    .select({
      ...getTableColumns(gigCatalog),
      rsvpStatus: rsvpStatusExpr,
      rsvpSource: rsvpSourceExpr,
      reviews: reviewsExpr,
      photos: photosExpr,
      loggedAt: loggedAtExpr,
    })
    .from(gigCatalog)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(keysetOrderBy(sortKey, gigCatalog.id, input.sort_order))
    .limit(input.limit)
    .offset(input.cursor ? 0 : (input.page - 1) * input.limit)

  const last = rows[rows.length - 1]
  const lastSortValue = last
    ? input.sort_by === 'logged_at'
      ? toDate(last.loggedAt)
      : last.gigDate
        ? new Date(`${last.gigDate}T00:00:00Z`)
        : null
    : null
  const nextCursor = last && rows.length === input.limit ? encodeCursor(lastSortValue, last.id) : null

  return {
    count: rows.length,
    total: totals?.total ?? 0,
    page: input.cursor ? null : input.page,
    next_cursor: nextCursor,
    sort_by: input.sort_by,
    sort_order: input.sort_order,
    filters: {
      artist: input.artist ?? null,
      venue: input.venue ?? null,
      city: input.city ?? null,
      country: input.country ?? null,
      festival: input.festival ?? null,
      tour: input.tour ?? null,
      song: input.song ?? null,
      q: input.q ?? null,
      status: input.status ?? null,
      concert_status: input.concert_status ?? null,
      year: input.year ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      has_review: input.has_review,
      has_setlist: input.has_setlist,
      include_unenriched: input.include_unenriched,
    },
    gigs: rows.map((r) => ({
      concert_url: r.concertUrl,
      title: r.title,
      // The night of the gig. This is the date to use for anything historical.
      gig_date: r.gigDate,
      // The exact instant the music started, when the origin knows the venue's timezone
      // and the concert's start time. Absent for most of a backfilled archive — which is
      // why gig_date exists separately and is the one that sorts.
      start_at: toDate(r.startAt)?.toISOString() ?? null,
      doors_time: r.doorsTime,
      concert_status: r.concertStatus,
      tour_name: r.tourName,
      festival_name: r.festivalName,
      notes: r.notes,
      venue: {
        url: r.venueUrl,
        name: r.venueName,
        city: r.venueCity,
        country: r.venueCountry,
      },
      // [{ artistUrl, name, role, position }] — role is headliner | opener | guest, or
      // null when the origin served no roles.
      lineup: asArray(r.lineup) ?? [],
      artist_names: asArray<string>(r.artistNames) ?? [],
      // The RSVP state of the newest live attendance, and where it came from: 'tag' or
      // 'property' means the origin stated it, 'template' means it was read off the
      // generated opening sentence. null when nothing said.
      rsvp_status: r.rsvpStatus ?? null,
      status_source: r.rsvpSource ?? null,
      // Write-ups, newest first, duplicates collapsed. [] when none.
      reviews: asArray<string>(r.reviews) ?? [],
      photos: asArray(r.photos) ?? [],
      song_count: r.songCount,
      // When the attendance was posted — the paperwork, not the night.
      logged_at: toDate(r.loggedAt)?.toISOString() ?? null,
      fetched_at: (r.enrichedAt ?? r.fetchedAt)?.toISOString() ?? null,
      ...(input.include_unenriched
        ? { fetch_error: r.fetchError ?? null, fetch_attempts: r.fetchAttempts }
        : {}),
    })),
  }
}

// ---- get_gig_details: one gig in full --------------------------------------

export const getGigDetailsSchema = z.object({
  concert_url: z.string().optional().describe('The gig\'s canonical URL, exactly as get_gigs returns it'),
  title: z.string().optional().describe('Alternatively, a partial title match (case-insensitive). The most recent gig whose title matches wins.'),
  include_hidden: z.boolean().default(false).describe('Allow resolving a gig an admin has hidden'),
})

export async function getGigDetails(input: z.infer<typeof getGigDetailsSchema>) {
  if (!input.concert_url && !input.title) {
    return { error: 'Supply either concert_url or title' }
  }
  const db = getDb()

  const conditions: SQL[] = []
  if (!input.include_hidden) conditions.push(isNull(gigCatalog.hiddenAt))
  if (input.concert_url) conditions.push(eq(gigCatalog.concertUrl, input.concert_url))
  else if (input.title) conditions.push(sql`${gigCatalog.title} ILIKE ${'%' + input.title + '%'}`)

  const rows = await db
    .select({
      ...getTableColumns(gigCatalog),
      rsvpStatus: rsvpStatusExpr,
      rsvpSource: rsvpSourceExpr,
      reviews: reviewsExpr,
      photos: photosExpr,
      loggedAt: loggedAtExpr,
    })
    .from(gigCatalog)
    .where(and(...conditions))
    .orderBy(sql`gig_catalog.gig_date DESC NULLS LAST`)
    .limit(1)

  const gig = rows[0]
  if (!gig) {
    return { error: `No gig found for ${input.concert_url ?? input.title}` }
  }

  // The venue's full record, when it has been fetched. An origin that does not serve
  // venues as data leaves this null, and the denormalised name/city on the gig is all
  // there is — which is why those columns exist.
  const venue = gig.venueUrl
    ? (await db.select().from(gigVenues).where(eq(gigVenues.venueUrl, gig.venueUrl)).limit(1))[0] ?? null
    : null

  return {
    concert_url: gig.concertUrl,
    title: gig.title,
    gig_date: gig.gigDate,
    start_at: toDate(gig.startAt)?.toISOString() ?? null,
    doors_time: gig.doorsTime,
    concert_status: gig.concertStatus,
    tour_name: gig.tourName,
    festival_name: gig.festivalName,
    notes: gig.notes,
    venue: venue
      ? {
          url: venue.venueUrl,
          name: venue.name,
          aka: asArray<string>(venue.aka) ?? [],
          city: venue.city,
          country: venue.country,
          latitude: venue.latitude != null ? Number(venue.latitude) : null,
          longitude: venue.longitude != null ? Number(venue.longitude) : null,
          capacity: venue.capacity,
          timezone: venue.timezone,
          wikidata_qid: venue.wikidataQid,
          is_placeholder: venue.isPlaceholder,
        }
      : { url: gig.venueUrl, name: gig.venueName, city: gig.venueCity, country: gig.venueCountry },
    lineup: asArray(gig.lineup) ?? [],
    artist_names: asArray<string>(gig.artistNames) ?? [],
    // [{ id, artistUrl, entries: [{ position, setNumber, isEncore, songTitle, isCover,
    // coverOfArtist, note }] }]. [] when the origin serves no setlists.
    setlists: asArray(gig.setlists) ?? [],
    song_count: gig.songCount,
    rsvp_status: gig.rsvpStatus ?? null,
    status_source: gig.rsvpSource ?? null,
    reviews: asArray<string>(gig.reviews) ?? [],
    photos: asArray(gig.photos) ?? [],
    logged_at: toDate(gig.loggedAt)?.toISOString() ?? null,
    details: asObject(gig.details),
    // Which half of the origin each field came from: 'samklang-ap' or 'samklang-jsonld'.
    source_map: asObject(gig.sourceMap),
    enrichment: {
      fetched_at: gig.fetchedAt?.toISOString() ?? null,
      enriched_at: gig.enrichedAt?.toISOString() ?? null,
      fetch_error: gig.fetchError,
      fetch_attempts: gig.fetchAttempts,
    },
    hidden: gig.hiddenAt != null,
  }
}

// ---- get_gig_stats: the aggregate view -------------------------------------

export const getGigStatsSchema = z.object({
  status: z.enum(['interested', 'going', 'attended']).optional()
    .describe('Count only gigs with this RSVP state. Omit for every logged gig.'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Only gigs on or after this date (YYYY-MM-DD)'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Only gigs on or before this date (YYYY-MM-DD)'),
  year: z.number().int().min(1000).max(9999).optional().describe('Sugar for from/to spanning one calendar year'),
  top: z.number().int().min(1).max(50).default(10).describe('How many entries in each of the top-N breakdowns'),
  include_hidden: z.boolean().default(false).describe('Include gigs an admin has hidden'),
})

export async function getGigStats(input: z.infer<typeof getGigStatsSchema>) {
  const db = getDb()
  const conditions = buildConditions({
    status: input.status,
    from: input.from,
    to: input.to,
    year: input.year,
    include_hidden: input.include_hidden,
  })
  const where = and(...conditions)!

  const [totals] = await db
    .select({
      gigs: count(),
      firstGig: sql<string | null>`min(${gigCatalog.gigDate})`,
      lastGig: sql<string | null>`max(${gigCatalog.gigDate})`,
      venues: sql<number>`count(DISTINCT ${gigCatalog.venueUrl})`,
      cities: sql<number>`count(DISTINCT ${gigCatalog.venueCity})`,
      countries: sql<number>`count(DISTINCT ${gigCatalog.venueCountry})`,
      songs: sql<number>`coalesce(sum(${gigCatalog.songCount}), 0)`,
      withSetlist: sql<number>`count(*) FILTER (WHERE coalesce(${gigCatalog.songCount}, 0) > 0)`,
      // `gig_catalog.concert_url` written out by hand, not interpolated: this is a
      // select-list expression, where drizzle renders a bare column name that would bind
      // to `gig_attendances.concert_url` inside the subquery and make every row match.
      withReview: sql<number>`count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM gig_attendances a
        WHERE a.concert_url = gig_catalog.concert_url AND a.deleted_at IS NULL
          AND coalesce(a.review, '') <> ''
      ))`,
    })
    .from(gigCatalog)
    .where(where)

  // The breakdowns unnest a jsonb array per row, which Drizzle's select builder cannot
  // express as a lateral join, so they go through one raw statement each. The filter
  // conditions are reused verbatim so a breakdown can never disagree with the totals.
  const perYear = await db.execute<{ year: string; gigs: number }>(sql`
    SELECT to_char(gig_catalog.gig_date, 'YYYY') AS year, count(*)::int AS gigs
    FROM gig_catalog
    WHERE ${where} AND gig_catalog.gig_date IS NOT NULL
    GROUP BY 1 ORDER BY 1 DESC
  `)

  const topArtists = await db.execute<{ name: string; gigs: number }>(sql`
    SELECT n.name AS name, count(*)::int AS gigs
    FROM gig_catalog, jsonb_array_elements_text(gig_catalog.artist_names) AS n(name)
    WHERE ${where} AND jsonb_typeof(gig_catalog.artist_names) = 'array'
    GROUP BY 1 ORDER BY gigs DESC, name ASC LIMIT ${input.top}
  `)

  const topVenues = await db.execute<{ name: string; city: string | null; gigs: number }>(sql`
    SELECT gig_catalog.venue_name AS name, gig_catalog.venue_city AS city, count(*)::int AS gigs
    FROM gig_catalog
    WHERE ${where} AND gig_catalog.venue_name IS NOT NULL
    GROUP BY 1, 2 ORDER BY gigs DESC, name ASC LIMIT ${input.top}
  `)

  const topCities = await db.execute<{ city: string; gigs: number }>(sql`
    SELECT gig_catalog.venue_city AS city, count(*)::int AS gigs
    FROM gig_catalog
    WHERE ${where} AND gig_catalog.venue_city IS NOT NULL
    GROUP BY 1 ORDER BY gigs DESC, city ASC LIMIT ${input.top}
  `)

  const topSongs = await db.execute<{ song: string; plays: number }>(sql`
    SELECT e.entry->>'songTitle' AS song, count(*)::int AS plays
    FROM gig_catalog,
         jsonb_array_elements(gig_catalog.setlists) AS s(setlist),
         jsonb_array_elements(s.setlist->'entries') AS e(entry)
    WHERE ${where}
      AND jsonb_typeof(gig_catalog.setlists) = 'array'
      AND jsonb_typeof(s.setlist->'entries') = 'array'
      AND coalesce(e.entry->>'songTitle', '') <> ''
    GROUP BY 1 ORDER BY plays DESC, song ASC LIMIT ${input.top}
  `)

  const byStatus = await db.execute<{ status: string | null; gigs: number }>(sql`
    SELECT (
      SELECT a.status FROM gig_attendances a
      WHERE a.concert_url = gig_catalog.concert_url AND a.deleted_at IS NULL AND a.status IS NOT NULL
      ORDER BY a.published_at DESC NULLS LAST LIMIT 1
    ) AS status, count(*)::int AS gigs
    FROM gig_catalog
    WHERE ${where}
    GROUP BY 1 ORDER BY gigs DESC
  `)

  const distinctArtists = await db.execute<{ artists: number }>(sql`
    SELECT count(DISTINCT n.name)::int AS artists
    FROM gig_catalog, jsonb_array_elements_text(gig_catalog.artist_names) AS n(name)
    WHERE ${where} AND jsonb_typeof(gig_catalog.artist_names) = 'array'
  `)

  const rows = <T>(result: unknown): T[] =>
    Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? [])

  return {
    filters: {
      status: input.status ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      year: input.year ?? null,
      include_hidden: input.include_hidden,
    },
    totals: {
      gigs: totals?.gigs ?? 0,
      // Distinct artist names across every line-up in range. A name, not an identity:
      // two artists who share a name count once, which is the same trade every other
      // name-keyed total here makes.
      artists: rows<{ artists: number }>(distinctArtists)[0]?.artists ?? 0,
      venues: Number(totals?.venues ?? 0),
      cities: Number(totals?.cities ?? 0),
      countries: Number(totals?.countries ?? 0),
      songs_played: Number(totals?.songs ?? 0),
      gigs_with_setlist: Number(totals?.withSetlist ?? 0),
      gigs_with_review: Number(totals?.withReview ?? 0),
      first_gig: totals?.firstGig ?? null,
      last_gig: totals?.lastGig ?? null,
    },
    by_status: rows<{ status: string | null; gigs: number }>(byStatus),
    by_year: rows<{ year: string; gigs: number }>(perYear),
    top_artists: rows<{ name: string; gigs: number }>(topArtists),
    top_venues: rows<{ name: string; city: string | null; gigs: number }>(topVenues),
    top_cities: rows<{ city: string; gigs: number }>(topCities),
    // Only ever as complete as the setlists are: a gig with no setlist contributes
    // nothing here, so this is "songs I have a record of", not "songs I heard".
    top_songs: rows<{ song: string; plays: number }>(topSongs),
  }
}
