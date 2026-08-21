import { type NtfyMessage } from './ntfy.js'
import { osloDayKey } from './post-breakout.js'

/**
 * Pure decision logic for the convergence watcher: the moment the cumulative scrobble
 * count and the cumulative train kilometres meet, or swap places.
 *
 * Kept free of database, network and clock so the interesting part — which crossing
 * exists, and when it must NOT be announced a second time — is directly unit-testable.
 *
 * The model is one signed quantity walked over a merged timeline:
 *
 *     d(t) = km(t) − scrobbles(t)
 *
 * A scrobble moves it by −1. A departed leg moves it by +distance_km, in a lump of up
 * to 1,176. Two properties fall out of that asymmetry and the whole design rests on
 * them:
 *
 * 1. **A scrobble can never flip the sign without landing on zero.** It steps by
 *    exactly one, so it always visits d = 0 on the way past. Every *crossover* — a
 *    flip that skips zero — is therefore caused by a kilometre lump. Equality can be
 *    caused by either side.
 * 2. **Equality is a window, not an instant.** It opens on the event that lands d = 0
 *    and closes on the next event that moves it off. The one time these counters have
 *    met, that window was three minutes and ten seconds wide, and both ends of it are
 *    facts the archive already holds.
 */

export type ConvergenceCause =
  | {
    kind: 'scrobble'
    artist: string
    track: string
    album: string | null
    url: string | null
  }
  | {
    kind: 'leg'
    from: string
    to: string
    journey: string | null
    km: number
  }

export interface ConvergenceEvent {
  /** The event's own instant — a scrobble's played_at, a leg's departure_at. Never
   *  the time we noticed it: a backfilled leg is announced with the date it happened. */
  at: Date
  /** Stable tiebreak within one instant. The row's natural key on either side — the
   *  trip identity, or the scrobble dedupe key — so the order never depends on a uuid
   *  that a re-import would change. */
  key: string
  cause: ConvergenceCause
}

export interface ConvergenceSeed {
  scrobbles: number
  km: number
}

export type CrossingKind = 'equality' | 'crossover'
export type Leader = 'km' | 'scrobbles' | 'tie'

export interface Crossing {
  kind: CrossingKind
  occurredAt: Date
  /** The shared figure. Equality only — a crossover has no single value by definition. */
  value: number | null
  /** km − scrobbles immediately after the event. */
  gap: number
  leader: Leader
  scrobbles: number
  km: number
  cause: ConvergenceCause
  /** Equality only: when d left zero, if that happened inside this same walk. An
   *  equality still open when the walk ends carries null and is filled in later. */
  endedAt: Date | null
}

export interface WalkResult {
  crossings: Crossing[]
  scrobbles: number
  km: number
  /** The instant of the last event folded in — the new watermark. Null when the walk
   *  had nothing to fold. */
  watermarkAt: Date | null
  /** Set when the walk STARTED level (the seed itself was an open equality window)
   *  and an event closed it. The window's own row predates this walk, so the caller
   *  stamps it rather than this function returning it in `crossings`. */
  seedWindowClosedAt: Date | null
}

/** Legs before scrobbles at an identical instant, then the natural key.
 *
 *  Any total order would do; having one is what matters. Without it the same archive
 *  can produce different crossings on different runs, and the dedupe key — which is
 *  the crossing's instant — would stop being stable. */
const KIND_RANK: Record<ConvergenceCause['kind'], number> = { leg: 0, scrobble: 1 }

