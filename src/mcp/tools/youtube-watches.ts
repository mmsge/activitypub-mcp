import { z } from 'zod'
import { and, count, eq, ilike, sql, type SQL } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { youtubeWatches, youtubeVideos } from '../../db/schema.js'
import { SHORTS_MAX_SECONDS, WATCH_TIME_CAP_SECONDS } from '../../lib/parse-youtube-takeout.js'
import { encodeCursor, decodeCursor, keysetCondition, keysetOrderBy } from './pagination.js'

/**
 * YouTube watch history: a filterable feed and its aggregate.
 *
 * Shaped after get_scrobbles / get_scrobble_stats — one shared buildConditions feeds
 * both, so a filtered stats call reports totals and first/last over only the matching
 * rows and "when did I first watch this channel" is a single call.
 *
 * Two rules here are not stylistic and must not be "simplified" back:
 *
 *   **Calendar work reads watched_at_local; ordering reads watched_at.** The source
 *   records a bare Europe/Oslo wall clock, stored verbatim in watched_at_local, with the
 *   instant derived beside it. Year/month/hour buckets and the from/to/year filters read
 *   the local column, so a bucket needs no AT TIME ZONE and cannot be double-converted,
 *   and `year=2025` reproduces the source's own per-year counts instead of misfiling the
 *   hours either side of New Year. Ordering and the keyset cursor read the instant, which
 *   is what the shared pagination helpers cast to. See ADR 0047.
 *
 *   **There is no watch duration in this data.** duration_seconds is the VIDEO's length.
 *   Every time figure is an upper bound, which is why the stats response always carries
 *   three differently-qualified estimates and their coverage rather than one number.
 */

/** Milliseconds are noise on a minute-resolution archive; report whole seconds. */
const secondsToHours = (s: number) => Math.round((s / 3600) * 10) / 10

/**
 * Accepted shape for the from/to bounds: a date, optionally a time, optionally a timezone
 * suffix that is then IGNORED (these bounds are local wall clock — see ADR 0047).
 *
 * Validated here rather than left to Postgres' cast so a malformed bound is a 400 naming
 * the bad value, not a 500 carrying the whole query — the same reason InvalidCursorError
 * exists. `zod` rejects it before a connection is opened.
 */
const LOCAL_BOUND_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/

const localBound = (label: string) =>
  z.string()
    .refine((v) => LOCAL_BOUND_RE.test(v.trim()), {
      message: `${label} must be a local date or datetime such as "2025-01-01" or "2025-01-01T18:00:00". Any timezone suffix is ignored: these bounds are Europe/Oslo wall clock.`,
    })
    .transform((v) => v.trim())

// ---- shared filter handling ------------------------------------------------

export interface WatchFilters {
  account?: string
  channel?: string
  title?: string
  video_id?: string
  from?: string
  to?: string
  year?: number
  shorts?: 'include' | 'exclude' | 'only'
  include_unresolved?: boolean
}

// ---- the Shorts flag -------------------------------------------------------
//
// Every query here LEFT JOINs youtube_videos, whose is_short is DERIVED — by this repo, not
// by YouTube. See ADR 0049. The join is left, and the fallback below is why: a watch of a
// video the classifier has not reached yet still has to answer.

/**
 * The Shorts flag as served, in priority order.
 *
 * A stored verdict wins. Failing that, `unclassifiable` is an honest unknown — those are the
 * deleted and private videos, and nothing will ever decide them. Only then does the old flat
 * `duration < 180s` heuristic apply, as a labelled guess.
 *
 * Keeping the heuristic as the fallback rather than serving NULL is what makes this change
 * safe to deploy before the job has run: behaviour on an unclassified archive is exactly
 * what it was, and it improves monotonically as rows get settled. The cost is that a caller
 * cannot tell a verdict from a guess by this column alone — which is what `is_short_source`
 * and the `shorts_split` breakdown exist to say out loud.
 */
export const resolvedIsShortExpr = () => sql<boolean | null>`CASE
    WHEN ${youtubeVideos.isShort} IS NOT NULL THEN ${youtubeVideos.isShort}
    WHEN ${youtubeVideos.isShortMethod} = 'unclassifiable' THEN NULL
    WHEN ${guessDurationExpr()} IS NULL THEN NULL
    ELSE ${guessDurationExpr()} < ${SHORTS_MAX_SECONDS}
  END`

