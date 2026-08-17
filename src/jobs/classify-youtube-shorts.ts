import { sql, inArray } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { youtubeVideos } from '../db/schema.js'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import {
  classifyOffline,
  classifyFromMetadata,
  classifyFromProbe,
  type ShortsVerdict,
  type ShortsReason,
} from '../lib/youtube-shorts.js'
import {
  fetchYoutubeVideos,
  YOUTUBE_VIDEOS_BATCH_SIZE,
  YOUTUBE_VIDEOS_QUOTA_UNITS_PER_CALL,
  type YoutubeVideoMetadata,
} from '../lib/fetch-youtube-videos.js'
import { probeYoutubeShort } from '../lib/probe-youtube-short.js'

/**
 * Classify the watch archive's videos as Shorts, cheapest signal first.
 *
 * Three stages, each only touching what the one before it could not settle:
 *
 *   0. offline, free — duration against the era rules, keyed on the earliest watch
 *   1. videos.list, 50 ids per quota unit — the same rules against the real upload date
 *   2. an HTTP probe, expensive and rate-limited — the only stage that can confirm a Short
 *
 * The job is idempotent, resumable and bounded. All of that comes from one place: progress
 * lives in `youtube_videos`, never in memory, and every stage selects its own work through
 * a partial index rather than remembering what it did. Running it twice in a row does
 * nothing the second time; killing it mid-run loses nothing and repeats nothing.
 *
 * See ADR 0049.
 */

/** Chunk size for the bulk stage-0 writes. Bounds statement size, nothing more. */
const WRITE_CHUNK = 2_000

/** After this many failed attempts a video is left alone until someone looks at it. */
const MAX_ATTEMPTS = 3

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface ClassifyShortsOptions {
  /** Report the funnel and write nothing. */
  dryRun?: boolean
  maxApiCalls?: number
  maxProbes?: number
  /** Stage 2 is separately switchable and off unless asked for. */
  probe?: boolean
}

export interface Stage0Counts {
  examined: number
  unclassifiable: number
  falseByWatchDate: number
  falseByEraLimit: number
  ambiguous: number
}

export interface ClassifyShortsResult {
  seeded: number
  stage0: Stage0Counts
  stage1: { calls: number; quotaUnits: number; videos: number; classified: number; missing: number; stopped: string | null }
  stage2: { probes: number; short: number; notShort: number; errors: number; stopped: string | null }
  /** Whole-table state after the run. */
  pending: number
  terminal: number
  gaveUp: number
  dryRun: boolean
}

// ---- shared write helpers ---------------------------------------------------

const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/**
 * Apply one verdict to many videos.
 *
 * `is_short_checked_at` is set even when there is no verdict. That is what makes stage 0
 * terminate: "examined" and "decided" are different facts, and only recording the second
 * would make every later run re-examine the whole ambiguous band.
 */
async function writeVerdict(db: ReturnType<typeof getDb>, videoIds: string[], verdict: ShortsVerdict): Promise<void> {
  for (const ids of chunk(videoIds, WRITE_CHUNK)) {
    await db
      .update(youtubeVideos)
      .set({
        isShort: verdict.isShort,
        isShortMethod: verdict.method,
        isShortCheckedAt: new Date(),
        isShortError: null,
      })
      .where(inArray(youtubeVideos.videoId, ids))
  }
}

// ---- step 0: seed -----------------------------------------------------------

/**
 * Give every distinct watched video a row.
 *
 * This is the whole of "a future sync of new videos is handled by the same job with no
 * special casing": a newly imported watch produces a video row with a null
 * `is_short_checked_at`, which is exactly what stage 0 selects.
 */
async function seed(db: ReturnType<typeof getDb>): Promise<number> {
  const inserted = await db.execute(sql`
    INSERT INTO youtube_videos (video_id)
    SELECT DISTINCT video_id FROM youtube_watches
    ON CONFLICT (video_id) DO NOTHING
    RETURNING video_id`)
  return inserted.length
}

// ---- stage 0: offline -------------------------------------------------------

interface OfflineCandidate {
  video_id: string
  first_watch: string
  duration_seconds: number | null
}

