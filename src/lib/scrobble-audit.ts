/**
 * How much of the stored scrobble history is a play that never really happened.
 *
 * Nothing here changes a count. The store is a faithful mirror of Last.fm (see the
 * `scrobbles` table comment), and Markus decided to keep it that way — a local total
 * that disagrees with last.fm.com is not a better truth, it is a second one. This
 * module exists to *measure* the divergence so the decision to act on it can be made
 * on numbers. Decision record 0030.
 *
 * The measurement rests on one fact: `played_at` is the moment a track STARTED, so the
 * next row's `played_at` is the only bound we have on how long this one actually
 * played. Everything below is pure — the SQL in `src/jobs/scrobble-audit.ts` supplies
 * the gaps and the duration estimates; this file decides what they mean.
 */

/** Gaps longer than this are a listening-session break, not a track ending. Above it
 *  the gap says nothing about how long the track was played, so the play is reported
 *  as unbounded and can never be counted as suspect. */
export const SESSION_CEILING_SECONDS = 900

/** percentile_disc(0.9) needs enough in-ceiling observations that it is not simply the
 *  maximum: at n ≤ 10 the 0.9 percentile IS the largest value, so a single session-tail
 *  gap that squeaked in under the ceiling would set the whole estimate. Below this we
 *  refuse to estimate at all rather than guess a length. */
export const MIN_DURATION_OBSERVATIONS = 10

export const DURATION_PERCENTILE = 0.9

/** An estimate outside this band is a broken estimate, not a short or long track. */
export const MIN_TRUSTED_ESTIMATE_SECONDS = 30

export type ThresholdId = 'lt30s' | 'lt60s' | 'halfDuration' | 'lastfmRule'

export interface Threshold {
  id: ThresholdId
  label: string
  /** Fixed cut in seconds, or null when it is derived from the track's own length. */
  seconds: number | null
  kind: 'fixed' | 'half-duration' | 'lastfm'
}

/**
 * The spectrum. Reported as a curve rather than a verdict — Markus' call — because how
 * many plays are "not real" depends almost entirely on where the line is drawn, and one
 * number would hide that.
 *
 * A bare "under 4 minutes" threshold is deliberately absent. Last.fm's rule is half the
 * track *or* four minutes, **whichever comes first**, so a flat 240 s would flag every
 * complete play of an ordinary three-minute song. `lastfmRule` is the real thing, and it
 * differs from `halfDuration` only for tracks over eight minutes.
 */
export const THRESHOLDS: readonly Threshold[] = [
  { id: 'lt30s', label: 'under 30 s', seconds: 30, kind: 'fixed' },
  { id: 'lt60s', label: 'under 60 s', seconds: 60, kind: 'fixed' },
  { id: 'halfDuration', label: 'under half the estimated length', seconds: null, kind: 'half-duration' },
  { id: 'lastfmRule', label: "Last.fm's own rule — under min(half, 4 min)", seconds: null, kind: 'lastfm' },
]

export const LASTFM_MAX_THRESHOLD_SECONDS = 240

/**
 * One group of identical plays. The SQL groups rather than returning a row per scrobble,
 * so a 50 000-row history arrives as a few thousand signatures; `plays` is the multiplier.
 */
export interface GapGroup {
  artistName: string
  /** Oslo calendar year — one timezone for everything, per decision record 0019. */
  year: number
  /** Seconds until the next scrobble by any artist. Null only for the newest row in the
   *  whole history; anything above the ceiling arrives clamped to ceiling + 1. */
  playSeconds: number | null
  /** The track's estimated length, or null when too few observations to trust one. */
  estSeconds: number | null
  plays: number
}

export type Verdict =
  /** Cannot have met any scrobble threshold — it was cut short. */
  | 'suspect'
  /** Played long enough to count. */
  | 'kept'
  /** No successor, or the successor is past the session ceiling: length unknowable. */
  | 'unbounded'
  /** A relative threshold with no trusted length to be relative to. Counted as kept. */
  | 'no-estimate'

/** The cut, in seconds, below which a play does not count under this threshold. */
export function cutFor(t: Threshold, estSeconds: number | null): number | null {
  if (t.kind === 'fixed') return t.seconds
  if (estSeconds == null) return null
  const half = estSeconds / 2
  return t.kind === 'lastfm' ? Math.min(half, LASTFM_MAX_THRESHOLD_SECONDS) : half
}

export function classify(
  group: Pick<GapGroup, 'playSeconds' | 'estSeconds'>,
  t: Threshold,
  ceilingSeconds: number = SESSION_CEILING_SECONDS,
): Verdict {
  // Unknowable beats everything else. A play whose successor is hours away may have run
  // to the end or been abandoned after eight seconds, and nothing here can tell which —
  // so it is never counted against anyone.
  if (group.playSeconds == null || group.playSeconds > ceilingSeconds) return 'unbounded'
  const cut = cutFor(t, group.estSeconds)
  // Refuse to guess a length rather than substituting a corpus median: an invented
  // duration could only ever inflate the suspect count, which is the one direction this
  // audit must not err in.
  if (cut == null) return 'no-estimate'
  return group.playSeconds < cut ? 'suspect' : 'kept'
}