/**
 * The duration the fallback guesses from: the VIDEO's, with the watch row's only as a last
 * resort.
 *
 * Both are the same number for almost every row, but not all: a video can have one watch
 * row that scraped a duration and another that did not. Reading the watch row alone would
 * then answer differently for two watches of the same video, and `is_short` is a property
 * of the video, not of the occasion it was opened on.
 */
const guessDurationExpr = () => sql`coalesce(${youtubeVideos.durationSeconds}, ${youtubeWatches.durationSeconds})`

/** Where the served flag came from, so "known" and "guessed" never have to be inferred. */
export const isShortSourceExpr = () => sql<string>`CASE
    WHEN ${youtubeVideos.isShortMethod} = 'unclassifiable' THEN 'unclassifiable'
    WHEN ${youtubeVideos.isShort} IS NOT NULL THEN 'classified'
    WHEN ${guessDurationExpr()} IS NULL THEN 'unknown_duration'
    ELSE 'heuristic'
  END`

/**
 * Shorts predicate.
 *
 * A row with no answer is UNKNOWN — not proven short, not proven long. So `only` demands a
 * positive answer and `exclude` keeps unknowns rather than asserting they are long-form.
 * `IS TRUE` / `IS NOT TRUE` rather than `=` / `<>` precisely because three-valued logic is
 * the point here: `x <> true` is NULL when x is NULL, which would silently drop every
 * unknown row from an `exclude` that is documented to keep them.
 */
export function shortsCondition(mode: 'include' | 'exclude' | 'only'): SQL | null {
  if (mode === 'only') return sql`(${resolvedIsShortExpr()}) IS TRUE`
  if (mode === 'exclude') return sql`(${resolvedIsShortExpr()}) IS NOT TRUE`
  return null
}

// ---- the three watch-time estimates ----------------------------------------
//
// Exported individually so the SQL can be asserted on without a database. All three are
// upper bounds on a quantity this data does not contain; they differ in HOW they are
// wrong, which is the whole point of returning all three.

/** Sum of full video lengths. sum() ignores nulls, so no guard is needed. */
export const rawSecondsExpr = () =>
  sql<string>`coalesce(sum(${youtubeWatches.durationSeconds}), 0)`

/**
 * Each row capped at 20 minutes.
 *
 * The FILTER is load-bearing. Postgres' `least()` IGNORES nulls rather than propagating
 * them — `least(NULL, 1200)` is **1200**, not NULL — so without it every duration-less row
 * contributes a fabricated 20 minutes. On the real archive that pushed this figure ABOVE
 * the raw sum, which is impossible when `least(d, cap) <= d` for every row, and that
 * impossibility is what exposed it. `sum()` alone would have been safe; `least()` is the
 * trap, and it is the only place in this file that needs the guard.
 */
export const cappedSecondsExpr = () =>
  sql<string>`coalesce(sum(least(${youtubeWatches.durationSeconds}, ${WATCH_TIME_CAP_SECONDS})) filter (where ${youtubeWatches.durationSeconds} IS NOT NULL), 0)`

/**
 * Sum over rows that are NOT Shorts — read from the resolved flag, not from the raw
 * threshold, so a 90-second video from 2023 now counts as the long-form it is instead of
 * being discarded as a Short it never was. Unknowns stay excluded either way.
 */
export const longFormSecondsExpr = () =>
  sql<string>`coalesce(sum(${youtubeWatches.durationSeconds}) filter (where (${resolvedIsShortExpr()}) IS FALSE), 0)`

export function buildConditions(input: WatchFilters): SQL[] {
  const conditions: SQL[] = []
  if (input.account) conditions.push(eq(youtubeWatches.account, input.account))
  if (input.channel) conditions.push(ilike(youtubeWatches.channelName, `%${input.channel}%`))
  if (input.title) conditions.push(ilike(youtubeWatches.title, `%${input.title}%`))
  if (input.video_id) conditions.push(eq(youtubeWatches.videoId, input.video_id))

  // Local wall clock throughout. The ::timestamp cast makes Postgres ignore any offset a
  // caller appends, which is the documented contract: these bounds are read as local time.
  if (input.year !== undefined) {
    conditions.push(sql`${youtubeWatches.watchedAtLocal} >= make_timestamp(${input.year}, 1, 1, 0, 0, 0)`)
    conditions.push(sql`${youtubeWatches.watchedAtLocal} < make_timestamp(${input.year + 1}, 1, 1, 0, 0, 0)`)
  }
  if (input.from) conditions.push(sql`${youtubeWatches.watchedAtLocal} >= ${input.from}::timestamp`)
  if (input.to) conditions.push(sql`${youtubeWatches.watchedAtLocal} <= ${input.to}::timestamp`)

  const shorts = shortsCondition(input.shorts ?? 'include')
  if (shorts) conditions.push(shorts)

  // Unresolved rows are real watch events and are included by default; hiding them would
  // make every total quietly disagree with the archive.
  if (input.include_unresolved === false) conditions.push(eq(youtubeWatches.unresolved, false))

  return conditions
}

