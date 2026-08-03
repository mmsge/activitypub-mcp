import { type NtfyMessage } from './ntfy.js'

/**
 * Pure decision logic for the head-to-head scrobble race. Kept free of database and
 * network access so the interesting part — which alert fires, and when it must NOT
 * fire again — is directly unit-testable.
 */

export interface RacePlay {
  track: string
  url: string | null
  playedAt: Date
}

export interface RaceSnapshot {
  leaderArtist: string
  challengerArtist: string
  leaderPlays: number
  challengerPlays: number
  /** Newest play by each side, used to name the track that moved the number. */
  latestChallengerPlay: RacePlay | null
  latestLeaderPlay: RacePlay | null
  /** The challenger's first-ever scrobble, for flavour on the overtake alert. */
  challengerFirstPlayedAt: Date | null
  /** Recent net closing rate in plays/day; null when it can't be estimated. */
  netPerDay: number | null
}

export interface RaceState {
  /** Counts at the last decision. Both unchanged means nothing scrobbled, which is
   *  the whole duplicate-suppression story: no play, no alert, however often we tick. */
  leaderPlays: number
  challengerPlays: number
  /** Tightest milestone already announced. Ratchets downward and never re-arms. */
  lastMilestone: number | null
  /** Gap at the last endgame alert, so an unchanged gap stays quiet. */
  lastAnnouncedGap: number | null
  overtakenAt: Date | null
}

export type RaceAlertKind =
  | 'seeded'
  | 'none'
  | 'milestone'
  | 'per-play'
  | 'leader-answered'
  | 'overtake'

export interface RaceDecision {
  kind: RaceAlertKind
  message: NtfyMessage | null
  /** State to persist — but only once the message has actually been delivered. */
  state: RaceState
}

const num = (n: number) => n.toLocaleString('en-GB')

function oslo(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit',
  }).format(d)
}

function quote(track: string): string {
  return `“${track}”`
}

function standings(s: RaceSnapshot): string {
  return `${s.challengerArtist} ${num(s.challengerPlays)} · ${s.leaderArtist} ${num(s.leaderPlays)}.`
}

function eta(gap: number, netPerDay: number | null): string {
  if (netPerDay == null || netPerDay <= 0) return ''
  const days = Math.max(1, Math.ceil(gap / netPerDay))
  return ` At the current pace, ~${num(days)} day${days === 1 ? '' : 's'}.`
}

/** The tightest configured milestone the gap has already crossed, or null. */
export function tightestCrossed(gap: number, milestones: number[]): number | null {
  const crossed = milestones.filter(m => gap <= m)
  return crossed.length ? Math.min(...crossed) : null
}

/**
 * Decide what (if anything) to push for the current standings.
 *
 * `prev` is null on the very first observation of a pairing: that run seeds state
 * silently, so switching the feature on mid-race never replays the whole ladder.
 */
