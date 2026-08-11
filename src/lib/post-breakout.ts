import { type BreakoutWeights } from '../config.js'
import { type NtfyMessage } from './ntfy.js'

/**
 * Pure decision logic for the breakout notifier — "this post is doing better than your
 * usual". Kept free of database and network access so the interesting part — which
 * rung fires, and when it must NOT fire again — is directly unit-testable.
 *
 * See decision record 0036.
 */

export type BreakoutRung = 'p90' | 'p99' | 'best'

/** Rung ordering, so "have we already announced this far or further?" is one compare. */
export const RUNG_ORDER: Record<BreakoutRung, number> = { p90: 1, p99: 2, best: 3 }

export interface BreakoutBaseline {
  actorApId: string
  /** Handle when we could resolve one; the AP id otherwise. Used in copy and reports. */
  actor: string
  /** Scored posts inside the window — the size of the population behind the percentiles. */
  n: number
  windowDays: number
  median: number
  p90: number
  p99: number
  /** All-time best score and the post holding it. Deliberately NOT windowed. */
  best: number
  bestApId: string | null
  /** All-time runner-up, so a post never has to beat itself. See `breakoutThresholds`. */
  secondBest: number
}

/**
 * Why an account is not armed. Three genuinely different situations that all look
 * identical from the phone, and reporting them as one cost a round-trip of hand-written
 * SQL the first time this shipped:
 *
 *  - `no_posts` — nothing scored in the window at all. The account is not being
 *    ingested, or has not posted lately. Not a breakout problem; look at the sampler.
 *  - `no_engagement_data` — posts ARE being sampled, but every one of them scores zero
 *    and always has. The origin does not report favourite/boost/reply counts back to
 *    us (fetchEngagement's 'unsupported' path). No threshold can help; the account
 *    will simply never fire.
 *  - `too_few_posts` — the ordinary case. Real engagement, just not enough history yet
 *    for a percentile to mean anything.
 */
export type BreakoutUnarmedReason = 'no_posts' | 'no_engagement_data' | 'too_few_posts'

export interface BreakoutThresholds {
  p90: number
  p99: number
  best: number
  /** False when nothing about this account can meaningfully fire. Nothing is written. */
  established: boolean
  reason?: BreakoutUnarmedReason
}

export interface BreakoutPost {
  apId: string
  actorApId: string
  url: string | null
  publishedAt: Date | null
  text: string | null
  visibility: string | null
  favourites: number
  reblogs: number
  replies: number
  /** Peak score across this post's whole snapshot history — see `decideBreakout`. */
  peak: number
  /** Score from the latest snapshot; can be lower than `peak`. */
  score: number
}

export interface BreakoutState {
  score: number
  peakScore: number
  rung: BreakoutRung | null
  rungScore: number | null
  p90At: Date | null
  p99At: Date | null
  bestAt: Date | null
  weightsKey: string
}

export type BreakoutKind = 'seeded' | 'reseeded' | 'none' | BreakoutRung

export interface BreakoutDecision {
  kind: BreakoutKind
  message: NtfyMessage | null
  /** State to persist — but only once the message has actually been delivered. */
  state: BreakoutState
}

const num = (n: number) => n.toLocaleString('nn-NO')

/** Norwegian date, for naming when an old record was set. */
export function osloDate(d: Date): string {
  return new Intl.DateTimeFormat('nn-NO', {
    timeZone: 'Europe/Oslo', day: 'numeric', month: 'long', year: 'numeric',
  }).format(d)
}

/** The Oslo calendar day as `YYYY-MM-DD`.
 *
 *  Never derived by UTC arithmetic: Oslo is UTC+1 or UTC+2 depending on the month, so
 *  a UTC day key would silently skip or double the digest twice a year. Same rule as
 *  decision record 0019 — a bucket is computed in the timezone its label is read in. */
export function osloDayKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

/** The Oslo hour, 0-23. */
export function osloHour(d: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo', hour: '2-digit', hour12: false,
  }).format(d))
}

