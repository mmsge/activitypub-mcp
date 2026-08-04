import { sql, type SQL } from 'drizzle-orm'
import { config } from '../config.js'
import { decodeCursor } from '../mcp/tools/pagination.js'
import { archiveRange, type Facets } from './facets.js'
import { lanesForPlatform, platformInfo, AP_PLATFORMS, type ApPlatform, type Lane } from './sources.js'
import { readingKindOn, meaningfulReadingOn } from './reading-events.js'
import { publicOnlyOn } from './visibility.js'

/**
 * The candidate query for each lane of the public stream.
 *
 * The stream is a merge of six unrelated tables ordered by one synthetic date. The
 * naive shape — union everything, then filter and sort at the top — does not work
 * here: the planner will not push a qualifier on a *derived grouping expression*
 * into the scrobble lane's GROUP BY, so every request would materialise the whole
 * 51k-row listening history before discarding all but twenty rows.
 *
 * So instead this is a k-way merge of sorted streams. Each lane carries the keyset
 * predicate and its own LIMIT, hits its own index, and returns at most n rows; the
 * union of at most 6n candidates is then sorted and cut to n. The correctness
 * argument is the standard one: a lane's n-th row bounds anything further that lane
 * could contribute to this page.
 *
 * Every lane emits the same four columns, and nothing else — the winners are
 * hydrated afterwards by kind. A wide union of forty nullable columns would be
 * slower and far easier to get wrong.
 *
 *   event_at  timestamptz  when it happened (never null — see event-date.ts)
 *   kind      text         which renderer, and which hydration query
 *   ref_id    text         "<prefix>:<id>", the tiebreaker and the hydration key
 *   source    text         the platform slug, for the entry's badge
 */

export interface LaneContext {
  facets: Facets
  /** Resolved AP ids of the allowlisted accounts, by platform. */
  actorIds: Record<ApPlatform, string[]>
  /** How many candidates each lane may return. */
  limit: number
}

/** The keyset predicate, in terms of the lane's own event_at/ref_id expressions. */
function keyset(facets: Facets, eventAt: SQL, refId: SQL): SQL | null {
  if (!facets.cursor) return null
  const c = decodeCursor(facets.cursor)
  // event_at is never null in any lane, so the null-tail branch the shared helper
  // carries for `objects.published_at` cannot arise here.
  if (c.p === null) return sql`${refId} COLLATE "C" < ${c.id}::text COLLATE "C"`
  return sql`(${eventAt} < ${c.p}::timestamptz
    OR (${eventAt} = ${c.p}::timestamptz AND ${refId} COLLATE "C" < ${c.id}::text COLLATE "C"))`
}

/**
 * Nothing that has not happened yet.
 *
 * The stream says what Markus has done, and it is ordered by event date — so a
 * future-dated row does not merely appear, it sorts to the very top and pushes real
 * activity off the front page. The viaduct.world import carries *planned* journeys
 * alongside completed ones, which is how this was found: three months of trips he
 * has not taken were leading the page.
 *
 * Applied to every lane rather than only to trips. Any source can hand us a future
 * date — a scheduled post, a mistyped frontmatter year, a mark shelved with
 * tomorrow's date — and in each case the answer is the same.
 */
function notFuture(eventAt: SQL): SQL {
  return sql`${eventAt} <= now()`
}

/** Archive bounds, applied to whatever the lane calls its date. */
function archiveBound(facets: Facets, eventAt: SQL): SQL | null {
  if (facets.year == null || facets.month == null) return null
  const { start, end } = archiveRange(facets.year, facets.month)
  return sql`(${eventAt} >= ${start.toISOString()}::timestamptz AND ${eventAt} < ${end.toISOString()}::timestamptz)`
}

