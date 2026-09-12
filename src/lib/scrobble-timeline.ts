/**
 * The pure half of `get_scrobble_timeline`: bucket keys, per-bucket folding, tie-broken
 * winners, and the assembly of the whole response from flat aggregate rows.
 *
 * Nothing here touches the database, and nothing here knows about timezones. The one
 * timezone rule — that a bucket is a LOCAL calendar period, not a UTC one — lives in the
 * SQL, which hands these functions bucket keys that are already local dates. A second
 * implementation in JS is exactly the drift worth avoiding: the offset is +01:00 in
 * winter and +02:00 in summer, so two implementations disagree twice a year about
 * roughly two hours of evening listening, in a way no query error would ever reveal.
 *
 * Stepping a `YYYY-MM-DD` string forward by a day, a week or a month is pure calendar
 * arithmetic, which is why the enumeration below can be timezone-free.
 */

export type Bucket = 'day' | 'week' | 'month'
export type GroupBy = 'artist' | 'album' | 'track'

export const BUCKETS: readonly Bucket[] = ['day', 'week', 'month']

/**
 * A defensive ceiling on the enumerated bucket count, not a user-facing limit.
 *
 * The resolved range is intersected with the archive's own bounds before enumeration
 * (see `resolveRange`), so a caller asking `from=1900-01-01` gets the archive start
 * rather than 46,000 rows of pre-Last.fm silence. This guard therefore signals a bug in
 * that clamping rather than a bad request — 55 years of daily buckets is far more than
 * the data can produce.
 */
export const MAX_BUCKETS = 20_000

const KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A bucket key as a UTC instant, purely so the Date object's calendar arithmetic can be
 * borrowed. The instant is meaningless; only the Y-M-D is.
 *
 * Round-tripped because `Date.UTC` silently rolls an impossible date over: without the
 * check, `2026-02-30` would be accepted and answered as `2026-03-02`.
 */
function toCalendar(key: string): Date {
  if (!KEY_RE.test(key)) throw new TypeError(`Not a bucket key: ${JSON.stringify(key)}`)
  const [y, m, d] = key.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d))
  if (Number.isNaN(at.getTime()) || fromCalendar(at) !== key) {
    throw new TypeError(`Not a real date: ${JSON.stringify(key)}`)
  }
  return at
}

function fromCalendar(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/**
 * The key of the bucket a date falls in — which must agree with what `date_trunc` in the
 * SQL produces, or the enumerated buckets and the aggregated ones would not line up.
 *
 * `date_trunc('week', …)` truncates to Monday, so a week bucket is keyed on its Monday.
 */
export function bucketStart(date: string, bucket: Bucket): string {
  const at = toCalendar(date)
  if (bucket === 'day') return fromCalendar(at)
  if (bucket === 'month') return `${date.slice(0, 7)}-01`
  const dow = at.getUTCDay() // 0 = Sunday
  at.setUTCDate(at.getUTCDate() - ((dow + 6) % 7)) // back to Monday
  return fromCalendar(at)
}

/** The next bucket key after `key`. Month keys are rebuilt, never incremented. */
export function nextBucketKey(key: string, bucket: Bucket): string {
  const at = toCalendar(key)
  if (bucket === 'day') {
    at.setUTCDate(at.getUTCDate() + 1)
    return fromCalendar(at)
  }
  if (bucket === 'week') {
    at.setUTCDate(at.getUTCDate() + 7)
    return fromCalendar(at)
  }
  // `setUTCMonth(+1)` from the 31st overflows into the month after next (31 January
  // becomes 2 or 3 March). A month bucket is always the 1st, so rebuild it.
  const y = at.getUTCFullYear()
  const m = at.getUTCMonth()
  return fromCalendar(new Date(Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1)))
}

/**
 * Every bucket key from `from`'s bucket through `to`'s, inclusive — including the silent
 * ones, which is the whole point. A week of not listening is signal, not missing data,
 * and reconstructing the gaps client-side means reimplementing this.
 */
