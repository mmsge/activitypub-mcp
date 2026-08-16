import { z } from 'zod'
import { and, count, eq, ilike, sql, type SQL } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { youtubeWatches } from '../../db/schema.js'
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

/**
 * Shorts predicate.
 *
 * A row with NO duration is UNKNOWN — not proven short, not proven long. So `only` demands
 * a known sub-threshold duration, and `exclude` keeps unknowns rather than asserting they
 * are long-form. The stats response reports how many unknowns there are so the asymmetry
 * is visible instead of implied.
 */
export function shortsCondition(mode: 'include' | 'exclude' | 'only'): SQL | null {
  if (mode === 'only') {
    return sql`(${youtubeWatches.durationSeconds} IS NOT NULL AND ${youtubeWatches.durationSeconds} < ${SHORTS_MAX_SECONDS})`
  }
  if (mode === 'exclude') {
    return sql`(${youtubeWatches.durationSeconds} IS NULL OR ${youtubeWatches.durationSeconds} >= ${SHORTS_MAX_SECONDS})`
  }
  return null
}

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
  from: z.string().optional()
    .describe('Only watches at or after this LOCAL wall-clock datetime (Europe/Oslo), e.g. "2025-01-01" or "2025-01-01T18:00:00". Any timezone suffix is ignored: these bounds are local time, matching how the archive records it.'),
  to: z.string().optional()
    .describe('Only watches at or before this LOCAL wall-clock datetime (Europe/Oslo). Inclusive. Any timezone suffix is ignored.'),
  year: z.number().int().optional()
    .describe('Sugar for a whole calendar year in Europe/Oslo local time, e.g. 2025. Bucketed on the local wall clock, so the counts match the source exactly rather than shifting the hours either side of New Year.'),
  shorts: z.enum(['include', 'exclude', 'only']).default('include')
    .describe('Shorts handling. There is NO Shorts flag in this data; the heuristic is duration < 180s, and Shorts dominate the archive. "only" requires a KNOWN sub-180s duration. "exclude" drops known Shorts but KEEPS rows with no duration at all, because an unknown duration is unknown, not long-form.'),
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
      is_short: sql<boolean | null>`CASE WHEN ${youtubeWatches.durationSeconds} IS NULL THEN NULL ELSE ${youtubeWatches.durationSeconds} < ${SHORTS_MAX_SECONDS} END`,
      unresolved: youtubeWatches.unresolved,
      account: youtubeWatches.account,
      source: youtubeWatches.source,
    })
    .from(youtubeWatches)
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
  group_by: z.enum(['channel', 'year', 'month', 'hour_of_day', 'account', 'video']).default('channel')
    .describe('Breakdown dimension. channel/account/video are ranked by watch count descending; year/month/hour_of_day are returned in CALENDAR order ascending, because a calendar sorted by count is not a calendar. group_count reports how many buckets exist, so truncation by "limit" is visible.'),
  limit: z.number().int().min(1).max(500).default(20)
    .describe('How many buckets to return. Raise it for month (~190 buckets across the archive) or hour_of_day (24) — the default of 20 will truncate those.'),
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
      // The three time estimates. All are upper bounds on a quantity this data does not
      // contain; they differ in HOW they are wrong, which is the point of quoting all of
      // them. coalesce keeps an empty result set at 0 rather than null.
      rawSeconds: sql<string>`coalesce(sum(${youtubeWatches.durationSeconds}), 0)`,
      cappedSeconds: sql<string>`coalesce(sum(least(${youtubeWatches.durationSeconds}, ${WATCH_TIME_CAP_SECONDS})), 0)`,
      longFormSeconds: sql<string>`coalesce(sum(${youtubeWatches.durationSeconds}) filter (where ${youtubeWatches.durationSeconds} >= ${SHORTS_MAX_SECONDS}), 0)`,
      withDuration: sql<string>`count(*) filter (where ${youtubeWatches.durationSeconds} IS NOT NULL)`,
      shorts: sql<string>`count(*) filter (where ${youtubeWatches.durationSeconds} < ${SHORTS_MAX_SECONDS})`,
      longForm: sql<string>`count(*) filter (where ${youtubeWatches.durationSeconds} >= ${SHORTS_MAX_SECONDS})`,
      unresolvedCount: sql<string>`count(*) filter (where ${youtubeWatches.unresolved})`,
      noChannel: sql<string>`count(*) filter (where ${youtubeWatches.channelId} IS NULL)`,
    })
    .from(youtubeWatches)
    .where(where)

  const plan = groupPlan(input.group_by)
  const groupWhere = plan.extra
    ? and(...(conditions.length ? conditions : []), plan.extra)
    : where

  const top = await db
    .select({
      key: sql<string | null>`(${plan.key})::text`,
      ...(plan.label ? { label: plan.label } : {}),
      watches: count(),
      rawSeconds: sql<string>`coalesce(sum(${youtubeWatches.durationSeconds}), 0)`,
      withDuration: sql<string>`count(*) filter (where ${youtubeWatches.durationSeconds} IS NOT NULL)`,
    })
    .from(youtubeWatches)
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
      shorts: Number(totals?.shorts ?? 0),
      long_form: Number(totals?.longForm ?? 0),
      unknown_duration: total - withDuration,
      shorts_threshold_seconds: SHORTS_MAX_SECONDS,
      note: 'There is no Shorts flag in this data; duration < 180s is a heuristic. Rows with no duration are UNKNOWN — not counted as either.',
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
    })),

    timezone: 'Europe/Oslo',
    filters: filterEcho(input),
    range: { from: input.from ?? null, to: input.to ?? null, year: input.year ?? null },
  }
}