/**
 * A lane's ORDER BY, written from the expressions rather than the output aliases.
 *
 * `ORDER BY ref_id` would be legal — a bare output-column name is allowed — but
 * `ORDER BY ref_id COLLATE "C"` is not: the moment the alias is wrapped in an
 * expression, Postgres resolves it against the *input* columns and fails with
 * `column "ref_id" does not exist`. The collation is not optional here (it is what
 * makes the tiebreaker byte-stable and match the keyset), so the expressions are
 * repeated instead.
 */
function laneOrder(eventAt: SQL, refId: SQL): SQL {
  return sql`ORDER BY ${eventAt} DESC, (${refId}) COLLATE "C" DESC`
}

function allOf(parts: Array<SQL | null | undefined>): SQL {
  const kept = parts.filter((p): p is SQL => p != null)
  if (kept.length === 0) return sql`true`
  return sql.join(kept, sql` AND `)
}

/** `ARRAY[…]::text[]`, for `= ANY(…)` against a list of actor ids. */
function idArray(ids: string[]): SQL {
  return sql`ARRAY[${sql.join(ids.map((x) => sql`${x}`), sql`, `)}]::text[]`
}

/** Every platform whose posts land in the `posts` lane. */
const POSTS_PLATFORMS = AP_PLATFORMS.filter((p) => platformInfo(p).lane === 'posts')

/**
 * The badge each post carries, taken from the *configured* platform rather than
 * from `actors.software`.
 *
 * The probed NodeInfo name is not ours to rely on: a server can report anything
 * (Markus' own reports "rullen"), and any value the view's platform registry does
 * not know would render as undefined and take the page down. STREAM_SOURCES is the
 * source of truth for which account is what, so the badge comes from there.
 */
function sourceOf(ctx: LaneContext): SQL {
  const present = POSTS_PLATFORMS.filter((p) => ctx.actorIds[p].length > 0)
  if (present.length === 0) return sql`'mastodon'`
  const whens = present.map(
    (p) => sql`WHEN o.actor_ap_id = ANY(${idArray(ctx.actorIds[p])}) THEN ${p}`,
  )
  return sql`CASE ${sql.join(whens, sql` `)} ELSE 'mastodon' END`
}

/** A hashtag predicate over the raw AP `tag` array. Only the lanes that have one. */
function tagCondition(tag: string): SQL {
  return sql`jsonb_typeof(o.tags) = 'array' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(o.tags) AS t
    WHERE lower(t->>'type') = 'hashtag' AND lower(ltrim(t->>'name', '#')) = ${tag}
  )`
}

/**
 * Posts from Mastodon, Pixelfed and Loops.
 *
 * Only thread *roots* become timeline entries: `in_reply_to IS NULL`, or a reply
 * whose parent is another publishable post by the same account. That second arm is
 * what keeps Markus' own threads — an ordinary reply to someone else stays out,
 * but the second post of his own thread is not orphaned from the first. The parts
 * are assembled at hydration time; the root is what is ordered and paged.
 */
export function postsLane(ctx: LaneContext): SQL | null {
  const { facets } = ctx
  const actors = POSTS_PLATFORMS.flatMap((p) => ctx.actorIds[p])
  if (actors.length === 0) return null

  const eventAt = sql`o.published_at`
  const refId = sql`('post:' || o.id::text)`
  const kind = sql`CASE
    WHEN jsonb_typeof(o.attachments) = 'array' AND jsonb_array_length(o.attachments) > 0
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(o.attachments) a
                  WHERE a->>'mediaType' LIKE 'video/%') THEN 'video'
    WHEN jsonb_typeof(o.attachments) = 'array' AND jsonb_array_length(o.attachments) > 0
      THEN 'photo'
    ELSE 'post' END`

  return sql`
    SELECT ${eventAt} AS event_at, ${kind} AS kind, ${refId} AS ref_id,
           ${sourceOf(ctx)} AS source
    FROM objects o
    WHERE ${allOf([
      sql`o.actor_ap_id = ANY(${idArray(actors)})`,
      sql`o.deleted_at IS NULL`,
      sql`o.published_at IS NOT NULL`,
      publicOnlyOn('o', config.STREAM_INCLUDE_UNLISTED),
      // Thread roots, plus Markus' own continuations of them.
      sql`(o.in_reply_to IS NULL OR EXISTS (
             SELECT 1 FROM objects p
             WHERE p.ap_id = o.in_reply_to
               AND p.actor_ap_id = o.actor_ap_id
               AND p.deleted_at IS NULL
               AND ${publicOnlyOn('p', config.STREAM_INCLUDE_UNLISTED)}))`,
      // Only the root is an entry; a continuation is folded into it at hydration.
      sql`o.in_reply_to IS NULL`,
      facets.tag ? tagCondition(facets.tag) : null,
      facets.kind ? sql`${kind} = ${facets.kind}` : null,
      notFuture(eventAt),
      archiveBound(facets, eventAt),
      keyset(facets, eventAt, refId),
    ])}
    ${laneOrder(eventAt, refId)}
    LIMIT ${ctx.limit}`
}