/**
 * Every video no stage has looked at yet, with the two facts the offline rule needs.
 *
 * `min(watched_at_local)` — the EARLIEST watch, because a watch date bounds the upload date
 * from above and never from below, so only the earliest one is a sound bound.
 *
 * `max(duration_seconds)` — `max` ignores nulls, so one duration-less watch row of a video
 * cannot erase a duration another row of the same video does have.
 *
 * Rendered with `to_char` off the LOCAL column, never the instant: the wall clock is the
 * authority (ADR 0047), and the classifier compares it as a string precisely so it is never
 * reparsed through a timezone on the way.
 *
 * **Driven from `youtube_watches`, LEFT JOINed to `youtube_videos`, not the other way
 * round.** The watches are what say which videos exist; the videos table is only where
 * verdicts are kept. `v.is_short_checked_at IS NULL` is then true both for a video that has
 * no row yet and for one whose row nothing has examined — which is what lets a dry run
 * report the real funnel without seeding a single row first. Selecting from the videos
 * table instead would make the dry run report zeros on a fresh database, which is exactly
 * the shape of "reports without writing anything" being quietly false.
 */
async function stage0(db: ReturnType<typeof getDb>, dryRun: boolean): Promise<Stage0Counts> {
  const rows = (await db.execute(sql`
    SELECT w.video_id AS video_id,
           to_char(min(w.watched_at_local), 'YYYY-MM-DD"T"HH24:MI:SS') AS first_watch,
           max(w.duration_seconds) AS duration_seconds
    FROM youtube_watches w
    LEFT JOIN youtube_videos v ON v.video_id = w.video_id
    WHERE v.is_short_checked_at IS NULL
    GROUP BY w.video_id`)) as unknown as OfflineCandidate[]

  // Grouped by verdict rather than classified row by row in SQL: the rule exists once, in
  // the pure module that CI can actually assert, and the dry run runs the same code path as
  // the write so it genuinely predicts it rather than approximating it.
  const byReason = new Map<ShortsReason, { verdict: ShortsVerdict; ids: string[] }>()
  for (const row of rows) {
    const verdict = classifyOffline({
      durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
      firstWatchedAtLocal: row.first_watch,
    })
    const bucket = byReason.get(verdict.reason) ?? { verdict, ids: [] }
    bucket.ids.push(row.video_id)
    byReason.set(verdict.reason, bucket)
  }

  const n = (reason: ShortsReason) => byReason.get(reason)?.ids.length ?? 0
  const counts: Stage0Counts = {
    examined: rows.length,
    unclassifiable: n('no_duration'),
    falseByWatchDate: n('watched_before_shorts_existed'),
    falseByEraLimit: n('longer_than_watch_era_limit'),
    ambiguous: n('ambiguous'),
  }

  if (!dryRun) {
    for (const { verdict, ids } of byReason.values()) await writeVerdict(db, ids, verdict)
  }

  return counts
}

// ---- the pending queue ------------------------------------------------------

/**
 * Videos still without a verdict, fewest attempts first.
 *
 * Ordered in SQL rather than filtered in JS. `sync-neodb-metadata.ts` builds its todo list
 * by subtracting fresh rows from an unordered set, which means a permanently-failing prefix
 * longer than the per-run cap is retried on every pass forever while everything behind it
 * starves. `sync-stations.ts` does it this way instead, and so does this.
 *
 * The `is_short_method IS NULL` predicate is also what keeps the ~10.7k unclassifiable
 * videos out: they carry a method, so they are not in the partial index at all and no
 * amount of running this can select them.
 */
async function pendingVideoIds(db: ReturnType<typeof getDb>, limit: number): Promise<string[]> {
  if (limit <= 0) return []
  const rows = (await db.execute(sql`
    SELECT video_id
    FROM youtube_videos
    WHERE is_short_method IS NULL
      AND is_short_checked_at IS NOT NULL
      AND is_short_attempts < ${MAX_ATTEMPTS}
    ORDER BY is_short_attempts ASC, video_id ASC
    LIMIT ${limit}`)) as unknown as { video_id: string }[]
  return rows.map((r) => r.video_id)
}

// ---- stage 1: videos.list ---------------------------------------------------

