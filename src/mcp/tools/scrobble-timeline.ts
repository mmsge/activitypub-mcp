import { z } from 'zod'
import { and, count, sql, type SQL } from 'drizzle-orm'
import { getDb } from '../../db/client.js'
import { scrobbles } from '../../db/schema.js'
import { buildConditions } from './scrobbles.js'
import { STREAM_TIMEZONE } from '../../stream/event-date.js'
import { LOCAL_BOUND_RE, localBoundDate } from '../../lib/local-bound.js'
import {
  BUCKETS, assembleTimeline, isTimeZoneShaped, entityKey, resolveRange, UnknownTimeZoneError,
  UNKNOWN_NAME,
  type Bucket, type EntityRow, type FlatRow, type Timeline,
} from '../../lib/scrobble-timeline.js'

/**
 * A per-bucket scrobble series: play counts by local calendar day, week or month, broken
 * down by artist, album or track.
 *
 * `get_scrobbles` returns raw rows (260 pages for the archive) and `get_scrobble_stats`
 * collapses the whole range into one ranking. Neither can produce a series, and day is
 * not a `group_by` value on the stats tool because `group_by` there selects the entity
 * being ranked — a bucketing axis is a different thing and you want both at once.
 *
 * Everything that is not a query lives in `src/lib/scrobble-timeline.ts`, which is pure
 * and carries the tests. This module is the SQL and the two schemas.
 */

// ---- local bounds ----------------------------------------------------------

/**
 * A `from`/`to` bound: a local calendar date. A datetime is accepted and reduced to its
 * date, because a bucket is a whole day and a time of day cannot narrow one.
 */
const localDate = (label: string) =>
  z.string()
    .refine((v) => LOCAL_BOUND_RE.test(v.trim()), {
      message: `${label} must be a local date such as "2026-01-15". A datetime is accepted and truncated to its date; a timezone suffix is ignored, since these bounds are read in the "timezone" parameter's zone.`,
    })
    .transform(localBoundDate)

// ---- SQL fragments ---------------------------------------------------------

/**
 * `played_at` as the wall clock in `tz`.
 *
 * `tz` is a BOUND PARAMETER, never interpolated: it is caller-supplied text reaching a
 * SQL expression, and `src/mcp/tools/scrobble-timeline.test.ts` pins that it stays in
 * the parameter list.
 */
function localAt(tz: string): SQL {
  return sql`(${scrobbles.playedAt} AT TIME ZONE ${tz})`
}

/**
 * The bucket a scrobble belongs to, as `YYYY-MM-DD`.
 *
 * Truncated on the LOCAL wall clock, not the UTC one. Norway is UTC+2 in summer, so
 * everything after 22:00 local lands on the following UTC day: bucketing on UTC misfiles
 * every summer evening by a day, and the misfiling is invisible in an aggregate. Same
 * rule `musicLane()` in `src/stream/lanes.ts` applies to the public stream's daily
 * digests, and the one ADR 0047 settled for the YouTube archive.
 *
 * `date_trunc('week', …)` truncates to Monday, which `bucketStart` in the pure module
 * must agree with or the enumerated buckets would not line up with the aggregated ones.
 */
export function localBucketExpr(bucket: Bucket, tz: string): SQL<string> {
  return sql<string>`to_char(date_trunc(${bucket}, ${localAt(tz)}), 'YYYY-MM-DD')`
}

/**
 * The window, as bounds on `played_at` itself so `scrobbles_played_idx` stays usable —
 * a predicate on the AT TIME ZONE expression could not use it.
 *
 * `to` is inclusive of the whole named day, so the upper bound is the next local
 * midnight, exclusive. Same rule as `parseWatchedBound` in `src/mcp/tools/watched.ts`.
 */
export function localWindowConditions(from: string, to: string, tz: string): SQL[] {
  return [
    sql`${scrobbles.playedAt} >= (${from}::date::timestamp AT TIME ZONE ${tz})`,
    sql`${scrobbles.playedAt} < ((${to}::date + 1)::timestamp AT TIME ZONE ${tz})`,
  ]
}

/** The entity's own name column, or null when the entity IS the artist. */
function nameExprFor(groupBy: 'artist' | 'album' | 'track'): SQL<string | null> | null {
  // nullif('') so Last.fm's empty album string groups with a genuinely absent one
  // instead of forming a second, identical-looking entity.
  if (groupBy === 'album') return sql<string | null>`nullif(${scrobbles.albumName}, '')`
  if (groupBy === 'track') return sql<string | null>`nullif(${scrobbles.trackName}, '')`
  return null
}

// ---- schemas ---------------------------------------------------------------

/**
 * Everything both surfaces share. `bucket` and `top_n` are deliberately absent: they are
 * the only two parameters whose DEFAULTS differ between MCP and REST, and each surface
 * supplies its own below.
 */