/**
 * BookWyrm reading events — started, finished, reviews and quotations. Ratings and
 * automatic progress notes are excluded by meaningfulReadingCondition.
 *
 * Started/finished are dated by the reader's own recorded dates where BookWyrm
 * carried them, so a book finished in June but posted in August sits in June.
 */
export function readingLane(ctx: LaneContext): SQL | null {
  const { facets } = ctx
  const actors = ctx.actorIds.bookwyrm
  if (actors.length === 0) return null

  const eventAt = sql`coalesce(
    CASE WHEN o.ap_id LIKE '%/generatednote/%' AND o.content_text LIKE '%started reading%'
         THEN (o.raw->>'startedDate')::timestamptz END,
    CASE WHEN o.ap_id LIKE '%/generatednote/%' AND o.content_text LIKE '%finished reading%'
         THEN (o.raw->>'finishedDate')::timestamptz END,
    o.published_at)`
  const refId = sql`('book:' || o.id::text)`
  const kind = sql`CASE
    WHEN o.ap_id LIKE '%/review/%' THEN 'book_review'
    WHEN o.ap_id LIKE '%/quotation/%' THEN 'book_quote'
    WHEN o.content_text LIKE '%started reading%' THEN 'book_started'
    ELSE 'book_finished' END`

  return sql`
    SELECT ${eventAt} AS event_at, ${kind} AS kind, ${refId} AS ref_id, 'bookwyrm' AS source
    FROM objects o
    WHERE ${allOf([
      sql`o.actor_ap_id = ANY(${idArray(actors)})`,
      sql`o.deleted_at IS NULL`,
      publicOnlyOn('o', config.STREAM_INCLUDE_UNLISTED),
      // A BookWyrm review carries the book in `inReplyToBook`, not `inReplyTo`, so
      // it is not a reply. A genuine reply to someone else's review is.
      sql`o.in_reply_to IS NULL`,
      meaningfulReadingOn('o'),
      sql`${eventAt} IS NOT NULL`,
      facets.tag ? tagCondition(facets.tag) : null,
      facets.kind ? readingKindOn('o', facets.kind) ?? sql`false` : null,
      notFuture(eventAt),
      archiveBound(facets, eventAt),
      keyset(facets, eventAt, refId),
    ])}
    ${laneOrder(eventAt, refId)}
    LIMIT ${ctx.limit}`
}

/**
 * NeoDB marks — films, series, music, games.
 *
 * The join onto `objects` is INNER and not negotiable: a mark's visibility lives on
 * the Note it federated with, so a mark whose Note we do not hold is a mark we
 * cannot prove was public. Degrading this to a LEFT JOIN would publish it anyway.
 *
 * Wishlist marks are excluded — "I want to watch this" is intent, not activity.
 */