const filterEcho = (input: WatchFilters) => ({
  account: input.account ?? null,
  channel: input.channel ?? null,
  title: input.title ?? null,
  video_id: input.video_id ?? null,
  from: input.from ?? null,
  to: input.to ?? null,
  year: input.year ?? null,
  shorts: input.shorts ?? 'include',
  include_unresolved: input.include_unresolved ?? true,
})

// ---- shared schema fields --------------------------------------------------

const filterShape = {
  account: z.string().optional()
    .describe('Filter to one account (exact match), e.g. "mvrkws" or "rawen100". The two accounts OVERLAP in time — this is not a switchover on a single date — so filtering by account narrows to a person-and-profile, not to an era.'),
  channel: z.string().optional()
    .describe('Filter by channel name (case-insensitive, partial match). Unresolved rows carry no channel and are therefore excluded by this filter, whatever include_unresolved says.'),
  title: z.string().optional()
    .describe('Filter by video title (case-insensitive, partial match). Unresolved rows carry no title and are excluded by this filter.'),
  video_id: z.string().optional()
    .describe('Filter to one video by its 11-character YouTube id (exact). Use this to count rewatches — the same video legitimately appears many times.'),
  from: localBound('from').optional()
    .describe('Only watches at or after this LOCAL wall-clock datetime (Europe/Oslo), e.g. "2025-01-01" or "2025-01-01T18:00:00". Any timezone suffix is ignored: these bounds are local time, matching how the archive records it.'),
  to: localBound('to').optional()
    .describe('Only watches at or before this LOCAL wall-clock datetime (Europe/Oslo). Inclusive. Any timezone suffix is ignored.'),
  year: z.number().int().min(2005).max(2100).optional()
    .describe('Sugar for a whole calendar year in Europe/Oslo local time, e.g. 2025. Bucketed on the local wall clock, so the counts match the source exactly rather than shifting the hours either side of New Year.'),
  shorts: z.enum(['include', 'exclude', 'only']).default('include')
    .describe('Shorts handling. The flag is DERIVED BY THIS SERVER, not supplied by YouTube — the archive carries no Shorts flag at all. Each video is decided by a stored classification where one exists (is_short_method says how: duration_rule, api_metadata, or probe), and otherwise falls back to the flat "duration < 180s" guess. "only" requires a positive answer; "exclude" drops those but KEEPS anything unknown, because an unknown is unknown, not long-form. Read shorts_split in get_youtube_stats to see how much of a result is known versus guessed before quoting a Shorts figure.'),
  include_unresolved: z.boolean().default(true)
    .describe('Whether to include unresolved watches — deleted or private videos, which have no title and no channel. Default true: they are real watch events, and dropping them makes totals disagree with the archive. Set false for a title/channel-complete view, and expect a smaller total.'),
}

// ---- get_youtube_watches: raw, filterable feed ------------------------------

export const getYoutubeWatchesSchema = z.object({
  ...filterShape,
  sort_order: z.enum(['asc', 'desc']).default('desc')
    .describe('Order by when it was watched. "desc" (default) is newest-first; "asc" is oldest-first — pair with limit:1 to fetch the earliest matching watch in one call.'),
  limit: z.number().int().min(1).max(200).default(50),
  page: z.number().int().min(1).default(1)
    .describe('Offset-based page (legacy). Ignored when "cursor" is supplied; prefer "cursor" for deep traversal — this archive is ~96k rows.'),
  cursor: z.string().optional()
    .describe('Opaque pagination cursor from a previous response\'s next_cursor. When set, page/offset is ignored and traversal continues from where the last page ended (respecting sort_order and all filters).'),
})

