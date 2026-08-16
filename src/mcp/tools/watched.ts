import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { catalogMetadata } from '../../db/schema.js'
import { and, eq, isNotNull, count, desc, getTableColumns, sql, type SQL } from 'drizzle-orm'
import { encodeCursor, decodeCursor, keysetCondition, keysetOrderBy } from './pagination.js'
import { visibleCatalog } from '../../lib/hidden.js'

// ---- shared helpers --------------------------------------------------------

// Case-insensitive, partial title match across the enriched `title` and the retained
// mark-supplied aliases (`mark_titles`). NeoDB overwrites the title with the localized
// name (e.g. "Konflikt"), so the name a mark actually federated with (e.g. "Conflict")
// only lives in mark_titles — either must find the row. The jsonb-array arm mirrors the
// genre filter below.
function titleMatch(title: string): SQL {
  const pat = `%${title}%`
  return sql`(
    ${catalogMetadata.title} ILIKE ${pat}
    OR (
      jsonb_typeof(${catalogMetadata.markTitles}) = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${catalogMetadata.markTitles}) AS mt(name)
        WHERE mt.name ILIKE ${pat}
      )
    )
  )`
}

/**
 * The comments the mark(s) for one catalogue item carry, newest mark first, duplicates
 * collapsed, tombstoned marks excluded. Plural like `mark_titles`, and for the same
 * reason: an item can be marked more than once — re-marked over time, or marked by more
 * than one actor — and each mark carries its own note. `[]` when none.
 *
 * Read live off `neodb_marks` rather than materialised onto the catalogue row: unlike the
 * NeoDB-supplied title (which enrichment overwrites, hence the retained aliases), the
 * comment only ever comes from the mark, so there is nothing to retain it against.
 *
 * The correlation is written table-qualified by hand, not interpolated. Drizzle renders a
 * bare column reference **unqualified** inside a select-list expression (it qualifies only
 * in WHERE), and an unqualified `item_url` in here binds to `neodb_marks`' own column — a
 * silent always-true self-comparison that hands every row every comment in the table.
 */
export const markCommentsExpr = sql<string[]>`(
  SELECT coalesce(jsonb_agg(c.comment ORDER BY c.published_at DESC NULLS LAST), '[]'::jsonb)
  FROM (
    SELECT DISTINCT ON (m.comment) m.comment, m.published_at
    FROM neodb_marks m
    WHERE m.item_url = catalog_metadata.item_url
      AND m.deleted_at IS NULL
      AND coalesce(m.comment, '') <> ''
    ORDER BY m.comment, m.published_at DESC NULLS LAST
  ) c
)`

/**
 * The status(es) the item's live mark(s) carry — wishlist | progress | complete |
 * dropped, plus whatever verb NeoDB sent verbatim for anything outside that set.
 * Plural for the same reason `mark_titles` / `mark_comments` / `watched_dates` are:
 * an item can be marked more than once, and a re-mark is exactly how "progress"
 * becomes "complete". Newest mark first, so `statuses[0]` is the current state.
 *
 * ADR 0008 deliberately left this unserved, to avoid changing get_watched's
 * established shape. That call is reversed here, and only additively: two new
 * fields, no field removed and no default filter added.
 *
 * Correlated **table-qualified by hand** — see `markCommentsExpr` above for why an
 * unqualified `item_url` in here is a silent always-true self-comparison.
 */
export const markStatusesExpr = sql<string[]>`(
  SELECT coalesce(jsonb_agg(m.status ORDER BY m.published_at DESC NULLS LAST), '[]'::jsonb)
  FROM neodb_marks m
  WHERE m.item_url = catalog_metadata.item_url
    AND m.deleted_at IS NULL AND m.status IS NOT NULL
)`

/** The newest live mark's canonical status — the item's current shelf state. */
export const latestMarkStatusExpr = sql<string | null>`(
  SELECT m.status FROM neodb_marks m
  WHERE m.item_url = catalog_metadata.item_url
    AND m.deleted_at IS NULL AND m.status IS NOT NULL
  ORDER BY m.published_at DESC NULLS LAST LIMIT 1
)`