export function bucketKeys(from: string, to: string, bucket: Bucket): string[] {
  const last = toCalendar(to).getTime()
  const keys: string[] = []
  let key = bucketStart(from, bucket)
  while (toCalendar(key).getTime() <= last) {
    keys.push(key)
    if (keys.length > MAX_BUCKETS) {
      throw new RangeError(`Bucket enumeration exceeded ${MAX_BUCKETS} for ${from}..${to} by ${bucket}`)
    }
    key = nextBucketKey(key, bucket)
  }
  return keys
}

/**
 * Intersect what the caller asked for with what the archive can answer.
 *
 * `from` is pulled forward to the first day with data, so a wide-open lower bound costs
 * nothing. `to` is pushed back to today, so the future is never emitted as silence —
 * but it is NOT pushed back to the last day with data, because trailing zero buckets are
 * the answer to "has he stopped listening?".
 *
 * Returns null when the filtered archive is empty; there is no range to report then.
 */
export function resolveRange(
  bounds: { min: string | null; max: string | null; today: string },
  requested: { from?: string; to?: string },
): { from: string; to: string } | null {
  if (!bounds.min || !bounds.max) return null
  const from = requested.from && requested.from > bounds.min ? requested.from : bounds.min
  const wanted = requested.to ?? bounds.today
  const to = wanted < bounds.today ? wanted : bounds.today
  return to < from ? null : { from, to }
}

// ---- entity keys -----------------------------------------------------------

/**
 * The key an entity is reported under.
 *
 * An artist is its own name. An album or a track carries the artist, because
 * `get_scrobble_stats` groups those by `(artist, name)` precisely so same-titled records
 * by different artists do not merge, and keying a timeline on the bare name would undo
 * that. The key is an identity, not data — every entity also reports `artist` and `name`
 * as fields, so nothing downstream has to parse it back apart.
 */
export const UNKNOWN_NAME = '(unknown)'

export function entityKey(groupBy: GroupBy, artist: string, name: string | null): string {
  const label = name ?? UNKNOWN_NAME
  return groupBy === 'artist' ? artist : `${artist} – ${label}`
}

export const OTHER_KEY = 'Other'

/**
 * The key the `top_n` overflow is folded into.
 *
 * `Other` unless a real entity is already called that, in which case it steps aside.
 * Silently merging an actual artist named "Other" into the overflow row would be
 * undetectable from the response, so the envelope reports whichever key was used and a
 * client reads it rather than assuming.
 */
export function foldKeyFor(taken: Iterable<string>): string {
  const names = new Set(taken)
  if (!names.has(OTHER_KEY)) return OTHER_KEY
  if (!names.has(`${OTHER_KEY} (folded)`)) return `${OTHER_KEY} (folded)`
  for (let n = 2; ; n++) {
    const key = `${OTHER_KEY} (folded ${n})`
    if (!names.has(key)) return key
  }
}

// ---- per-bucket shaping ----------------------------------------------------

export type EntityTotals = ReadonlyMap<string, number>

/**
 * Order two entities within a bucket: more plays first, ties broken by the higher
 * range-wide play count, then by key ascending byte-wise.
 *
 * Byte-wise rather than `localeCompare` for the same reason `compareEntries` in
 * `src/stream/event-date.ts` is: the answer must be identical between calls and between
 * machines, and a locale-aware collation is neither.
 */
function compareInBucket(
  a: readonly [string, number],
  b: readonly [string, number],
  rangePlays: EntityTotals,
): number {
  if (a[1] !== b[1]) return b[1] - a[1]
  const ra = rangePlays.get(a[0]) ?? 0
  const rb = rangePlays.get(b[0]) ?? 0
  if (ra !== rb) return rb - ra
  if (a[0] === b[0]) return 0
  return a[0] < b[0] ? -1 : 1
}

/**
 * The entity that won a bucket.
 *
 * Picked from the bucket's RAW counts, before `min_plays` and `top_n` touch anything, so
 * the answer to "who won this day" does not change with a display parameter and the fold
 * key can never win. Null for a silent bucket.
 */