export function marksLane(ctx: LaneContext): SQL | null {
  const { facets } = ctx
  const actors = ctx.actorIds.neodb
  if (actors.length === 0) return null

  const eventAt = sql`coalesce(m.watched_at, m.published_at)`
  const refId = sql`('mark:' || m.id::text)`
  const kind = sql`CASE
    WHEN m.category IN ('movie', 'tv') THEN 'screen'
    WHEN m.category = 'music' THEN 'listen'
    WHEN m.category = 'game' THEN 'play'
    WHEN m.category = 'book' THEN 'read_neodb'
    ELSE 'mark' END`

  return sql`
    SELECT ${eventAt} AS event_at, ${kind} AS kind, ${refId} AS ref_id, 'neodb' AS source
    FROM neodb_marks m
    JOIN objects o ON o.ap_id = m.mark_ap_id
    LEFT JOIN catalog_metadata cm ON cm.item_url = m.item_url
    WHERE ${allOf([
      sql`m.actor_ap_id = ANY(${idArray(actors)})`,
      sql`m.deleted_at IS NULL`,
      sql`o.deleted_at IS NULL`,
      publicOnlyOn('o', config.STREAM_INCLUDE_UNLISTED),
      sql`cm.hidden_at IS NULL`, // ADR 0013
      sql`m.status IS DISTINCT FROM 'wishlist'`,
      sql`coalesce(m.watched_at, m.published_at) IS NOT NULL`,
      facets.kind ? sql`${kind} = ${facets.kind}` : null,
      notFuture(eventAt),
      archiveBound(facets, eventAt),
      keyset(facets, eventAt, refId),
    ])}
    ${laneOrder(eventAt, refId)}
    LIMIT ${ctx.limit}`
}

/**
 * One digest per day of listening, in Markus' own timezone.
 *
 * Bounded by STREAM_SCROBBLE_CUTOFF_MONTHS: 51k scrobbles since 2016 is more daily
 * digests than he has posts, and without a cutoff the deep archive reads as a
 * listening log with the occasional thought in it. Older listening lives on its
 * own page.
 *
 * The extra upper bound on `played_at` is not redundant with the keyset — it is
 * what lets the GROUP BY read an index range instead of the whole table.
 */
export function musicLane(ctx: LaneContext): SQL | null {
  const { facets } = ctx
  if (facets.tag) return null // scrobbles carry no hashtags
  if (facets.kind && facets.kind !== 'scrobble_day') return null

  const day = sql`date_trunc('day', s.played_at AT TIME ZONE 'Europe/Oslo') AT TIME ZONE 'Europe/Oslo'`
  const refId = sql`('scrobbleday:' || to_char(s.played_at AT TIME ZONE 'Europe/Oslo', 'YYYY-MM-DD'))`

  const cutoff = config.STREAM_SCROBBLE_CUTOFF_MONTHS > 0
    ? sql`s.played_at >= now() - ${`${config.STREAM_SCROBBLE_CUTOFF_MONTHS} months`}::interval`
    : null

  // Pre-bound the indexed column from the cursor, one day wide to be safe about
  // the timezone shift between played_at and the grouped day.
  const cursorBound = facets.cursor
    ? (() => {
        const c = decodeCursor(facets.cursor!)
        return c.p ? sql`s.played_at < ${c.p}::timestamptz + interval '2 days'` : null
      })()
    : null

  const archive = facets.year != null && facets.month != null
    ? (() => {
        const { start, end } = archiveRange(facets.year!, facets.month!)
        return sql`s.played_at >= ${start.toISOString()}::timestamptz - interval '2 days'
               AND s.played_at < ${end.toISOString()}::timestamptz + interval '2 days'`
      })()
    : null

  return sql`
    SELECT ${day} AS event_at, 'scrobble_day' AS kind, ${refId} AS ref_id, 'lastfm' AS source
    FROM scrobbles s
    WHERE ${allOf([cutoff, cursorBound, archive])}
    GROUP BY 1, 3
    HAVING ${allOf([
      notFuture(sql`${day}`),
      archiveBound(facets, sql`${day}`),
      keyset(facets, sql`${day}`, refId),
    ])}
    ${laneOrder(day, refId)}
    LIMIT ${ctx.limit}`
}