export function scoreOf(
  counts: { favourites: number; reblogs: number; replies: number },
  w: BreakoutWeights,
): number {
  return Math.round(
    counts.favourites * w.favourites + counts.reblogs * w.reblogs + counts.replies * w.replies,
  )
}

/** Fingerprint of the weights, stored on each state row.
 *
 *  Changing a weight re-scores the entire archive in one tick. Without this, that
 *  reads as fifty posts breaking out in the same minute; with it, a mismatch re-seeds
 *  in silence. */
export function breakoutWeightsKey(w: BreakoutWeights): string {
  return `f${w.favourites}-r${w.reblogs}-y${w.replies}`
}

/**
 * Turn a baseline into the three thresholds a candidate is judged against.
 *
 * Three things happen here that the raw percentiles don't give you:
 *
 * 1. **The floor.** A percentile is relative, but "did particularly well" also has an
 *    absolute floor below which a push is noise — a p90 of 2 is arithmetic, not a
 *    compliment. Every rung is lifted to at least `minScore`.
 * 2. **Strict monotonicity.** With a small or flat population `percentile_cont(0.9)`
 *    and `percentile_cont(0.99)` can land on the same number, and the middle rung
 *    would then be unreachable — a post would cross p90 and p99 at once, forever.
 *    Each rung is forced at least one point above the one below it.
 * 3. **A post never has to beat itself.** When the candidate already holds the record,
 *    its record threshold comes from the runner-up. Otherwise the current record
 *    holder could never be told it had extended its own record, and — worse — a
 *    re-sampled record holder would compare against a number it had itself set.
 *
 * Percentiles are rounded UP: a p90 of 23.4 means the rung fires at 24, and integer
 * thresholds are what the push copy quotes.
 */
export function breakoutThresholds(
  baseline: BreakoutBaseline,
  opts: { minPosts: number; minScore: number; candidateApId?: string },
): BreakoutThresholds {
  // Order matters: the most specific diagnosis wins. An account with 19 zero-scoring
  // BookWyrm posts is not "nearly there" — it is never going to fire, and saying
  // "too few posts" would send you looking for more posts rather than for the counts.
  const reason: BreakoutUnarmedReason | null =
    baseline.n === 0 ? 'no_posts'
      : baseline.best === 0 ? 'no_engagement_data'
        : baseline.n < opts.minPosts ? 'too_few_posts'
          : null

  const floor = opts.minScore

  const p90 = Math.max(Math.ceil(baseline.p90), floor)
  const p99 = Math.max(Math.ceil(baseline.p99), p90 + 1, floor)

  const holdsRecord = opts.candidateApId != null && opts.candidateApId === baseline.bestApId
  const toBeat = holdsRecord ? baseline.secondBest : baseline.best
  const best = Math.max(toBeat + 1, p99 + 1, floor)

  return reason
    ? { p90, p99, best, established: false, reason }
    : { p90, p99, best, established: true }
}

/** The FURTHEST rung a score has reached, or null.
 *
 *  Inclusive on the number, matching `tightestCrossed` in the scrobble race: a rung is
 *  crossed ON its threshold, not one point past it. */
export function furthestRung(score: number, t: BreakoutThresholds): BreakoutRung | null {
  if (score >= t.best) return 'best'
  if (score >= t.p99) return 'p99'
  if (score >= t.p90) return 'p90'
  return null
}

/** First ~80 characters of a post, on one line, for the push body. */
export function excerpt(text: string | null, max = 80): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return '(utan tekst)'
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function counts(p: BreakoutPost): string {
  return `${num(p.favourites)} hjarte, ${num(p.reblogs)} framhevingar, ${num(p.replies)} svar`
}

/**
 * The push for one rung. Nynorsk, like every other string this codebase composes
 * (`composeIntro`/`composeStatus` in publish-status-note.ts). `publishNtfy` posts a
 * JSON body precisely so titles carrying å/ø/æ and curly quotes survive — do not
 * switch it to the header form.
 */