export function pickTop(raw: EntityTotals, rangePlays: EntityTotals): string | null {
  let best: readonly [string, number] | null = null
  for (const entry of raw) {
    if (!best || compareInBucket(entry, best, rangePlays) < 0) best = entry
  }
  return best ? best[0] : null
}

/**
 * A bucket's reported breakdown: drop below `min_plays`, cap at `top_n`, sum the
 * remainder into the fold key.
 *
 * A dropped entity is dropped, not folded — `min_plays` exists to remove the long tail,
 * and folding it would put it straight back as a single large bar. Insertion order is
 * plays-descending, which JSON preserves.
 */
export function foldBucket(
  raw: EntityTotals,
  opts: { topN: number; minPlays: number; foldKey: string; rangePlays: EntityTotals },
): Record<string, number> {
  const kept = [...raw]
    .filter(([, plays]) => plays >= opts.minPlays)
    .sort((a, b) => compareInBucket(a, b, opts.rangePlays))

  const head = opts.topN > 0 ? kept.slice(0, opts.topN) : kept
  const out: Record<string, number> = {}
  for (const [key, plays] of head) out[key] = plays

  if (opts.topN > 0 && kept.length > opts.topN) {
    let rest = 0
    for (const [, plays] of kept.slice(opts.topN)) rest += plays
    if (rest > 0) out[opts.foldKey] = rest
  }
  return out
}

// ---- assembly --------------------------------------------------------------

/** One `(bucket, entity, plays)` row from the flat aggregate. */
export type FlatRow = { bucket: string; key: string; plays: number }

/** One entity's range-wide figures. */
export type EntityRow = {
  key: string
  name: string
  artist: string
  plays: number
  image: string | null
}

export type TimelineBucket = {
  date: string
  plays: number
  top: string | null
  entities: Record<string, number>
}

export type Timeline = {
  bucket: Bucket
  group_by: GroupBy
  timezone: string
  range: { from: string | null; to: string | null }
  totals: {
    buckets: number
    active_buckets: number
    scrobbles: number
    distinct_artists: number
    distinct_entities: number
  }
  other_key: string
  entities: Record<string, { plays: number; image: string | null; artist: string; name: string }>
  buckets: TimelineBucket[]
  filters: { artist: string | null; album: string | null; track: string | null }
}

/**
 * Build the response from the three things the database supplies: the flat
 * bucket×entity aggregate, the range-wide per-entity rollup, and the resolved range.
 *
 * Buckets come back newest-first, matching every other feed here.
 */