export async function getYoutubeWatches(input: z.infer<typeof getYoutubeWatchesSchema>) {
  const db = getDb()
  const conditions = buildConditions(input)

  // Keyset on the INSTANT, not the wall clock: the shared helpers bind their cursor with
  // an explicit ::timestamptz cast, and ORDER BY must mirror the WHERE exactly or the
  // traversal silently skips or repeats rows.
  if (input.cursor) {
    conditions.push(keysetCondition(youtubeWatches.watchedAt, youtubeWatches.id, decodeCursor(input.cursor), input.sort_order))
  }

  const where = conditions.length ? and(...conditions) : undefined
  const orderBy = keysetOrderBy(youtubeWatches.watchedAt, youtubeWatches.id, input.sort_order)

  const baseQuery = db
    .select({
      id: youtubeWatches.id,
      watchedAt: youtubeWatches.watchedAt,
      // Rendered from the local column so the string is the source's own wall clock,
      // never a re-derivation that could pick up the session timezone.
      watched_at_local: sql<string>`to_char(${youtubeWatches.watchedAtLocal}, 'YYYY-MM-DD"T"HH24:MI:SS')`,
      video_id: youtubeWatches.videoId,
      video_url: youtubeWatches.videoUrl,
      title: youtubeWatches.title,
      channel_name: youtubeWatches.channelName,
      channel_id: youtubeWatches.channelId,
      duration_seconds: youtubeWatches.durationSeconds,
      is_short: resolvedIsShortExpr(),
      // How this row's flag was arrived at. `is_short_method` is null for a guess, which is
      // the same thing `is_short_source: 'heuristic'` says — both are served because the
      // method names the evidence and the source names the confidence.
      is_short_method: youtubeVideos.isShortMethod,
      is_short_source: isShortSourceExpr(),
      unresolved: youtubeWatches.unresolved,
      account: youtubeWatches.account,
      source: youtubeWatches.source,
    })
    .from(youtubeWatches)
    .leftJoin(youtubeVideos, eq(youtubeVideos.videoId, youtubeWatches.videoId))
    .where(where)
    .orderBy(orderBy)
    .limit(input.limit)

  const rows = input.cursor
    ? await baseQuery
    : await baseQuery.offset((input.page - 1) * input.limit)

  const last = rows[rows.length - 1]
  const nextCursor = rows.length === input.limit && last
    ? encodeCursor(last.watchedAt, last.id)
    : null

  // The id is an internal keyset detail. Both times go out: the local wall clock as the
  // source wrote it, and the instant beside it, so a caller can join on either without
  // re-deriving one — and cannot mistake which is which.
  const watches = rows.map(({ id: _id, watchedAt, ...rest }) => ({
    ...rest,
    watched_at: watchedAt.toISOString(),
  }))

  return {
    count: watches.length,
    page: input.cursor ? null : input.page,
    next_cursor: nextCursor,
    sort_order: input.sort_order,
    timezone: 'Europe/Oslo',
    shorts_threshold_seconds: SHORTS_MAX_SECONDS,
    filters: filterEcho(input),
    watches,
  }
}

// ---- get_youtube_stats: aggregate metrics -----------------------------------

export const getYoutubeStatsSchema = z.object({
  ...filterShape,
  group_by: z.enum(['channel', 'year', 'month', 'day', 'weekday', 'hour_of_day', 'account', 'video']).default('channel')
    .describe('Breakdown dimension. channel/account/video are ranked by watch count descending; year/month/day/weekday/hour_of_day are returned in CALENDAR order ascending, because a calendar sorted by count is not a calendar. group_count reports how many buckets exist, so truncation by "limit" is visible. "day" spans ~2,500 buckets across the archive and cannot be fetched whole — scope it with year or from/to. "weekday" is ISO numbering, 1=Monday through 7=Sunday, and carries the short day name as its label.'),
  limit: z.number().int().min(1).max(500).default(20)
    .describe('How many buckets to return. Raise it for month (~190 buckets across the archive), day (~366 per year) or hour_of_day (24) — the default of 20 will truncate those.'),
})

