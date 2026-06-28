import { z } from 'zod'
import { sql, type SQL } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { config } from '../../config.js'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'

/**
 * Hashtag analytics over the stored `objects.tags`. Every ingested post keeps its
 * raw ActivityPub `tag` array as JSONB; a hashtag looks like
 * `{ "type": "Hashtag", "name": "#bookwyrm", "href": "..." }`. These tools unnest
 * that array (matching `lower(type) = 'hashtag'`, so Mentions/Editions are ignored)
 * and aggregate it — no schema change or re-ingest needed.
 */

/** Lowercase, strip a single leading `#`, and trim. Pure so it can be unit-tested. */
export function normalizeHashtag(name: string): string {
  return name.trim().replace(/^#/, '').trim().toLowerCase()
}

/** Resolve the actor a request is scoped to. Mirrors `activity-stats.ts`:
 *  an explicit `actor_handle` wins (URL or @user@domain); otherwise fall back to
 *  the configured OWNER_ACTOR; otherwise null = aggregate across all stored posts. */
async function resolveScopeActor(
  actorHandle: string | undefined,
): Promise<{ actorApId: string | null } | { error: string }> {
  const handle = actorHandle ?? (config.OWNER_ACTOR || undefined)
  if (!handle) return { actorApId: null }
  if (handle.startsWith('http')) return { actorApId: handle }
  const actor = await resolveActorByHandle(handle)
  if (!actor) return { error: `Could not resolve actor: ${handle}` }
  return { actorApId: actor.apId }
}

/** Shared `objects` predicates (soft-delete, actor scope, time window) as a SQL
 *  fragment, with an optional post-level "contains this hashtag" filter. `o` is the
 *  expected alias for the `objects` table. */
function buildWhere(
  actorApId: string | null,
  input: { from?: string; to?: string; since?: string },
  tag?: string,
): SQL {
  const conds: SQL[] = [sql`o.deleted_at IS NULL`]
  if (actorApId) conds.push(sql`o.actor_ap_id = ${actorApId}`)
  if (input.from) conds.push(sql`o.published_at >= ${new Date(input.from)}`)
  if (input.to) conds.push(sql`o.published_at <= ${new Date(input.to)}`)
  if (input.since) conds.push(sql`o.published_at > ${new Date(input.since)}`)
  if (tag) {
    conds.push(sql`EXISTS (
      SELECT 1 FROM jsonb_array_elements(o.tags) AS t2
      WHERE lower(t2->>'type') = 'hashtag'
        AND lower(ltrim(t2->>'name', '#')) = ${tag}
    )`)
  }
  return sql.join(conds, sql` AND `)
}

const num = (v: unknown): number => Number(v ?? 0)
const iso = (v: unknown): string | null =>
  v == null ? null : new Date(v as string).toISOString()

// ── get_hashtag_stats ────────────────────────────────────────────────────────

export const getHashtagStatsSchema = z.object({
  actor_handle: z.string().optional(),
  tag: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  since: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(30),
})

export async function getHashtagStats(input: z.infer<typeof getHashtagStatsSchema>) {
  const scope = await resolveScopeActor(input.actor_handle)
  if ('error' in scope) return scope

  const db = getDb()
  const tag = input.tag ? normalizeHashtag(input.tag) : undefined
  const where = buildWhere(scope.actorApId, input, tag)

  // Unnested hashtag rows feed top_hashtags and the running totals.
  const hashtagRows = sql`
    SELECT lower(ltrim(tag->>'name', '#')) AS name, o.published_at AS published_at
    FROM objects o, jsonb_array_elements(o.tags) AS tag
    WHERE jsonb_typeof(o.tags) = 'array'
      AND lower(tag->>'type') = 'hashtag'
      AND ltrim(tag->>'name', '#') <> ''
      AND ${where}
  `

  const topRows = [...await db.execute<{
    tag: string; count: string | number; first_used: string; last_used: string
  }>(sql`
    SELECT name AS tag, count(*) AS count,
           min(published_at) AS first_used, max(published_at) AS last_used
    FROM (${hashtagRows}) h
    GROUP BY name
    ORDER BY count(*) DESC, name ASC
    LIMIT ${input.limit}
  `)]

  const totalsRow = [...await db.execute<{ total_uses: string; distinct_tags: string }>(sql`
    SELECT count(*) AS total_uses, count(DISTINCT name) AS distinct_tags
    FROM (${hashtagRows}) h
  `)][0]

  const ratioRow = [...await db.execute<{ posts_total: string; posts_with_hashtags: string }>(sql`
    SELECT count(*) AS posts_total,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM jsonb_array_elements(o.tags) AS tag
             WHERE jsonb_typeof(o.tags) = 'array'
               AND lower(tag->>'type') = 'hashtag'
               AND ltrim(tag->>'name', '#') <> ''
           )) AS posts_with_hashtags
    FROM objects o
    WHERE ${where}
  `)][0]

  // Co-occurrence: distinct (post, hashtag) pairs self-joined within a post.
  const cooccurRows = [...await db.execute<{ tag_a: string; tag_b: string; count: string }>(sql`
    WITH post_tags AS (
      SELECT DISTINCT o.id AS oid, lower(ltrim(tag->>'name', '#')) AS name
      FROM objects o, jsonb_array_elements(o.tags) AS tag
      WHERE jsonb_typeof(o.tags) = 'array'
        AND lower(tag->>'type') = 'hashtag'
        AND ltrim(tag->>'name', '#') <> ''
        AND ${where}
    )
    SELECT a.name AS tag_a, b.name AS tag_b, count(*) AS count
    FROM post_tags a JOIN post_tags b ON a.oid = b.oid AND a.name < b.name
    GROUP BY a.name, b.name
    ORDER BY count(*) DESC, a.name, b.name
    LIMIT ${input.limit}
  `)]

  const totalUses = num(totalsRow?.total_uses)
  const postsTotal = num(ratioRow?.posts_total)
  const postsWithHashtags = num(ratioRow?.posts_with_hashtags)

  return {
    scope: {
      actor: scope.actorApId,
      tag: tag ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      since: input.since ?? null,
    },
    total_hashtag_uses: totalUses,
    distinct_hashtags: num(totalsRow?.distinct_tags),
    posts_total: postsTotal,
    posts_with_hashtags: postsWithHashtags,
    posts_with_hashtags_pct:
      postsTotal > 0 ? Math.round((postsWithHashtags / postsTotal) * 1000) / 10 : 0,
    avg_hashtags_per_post:
      postsWithHashtags > 0 ? Math.round((totalUses / postsWithHashtags) * 100) / 100 : 0,
    top_hashtags: topRows.map((r) => ({
      tag: r.tag,
      count: num(r.count),
      first_used: iso(r.first_used),
      last_used: iso(r.last_used),
    })),
    top_cooccurring_pairs: cooccurRows.map((r) => ({
      tag_a: r.tag_a,
      tag_b: r.tag_b,
      count: num(r.count),
    })),
  }
}

// ── get_hashtag_trends ───────────────────────────────────────────────────────

export const getHashtagTrendsSchema = z.object({
  actor_handle: z.string().optional(),
  tag: z.string().optional(),
  group_by: z.enum(['week', 'month', 'year']).default('month'),
  from: z.string().optional(),
  to: z.string().optional(),
  since: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(120),
})

export async function getHashtagTrends(input: z.infer<typeof getHashtagTrendsSchema>) {
  const scope = await resolveScopeActor(input.actor_handle)
  if ('error' in scope) return scope

  const db = getDb()
  const tag = input.tag ? normalizeHashtag(input.tag) : undefined
  const where = buildWhere(scope.actorApId, input)
  const nameFilter = tag
    ? sql`AND lower(ltrim(tag->>'name', '#')) = ${tag}`
    : sql``

  // Newest periods first; reversed below so the series reads oldest → newest.
  const rows = [...await db.execute<{
    period: string; uses: string; distinct_tags: string
  }>(sql`
    SELECT to_char(date_trunc(${input.group_by}, o.published_at), 'YYYY-MM-DD') AS period,
           count(*) AS uses,
           count(DISTINCT lower(ltrim(tag->>'name', '#'))) AS distinct_tags
    FROM objects o, jsonb_array_elements(o.tags) AS tag
    WHERE jsonb_typeof(o.tags) = 'array'
      AND lower(tag->>'type') = 'hashtag'
      AND ltrim(tag->>'name', '#') <> ''
      AND o.published_at IS NOT NULL
      ${nameFilter}
      AND ${where}
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT ${input.limit}
  `)]

  const series = rows
    .reverse()
    .map((r) =>
      tag
        ? { period: r.period, count: num(r.uses) }
        : { period: r.period, uses: num(r.uses), distinct_hashtags: num(r.distinct_tags) },
    )

  return {
    scope: {
      actor: scope.actorApId,
      tag: tag ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      since: input.since ?? null,
    },
    group_by: input.group_by,
    series,
  }
}