export function orderEvents(events: readonly ConvergenceEvent[]): ConvergenceEvent[] {
  return [...events].sort((a, b) =>
    a.at.getTime() - b.at.getTime()
    || KIND_RANK[a.cause.kind] - KIND_RANK[b.cause.kind]
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
}

function leaderOf(gap: number): Leader {
  return gap === 0 ? 'tie' : gap > 0 ? 'km' : 'scrobbles'
}

/**
 * Walk the merged timeline from `seed` and return every crossing it contains.
 *
 * Used by both evaluation paths: the 60-second tick feeds it the handful of scrobbles
 * that landed since the watermark, and the post-import recompute feeds it the whole
 * archive from zero. One function, so the tail can never disagree with the whole.
 */
export function findCrossings(
  events: readonly ConvergenceEvent[],
  seed: ConvergenceSeed = { scrobbles: 0, km: 0 },
): WalkResult {
  let { scrobbles, km } = seed
  const crossings: Crossing[] = []
  let openEquality: Crossing | null = null
  let watermarkAt: Date | null = null
  let seedWindowClosedAt: Date | null = null
  // The seed itself can be a level standing — an equality window opened by an earlier
  // walk and still open. Its row already exists, so it is closed rather than re-found.
  let seedWindowOpen = km - scrobbles === 0

  for (const event of orderEvents(events)) {
    const before = km - scrobbles
    if (event.cause.kind === 'scrobble') scrobbles += 1
    else km += event.cause.km
    const after = km - scrobbles
    watermarkAt = event.at

    if (after === before) continue // a leg with no distance moves nothing

    if (after !== 0) {
      if (openEquality) {
        openEquality.endedAt = event.at
        openEquality = null
      } else if (seedWindowOpen) {
        seedWindowClosedAt = event.at
        seedWindowOpen = false
      }
    }

    if (after === 0) {
      // Equality. `before !== 0` is guaranteed here: d only reaches zero from
      // somewhere else, and a zero-delta event was skipped above.
      const crossing: Crossing = {
        kind: 'equality',
        occurredAt: event.at,
        value: km,
        gap: 0,
        leader: 'tie',
        scrobbles,
        km,
        cause: event.cause,
        endedAt: null,
      }
      crossings.push(crossing)
      openEquality = crossing
      seedWindowOpen = false
    } else if (before !== 0 && Math.sign(before) !== Math.sign(after)) {
      // A sign flip that skipped zero. Only a kilometre lump can do this — leaving an
      // equality window is `before === 0`, and is the resolution of a crossing already
      // announced rather than a new one.
      crossings.push({
        kind: 'crossover',
        occurredAt: event.at,
        value: null,
        gap: after,
        leader: leaderOf(after),
        scrobbles,
        km,
        cause: event.cause,
        endedAt: null,
      })
    }
  }

  return { crossings, scrobbles, km, watermarkAt, seedWindowClosedAt }
}

// ── Copy ────────────────────────────────────────────────────────────────────────

const num = (n: number) => n.toLocaleString('nn-NO')

/** `29.10.2026` — the Oslo calendar day, written the way it is read here.
 *
 *  Built from `osloDayKey`'s ISO day rather than a second Intl call, for the reason
 *  decision record 0019 gives: a bucket is computed in the timezone its label is read
 *  in, and UTC arithmetic would skip or double a day twice a year. */
export function osloDay(d: Date): string {
  const [year, month, day] = osloDayKey(d).split('-')
  return `${day}.${month}.${year}`
}

/** `29.10.2026 kl. 14:12`. */
export function osloStamp(d: Date): string {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d)
  return `${osloDay(d)} kl. ${time}`
}