export function decideRaceAlert(
  snap: RaceSnapshot,
  prev: RaceState | null,
  milestones: number[],
  now: Date = new Date(),
): RaceDecision {
  const gap = snap.leaderPlays - snap.challengerPlays
  const fineZone = milestones.length ? Math.min(...milestones) : 0
  const crossed = tightestCrossed(gap, milestones)
  const counts = { leaderPlays: snap.leaderPlays, challengerPlays: snap.challengerPlays }

  // First sighting: record where the race already is, say nothing. Pre-marking the
  // tightest passed milestone is what stops a deploy at gap 120 from firing 300, 250,
  // 200 and 150 in one breath.
  if (!prev) {
    return {
      kind: 'seeded',
      message: null,
      state: {
        ...counts,
        lastMilestone: crossed,
        lastAnnouncedGap: gap <= fineZone ? gap : null,
        overtakenAt: gap <= 0 ? now : null,
      },
    }
  }

  // The race is run. Nothing more to say, however the numbers move afterwards.
  if (prev.overtakenAt) {
    return { kind: 'none', message: null, state: prev }
  }

  // Nothing scrobbled since the last look — no alert can be owed.
  if (prev.leaderPlays === snap.leaderPlays && prev.challengerPlays === snap.challengerPlays) {
    return { kind: 'none', message: null, state: prev }
  }

  // Milestones only ever tighten. If the leader pulls back ahead, re-crossing 100 on
  // the way down must not announce "100 to go" a second time.
  const nextMilestone = crossed != null && (prev.lastMilestone == null || crossed < prev.lastMilestone)
    ? crossed
    : prev.lastMilestone

  if (gap <= 0) {
    const play = snap.latestChallengerPlay
    const days = snap.challengerFirstPlayedAt
      ? Math.round((now.getTime() - snap.challengerFirstPlayedAt.getTime()) / 86_400_000)
      : null
    const lead = gap === 0
      ? `${snap.challengerArtist} has drawn level with ${snap.leaderArtist}.`
      : `${snap.challengerArtist} is your new all-time #1.`
    return {
      kind: 'overtake',
      message: {
        title: gap === 0 ? 'Dead heat' : `${snap.challengerArtist} takes the lead`,
        body: [
          play ? `${quote(play.track)} did it at ${oslo(play.playedAt)}. ${lead}` : lead,
          standings(snap),
          days != null ? `${num(days)} days after the first play.` : '',
        ].filter(Boolean).join(' '),
        tags: ['trophy'],
        priority: 'max',
        click: play?.url ?? undefined,
      },
      state: { ...counts, lastMilestone: nextMilestone, lastAnnouncedGap: gap, overtakenAt: now },
    }
  }

  // Endgame: every play that moves the number gets its own alert.
  if (gap <= fineZone) {
    if (prev.lastAnnouncedGap === gap) {
      return {
        kind: 'none',
        message: null,
        state: { ...prev, ...counts, lastMilestone: nextMilestone },
      }
    }

    const widened = prev.lastAnnouncedGap != null && gap > prev.lastAnnouncedGap
    const play = widened ? snap.latestLeaderPlay : snap.latestChallengerPlay
    const body = widened
      ? `${snap.leaderArtist} just scrobbled${play ? ` ${quote(play.track)}` : ''}. ${standings(snap)}`
      : `${play ? `${quote(play.track)} — ` : ''}${standings(snap)}`

    return {
      kind: widened ? 'leader-answered' : 'per-play',
      message: {
        title: widened ? `Back to ${num(gap)}` : `${num(gap)} to go`,
        body,
        tags: [widened ? 'arrow_up' : 'fire'],
        priority: widened ? 'default' : 'high',
        click: play?.url ?? undefined,
      },
      state: { ...counts, lastMilestone: nextMilestone, lastAnnouncedGap: gap, overtakenAt: null },
    }
  }

  // Above the endgame: one alert per milestone, on the way down only. Crossing several
  // rungs at once (a long backfill, or the app having been down) announces the
  // tightest one — a single push, not a flood of stale ones.
  if (nextMilestone !== prev.lastMilestone && nextMilestone != null) {
    const play = snap.latestChallengerPlay
    return {
      kind: 'milestone',
      message: {
        title: `${num(gap)} to go`,
        body: [
          standings(snap),
          `Under ${num(nextMilestone)} for the first time.`,
          play ? `Last play: ${quote(play.track)}.` : '',
        ].filter(Boolean).join(' ') + eta(gap, snap.netPerDay),
        tags: ['chart_with_upwards_trend'],
        priority: 'default',
        click: play?.url ?? undefined,
      },
      // Outside the fine zone we don't track per-play gaps; clearing this means
      // re-entering the endgame always announces its first play.
      state: { ...counts, lastMilestone: nextMilestone, lastAnnouncedGap: null, overtakenAt: null },
    }
  }

  return {
    kind: 'none',
    message: null,
    state: { ...counts, lastMilestone: nextMilestone, lastAnnouncedGap: null, overtakenAt: null },
  }
}

/** Re-announce a repeat play of the same track only after this long. Without it,
 *  putting the decisive song on twice in a row would alert once. */
export const NOWPLAYING_REARM_MS = 15 * 60_000

/**
 * The predictive endgame alert: the track playing right now is the one that ties or
 * wins it. Returns null when the live track isn't the challenger's, or when this
 * exact track has already been shouted about recently.
 */
export function decideNowPlayingAlert(
  playing: { artist: string; track: string; url: string | null } | null,
  gap: number,
  challengerArtist: string,
  leaderArtist: string,
  last: { key: string | null; at: Date | null },
  now: Date = new Date(),
): { message: NtfyMessage; key: string } | null {
  if (!playing) return null
  if (playing.artist.toLowerCase() !== challengerArtist.toLowerCase()) return null

  const key = `${playing.artist} ${playing.track}`.toLowerCase()
  if (key === last.key) {
    const age = last.at ? now.getTime() - last.at.getTime() : Infinity
    if (age < NOWPLAYING_REARM_MS) return null
  }

  // The gap is measured BEFORE this track scrobbles, so it is one play behind the
  // outcome: level at 1, and only at 0 does the next play actually take the lead.
  const outcome = gap <= 0
    ? `${challengerArtist} passes ${leaderArtist} for the first time. Don't skip it.`
    : gap === 1
      ? `${challengerArtist} draws level with ${leaderArtist}.`
      : `${challengerArtist} closes to ${num(gap - 1)} behind ${leaderArtist}.`

  return {
    key,
    message: {
      title: gap <= 0 ? 'THIS SONG TAKES THE LEAD' : `${num(gap)} to go — playing now`,
      body: `Playing right now: ${quote(playing.track)}. When it scrobbles, ${outcome}`,
      tags: ['rotating_light'],
      priority: 'max',
      click: playing.url ?? undefined,
    },
  }
}