const timelineCoreSchema = z.object({
  artist: z.string().optional().describe('Filter by artist name (case-insensitive, partial match) — same semantics as get_scrobbles'),
  album: z.string().optional().describe('Filter by album name (case-insensitive, partial match)'),
  track: z.string().optional().describe('Filter by track name (case-insensitive, partial match)'),
  from: localDate('from').optional().describe('First bucket, inclusive, as a local date in "timezone". Defaults to the first day with matching scrobbles; an earlier value is pulled forward to it.'),
  to: localDate('to').optional().describe('Last bucket, inclusive, as a local date in "timezone". Defaults to today; a later value is pushed back to today, so the future is never reported as silence.'),
  group_by: z.enum(['artist', 'album', 'track']).default('artist')
    .describe('The entity stacked within each bucket. Album and track entities are keyed "<artist> – <name>", so same-titled records by different artists do not merge.'),
  min_plays: z.number().int().min(1).max(10_000).default(1)
    .describe('Drop entities below this many plays within a bucket. Dropped, not folded — the bucket\'s "plays" stays the true total, so "entities" then sums to less than it.'),
  timezone: z.string().refine(isTimeZoneShaped, {
    message: 'timezone must be an IANA zone name such as "Europe/Oslo" or "UTC"',
  }).default(STREAM_TIMEZONE)
    .describe('IANA zone the calendar buckets are cut in, as Postgres spells it. played_at is stored UTC; bucketing on UTC dates misfiles evening listening after 22:00 local in summer onto the next day. Backward-compatibility links such as "US/Pacific" are NOT accepted — use the canonical name ("America/Los_Angeles").'),
  include_empty_buckets: z.boolean().default(true)
    .describe('Emit zero rows for silent buckets so a client need not reconstruct the gaps. A week of not listening is signal, not missing data.'),
})

const bucketParam = z.enum(['day', 'week', 'month'] as const)

/**
 * The MCP surface. Defaults to MONTHLY, TOP 12 — a bare call must be readable in a chat
 * context, and the full archive at daily resolution with every entity is 3,894 buckets
 * and ~1.2 MB (measured, not estimated; the spec's 400 KB guess was three times out).
 * Those defaults come back at ~41 KB. Ask for `bucket: "day"` explicitly when you want
 * the series itself, and prefer a from/to window with it.
 *
 * This is the one place MCP and REST diverge, and the divergence is exactly these two
 * defaults; `src/rest/table.ts`'s header comment otherwise holds. Both surfaces run the
 * same handler over the same core schema, and
 * `src/mcp/tools/scrobble-timeline.test.ts` pins both default sets so a refactor that
 * unifies them fails rather than quietly changing what a bare call returns.
 */
export const getScrobbleTimelineSchema = timelineCoreSchema.extend({
  bucket: bucketParam.default('month')
    .describe('Bucketing axis. Defaults to "month" on MCP so a bare call stays small; pass "day" for the full series.'),
  top_n: z.number().int().min(0).max(1000).default(12)
    .describe('Per-bucket cap; 0 means every entity. Overflow is summed into one synthetic row whose key the response reports as "other_key". Defaults to 12 on MCP.'),
})

/** The REST surface: the full daily series with every entity, which is what a chart wants. */
export const getScrobbleTimelineRestSchema = timelineCoreSchema.extend({
  bucket: bucketParam.default('day')
    .describe('Bucketing axis. Defaults to "day" on REST.'),
  top_n: z.number().int().min(0).max(1000).default(0)
    .describe('Per-bucket cap; 0 (the REST default) means every entity. Overflow is summed into one synthetic row whose key the response reports as "other_key".'),
})

export type ScrobbleTimelineInput = z.infer<typeof getScrobbleTimelineSchema>

// ---- the zone set Postgres will accept -------------------------------------

/**
 * The zones this database recognises, lowercased — Postgres matches a zone name
 * case-insensitively, so `europe/oslo` is as valid as `Europe/Oslo`.
 *
 * Cached for the life of the process, because `pg_timezone_names` reads the whole tz
 * database on every call — 11 ms measured, against a Set lookup afterwards — and the
 * set cannot change without replacing the image, which restarts this process.
 *
 * Asked at all because nothing in JS agrees with Postgres about which zones exist; see
 * `isTimeZoneShaped` in src/lib/scrobble-timeline.ts for the two ways that goes wrong.
 */
let knownZones: Promise<Set<string>> | null = null

function loadKnownZones(db: ReturnType<typeof getDb>): Promise<Set<string>> {
  if (!knownZones) {
    knownZones = db
      .execute<{ name: string }>(sql`select name from pg_timezone_names`)
      .then((rows) => new Set((rows as unknown as Array<{ name: string }>).map((r) => r.name.toLowerCase())))
      .catch((e) => {
        // Never cache a failure: a connection blip would make every later call refuse
        // every zone, including the default.
        knownZones = null
        throw e
      })
  }
  return knownZones
}

// ---- handler ---------------------------------------------------------------

