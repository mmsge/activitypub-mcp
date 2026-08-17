/**
 * Is a watched YouTube video a Short?
 *
 * Nothing in the archive says. Every one of the ~96k watch rows carries a `/watch?v=` URL,
 * never a `/shorts/` one, because My Activity does not distinguish the two — so nothing was
 * lost in collection, there is simply no flag to read. Aspect ratio, the one unambiguous
 * signal, is not exposed by the Data API either. Duration is the only proxy available
 * offline, and a flat "under three minutes" rule is wrong in two known directions:
 *
 *   - **Shorts did not exist before roughly September 2020.** Nothing uploaded earlier can
 *     be one, whatever its length.
 *   - **The ceiling was 60 seconds until 15 October 2024**, and 3 minutes after. A 90-second
 *     video uploaded in 2023 is not a Short, though a flat 180-second rule calls it one.
 *
 * Over this archive a flat 180-second rule mislabels about 5,950 of the 59,012 rows it
 * catches, roughly 10 %.
 *
 * **The subtlety that matters most: the archive holds the date each video was WATCHED, not
 * when it was UPLOADED.** The era rules are only sound against the upload date. A 45-second
 * video watched in 2025 could have been uploaded in 2013. A watch date bounds the upload
 * date from ABOVE and never from below, which gives certainty in exactly one direction:
 * something watched before September 2020 cannot be a Short. That asymmetry is why this
 * module has two functions rather than one, and why the offline one keys on the EARLIEST
 * watch — the tightest such bound available.
 *
 * Everything here is pure: no database, no network. CI has no Postgres, so the rule lives
 * where it can actually be asserted, in the shape of `planGardenSync`. See ADR 0049.
 */

/**
 * Shorts did not exist before this. The real rollout was staged through 2020 and the exact
 * day is not public, so this is deliberately the conservative edge of "roughly September
 * 2020": a video watched earlier is ruled out, and one watched later is merely not ruled
 * out. Nothing here ever asserts a Short on the strength of a date.
 */
export const SHORTS_ERA_START = '2020-09-01'

/** The day the ceiling moved from 60 seconds to 3 minutes. */
export const SHORTS_LIMIT_CHANGE = '2024-10-15'

/** The ceiling before {@link SHORTS_LIMIT_CHANGE}. A 60-second Short is a Short. */
export const SHORTS_LIMIT_EARLY_SECONDS = 60

/** The ceiling from {@link SHORTS_LIMIT_CHANGE} onwards. */
export const SHORTS_LIMIT_LATE_SECONDS = 180

/**
 * How a verdict was reached. Stored on the row, because the point of the exercise is that a
 * later run can upgrade a guess to a verified answer, and that the stats can say "of the
 * ones we actually know" without pretending.
 *
 *   - `duration_rule`   — settled offline from duration and the earliest watch date
 *   - `api_metadata`    — settled against the real upload date from videos.list
 *   - `probe`           — verified by requesting the /shorts/ URL
 *   - `unclassifiable`  — TERMINAL. No duration and no working URL; nothing can decide it.
 *
 * A null method means no verdict yet — still ambiguous, awaiting a later stage. That is a
 * different thing from `unclassifiable`, and conflating them is what would cause the ~10.7k
 * dead videos to be retried forever.
 */
export type ShortsMethod = 'duration_rule' | 'api_metadata' | 'probe' | 'unclassifiable'

/** Why, in enough detail to print a funnel. */
export type ShortsReason =
  | 'no_duration'
  | 'watched_before_shorts_existed'
  | 'longer_than_watch_era_limit'
  | 'uploaded_before_shorts_existed'
  | 'longer_than_upload_era_limit'
  | 'stays_on_shorts_url'
  | 'redirects_to_watch_url'
  | 'ambiguous'

export interface ShortsVerdict {
  /** true, false, or null — three states, never a bare boolean. */
  isShort: boolean | null
  /** null when there is no verdict yet, as distinct from `unclassifiable`. */
  method: ShortsMethod | null
  reason: ShortsReason
}