export function composeBreakoutMessage(
  post: BreakoutPost,
  rung: BreakoutRung,
  peak: number,
  baseline: BreakoutBaseline,
  t: BreakoutThresholds,
): NtfyMessage {
  const body = `«${excerpt(post.text)}»`
  const stats = `Skår ${num(peak)} (${counts(post)}).`
  const click = post.url ?? undefined

  if (rung === 'best') {
    const old = baseline.bestApId === post.apId ? baseline.secondBest : baseline.best
    return {
      title: 'Ny personleg rekord',
      body: `${body}\n${stats} Slår den gamle rekorden på ${num(old)}. Det beste innlegget ditt nokosinne.`,
      tags: ['trophy'],
      priority: 'high',
      click,
    }
  }

  if (rung === 'p99') {
    return {
      title: 'Topp 1 % — for deg',
      body: `${body}\n${stats} Over p99 (${num(t.p99)}): berre eitt av hundre innlegg dine gjer det betre. Rekorden din er ${num(baseline.best)}.`,
      tags: ['fire'],
      priority: 'high',
      click,
    }
  }

  return {
    title: 'Dette innlegget går godt',
    body: `${body}\n${stats} Over p90 (${num(t.p90)}): betre enn 9 av 10 innlegg du har skrive dei siste ${num(baseline.windowDays)} dagane.`,
    tags: ['chart_with_upwards_trend'],
    priority: 'default',
    click,
  }
}

/**
 * Decide what (if anything) to push for one post.
 *
 * `prev` is null on the very first sighting of a post. That run **seeds silently**:
 * the rung it has already reached is recorded, but no `*At` stamp is written and no
 * message is produced. This is the only thing standing between switching the feature
 * on and replaying a year of history into his phone — the same "switching it on
 * mid-race is silent" property record 0015 gives the scrobble race.
 *
 * The ladder is evaluated against the **peak** score, never the latest one. Engagement
 * counts go down (un-favourites, undone boosts), and a post that reached 60 and settled
 * at 40 must neither lose its rung nor re-fire it on the way back up.
 */
export function decideBreakout(
  post: BreakoutPost,
  prev: BreakoutState | null,
  t: BreakoutThresholds,
  baseline: BreakoutBaseline,
  weightsKey: string,
  now: Date = new Date(),
): BreakoutDecision {
  const peak = Math.max(post.peak, post.score, prev?.peakScore ?? 0)
  const crossed = furthestRung(peak, t)

  const base: BreakoutState = {
    score: post.score,
    peakScore: peak,
    rung: crossed ?? prev?.rung ?? null,
    rungScore: crossed ? peak : prev?.rungScore ?? null,
    p90At: prev?.p90At ?? null,
    p99At: prev?.p99At ?? null,
    bestAt: prev?.bestAt ?? null,
    weightsKey,
  }

  // First sighting, or the weights changed under us. Record where the post already is
  // and say nothing. `rung` is pre-marked so the ladder is spent, while the *At stamps
  // stay null so "was this ever actually announced?" is still answerable — which is
  // what stops the digest reporting a seeded backlog as today's news.
  if (!prev) return { kind: 'seeded', message: null, state: base }
  if (prev.weightsKey !== weightsKey) return { kind: 'reseeded', message: null, state: base }

  // Nothing new to say: no rung reached, or one already spent at this height or higher.
  // Persist anyway — `score`/`peakScore` moving is what makes the next tick cheap.
  if (!crossed || (prev.rung && RUNG_ORDER[crossed] <= RUNG_ORDER[prev.rung])) {
    return { kind: 'none', message: null, state: { ...base, rung: prev.rung ?? crossed ?? null } }
  }

  // Announce the FURTHEST rung only. Several crossed in one tick — a post that jumps
  // straight past the record — announce the record, not the p90 on the way there.
  // Saying "over your p90" about a post that has just taken the record is worse than
  // saying nothing (record 0015's ladder rule, restated for three rungs).
  const stamped: BreakoutState = {
    ...base,
    rung: crossed,
    rungScore: peak,
    p90At: crossed === 'p90' ? now : base.p90At,
    p99At: crossed === 'p99' ? now : base.p99At,
    bestAt: crossed === 'best' ? now : base.bestAt,
  }

  return {
    kind: crossed,
    message: composeBreakoutMessage(post, crossed, peak, baseline, t),
    state: stamped,
  }
}