async function persistMetadata(db: ReturnType<typeof getDb>, meta: YoutubeVideoMetadata, verdict: ShortsVerdict): Promise<void> {
  await db
    .update(youtubeVideos)
    .set({
      publishedAt: meta.publishedAt ? new Date(meta.publishedAt) : null,
      durationSeconds: meta.durationSeconds,
      title: meta.title,
      channelId: meta.channelId,
      channelTitle: meta.channelTitle,
      categoryId: meta.categoryId,
      apiFetchedAt: new Date(),
      apiMissing: false,
      isShort: verdict.isShort,
      isShortMethod: verdict.method,
      isShortCheckedAt: new Date(),
      isShortError: null,
      // An id that answered is not a failing id, whatever it did last time.
      isShortAttempts: 0,
    })
    .where(inArray(youtubeVideos.videoId, [meta.videoId]))
}

async function stage1(db: ReturnType<typeof getDb>, maxCalls: number, dryRun: boolean): Promise<ClassifyShortsResult['stage1']> {
  const out: ClassifyShortsResult['stage1'] = { calls: 0, quotaUnits: 0, videos: 0, classified: 0, missing: 0, stopped: null }
  if (!config.YOUTUBE_API_KEY) return { ...out, stopped: 'no_api_key' }
  if (maxCalls <= 0) return { ...out, stopped: 'bounded' }
  if (dryRun) return { ...out, stopped: 'dry_run' }

  const ids = await pendingVideoIds(db, maxCalls * YOUTUBE_VIDEOS_BATCH_SIZE)

  for (const batch of chunk(ids, YOUTUBE_VIDEOS_BATCH_SIZE)) {
    const res = await fetchYoutubeVideos(batch, config.YOUTUBE_API_KEY)
    out.calls += 1
    out.quotaUnits += YOUTUBE_VIDEOS_QUOTA_UNITS_PER_CALL
    out.videos += batch.length

    if (!res.ok) {
      // Quota exhaustion is not a failure of these ids and must not count against them:
      // bumping their attempts would eventually give up on videos nothing was ever asked
      // about. Stop the stage instead and come back when the quota resets.
      if (res.quotaExceeded) return { ...out, stopped: 'quota_exceeded' }
      await db
        .update(youtubeVideos)
        .set({ isShortAttempts: sql`${youtubeVideos.isShortAttempts} + 1`, isShortError: res.error.slice(0, 500), isShortCheckedAt: new Date() })
        .where(inArray(youtubeVideos.videoId, batch))
      continue
    }

    for (const meta of res.found.values()) {
      const verdict = classifyFromMetadata(meta)
      await persistMetadata(db, meta, verdict)
      if (verdict.method) out.classified += 1
    }

    if (res.missing.length > 0) {
      out.missing += res.missing.length
      // Deleted, private or region-blocked. Recorded as an attempt rather than as a
      // verdict: unlike a video with no duration at all, this one might come back, and
      // MAX_ATTEMPTS is what stops it being asked about forever.
      await db
        .update(youtubeVideos)
        .set({
          apiMissing: true,
          apiFetchedAt: new Date(),
          isShortAttempts: sql`${youtubeVideos.isShortAttempts} + 1`,
          isShortError: 'videos.list returned no entry for this id',
          isShortCheckedAt: new Date(),
        })
        .where(inArray(youtubeVideos.videoId, res.missing))
    }
  }

  return out
}

// ---- stage 2: the probe -----------------------------------------------------

/** Consecutive 429s after which the run gives up rather than spinning. */
const ABORT_AFTER_RATE_LIMITS = 3