/** The same mark's verb exactly as NeoDB sent it. */
export const latestMarkStatusRawExpr = sql<string | null>`(
  SELECT m.status_raw FROM neodb_marks m
  WHERE m.item_url = catalog_metadata.item_url
    AND m.deleted_at IS NULL AND m.status IS NOT NULL
  ORDER BY m.published_at DESC NULLS LAST LIMIT 1
)`

/**
 * Items whose NEWEST live mark carries this status.
 *
 * Positive, so an item we track no mark for does not match. That makes this the
 * wrong filter for "everything I finished" — see `markStatusExcluded` for why.
 */
export function markStatusMatch(status: string): SQL {
  return sql`(
    SELECT m.status FROM neodb_marks m
    WHERE m.item_url = ${catalogMetadata.itemUrl}
      AND m.deleted_at IS NULL AND m.status IS NOT NULL
    ORDER BY m.published_at DESC NULLS LAST LIMIT 1
  ) = ${status}`
}

/**
 * Drop items whose newest live mark carries one of these statuses. Items with no
 * tracked mark are KEPT.
 *
 * The asymmetry with `status` is deliberate and load-bearing. The tombstone clause
 * in buildConditions already documents that items enriched before the mark store
 * existed are grandfathered in — so **absence of a mark is not information here**,
 * unlike BookWyrm shelf membership, which is rebuilt whole on every pass. A caller
 * wanting "only what I actually finished" must therefore subtract what is positively
 * known to be unfinished rather than select what is positively known to be finished:
 * the first costs a dropped film staying in the list, the second would silently
 * discard every grandfathered title at once.
 *
 * `NOT IN ${statuses}` and NOT `<> ALL (${statuses})`. Drizzle renders an embedded
 * JS array as an already-parenthesised placeholder list — `($1, $2)` — which is
 * exactly the shape `IN` wants and NOT the shape `ALL` wants. `ALL` needs an array
 * expression, so wrapping the list in the parens it needs yields `ALL (($1, $2))`,
 * a row constructor, and Postgres rejects the statement outright. It cost a 500 on
 * every /api/v1/watched call carrying the filter; the test below pins the rendering.
 */
export function markStatusExcluded(statuses: string[]): SQL {
  return sql`coalesce((
    SELECT m.status FROM neodb_marks m
    WHERE m.item_url = ${catalogMetadata.itemUrl}
      AND m.deleted_at IS NULL AND m.status IS NOT NULL
    ORDER BY m.published_at DESC NULLS LAST LIMIT 1
  ), '') NOT IN ${statuses}`
}