export function assembleTimeline(input: {
  bucket: Bucket
  groupBy: GroupBy
  timezone: string
  range: { from: string; to: string } | null
  rows: readonly FlatRow[]
  entities: readonly EntityRow[]
  topN: number
  minPlays: number
  includeEmptyBuckets: boolean
  filters: { artist: string | null; album: string | null; track: string | null }
}): Timeline {
  const rangePlays = new Map(input.entities.map((e) => [e.key, e.plays]))
  const foldKey = foldKeyFor(rangePlays.keys())

  const byBucket = new Map<string, Map<string, number>>()
  for (const row of input.rows) {
    let entry = byBucket.get(row.bucket)
    if (!entry) byBucket.set(row.bucket, (entry = new Map()))
    // The same (bucket, entity) can only appear once, but summing rather than assigning
    // keeps this correct if a caller ever pre-merges two group_by dimensions.
    entry.set(row.key, (entry.get(row.key) ?? 0) + row.plays)
  }

  const keys = input.range ? bucketKeys(input.range.from, input.range.to, input.bucket) : []

  const buckets: TimelineBucket[] = []
  const referenced = new Set<string>()
  let activeBuckets = 0
  for (const date of keys) {
    const raw = byBucket.get(date) ?? new Map<string, number>()
    let plays = 0
    for (const n of raw.values()) plays += n
    if (plays > 0) activeBuckets++
    const shown = foldBucket(raw, { topN: input.topN, minPlays: input.minPlays, foldKey, rangePlays })
    for (const key of Object.keys(shown)) referenced.add(key)
    if (plays === 0 && !input.includeEmptyBuckets) continue
    buckets.push({
      date,
      // The bucket's TRUE total, which does not move with min_plays or top_n — so two
      // calls with different display parameters return comparable series. When
      // min_plays drops a tail, `entities` sums to less than this on purpose.
      plays,
      top: pickTop(raw, rangePlays),
      entities: shown,
    })
  }
  buckets.reverse() // newest first

  const artists = new Set(input.entities.map((e) => e.artist))
  let scrobbles = 0
  for (const e of input.entities) scrobbles += e.plays

  // Only the entities some bucket actually shows.
  //
  // At `top_n: 0` that is every one of them, which is the chart's case and unchanged.
  // But a capped call lists at most `top_n` per bucket, and carrying the other ~2,400
  // range-wide rows anyway was 262 KB of the monthly top-12 answer's 275 KB — the
  // default whose entire job is to fit in a chat context. An entity that never makes a
  // single bucket's cut is invisible in the series, so its all-time total is not what
  // this call is for; ask with a higher `top_n`, or `get_scrobble_stats`, for that.
  //
  // `totals` is computed above from the unfiltered set, so the totals still describe the
  // whole range rather than the part that fitted.
  const entities: Timeline['entities'] = {}
  for (const e of [...input.entities].sort((a, b) => b.plays - a.plays || (a.key < b.key ? -1 : 1))) {
    if (!referenced.has(e.key)) continue
    entities[e.key] = { plays: e.plays, image: e.image, artist: e.artist, name: e.name }
  }

  return {
    bucket: input.bucket,
    group_by: input.groupBy,
    timezone: input.timezone,
    range: { from: input.range?.from ?? null, to: input.range?.to ?? null },
    totals: {
      // Every bucket in the range, including the silent ones that
      // include_empty_buckets: false leaves out of the array.
      buckets: keys.length,
      active_buckets: activeBuckets,
      scrobbles,
      distinct_artists: artists.size,
      distinct_entities: input.entities.length,
    },
    other_key: foldKey,
    entities,
    buckets,
    filters: input.filters,
  }
}

// ---- timezone validation ---------------------------------------------------

/**
 * Raised when `timezone` is a well-formed zone name Postgres does not know.
 *
 * A distinct type because it is a CALLER error: `src/rest/router.ts` maps it to a 400
 * naming the zone, the way it already does for `InvalidCursorError`. Without that it
 * would surface as an opaque 500 over a value the caller could fix.
 */
export class UnknownTimeZoneError extends Error {
  constructor(tz: string) {
    super(`Unknown timezone ${JSON.stringify(tz)}. Use an IANA zone name Postgres recognises, such as "Europe/Oslo" or "UTC" — note that backward-compatibility links like "US/Pacific" and "Asia/Calcutta" are not among them.`)
    this.name = 'UnknownTimeZoneError'
  }
}

/**
 * Whether `tz` is SHAPED like a zone name. A cheap syntactic gate, not an authority.
 *
 * Membership is decided by `pg_timezone_names`, because Postgres is the only thing that
 * knows what Postgres accepts, and nothing in JS agrees with it: `Intl.DateTimeFormat`
 * accepts 18 backward-compatibility links this Postgres rejects (`US/Pacific`,
 * `Asia/Calcutta`, `Europe/Kiev` among them — each one a 500 if trusted), while
 * `Intl.supportedValuesOf('timeZone')` omits 99 zones Postgres does accept (the whole
 * `America/Argentina/*` tree included), which would refuse valid questions. Neither set
 * contains the other, so neither can be the gate.
 *
 * This check exists only so obvious junk is refused without a connection, and so the
 * error a caller sees names the parameter rather than the query.
 */
const TZ_SHAPE = /^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+_.-]+){0,2}$/

export function isTimeZoneShaped(tz: string): boolean {
  return typeof tz === 'string' && tz.length <= 64 && TZ_SHAPE.test(tz)
}
