import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { catalogMetadata } from '../../db/schema.js'
import { and, eq, ilike, count, sql, type SQL } from 'drizzle-orm'
import { encodeCursor, decodeCursor, keysetCondition, keysetOrderBy } from './pagination.js'

// ---- shared filter handling ------------------------------------------------

function buildConditions(input: {
  title?: string
  category?: string
  item_type?: string
  genre?: string
  imdb?: string
}): SQL[] {
  const conditions: SQL[] = []
  if (input.title) conditions.push(ilike(catalogMetadata.title, `%${input.title}%`))
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
  return conditions
}

function asArray(v: unknown): string[] | null {
  return Array.isArray(v) ? (v as string[]) : null
}

// ---- get_watched: paginated catalogue of cached NeoDB film/TV metadata -------

export const getWatchedSchema = z.object({
  title: z.string().optional().describe('Filter by title (case-insensitive, partial match)'),
  category: z.string().optional().describe('Filter by exact NeoDB category: "tv" or "movie"'),
  item_type: z.string().optional().describe('Filter by exact AP object type: "Movie", "TVShow", "TVSeason", or "TVEpisode"'),
  genre: z.string().optional().describe('Filter by genre (case-insensitive partial match against any of the title\'s genres)'),
  imdb: z.string().optional().describe('Filter by exact IMDb id, e.g. "tt27579939"'),
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
    },
    titles: rows.map((r) => ({
      item_url: r.itemUrl,
      category: r.category,
      item_type: r.itemType,
      title: r.title,
      display_title: r.displayTitle,
      orig_title: r.origTitle,
      year: r.year,
      season_number: r.seasonNumber,
      episode_count: r.episodeCount,
      imdb: r.imdb,
      imdb_url: r.imdbUrl,
      tmdb_url: r.tmdbUrl,
      cover_url: r.coverUrl,
      description: r.description,
      genre: asArray(r.genre),
      director: asArray(r.director),
      actors: asArray(r.actors),
      language: asArray(r.language),
      area: asArray(r.area),
      rating: r.rating != null ? Number(r.rating) : null,
      external_resources: r.externalResources ?? null,
      fetched_at: r.fetchedAt?.toISOString() ?? null,
    })),
  }
}