// Case-insensitive substring match against any live mark comment on the item. Substring
// only — the text is free prose, deliberately never parsed into categories.
function markCommentMatch(needle: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM neodb_marks m
    WHERE m.item_url = ${catalogMetadata.itemUrl}
      AND m.deleted_at IS NULL
      AND m.comment ILIKE ${'%' + needle + '%'}
  )`
}

/**
 * Every distinct shelf date the item's live mark(s) carry — when it was watched, read,
 * played or listened to — newest first, `[]` when none. Plural for the same reason
 * `mark_titles` and `mark_comments` are: one item can be marked more than once (re-watched
 * years later, or marked by a second actor), and each mark carries its own date.
 *
 * Rendered as ISO-8601 UTC strings so the shape matches every other timestamp the tools
 * return. Read live off `neodb_marks` and correlated **table-qualified by hand** — see
 * `markCommentsExpr` above for why an unqualified `item_url` in here is a silent bug.
 */
export const markWatchedDatesExpr = sql<string[]>`(
  SELECT coalesce(
    jsonb_agg(
      to_char(w.watched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ORDER BY w.watched_at DESC
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT DISTINCT m.watched_at
    FROM neodb_marks m
    WHERE m.item_url = catalog_metadata.item_url
      AND m.deleted_at IS NULL
      AND m.watched_at IS NOT NULL
  ) w
)`

/**
 * The single shelf date for the item: the newest of the above, null when unknown. This is
 * the scalar `watched_at` the row reports, and the key `sort_by: 'watched_at'` orders on —
 * an array can't be a sort key, and for a re-watched item the latest viewing is the one a
 * "most recently watched first" listing means.
 *
 * Correlated table-qualified by hand for the same reason as above; it is used in the
 * select list, the ORDER BY and the keyset condition, so one spelling has to serve all three.
 */
export const latestWatchedAtExpr = sql<Date | null>`(
  SELECT max(m.watched_at)
  FROM neodb_marks m
  WHERE m.item_url = catalog_metadata.item_url
    AND m.deleted_at IS NULL
)`

/**
 * A `watched_from` / `watched_to` bound, parsed.
 *
 * A bare `YYYY-MM-DD` means the whole day, so it is anchored to UTC midnight and the upper
 * bound is pushed to the following midnight (exclusive) — otherwise `watched_to=2016-12-31`
 * would silently exclude everything actually marked on 31 December. A full timestamp is
 * taken at face value and compared inclusively.
 *
 * Comparison is on the stored instant, in UTC. Shelf dates arrive in two shapes — our
 * importer sends `T12:00:00+00:00` (safely mid-day, so the UTC day is the intended day)
 * and minreol's own date picker sends a local-midnight form like `22:00:00+00:53`. Both
 * land on the intended UTC day; a mark whose instant sits within an hour of midnight in
 * some other zone is the one case where a day-boundary query could disagree, which is why
 * the bound semantics are stated rather than guessed at.
 */
export interface WatchedBound { at: Date; bare: boolean }

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/

export function parseWatchedBound(value: string, edge: 'from' | 'to'): WatchedBound | null {
  const s = value.trim()
  if (!s) return null
  if (BARE_DATE.test(s)) {
    const at = new Date(`${s}T00:00:00.000Z`)
    if (Number.isNaN(at.getTime())) return null
    // The `to` edge covers the named day in full: shift to the next midnight, exclusive.
    if (edge === 'to') at.setUTCDate(at.getUTCDate() + 1)
    return { at, bare: true }
  }
  const at = new Date(s)
  return Number.isNaN(at.getTime()) ? null : { at, bare: false }
}

/**
 * Items with at least one live mark inside the window. Matched per-mark, not against the
 * item's latest date: a film seen in 2016 and again in 2020 belongs in both years' answers.
 */
export function watchedRangeMatch(from: WatchedBound | null, to: WatchedBound | null): SQL {
  const bounds: SQL[] = []
  if (from) bounds.push(sql`m.watched_at >= ${from.at.toISOString()}::timestamptz`)
  // A bare `to` date already points at the next midnight, so it is exclusive; an explicit
  // timestamp is the caller's own instant and stays inclusive.
  if (to) {
    bounds.push(to.bare
      ? sql`m.watched_at < ${to.at.toISOString()}::timestamptz`
      : sql`m.watched_at <= ${to.at.toISOString()}::timestamptz`)
  }
  return sql`EXISTS (
    SELECT 1 FROM neodb_marks m
    WHERE m.item_url = ${catalogMetadata.itemUrl}
      AND m.deleted_at IS NULL
      AND m.watched_at IS NOT NULL
      AND ${sql.join(bounds, sql` AND `)}
  )`
}

/**
 * The effective window for a request: `watched_year` is sugar for the two bounds, and an
 * explicit bound wins over the year on its own edge, so `watched_year=2016` with
 * `watched_from=2016-06-01` reads as "the second half of 2016".
 */
export function resolveWatchedWindow(input: {
  watched_from?: string
  watched_to?: string
  watched_year?: number
}): { from: WatchedBound | null; to: WatchedBound | null } {
  const year = input.watched_year
  const from = input.watched_from
    ? parseWatchedBound(input.watched_from, 'from')
    : year != null ? parseWatchedBound(`${year}-01-01`, 'from') : null
  const to = input.watched_to
    ? parseWatchedBound(input.watched_to, 'to')
    : year != null ? parseWatchedBound(`${year}-12-31`, 'to') : null
  return { from, to }
}

/** postgres.js hands back a Date for timestamptz, but be explicit — the cursor needs one. */
function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v === 'string') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

function buildConditions(input: {
  title?: string
  category?: string
  item_type?: string
  genre?: string
  imdb?: string
  mark_comment?: string
  status?: string
  exclude_status?: string[]
  watched_from?: string
  watched_to?: string
  watched_year?: number
  include_unenriched?: boolean
  include_hidden?: boolean
}): SQL[] {
  const conditions: SQL[] = []
  // Admin-hidden rows are out by default; `include_hidden` opts back in, exactly as
  // `include_unenriched` does below. See ADR 0013.
  if (!input.include_hidden) conditions.push(visibleCatalog())
  if (input.title) conditions.push(titleMatch(input.title))
  if (input.mark_comment) conditions.push(markCommentMatch(input.mark_comment))
  if (input.status) conditions.push(markStatusMatch(input.status))
  if (input.exclude_status?.length) conditions.push(markStatusExcluded(input.exclude_status))
  const window = resolveWatchedWindow(input)
  if (window.from || window.to) conditions.push(watchedRangeMatch(window.from, window.to))
  if (input.category) conditions.push(eq(catalogMetadata.category, input.category))
  if (input.item_type) conditions.push(eq(catalogMetadata.itemType, input.item_type))
  if (input.imdb) conditions.push(eq(catalogMetadata.imdb, input.imdb))
  if (input.genre) {
    // genre is a jsonb string[]; match any element, case-insensitive partial.
    conditions.push(sql`(
      jsonb_typeof(${catalogMetadata.genre}) = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(${catalogMetadata.genre}) AS g(genre)
        WHERE g.genre ILIKE ${'%' + input.genre + '%'}
      )
    )`)
  }
  // By default only rows that have enriched at least once are returned; never-enriched
  // stubs (pending or only-ever-failed) are hidden unless explicitly requested. A row
  // that enriched and later hit a transient refresh error stays visible (its data is
  // still good) — the error surfaces via get_catalogue_details / include_unenriched.
  if (!input.include_unenriched) {
    conditions.push(isNotNull(catalogMetadata.enrichedAt))
  }
  // Respect mark tombstones: once every mark for an item has been deleted, drop it from
  // get_watched (criterion 5). Items with a live mark stay; items we track no mark for
  // (enriched by a path that predates the mark store) are grandfathered in, so this never
  // hides a title that has no delete behind it.
  conditions.push(sql`(
    NOT EXISTS (SELECT 1 FROM neodb_marks m WHERE m.item_url = ${catalogMetadata.itemUrl})
    OR EXISTS (SELECT 1 FROM neodb_marks m WHERE m.item_url = ${catalogMetadata.itemUrl} AND m.deleted_at IS NULL)
  )`)
  return conditions
}

function asArray(v: unknown): string[] | null {
  return Array.isArray(v) ? (v as string[]) : null
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

// ---- get_watched: paginated catalogue of cached NeoDB metadata (all categories) --

export const getWatchedSchema = z.object({
  title: z.string().optional().describe('Filter by title (case-insensitive, partial match)'),
  category: z.string().optional().describe('Filter by exact NeoDB category: "tv", "movie", "book", "music", "game", "podcast", or "performance"'),
  item_type: z.string().optional().describe('Filter by exact AP object type: "Movie", "TVShow", "TVSeason", "TVEpisode", "Edition", "Album", "Game", "Podcast", or "Performance"'),
  genre: z.string().optional().describe('Filter by genre (case-insensitive partial match against any of the title\'s genres)'),
  imdb: z.string().optional().describe('Filter by exact IMDb id, e.g. "tt27579939" (film/TV only)'),
  mark_comment: z.string().optional()
    .describe('Filter by the comment the mark carried (case-insensitive substring, matched against any of the item\'s mark comments). Free text, e.g. "kino" finds everything marked "Sett på kino."'),
  status: z.enum(['wishlist', 'progress', 'complete', 'dropped']).optional()
    .describe('Only items whose NEWEST live mark carries this status. Positive, so it REQUIRES a tracked mark: an item enriched by a path predating the mark store has no status and is not returned. For "only what I actually finished", prefer exclude_status.'),
  exclude_status: z.array(z.string()).optional()
    .describe('Drop items whose newest live mark carries any of these statuses, e.g. ["dropped","progress"] for "only things I actually finished". Items with no tracked mark are KEPT — this removes only what is positively known, which is the safe direction given the mark store does not cover every enriched item.'),
  watched_from: z.string()
    .refine((v) => parseWatchedBound(v, 'from') != null, { message: 'watched_from must be YYYY-MM-DD or an ISO timestamp' })
    .optional()
    .describe('Only items with a mark watched/read/played on or after this date. "YYYY-MM-DD" (from that day\'s start, UTC) or a full ISO timestamp.'),
  watched_to: z.string()
    .refine((v) => parseWatchedBound(v, 'to') != null, { message: 'watched_to must be YYYY-MM-DD or an ISO timestamp' })
    .optional()
    .describe('Only items with a mark watched/read/played on or before this date. "YYYY-MM-DD" covers that whole day (UTC); a full ISO timestamp is compared inclusively.'),
  watched_year: z.number().int().min(1000).max(9999).optional()
    .describe('Sugar for watched_from/watched_to spanning one calendar year (UTC), e.g. 2016 for "everything I watched in 2016". An explicit watched_from/watched_to overrides it on that edge.'),
  include_unenriched: z.boolean().default(false)
    .describe('Include rows that have not been successfully enriched yet (pending or failed fetches, carrying fetch_error/fetch_attempts). Off by default.'),
  include_hidden: z.boolean().default(false)
    .describe('Include items an admin has hidden from the served catalogue. Off by default. Hidden items still exist and are still enriched; they are suppressed from listings, not deleted.'),
  sort_by: z.enum(['fetched_at', 'watched_at']).default('fetched_at')
    .describe('Which timestamp to order by. "fetched_at" (default) is enrichment time — for a backfilled import that is the order the import ran in, not a reading of history. "watched_at" orders by the item\'s newest shelf date; items with no date sort last in both directions.'),
  sort_order: z.enum(['asc', 'desc']).default('desc')
    .describe('Direction for sort_by. "desc" (default) is newest first; "asc" is oldest first.'),
  limit: z.number().int().min(1).max(200).default(50),
  page: z.number().int().min(1).default(1)
    .describe('Offset-based page (legacy). Ignored when "cursor" is supplied; prefer "cursor" for deep traversal.'),
  cursor: z.string().optional()
    .describe('Opaque pagination cursor from a previous response\'s next_cursor. When set, page/offset is ignored and traversal continues from where the last page ended (respecting sort_order and all filters).'),
})

export async function getWatched(input: z.infer<typeof getWatchedSchema>) {
  const db = getDb()
  const filterConditions = buildConditions(input)

  // total reflects the filters only (not the cursor), so it's a stable count of
  // every matching title regardless of which page we're on.
  const filterWhere = filterConditions.length ? and(...filterConditions) : undefined
  const [totals] = await db.select({ total: count() }).from(catalogMetadata).where(filterWhere)

  // Keyset pagination on (<sort key>, id); falls back to offset when no cursor. The sort
  // key is either the enrichment stamp or the item's newest shelf date — the latter is a
  // correlated subquery, hence the SQL-expression form of the keyset helpers.
  const sortKey = input.sort_by === 'watched_at' ? latestWatchedAtExpr : catalogMetadata.fetchedAt
  const conditions = [...filterConditions]
  if (input.cursor) {
    conditions.push(keysetCondition(sortKey, catalogMetadata.id, decodeCursor(input.cursor), input.sort_order))
  }

  const where = conditions.length ? and(...conditions) : undefined
  const orderBy = keysetOrderBy(sortKey, catalogMetadata.id, input.sort_order)

  const baseQuery = db
    .select({
      id: catalogMetadata.id,
      itemUrl: catalogMetadata.itemUrl,
      category: catalogMetadata.category,
      itemType: catalogMetadata.itemType,
      title: catalogMetadata.title,
      displayTitle: catalogMetadata.displayTitle,
      origTitle: catalogMetadata.origTitle,
      description: catalogMetadata.description,
      coverUrl: catalogMetadata.coverUrl,
      imdb: catalogMetadata.imdb,
      imdbUrl: catalogMetadata.imdbUrl,
      tmdbUrl: catalogMetadata.tmdbUrl,
      externalResources: catalogMetadata.externalResources,
      year: catalogMetadata.year,
      seasonNumber: catalogMetadata.seasonNumber,
      episodeCount: catalogMetadata.episodeCount,
      genre: catalogMetadata.genre,
      director: catalogMetadata.director,
      actors: catalogMetadata.actors,
      language: catalogMetadata.language,
      area: catalogMetadata.area,
      rating: catalogMetadata.rating,
      details: catalogMetadata.details,
      markTitles: catalogMetadata.markTitles,
      markComments: markCommentsExpr,
      watchedDates: markWatchedDatesExpr,
      markStatus: latestMarkStatusExpr,
      markStatusRaw: latestMarkStatusRawExpr,
      markStatuses: markStatusesExpr,
      latestWatchedAt: latestWatchedAtExpr,
      bookwyrmBookUrl: catalogMetadata.bookwyrmBookUrl,
      enrichedAt: catalogMetadata.enrichedAt,
      fetchError: catalogMetadata.fetchError,
      fetchAttempts: catalogMetadata.fetchAttempts,
      fetchedAt: catalogMetadata.fetchedAt,
    })
    .from(catalogMetadata)
    .where(where)
    .orderBy(orderBy)
    .limit(input.limit)

  // Cursor traversal is offset-free; only the legacy offset path applies page.
  const rows = input.cursor
    ? await baseQuery
    : await baseQuery.offset((input.page - 1) * input.limit)

  const last = rows[rows.length - 1]
  const lastSortValue = last
    ? (input.sort_by === 'watched_at' ? toDate(last.latestWatchedAt) : last.fetchedAt)
    : null
  const nextCursor = rows.length === input.limit && last
    ? encodeCursor(lastSortValue, last.id)
    : null

  const window = resolveWatchedWindow(input)

  return {
    count: rows.length,
    total: totals?.total ?? 0,
    page: input.cursor ? null : input.page,
    next_cursor: nextCursor,
    sort_by: input.sort_by,
    sort_order: input.sort_order,
    filters: {
      title: input.title ?? null,
      category: input.category ?? null,
      item_type: input.item_type ?? null,
      genre: input.genre ?? null,
      imdb: input.imdb ?? null,
      mark_comment: input.mark_comment ?? null,
      status: input.status ?? null,
      exclude_status: input.exclude_status ?? null,
      watched_from: input.watched_from ?? null,
      watched_to: input.watched_to ?? null,
      watched_year: input.watched_year ?? null,
      // The window the two/three inputs above actually resolved to, so a caller can see
      // that a bare `watched_to` date was taken as the whole day.
      watched_window: (window.from || window.to)
        ? { from: window.from?.at.toISOString() ?? null, to: window.to?.at.toISOString() ?? null, to_exclusive: window.to?.bare ?? false }
        : null,
      include_unenriched: input.include_unenriched,
    },
    titles: rows.map((r) => ({
      item_url: r.itemUrl,
      category: r.category,
      item_type: r.itemType,
      title: r.title,
      display_title: r.displayTitle,
      orig_title: r.origTitle,
      // Names the mark(s) federated with, retained through NeoDB's localized-title
      // overwrite; searched alongside `title`. [] when none.
      mark_titles: asArray(r.markTitles) ?? [],
      // The note(s) the mark(s) carried, verbatim and unparsed — newest mark first,
      // duplicates collapsed. [] when none.
      mark_comments: asArray(r.markComments) ?? [],
      // When this was watched / read / played / listened to, off the mark's shelf record
      // — NOT the post timestamp (see get_actor_posts for that). Scalar `watched_at` is
      // the newest of `watched_dates`, which lists every distinct date across the item's
      // live marks, newest first, following mark_titles/mark_comments. null / [] when the
      // mark carried no date.
      watched_at: toDate(r.latestWatchedAt)?.toISOString() ?? null,
      watched_dates: asArray(r.watchedDates) ?? [],
      status: r.markStatus ?? null,
      status_raw: r.markStatusRaw ?? null,
      statuses: asArray(r.markStatuses) ?? [],
      year: r.year,
      // Film/TV columns (null for other categories).
      season_number: r.seasonNumber,
      episode_count: r.episodeCount,
      imdb: r.imdb,
      imdb_url: r.imdbUrl,
      tmdb_url: r.tmdbUrl,
      director: asArray(r.director),
      actors: asArray(r.actors),
      // Common fields.
      cover_url: r.coverUrl,
      description: r.description,
      genre: asArray(r.genre),
      language: asArray(r.language),
      area: asArray(r.area),
      rating: r.rating != null ? Number(r.rating) : null,
      external_resources: r.externalResources ?? null,
      // Category-specific fields (author/isbn/pages, artist/release_date, developer/
      // platform, host/feed_url, playwright/venue, …) — {} for film/TV & unknown.
      details: asObject(r.details),
      // When this NeoDB book dedupes to a cached BookWyrm Edition.
      bookwyrm_book_url: r.bookwyrmBookUrl ?? null,
      fetched_at: (r.enrichedAt ?? r.fetchedAt)?.toISOString() ?? null,
      ...(input.include_unenriched
        ? { fetch_error: r.fetchError ?? null, fetch_attempts: r.fetchAttempts }
        : {}),
    })),
  }
}

// ---- get_catalogue_details: one item's full record incl. provenance ---------

export const getCatalogueDetailsSchema = z.object({
  item_url: z.string().optional().describe('NeoDB catalog URL (exact match, the primary key)'),
  title: z.string().optional().describe('Case-insensitive partial title match (most recently-enriched wins)'),
  category: z.string().optional().describe('Optional category filter to disambiguate a title match ("tv", "movie", "book", "music", "game", "podcast", "performance")'),
  include_hidden: z.boolean().default(false)
    .describe('Include an item an admin has hidden from the served catalogue. Off by default. Hidden items still exist and are still enriched; they are suppressed from listings, not deleted.'),
})

type CatalogueDetailsInput = z.infer<typeof getCatalogueDetailsSchema>

export async function getCatalogueDetails(input: CatalogueDetailsInput) {
  if (!input.item_url && !input.title) {
    return { error: 'Provide at least one of item_url or title' }
  }
  const db = getDb()

  const conditions: SQL[] = []
  // A hidden item must not stay reachable by exact URL just because the listing dropped it.
  if (!input.include_hidden) conditions.push(visibleCatalog())
  if (input.item_url) conditions.push(eq(catalogMetadata.itemUrl, input.item_url))
  if (input.title) conditions.push(titleMatch(input.title))
  if (input.category) conditions.push(eq(catalogMetadata.category, input.category))

  const rows = await db
    .select({
      ...getTableColumns(catalogMetadata),
      markComments: markCommentsExpr,
      watchedDates: markWatchedDatesExpr,
      markStatus: latestMarkStatusExpr,
      markStatusRaw: latestMarkStatusRawExpr,
      markStatuses: markStatusesExpr,
      latestWatchedAt: latestWatchedAtExpr,
    })
    .from(catalogMetadata)
    .where(and(...conditions))
    .orderBy(desc(catalogMetadata.enrichedAt), desc(catalogMetadata.fetchedAt))
    .limit(1)

  const r = rows[0]
  if (!r) return { error: 'No catalogue item found for the given query' }

  return {
    item_url: r.itemUrl,
    category: r.category,
    item_type: r.itemType,
    title: r.title,
    display_title: r.displayTitle,
    orig_title: r.origTitle,
    mark_titles: asArray(r.markTitles) ?? [],
    mark_comments: asArray(r.markComments) ?? [],
    // The shelf date(s) the mark(s) carried — when this was watched/read/played, not when
    // the mark was posted. `watched_at` is the newest of `watched_dates`.
    watched_at: toDate(r.latestWatchedAt)?.toISOString() ?? null,
    watched_dates: asArray(r.watchedDates) ?? [],
    status: r.markStatus ?? null,
    status_raw: r.markStatusRaw ?? null,
    statuses: asArray(r.markStatuses) ?? [],
    year: r.year,
    season_number: r.seasonNumber,
    episode_count: r.episodeCount,
    imdb: r.imdb,
    imdb_url: r.imdbUrl,
    tmdb_url: r.tmdbUrl,
    director: asArray(r.director),
    actors: asArray(r.actors),
    cover_url: r.coverUrl,
    description: r.description,
    genre: asArray(r.genre),
    language: asArray(r.language),
    area: asArray(r.area),
    rating: r.rating != null ? Number(r.rating) : null,
    external_resources: r.externalResources ?? null,
    details: asObject(r.details),
    bookwyrm_book_url: r.bookwyrmBookUrl ?? null,
    source_map: r.sourceMap ?? null,
    fetched_at: (r.enrichedAt ?? null)?.toISOString() ?? null,
    fetch_error: r.fetchError ?? null,
    fetch_attempts: r.fetchAttempts,
    last_attempt_at: r.lastAttemptAt?.toISOString() ?? null,
  }
}