async function stage2(db: ReturnType<typeof getDb>, maxProbes: number, dryRun: boolean): Promise<ClassifyShortsResult['stage2']> {
  const out: ClassifyShortsResult['stage2'] = { probes: 0, short: 0, notShort: 0, errors: 0, stopped: null }
  if (maxProbes <= 0) return { ...out, stopped: 'bounded' }
  if (dryRun) return { ...out, stopped: 'dry_run' }

  const ids = await pendingVideoIds(db, maxProbes)
  let consecutiveRateLimits = 0
  let backoffMs = config.YOUTUBE_SHORTS_PROBE_SPACING_MS

  for (const videoId of ids) {
    const outcome = await probeYoutubeShort(videoId)
    out.probes += 1

    if (outcome.kind === 'rate_limited') {
      consecutiveRateLimits += 1
      // Exponential, and honouring Retry-After when YouTube bothers to send one. This
      // endpoint 429s after two requests, so the only workable posture is to slow down and
      // eventually walk away — a tight retry loop would just extend the block.
      backoffMs = Math.max(backoffMs * 2, outcome.retryAfterMs ?? 0)
      if (consecutiveRateLimits >= ABORT_AFTER_RATE_LIMITS) return { ...out, stopped: 'rate_limited' }
      await sleep(backoffMs)
      continue
    }

    consecutiveRateLimits = 0
    backoffMs = config.YOUTUBE_SHORTS_PROBE_SPACING_MS

    if (outcome.kind === 'error') {
      out.errors += 1
      await db
        .update(youtubeVideos)
        .set({ isShortAttempts: sql`${youtubeVideos.isShortAttempts} + 1`, isShortError: outcome.error.slice(0, 500), isShortCheckedAt: new Date() })
        .where(inArray(youtubeVideos.videoId, [videoId]))
    } else {
      const verdict = classifyFromProbe(outcome.kind === 'short')
      if (verdict.isShort) out.short += 1
      else out.notShort += 1
      await writeVerdict(db, [videoId], verdict)
    }

    await sleep(config.YOUTUBE_SHORTS_PROBE_SPACING_MS)
  }

  return out
}

// ---- the run ----------------------------------------------------------------

async function tableState(db: ReturnType<typeof getDb>) {
  const [row] = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE is_short_method IS NULL AND is_short_attempts < ${MAX_ATTEMPTS}) AS pending,
      count(*) FILTER (WHERE is_short_method = 'unclassifiable') AS terminal,
      count(*) FILTER (WHERE is_short_method IS NULL AND is_short_attempts >= ${MAX_ATTEMPTS}) AS gave_up
    FROM youtube_videos`)) as unknown as { pending: string; terminal: string; gave_up: string }[]
  return { pending: Number(row?.pending ?? 0), terminal: Number(row?.terminal ?? 0), gaveUp: Number(row?.gave_up ?? 0) }
}

export async function classifyYoutubeShorts(options: ClassifyShortsOptions = {}): Promise<ClassifyShortsResult> {
  const db = getDb()
  const dryRun = options.dryRun ?? false
  const maxApiCalls = options.maxApiCalls ?? config.YOUTUBE_SHORTS_MAX_API_CALLS_PER_RUN
  const probeEnabled = options.probe ?? config.YOUTUBE_SHORTS_PROBE_ENABLED
  const maxProbes = probeEnabled ? (options.maxProbes ?? config.YOUTUBE_SHORTS_MAX_PROBES_PER_RUN) : 0

  // A dry run must not create rows either, or "reports without writing anything" would be
  // false on the very first invocation.
  const seeded = dryRun ? 0 : await seed(db)

  const stage0Counts = await stage0(db, dryRun)
  const stage1Result = await stage1(db, maxApiCalls, dryRun)
  const stage2Result = await stage2(db, maxProbes, dryRun)
  const state = await tableState(db)

  // A dry run wrote nothing, so the stored state does not yet include what stage 0 just
  // worked out. Projecting it forward is what makes the dry run predict the real run rather
  // than merely describe the database as it was.
  const projected = dryRun
    ? {
        pending: state.pending + stage0Counts.ambiguous,
        terminal: state.terminal + stage0Counts.unclassifiable,
        gaveUp: state.gaveUp,
      }
    : state

  const result: ClassifyShortsResult = {
    seeded,
    stage0: stage0Counts,
    stage1: stage1Result,
    stage2: stage2Result,
    ...projected,
    dryRun,
  }

  logger.info(
    {
      dry_run: dryRun,
      seeded,
      stage0: stage0Counts,
      stage1: stage1Result,
      stage2: stage2Result,
      pending: state.pending,
      terminal: state.terminal,
      gave_up: state.gaveUp,
    },
    'YouTube Shorts classification complete',
  )

  return result
}
