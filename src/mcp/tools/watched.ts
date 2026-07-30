import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { catalogMetadata } from '../../db/schema.js'
import { and, eq, isNotNull, count, desc, getTableColumns, sql, type SQL } from 'drizzle-orm'
import { encodeCursor, decodeCursor, keysetCondition, keysetOrderBy } from './pagination.js'

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

function buildConditions(input: {
  title?: string
  category?: string
  item_type?: string
  genre?: string
  imdb?: string
  mark_comment?: string
  include_unenriched?: boolean
}): SQL[] {
  const conditions: SQL[] = []
  if (input.title) conditions.push(titleMatch(input.title))
  if (input.mark_comment) conditions.push(markCommentMatch(input.mark_comment))
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
  include_unenriched: z.boolean().default(false)
    .describe('Include rows that have not been successfully enriched yet (pending or failed fetches, carrying fetch_error/fetch_attempts). Off by default.'),
  sort_order: z.enum(['asc', 'desc']).default('desc')
    .describe('Order by fetched_at. "desc" (default) is most-recently-enriched first; "asc" is oldest first.'),
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

  // Keyset pagination on (fetched_at, id); falls back to offset when no cursor.
  const conditions = [...filterConditions]
  if (input.cursor) {
    conditions.push(keysetCondition(catalogMetadata.fetchedAt, catalogMetadata.id, decodeCursor(input.cursor), input.sort_order))
  }

  const where = conditions.length ? and(...conditions) : undefined
  const orderBy = keysetOrderBy(catalogMetadata.fetchedAt, catalogMetadata.id, input.sort_order)

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
  const nextCursor = rows.length === input.limit && last
    ? encodeCursor(last.fetchedAt, last.id)
    : null

  return {
    count: rows.length,
    total: totals?.total ?? 0,
    page: input.cursor ? null : input.page,
    next_cursor: nextCursor,
    sort_order: input.sort_order,
    filters: {
      title: input.title ?? null,
      category: input.category ?? null,
      item_type: input.item_type ?? null,
      genre: input.genre ?? null,
      imdb: input.imdb ?? null,
      mark_comment: input.mark_comment ?? null,
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
})

type CatalogueDetailsInput = z.infer<typeof getCatalogueDetailsSchema>

export async function getCatalogueDetails(input: CatalogueDetailsInput) {
  if (!input.item_url && !input.title) {
    return { error: 'Provide at least one of item_url or title' }
  }
  const db = getDb()

  const conditions: SQL[] = []
  if (input.item_url) conditions.push(eq(catalogMetadata.itemUrl, input.item_url))
  if (input.title) conditions.push(titleMatch(input.title))
  if (input.category) conditions.push(eq(catalogMetadata.category, input.category))

  const rows = await db
    .select({ ...getTableColumns(catalogMetadata), markComments: markCommentsExpr })
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