export function tripsLane(ctx: LaneContext): SQL | null {
  const { facets } = ctx
  if (facets.tag) return null
  if (facets.kind && facets.kind !== 'trip') return null

  const eventAt = sql`t.departure_at`
  const refId = sql`('trip:' || t.id::text)`

  return sql`
    SELECT ${eventAt} AS event_at, 'trip' AS kind, ${refId} AS ref_id, 'tog' AS source
    FROM train_trips t
    WHERE ${allOf([
      // A planned journey is intent, not activity — the same call as NeoDB wishlists.
      sql`t.status IS DISTINCT FROM 'Planned'`,
      notFuture(eventAt),
      archiveBound(facets, eventAt),
      keyset(facets, eventAt, refId),
    ])}
    ${laneOrder(eventAt, refId)}
    LIMIT ${ctx.limit}`
}

/**
 * Garden notes, dated by their own frontmatter. Undated notes are excluded — see
 * event-date.ts on why an entry with no derivable date cannot be in the stream.
 * The cast is guarded by the regex so a malformed hand-written date cannot error
 * the whole query.
 */
export function gardenLane(ctx: LaneContext): SQL | null {
  const { facets } = ctx
  if (facets.tag) return null
  if (facets.kind && facets.kind !== 'garden') return null

  const eventAt = sql`(g.note_date || CASE
      WHEN g.note_date ~ '^\\d{4}$' THEN '-01-01'
      WHEN g.note_date ~ '^\\d{4}-\\d{2}$' THEN '-01'
      ELSE '' END)::timestamptz`
  const refId = sql`('garden:' || g.id::text)`

  return sql`
    SELECT ${eventAt} AS event_at, 'garden' AS kind, ${refId} AS ref_id, 'hage' AS source
    FROM garden_notes g
    WHERE ${allOf([
      sql`g.deleted_at IS NULL`,
      sql`g.note_date ~ '^\\d{4}(-\\d{2}(-\\d{2})?)?$'`,
      notFuture(eventAt),
      archiveBound(facets, eventAt),
      keyset(facets, eventAt, refId),
    ])}
    ${laneOrder(eventAt, refId)}
    LIMIT ${ctx.limit}`
}

const BUILDERS: Record<Lane, (ctx: LaneContext) => SQL | null> = {
  posts: postsLane,
  reading: readingLane,
  marks: marksLane,
  music: musicLane,
  trips: tripsLane,
  garden: gardenLane,
}

/**
 * The merged candidate query: every selected lane, unioned, sorted and cut.
 *
 * `ORDER BY … COLLATE "C"` here must match the per-lane ORDER BY and the keyset
 * comparison exactly. If they disagree, the page boundary lands somewhere the
 * cursor does not expect and entries are skipped or repeated.
 */
export function mergedCandidateSql(ctx: LaneContext): SQL | null {
  const lanes = lanesForPlatform(ctx.facets.platform)
  const parts = lanes.map((lane) => BUILDERS[lane](ctx)).filter((s): s is SQL => s != null)
  if (parts.length === 0) return null

  // Each branch must be parenthesised. A lane carries its own ORDER BY and LIMIT —
  // that is the whole point of the k-way merge — and Postgres will not accept those
  // on a bare UNION arm: it reads the ORDER BY as belonging to the union itself and
  // fails at the next SELECT.
  const union = sql.join(parts.map((p) => sql`(${p})`), sql` UNION ALL `)
  return sql`SELECT event_at, kind, ref_id, source FROM (${union}) AS merged
    ORDER BY event_at DESC, ref_id COLLATE "C" DESC
    LIMIT ${ctx.facets.limit}`
}