/** `3 min 10 s`, `1 t 4 min`, `2 d 3 t`. Two units at most — this is a push, not a report. */
export function nynorskDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = total % 60
  if (days > 0) return hours > 0 ? `${days} d ${hours} t` : `${days} d`
  if (hours > 0) return minutes > 0 ? `${hours} t ${minutes} min` : `${hours} t`
  if (minutes > 0) return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`
  return `${seconds} s`
}

export function causeText(cause: ConvergenceCause): string {
  if (cause.kind === 'scrobble') {
    const album = cause.album ? ` (${cause.album})` : ''
    return `${cause.artist}, «${cause.track}»${album}`
  }
  const journey = cause.journey ? ` (${cause.journey})` : ''
  return `${cause.from}–${cause.to}${journey}, ${num(cause.km)} km`
}

export interface CrossingNote {
  crossing: Crossing
  /** True when the crossing predates the watcher's own knowledge — a backfilled leg
   *  rewrote history under it. The push then says so and carries the real date. */
  historical: boolean
  /** The most recent equality strictly before this one, for the "Førre møte" line. */
  previousEqualityAt: Date | null
}

export interface Standing {
  scrobbles: number
  km: number
}

const TAGS = ['train', 'headphones']

/** The line that makes "exactly equal" an honest claim. Whole kilometres per leg is
 *  the resolution Viaduct stores, so equality is exact only at that resolution. */
const RESOLUTION = 'Heile kilometer per etappe, slik Viaduct lagrar dei.'
const RETROSPECTIVE = 'Oppdaga i ettertid; tidspunktet over er då det hende.'

function lines(...parts: (string | null)[]): string {
  return parts.filter((p): p is string => p !== null).join('\n')
}

function equalityMessage(note: CrossingNote): NtfyMessage {
  const { crossing: c, historical, previousEqualityAt } = note
  const held = c.endedAt
    ? nynorskDuration(c.endedAt.getTime() - c.occurredAt.getTime())
    : null

  const opening = historical
    ? `Scrobbles og togkilometer stod likt ${osloStamp(c.occurredAt)}${held ? `, i ${held}` : ''}.`
    : `Scrobbles og togkilometer står likt, ${osloStamp(c.occurredAt)}.`

  return {
    title: `Likt: ${num(c.value ?? c.km)}`,
    body: lines(
      opening,
      `Utløyst av: ${causeText(c.cause)}.`,
      previousEqualityAt
        ? `Førre møte: ${osloDay(previousEqualityAt)}.`
        : 'Fyrste møtet i arkivet.',
      historical ? RETROSPECTIVE : null,
      RESOLUTION,
    ),
    tags: TAGS,
    priority: 'high',
    click: c.cause.kind === 'scrobble' ? c.cause.url ?? undefined : undefined,
  }
}

function crossoverMessage(note: CrossingNote): NtfyMessage {
  const { crossing: c, historical } = note
  const kmAhead = c.leader === 'km'
  const verb = historical ? 'gjekk' : 'går'
  const title = kmAhead
    ? `Togkilometer ${verb} forbi scrobbles`
    : `Scrobbles ${verb} forbi togkilometer`

  return {
    title,
    body: lines(
      `Togkilometer ${num(c.km)} · scrobbles ${num(c.scrobbles)}. Forsprang: ${num(Math.abs(c.gap))}.`,
      `Utløyst av: ${causeText(c.cause)}, ${osloStamp(c.occurredAt)}.`,
      historical ? RETROSPECTIVE : null,
    ),
    tags: TAGS,
    priority: 'default',
  }
}

/**
 * One push for one crossing; one summary push for several.
 *
 * Several at once is a backfill artefact, never the live case: a corrected leg
 * distance shifts every later crossing in time, so the walk rediscovers them at new
 * instants. Announcing each of those individually would be a burst of pushes about
 * one edit to one CSV row.
 */
export function composeMessage(
  notes: readonly CrossingNote[],
  standing: Standing,
): NtfyMessage | null {
  if (notes.length === 0) return null
  if (notes.length === 1) {
    const note = notes[0]!
    return note.crossing.kind === 'equality' ? equalityMessage(note) : crossoverMessage(note)
  }

  const ordered = [...notes].sort(
    (a, b) => a.crossing.occurredAt.getTime() - b.crossing.occurredAt.getTime(),
  )
  const first = ordered[0]!.crossing
  const last = ordered[ordered.length - 1]!.crossing
  const meetings = ordered.filter(n => n.crossing.kind === 'equality').length
  const swaps = ordered.length - meetings

  return {
    title: `${num(ordered.length)} kryssingar funne`,
    body: lines(
      'Ein import endra historia bakover.',
      `${num(meetings)} møte og ${num(swaps)} leiarskifte, frå ${osloDay(first.occurredAt)} til ${osloDay(last.occurredAt)}.`,
      `Sist: ${causeText(last.cause)}, ${osloStamp(last.occurredAt)}.`,
      `Står no: togkilometer ${num(standing.km)} · scrobbles ${num(standing.scrobbles)}.`,
      RESOLUTION,
    ),
    tags: TAGS,
    priority: meetings > 0 ? 'high' : 'default',
  }
}