/** Group key and label expressions per dimension, plus whether to rank or order by key. */
export function groupPlan(groupBy: z.infer<typeof getYoutubeStatsSchema>['group_by']) {
  switch (groupBy) {
    case 'channel':
      return {
        key: youtubeWatches.channelId as unknown as SQL,
        // A channel that renames keeps one id and gains a name, so the newest name
        // represents the group. Aggregated because it isn't a grouping key.
        label: sql<string | null>`(array_agg(${youtubeWatches.channelName} ORDER BY ${youtubeWatches.watchedAtLocal} DESC))[1]`,
        // Rows with no channel cannot be ranked; they are excluded here and the count of
        // what was excluded is reported alongside, rather than left to be inferred.
        extra: sql`${youtubeWatches.channelId} IS NOT NULL`,
        rankByCount: true,
      }
    case 'video':
      return {
        key: youtubeWatches.videoId as unknown as SQL,
        label: sql<string | null>`(array_agg(${youtubeWatches.title} ORDER BY ${youtubeWatches.watchedAtLocal} DESC))[1]`,
        extra: null,
        rankByCount: true,
      }
    case 'account':
      return { key: youtubeWatches.account as unknown as SQL, label: null, extra: null, rankByCount: true }
    case 'year':
      return { key: sql`extract(year from ${youtubeWatches.watchedAtLocal})::int`, label: null, extra: null, rankByCount: false }
    case 'month':
      return { key: sql`to_char(${youtubeWatches.watchedAtLocal}, 'YYYY-MM')`, label: null, extra: null, rankByCount: false }
    case 'day':
      // Rendered as text rather than a date so the key sorts correctly as a string and
      // needs no client-side parsing — and, like every other calendar bucket here, it is
      // cut on the LOCAL column so no AT TIME ZONE is involved. ~2,500 buckets exist
      // archive-wide against a limit of 500, so this dimension is meant to be scoped.
      return { key: sql`to_char(${youtubeWatches.watchedAtLocal}, 'YYYY-MM-DD')`, label: null, extra: null, rankByCount: false }
    case 'weekday':
      return {
        // ISO numbering (1=Monday…7=Sunday) so the week reads Monday-first, which is what
        // both the calendar and the reader expect here; `dow` would put Sunday at 0.
        key: sql`extract(isodow from ${youtubeWatches.watchedAtLocal})::int`,
        // Spelled from a literal array rather than to_char(…,'Dy'), which reads the
        // server's lc_time and would silently change the label with the container locale.
        // Aggregated because it is not itself a grouping key.
        label: sql<string | null>`min((ARRAY['Mon','Tue','Wed','Thu','Fri','Sat','Sun'])[extract(isodow from ${youtubeWatches.watchedAtLocal})::int])`,
        extra: null,
        rankByCount: false,
      }
    case 'hour_of_day':
      return { key: sql`extract(hour from ${youtubeWatches.watchedAtLocal})::int`, label: null, extra: null, rankByCount: false }
  }
}