// ── The daily digest ────────────────────────────────────────────────────────────

export interface DigestRow {
  actor: string
  rung: BreakoutRung
  firedAt: Date
  score: number
  text: string | null
  url: string | null
}

export interface DigestMovement {
  favourites: number
  reblogs: number
  replies: number
}

/**
 * Is the daily digest due?
 *
 * True when the digest is enabled, the Oslo hour has arrived, and it has not already
 * gone out on this Oslo calendar day. The day key is computed in Oslo rather than UTC
 * for the reason `osloDayKey` gives — a UTC key would skip or double the digest at each
 * clock change.
 */
export function isDigestDue(opts: {
  hour: number
  lastSentAt: Date | null
  now: Date
}): boolean {
  if (opts.hour < 0) return false
  if (osloHour(opts.now) < opts.hour) return false
  if (!opts.lastSentAt) return true
  return osloDayKey(opts.lastSentAt) !== osloDayKey(opts.now)
}

const RUNG_LABEL: Record<BreakoutRung, string> = {
  p90: 'over p90',
  p99: 'topp 1 %',
  best: 'ny rekord',
}

/**
 * The day's summary, or **null when there is nothing to say**.
 *
 * A push that says "ingenting skjedde i dag" every quiet evening trains him to mute the
 * topic, which would cost him the alerts that matter. The caller still advances its
 * cursor on a null — that is a decision not to push, not an undelivered push, and it is
 * the one deliberate exception to "state advances only on a delivered push".
 */
export function composeBreakoutDigest(
  rows: DigestRow[],
  movement: DigestMovement,
  baselines: BreakoutBaseline[],
  now: Date = new Date(),
): NtfyMessage | null {
  const moved = movement.favourites + movement.reblogs + movement.replies
  if (rows.length === 0 && moved === 0) return null

  const lines: string[] = []

  if (rows.length) {
    const top = [...rows].sort((a, b) => b.score - a.score)[0]
    lines.push(
      ...rows
        .slice()
        .sort((a, b) => a.firedAt.getTime() - b.firedAt.getTime())
        .map(r => `· ${RUNG_LABEL[r.rung]} — «${excerpt(r.text, 48)}» (${num(r.score)})`),
    )
    lines.push('')
    lines.push(`Dagens beste: «${excerpt(top.text, 60)}» med skår ${num(top.score)}.`)
  }

  // The part a per-post push can never tell him: what came in across everything,
  // including the posts that never crossed a rung.
  lines.push(
    `I dag: +${num(movement.favourites)} hjarte, +${num(movement.reblogs)} framhevingar, +${num(movement.replies)} svar.`,
  )

  for (const b of baselines) {
    lines.push(`${b.actor}: p90 ${num(Math.ceil(b.p90))}, p99 ${num(Math.ceil(b.p99))}, rekord ${num(b.best)}.`)
  }

  const title = rows.length
    ? `Dagsoppsummering — ${num(rows.length)} innlegg rørte på seg`
    : 'Dagsoppsummering'

  return {
    title,
    body: `${osloDate(now)}\n${lines.join('\n')}`,
    tags: ['bar_chart'],
    // Low, so the summary lands in the list without buzzing. The rungs themselves
    // escalate default → high; this is the record of the day, not an event.
    priority: 'low',
    click: rows.length ? (rows.slice().sort((a, b) => b.score - a.score)[0].url ?? undefined) : undefined,
  }
}