export async function getScrobbleTimeline(input: ScrobbleTimelineInput): Promise<Timeline> {
  const db = getDb()
  const tz = input.timezone

  // Before anything is aggregated: a zone Postgres does not know would otherwise fail
  // the first query with a bare 22023 and reach the caller as a 500 over a value they
  // could have fixed. The shape was already checked by the schema; this is membership.
  if (!(await loadKnownZones(db)).has(tz.toLowerCase())) throw new UnknownTimeZoneError(tz)
  const filters = {
    artist: input.artist ?? null,
    album: input.album ?? null,
    track: input.track ?? null,
  }

  // Only the entity filters: `buildConditions`' from/to arms read ISO datetimes against
  // played_at, and these bounds are local calendar dates (see localWindowConditions).
  const base = buildConditions({
    artist: input.artist,
    album: input.album,
    track: input.track,
  })
  const baseWhere = base.length ? and(...base) : undefined

  // The archive's own bounds, unwindowed, so a wide-open `from` costs nothing and
  // `to` can be clamped to today rather than emitting the future as silence.
  const [bounds] = await db
    .select({
      min: sql<string | null>`to_char(min(${localAt(tz)}), 'YYYY-MM-DD')`,
      max: sql<string | null>`to_char(max(${localAt(tz)}), 'YYYY-MM-DD')`,
      today: sql<string>`to_char((now() AT TIME ZONE ${tz})::date, 'YYYY-MM-DD')`,
    })
    .from(scrobbles)
    .where(baseWhere)

  const range = resolveRange(
    { min: bounds?.min ?? null, max: bounds?.max ?? null, today: bounds?.today ?? '1970-01-01' },
    { from: input.from, to: input.to },
  )

  const shape = {
    bucket: input.bucket,
    groupBy: input.group_by,
    timezone: tz,
    topN: input.top_n,
    minPlays: input.min_plays,
    includeEmptyBuckets: input.include_empty_buckets,
    filters,
  }

  // No matching scrobbles at all, or a from/to that crosses over: a well-formed empty
  // answer rather than an error, since an empty window is a legitimate question.
  if (!range) return assembleTimeline({ ...shape, range: null, rows: [], entities: [] })

  const where = and(...base, ...localWindowConditions(range.from, range.to, tz))
  const key = localBucketExpr(input.bucket, tz)
  const nameExpr = nameExprFor(input.group_by)

  // GROUP BY the ORDINAL, not a second copy of the bucket expression.
  //
  // `bucket` and `timezone` are bound parameters, and re-emitting the fragment gives
  // them fresh placeholder numbers — $7 and $8 in the GROUP BY against $1 and $2 in the
  // SELECT. Postgres then sees two DIFFERENT expressions and refuses the query outright
  // ("played_at must appear in the GROUP BY clause"). `musicLane()` in
  // src/stream/lanes.ts groups on `1, 3` for the same reason. The entity columns are
  // safe to repeat: they carry no parameters.
  const FIRST_COLUMN = sql`1`

  // Range-wide per-entity figures are hoisted out of the buckets: repeating a Last.fm
  // image URL across thousands of days is most of the payload for none of the
  // information. The representative-image idiom is getScrobbleStats'.
  const imageExpr = sql<string | null>`(array_agg(${scrobbles.imageUrl} ORDER BY ${scrobbles.playedAt} DESC))[1]`

  // The flat aggregate is uncapped: top_n and min_plays are display decisions applied in
  // JS, which is what lets `plays` stay the bucket's true total. When the entity IS the
  // artist there is no second name column to select — selecting artist_name twice would
  // work but relies on positional mapping for no gain.
  const [flat, entityRows] = await Promise.all([
    nameExpr
      ? db.select({ bucket: key, artist: scrobbles.artistName, name: nameExpr, plays: count() })
        .from(scrobbles).where(where).groupBy(FIRST_COLUMN, scrobbles.artistName, nameExpr)
      : db.select({ bucket: key, artist: scrobbles.artistName, plays: count() })
        .from(scrobbles).where(where).groupBy(FIRST_COLUMN, scrobbles.artistName),
    nameExpr
      ? db.select({ artist: scrobbles.artistName, name: nameExpr, plays: count(), image: imageExpr })
        .from(scrobbles).where(where).groupBy(scrobbles.artistName, nameExpr)
      : db.select({ artist: scrobbles.artistName, plays: count(), image: imageExpr })
        .from(scrobbles).where(where).groupBy(scrobbles.artistName),
  ])

  // A row from the artist branch has no `name` at all; one from the album or track
  // branch has it and it may be null, which entityKey renders as UNKNOWN_NAME. Those
  // two cases must not be conflated — coalescing a null album to the artist's name
  // would file every album-less single under a fictitious album of that name.
  const nameOf = (r: { artist: string; name?: string | null }) => ('name' in r ? r.name ?? null : r.artist)

  const rows: FlatRow[] = flat.map((r) => ({
    bucket: r.bucket,
    key: entityKey(input.group_by, r.artist, nameOf(r)),
    plays: Number(r.plays),
  }))

  const entities: EntityRow[] = entityRows.map((r) => ({
    key: entityKey(input.group_by, r.artist, nameOf(r)),
    name: nameOf(r) ?? UNKNOWN_NAME,
    artist: r.artist,
    plays: Number(r.plays),
    image: r.image,
  }))

  return assembleTimeline({ ...shape, range, rows, entities })
}