export async function getYoutubeStats(input: z.infer<typeof getYoutubeStatsSchema>) {
  const db = getDb()
  const conditions = buildConditions(input)
  const where = conditions.length ? and(...conditions) : undefined

  const [totals] = await db
    .select({
      total: count(),
      distinctVideos: sql<string>`count(distinct ${youtubeWatches.videoId})`,
      distinctChannels: sql<string>`count(distinct ${youtubeWatches.channelId})`,
      distinctChannelNames: sql<string>`count(distinct ${youtubeWatches.channelName})`,
      first: sql<string | null>`to_char(min(${youtubeWatches.watchedAtLocal}), 'YYYY-MM-DD"T"HH24:MI:SS')`,
      last: sql<string | null>`to_char(max(${youtubeWatches.watchedAtLocal}), 'YYYY-MM-DD"T"HH24:MI:SS')`,
      rawSeconds: rawSecondsExpr(),
      cappedSeconds: cappedSecondsExpr(),
      longFormSeconds: longFormSecondsExpr(),
      withDuration: sql<string>`count(*) filter (where ${youtubeWatches.durationSeconds} IS NOT NULL)`,
      // The resolved split. Every one of these is a WATCH count, not a video count —
      // distinct_videos above is the per-video figure.
      shorts: sql<string>`count(*) filter (where (${resolvedIsShortExpr()}) IS TRUE)`,
      longForm: sql<string>`count(*) filter (where (${resolvedIsShortExpr()}) IS FALSE)`,
      // …and how much of it is actually known rather than guessed, which is the entire
      // point of storing a method alongside the flag.
      knownShort: sql<string>`count(*) filter (where ${youtubeVideos.isShort} IS TRUE)`,
      knownLongForm: sql<string>`count(*) filter (where ${youtubeVideos.isShort} IS FALSE)`,
      guessedShort: sql<string>`count(*) filter (where ${youtubeVideos.isShort} IS NULL AND (${resolvedIsShortExpr()}) IS TRUE)`,
      guessedLongForm: sql<string>`count(*) filter (where ${youtubeVideos.isShort} IS NULL AND (${resolvedIsShortExpr()}) IS FALSE)`,
      unclassifiable: sql<string>`count(*) filter (where ${youtubeVideos.isShortMethod} = 'unclassifiable')`,
      byDurationRule: sql<string>`count(*) filter (where ${youtubeVideos.isShortMethod} = 'duration_rule')`,
      byApiMetadata: sql<string>`count(*) filter (where ${youtubeVideos.isShortMethod} = 'api_metadata')`,
      byProbe: sql<string>`count(*) filter (where ${youtubeVideos.isShortMethod} = 'probe')`,
      unresolvedCount: sql<string>`count(*) filter (where ${youtubeWatches.unresolved})`,
      noChannel: sql<string>`count(*) filter (where ${youtubeWatches.channelId} IS NULL)`,
    })
    .from(youtubeWatches)
    .leftJoin(youtubeVideos, eq(youtubeVideos.videoId, youtubeWatches.videoId))
    .where(where)

  const plan = groupPlan(input.group_by)
  // A channel ranking additionally drops rows with no channel; every other dimension
  // groups over exactly the filtered set.
  const groupWhere = plan.extra ? and(...conditions, plan.extra) : where

  const top = await db
    .select({
      key: sql<string | null>`(${plan.key})::text`,
      ...(plan.label ? { label: plan.label } : {}),
      watches: count(),
      rawSeconds: rawSecondsExpr(),
      withDuration: sql<string>`count(*) filter (where ${youtubeWatches.durationSeconds} IS NOT NULL)`,
      // Per-bucket span and breadth. Read from the LOCAL column for the same reason every
      // other calendar value here is: it is the source's own wall clock, and a bucket that
      // needed AT TIME ZONE could be double-converted. Without these, "when did I start
      // watching this channel" is one filtered round trip per channel.
      distinctVideos: sql<string>`count(distinct ${youtubeWatches.videoId})`,
      firstWatch: sql<string | null>`to_char(min(${youtubeWatches.watchedAtLocal}), 'YYYY-MM-DD"T"HH24:MI:SS')`,
      lastWatch: sql<string | null>`to_char(max(${youtubeWatches.watchedAtLocal}), 'YYYY-MM-DD"T"HH24:MI:SS')`,
    })
    .from(youtubeWatches)
    .leftJoin(youtubeVideos, eq(youtubeVideos.videoId, youtubeWatches.videoId))
    .where(groupWhere)
    .groupBy(plan.key)
    // The key is a tiebreak, not decoration: this archive has thousands of groups with
    // identical counts (most videos are watched exactly once), and without it two
    // identical calls return different top-N members in a different order.
    .orderBy(
      ...(plan.rankByCount
        ? [sql`count(*) DESC`, sql`(${plan.key}) ASC`]
        : [sql`(${plan.key}) ASC`]),
    )
    .limit(input.limit)

  // How many buckets exist in total, so a truncated `top` is obvious rather than implied.
  const groupedAll = db
    .select({ one: sql<number>`1` })
    .from(youtubeWatches)
    // Joined here too: groupWhere can carry the shorts predicate, which reads the join.
    .leftJoin(youtubeVideos, eq(youtubeVideos.videoId, youtubeWatches.videoId))
    .where(groupWhere)
    .groupBy(plan.key)
    .as('g')
  const [groupCountRow] = await db.select({ n: count() }).from(groupedAll)

  const total = Number(totals?.total ?? 0)
  const withDuration = Number(totals?.withDuration ?? 0)
  const rawSeconds = Number(totals?.rawSeconds ?? 0)
  const cappedSeconds = Number(totals?.cappedSeconds ?? 0)
  const longFormSeconds = Number(totals?.longFormSeconds ?? 0)
  const noChannel = Number(totals?.noChannel ?? 0)
  const shorts = Number(totals?.shorts ?? 0)
  const longForm = Number(totals?.longForm ?? 0)
  const unclassifiable = Number(totals?.unclassifiable ?? 0)

  return {
    total_watches: total,
    distinct_videos: Number(totals?.distinctVideos ?? 0),
    // Counted on the channel id: a channel that renames would otherwise be counted twice,
    // and two channels sharing a name would be counted once. The name count is reported
    // beside it because the two answer different questions.
    distinct_channels: Number(totals?.distinctChannels ?? 0),
    distinct_channel_names: Number(totals?.distinctChannelNames ?? 0),
    first_watched_at_local: totals?.first ?? null,
    last_watched_at_local: totals?.last ?? null,

    watch_time_estimates: {
      caveat:
        'UPPER BOUNDS, not time watched. This data records only that a video was OPENED — ' +
        'neither Takeout nor My Activity stores how much of it was watched. duration_seconds ' +
        'is the video\'s full length. Quote a figure only with this caveat attached, and prefer ' +
        'the capped variant for anything resembling "time spent".',
      raw_seconds: rawSeconds,
      raw_hours: secondsToHours(rawSeconds),
      capped_20min_seconds: cappedSeconds,
      capped_20min_hours: secondsToHours(cappedSeconds),
      excluding_shorts_seconds: longFormSeconds,
      excluding_shorts_hours: secondsToHours(longFormSeconds),
      cap_seconds: WATCH_TIME_CAP_SECONDS,
      rows_with_duration: withDuration,
      rows_without_duration: total - withDuration,
      duration_coverage_pct: total === 0 ? 0 : Math.round((withDuration / total) * 1000) / 10,
    },

    shorts_split: {
      // Watch counts, not video counts. The three headline figures are the RESOLVED split:
      // a stored verdict where there is one, the flat heuristic where there is not.
      shorts: shorts,
      long_form: longForm,
      unknown: total - shorts - longForm,
      // Known versus guessed. This is what the classification bought, and quoting `shorts`
      // without it is exactly the overstatement the whole exercise exists to stop.
      known_short: Number(totals?.knownShort ?? 0),
      known_long_form: Number(totals?.knownLongForm ?? 0),
      guessed_short: Number(totals?.guessedShort ?? 0),
      guessed_long_form: Number(totals?.guessedLongForm ?? 0),
      // Terminal: deleted and private videos, which nothing will ever decide.
      unclassifiable: unclassifiable,
      // The rest of the unknowns: no verdict AND no duration to guess from. Derived from
      // the resolved unknown total rather than from rows_without_duration, which counts
      // WATCH rows — a video can have one watch row carrying a duration and another not,
      // and subtracting that from a video-level figure double-counts the difference.
      // Empty once the job has run, since a video with no duration becomes unclassifiable.
      unknown_duration: total - shorts - longForm - unclassifiable,
      by_method: {
        duration_rule: Number(totals?.byDurationRule ?? 0),
        api_metadata: Number(totals?.byApiMetadata ?? 0),
        probe: Number(totals?.byProbe ?? 0),
      },
      shorts_threshold_seconds: SHORTS_MAX_SECONDS,
      note:
        'DERIVED, not from YouTube — the archive carries no Shorts flag. A row counted under ' +
        'known_* was decided by is_short_method: duration_rule (the era rules offline), ' +
        'api_metadata (the real upload date) or probe (the /shorts/ URL, the only thing that ' +
        'can CONFIRM a Short). A row counted under guessed_* is the old flat "duration < 180s" ' +
        'heuristic, which over-counts Shorts because it ignores that they did not exist before ' +
        'September 2020 and were capped at 60s until 15 October 2024. Unknowns are their own ' +
        'bucket and are never folded into either side.',
    },

    unresolved_watches: Number(totals?.unresolvedCount ?? 0),
    watches_without_channel: noChannel,

    group_by: input.group_by,
    group_count: Number(groupCountRow?.n ?? 0),
    group_order: plan.rankByCount ? 'watches desc' : 'key asc',
    ...(input.group_by === 'channel'
      ? {
          excluded_from_ranking: {
            watches_without_channel: noChannel,
            reason: 'unresolved and channel-less rows carry no channel id, so no channel ranking can include them',
          },
        }
      : {}),
    top: top.map((r) => ({
      key: r.key,
      ...('label' in r ? { label: (r as { label: string | null }).label } : {}),
      watches: Number(r.watches),
      raw_seconds: Number(r.rawSeconds),
      rows_with_duration: Number(r.withDuration),
      distinct_videos: Number(r.distinctVideos),
      first_watch: r.firstWatch,
      last_watch: r.lastWatch,
    })),

    timezone: 'Europe/Oslo',
    filters: filterEcho(input),
    range: { from: input.from ?? null, to: input.to ?? null, year: input.year ?? null },
  }
}