/** No verdict yet. Not an answer — an admission that this stage had nothing to say. */
export const PENDING: ShortsVerdict = { isShort: null, method: null, reason: 'ambiguous' }

/**
 * The maximum length a Short could have been, for something dated `iso`.
 *
 * Dates are compared as ISO strings, which sorts correctly and — more to the point — does
 * not reparse a wall clock through a timezone. `watched_at_local` is a bare Europe/Oslo wall
 * clock (ADR 0047) and `snippet.publishedAt` is a UTC instant; both are compared against
 * these date-only boundaries in their own frame. The couple of hours of slop that introduces
 * at each boundary is immaterial against a rollout date that is itself only known to the
 * month, and it errs toward leaving a row ambiguous rather than deciding it wrongly.
 */
export function shortsLimitSeconds(iso: string): number {
  return iso < SHORTS_LIMIT_CHANGE ? SHORTS_LIMIT_EARLY_SECONDS : SHORTS_LIMIT_LATE_SECONDS
}

/**
 * Stage 0 — free, offline, no network. Decides about a third of the archive.
 *
 * `firstWatchedAtLocal` must be the EARLIEST watch of the video, not the latest and not an
 * arbitrary one. The rule is only sound because that date is an upper bound on the upload
 * date, and the earliest watch is the tightest bound the archive holds. Keying it on the
 * most recent watch instead would let a 2019 video rewatched in 2025 escape the date rule.
 */
export function classifyOffline(video: {
  durationSeconds: number | null
  firstWatchedAtLocal: string
}): ShortsVerdict {
  // Terminal. These are the deleted and private videos — no duration was ever scraped and
  // the URL does not resolve, so no stage can decide them. They must never be retried.
  if (video.durationSeconds === null) {
    return { isShort: null, method: 'unclassifiable', reason: 'no_duration' }
  }

  // The one direction a watch date gives certainty in.
  if (video.firstWatchedAtLocal < SHORTS_ERA_START) {
    return { isShort: false, method: 'duration_rule', reason: 'watched_before_shorts_existed' }
  }

  // Uploaded at or before the earliest watch, so the ceiling in force at upload was at most
  // the one in force at that watch. Longer than that and it cannot have been a Short.
  if (video.durationSeconds > shortsLimitSeconds(video.firstWatchedAtLocal)) {
    return { isShort: false, method: 'duration_rule', reason: 'longer_than_watch_era_limit' }
  }

  // Short enough, and new enough, to still be either.
  return PENDING
}

/**
 * Stage 1 — the same rules against `snippet.publishedAt`, the real upload date, so they are
 * exact rather than bounded.
 *
 * **This can only ever return `false`.** No metadata YouTube serves proves a video IS a
 * Short — the Data API exposes no aspect ratio and no Shorts flag — so a `true` verdict can
 * only ever come from the probe. Stage 1 earns its keep by shrinking the band the probe has
 * to walk, not by answering it.
 */
export function classifyFromMetadata(video: {
  durationSeconds: number | null
  publishedAt: string | null
}): ShortsVerdict {
  // videos.list returned nothing usable. The caller records the attempt; it is not terminal
  // here, because a missing id and a malformed duration are different failures.
  if (video.publishedAt === null || video.durationSeconds === null) return PENDING

  if (video.publishedAt < SHORTS_ERA_START) {
    return { isShort: false, method: 'api_metadata', reason: 'uploaded_before_shorts_existed' }
  }

  if (video.durationSeconds > shortsLimitSeconds(video.publishedAt)) {
    return { isShort: false, method: 'api_metadata', reason: 'longer_than_upload_era_limit' }
  }

  return PENDING
}

/**
 * Stage 2 — the only thing that can confirm a Short.
 *
 * A real Short stays on `/shorts/<id>`; anything else redirects to `/watch?v=<id>`.
 */
export function classifyFromProbe(staysOnShortsUrl: boolean): ShortsVerdict {
  return staysOnShortsUrl
    ? { isShort: true, method: 'probe', reason: 'stays_on_shorts_url' }
    : { isShort: false, method: 'probe', reason: 'redirects_to_watch_url' }
}