export interface Totals {
  plays: number
  suspect: number
  kept: number
  unbounded: number
  /** Subset of kept. Always zero for a fixed threshold. */
  noEstimate: number
}

const zero = (): Totals => ({ plays: 0, suspect: 0, kept: 0, unbounded: 0, noEstimate: 0 })

export function tally(
  groups: Iterable<GapGroup>,
  t: Threshold,
  ceilingSeconds: number = SESSION_CEILING_SECONDS,
): Totals {
  const out = zero()
  for (const g of groups) {
    out.plays += g.plays
    switch (classify(g, t, ceilingSeconds)) {
      case 'suspect': out.suspect += g.plays; break
      case 'unbounded': out.unbounded += g.plays; break
      case 'no-estimate': out.kept += g.plays; out.noEstimate += g.plays; break
      default: out.kept += g.plays
    }
  }
  return out
}

export interface RaceLine {
  threshold: ThresholdId
  label: string
  leaderPlays: number
  challengerPlays: number
  /** The gap exactly as get_scrobble_race reports it today. Never changed by the audit. */
  gap: number
  leaderSuspect: number
  challengerSuspect: number
  correctedGap: number
  /** correctedGap − gap. Positive means dropping the suspect plays widens the gap. */
  gapDelta: number
  /** Plays neither side can account for — the error bar on the corrected figure. */
  leaderUnbounded: number
  challengerUnbounded: number
}

export interface YearLine {
  year: number
  plays: number
  /** Suspect count under `lt60s`, the threshold cheap enough to compare across eras. */
  suspectUnder60s: number
  pct: number
}

export interface AuditSummary {
  overall: Record<ThresholdId, Totals>
  perArtist: Array<{ artist: string; totals: Record<ThresholdId, Totals> }>
  race: RaceLine[]
  byYear: YearLine[]
}

const byThreshold = (
  groups: GapGroup[],
  ceiling: number,
): Record<ThresholdId, Totals> =>
  Object.fromEntries(
    THRESHOLDS.map(t => [t.id, tally(groups, t, ceiling)]),
  ) as Record<ThresholdId, Totals>

/**
 * Fold the grouped gaps into everything the report says. Pure: hand it an array and it
 * never reaches for a database, which is what lets the whole classification be tested
 * without one.
 */
export function summarise(
  groups: GapGroup[],
  opts: { leader: string; challenger: string; ceilingSeconds?: number; artistLimit?: number },
): AuditSummary {
  const ceiling = opts.ceilingSeconds ?? SESSION_CEILING_SECONDS
  const artistLimit = opts.artistLimit ?? 15

  const byArtist = new Map<string, GapGroup[]>()
  for (const g of groups) {
    const bucket = byArtist.get(g.artistName)
    if (bucket) bucket.push(g)
    else byArtist.set(g.artistName, [g])
  }

  const playsOf = (rows: GapGroup[]) => rows.reduce((n, g) => n + g.plays, 0)

  // The racers are always reported, however little they were played; everyone else
  // makes the list on volume.
  const racers = [opts.leader, opts.challenger]
  const others = [...byArtist.entries()]
    .filter(([a]) => !racers.includes(a))
    .sort((a, b) => playsOf(b[1]) - playsOf(a[1]))
    .slice(0, artistLimit)
    .map(([a]) => a)

  const perArtist = [...racers, ...others].map(artist => ({
    artist,
    totals: byThreshold(byArtist.get(artist) ?? [], ceiling),
  }))

  const leaderRows = byArtist.get(opts.leader) ?? []
  const challengerRows = byArtist.get(opts.challenger) ?? []
  const leaderPlays = playsOf(leaderRows)
  const challengerPlays = playsOf(challengerRows)
  const gap = leaderPlays - challengerPlays

  const race: RaceLine[] = THRESHOLDS.map(t => {
    const l = tally(leaderRows, t, ceiling)
    const c = tally(challengerRows, t, ceiling)
    const correctedGap = (leaderPlays - l.suspect) - (challengerPlays - c.suspect)
    return {
      threshold: t.id,
      label: t.label,
      leaderPlays,
      challengerPlays,
      gap,
      leaderSuspect: l.suspect,
      challengerSuspect: c.suspect,
      correctedGap,
      gapDelta: correctedGap - gap,
      leaderUnbounded: l.unbounded,
      challengerUnbounded: c.unbounded,
    }
  })

  const years = new Map<number, GapGroup[]>()
  for (const g of groups) {
    const bucket = years.get(g.year)
    if (bucket) bucket.push(g)
    else years.set(g.year, [g])
  }
  const under60 = THRESHOLDS.find(t => t.id === 'lt60s')!
  const byYear: YearLine[] = [...years.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, rows]) => {
      const totals = tally(rows, under60, ceiling)
      return {
        year,
        plays: totals.plays,
        suspectUnder60s: totals.suspect,
        pct: totals.plays ? (totals.suspect / totals.plays) * 100 : 0,
      }
    })

  return { overall: byThreshold(groups, ceiling), perArtist, race, byYear }
}
