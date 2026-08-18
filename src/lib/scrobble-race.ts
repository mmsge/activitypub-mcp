import { nowPlayingMatchesEntity, type RaceSide } from './race-entity.js'
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
  /** How each side is named in the alert copy. An artist name for an artist race, the
   *  record or the song for an album or track race — see entityLabel(). The decision
   *  logic never needs to know which; it only ever renders these. */
  leaderLabel: string
  challengerLabel: string
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
  /** When the gap was first seen inside the countdown band. Latches: once set it never
   *  clears, so the leader pulling away doesn't un-arm a race that reached the endgame. */
  endgameArmedAt: Date | null
  overtakenAt: Date | null
}

export type RaceAlertKind =
  | 'seeded'
  | 'none'
  | 'milestone'
  | 'per-play'
  | 'leader-answered'
  | 'armed'
  | 'level'
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
  return `${s.challengerLabel} ${num(s.challengerPlays)} · ${s.leaderLabel} ${num(s.leaderPlays)}.`
}

function eta(gap: number, netPerDay: number | null): string {
  if (netPerDay == null || netPerDay <= 0) return ''
  const days = Math.max(1, Math.ceil(gap / netPerDay))
  return ` At the current pace, ~${num(days)} day${days === 1 ? '' : 's'}.`
}

/** The tightest configured milestone the gap has already crossed, or null.
 *
 *  Inclusive on purpose: a rung is crossed ON the number, not one play past it, so
 *  gap 250 crosses the 250 rung. That makes the *copy* the thing that has to be right —
 *  "under 250" is simply false at a gap of 250, however correct "250 to go" is. See
 *  `milestoneReach` below and decision record 0030. */
export function tightestCrossed(gap: number, milestones: number[]): number | null {
  const crossed = milestones.filter(m => gap <= m)
  return crossed.length ? Math.min(...crossed) : null
}

/** How the body should describe reaching a rung, given where the gap actually is.
 *  Landing exactly on the rung is "at" it; anything tighter is "under" it. */
export function milestoneReach(gap: number, milestone: number): string {
  return gap === milestone
    ? `At ${num(milestone)} for the first time.`
    : `Under ${num(milestone)} for the first time.`
}

/**
 * Decide what (if anything) to push for the current standings.
 *
 * `prev` is null on the very first observation of a pairing: that run seeds state
 * silently, so switching the feature on mid-race never replays the whole ladder.
 *
 * `countdownGap` is the endgame band — at or below it, every play that moves the number
 * gets its own alert. It defaults to the smallest milestone, which is how the band was
 * derived before it became configurable, so callers that don't pass it keep the old
 * behaviour exactly. Note it does NOT gate the decisive rungs at gap 1 and 0: those are
 * the finish rather than the countdown, and must fire at any band including 0.
 */
export function decideRaceAlert(
  snap: RaceSnapshot,
  prev: RaceState | null,
  milestones: number[],
  now: Date = new Date(),
  countdownGap: number = milestones.length ? Math.min(...milestones) : 0,
): RaceDecision {
  const gap = snap.leaderPlays - snap.challengerPlays
  const crossed = tightestCrossed(gap, milestones)
  const counts = { leaderPlays: snap.leaderPlays, challengerPlays: snap.challengerPlays }
  // Latches on the first observation inside the band and never clears afterwards, so
  // the leader pulling away cannot un-arm a race that has already reached its endgame.
  const endgameArmedAt = prev?.endgameArmedAt ?? (gap <= countdownGap ? now : null)

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
        lastAnnouncedGap: gap <= countdownGap ? gap : null,
        endgameArmedAt,
        // Level is not won: seeding at a dead heat must leave the watcher live.
        overtakenAt: gap < 0 ? (snap.latestChallengerPlay?.playedAt ?? now) : null,
      },
    }
  }

  // The race is run. Nothing more to say, however the numbers move afterwards.
  if (prev.overtakenAt) {
    return { kind: 'none', message: null, state: prev }
  }

  // Nothing scrobbled since the last look — no alert can be owed. The arming latch is
  // still carried through: widening the band should show as armed on the next tick,
  // not wait for a play that may be hours away.
  if (prev.leaderPlays === snap.leaderPlays && prev.challengerPlays === snap.challengerPlays) {
    return { kind: 'none', message: null, state: { ...prev, endgameArmedAt } }
  }

  // Milestones only ever tighten. If the leader pulls back ahead, re-crossing 100 on
  // the way down must not announce "100 to go" a second time.
  const nextMilestone = crossed != null && (prev.lastMilestone == null || crossed < prev.lastMilestone)
    ? crossed
    : prev.lastMilestone

  // Only a NEGATIVE gap is the finish. A dead heat is not a win, and treating it as
  // one would set overtakenAt, go inert, and swallow the alert this whole feature
  // exists for — see decision record 0016.
  if (gap < 0) {
    const play = snap.latestChallengerPlay
    const days = snap.challengerFirstPlayedAt
      ? Math.round((now.getTime() - snap.challengerFirstPlayedAt.getTime()) / 86_400_000)
      : null
    return {
      kind: 'overtake',
      message: {
        title: `${snap.challengerLabel} takes the lead`,
        body: [
          play
            ? `${quote(play.track)} did it at ${oslo(play.playedAt)}. ${snap.challengerLabel} is your new all-time #1.`
            : `${snap.challengerLabel} is your new all-time #1.`,
          standings(snap),
          days != null ? `${num(days)} days after the first play.` : '',
        ].filter(Boolean).join(' '),
        tags: ['trophy'],
        priority: 'max',
        click: play?.url ?? undefined,
      },
      // The play that pushed the gap negative IS the latest challenger play — this
      // branch is only reached on changed counts. Stamping its playedAt rather than
      // `now` keeps the record honest: the lead changed when the track was played, not
      // when the sync happened to notice a minute or two later.
      state: {
        ...counts,
        lastMilestone: nextMilestone,
        lastAnnouncedGap: gap,
        endgameArmedAt,
        overtakenAt: play?.playedAt ?? now,
      },
    }
  }

  // Endgame: every play that moves the number gets its own alert. The band gates only
  // the generic countdown — gap 1 and gap 0 are the finish and always speak, whatever
  // countdownGap is set to (record 0016, reaffirmed in 0022).
  if (gap <= 1 || gap <= countdownGap) {
    if (prev.lastAnnouncedGap === gap) {
      return {
        kind: 'none',
        message: null,
        state: { ...prev, ...counts, lastMilestone: nextMilestone, endgameArmedAt },
      }
    }

    const play = snap.latestChallengerPlay
    const nextState = {
      ...counts,
      lastMilestone: nextMilestone,
      lastAnnouncedGap: gap,
      endgameArmedAt,
      overtakenAt: null,
    }

    // The two decisive rungs arm you BEFORE you press play, which is the whole point:
    // the scrobbler tells us what you finished, never what you're about to start, so
    // the only honest way to say "this one wins it" is to say it one play early.
    if (gap <= 1) {
      const outcome = gap === 0
        ? `Whatever ${snap.challengerLabel} track you play next takes the all-time #1. Choose it.`
        : `One more ${snap.challengerLabel} play levels it.`
      return {
        kind: gap === 0 ? 'level' : 'armed',
        message: {
          title: gap === 0
            ? `Next ${snap.challengerLabel} song wins it`
            : `1 to go — next one levels it`,
          body: `${play ? `${quote(play.track)} — ` : ''}${standings(snap)} ${outcome}`,
          tags: ['rotating_light'],
          priority: 'max',
          click: play?.url ?? undefined,
        },
        state: nextState,
      }
    }

    const widened = prev.lastAnnouncedGap != null && gap > prev.lastAnnouncedGap
    const movedPlay = widened ? snap.latestLeaderPlay : play
    const body = widened
      ? `${snap.leaderLabel} just scrobbled${movedPlay ? ` ${quote(movedPlay.track)}` : ''}. ${standings(snap)}`
      : `${movedPlay ? `${quote(movedPlay.track)} — ` : ''}${standings(snap)}`

    return {
      kind: widened ? 'leader-answered' : 'per-play',
      message: {
        title: widened ? `Back to ${num(gap)}` : `${num(gap)} to go`,
        body,
        tags: [widened ? 'arrow_up' : 'fire'],
        priority: widened ? 'default' : 'high',
        click: movedPlay?.url ?? undefined,
      },
      state: nextState,
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
          milestoneReach(gap, nextMilestone),
          play ? `Last play: ${quote(play.track)}.` : '',
        ].filter(Boolean).join(' ') + eta(gap, snap.netPerDay),
        tags: ['chart_with_upwards_trend'],
        priority: 'default',
        click: play?.url ?? undefined,
      },
      // Outside the band we don't track per-play gaps; clearing this means re-entering
      // the endgame always announces its first play.
      state: {
        ...counts,
        lastMilestone: nextMilestone,
        lastAnnouncedGap: null,
        endgameArmedAt,
        overtakenAt: null,
      },
    }
  }

  return {
    kind: 'none',
    message: null,
    state: {
      ...counts,
      lastMilestone: nextMilestone,
      lastAnnouncedGap: null,
      endgameArmedAt,
      overtakenAt: null,
    },
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
  playing: { artist: string; track: string; album?: string | null; url: string | null } | null,
  gap: number,
  challenger: RaceSide,
  leader: RaceSide,
  last: { key: string | null; at: Date | null },
  now: Date = new Date(),
): { message: NtfyMessage; key: string } | null {
  if (!playing) return null
  // Entity matching, not an artist comparison: in an album race both sides can be the
  // SAME artist, so "is this the challenger's artist?" would fire the decisive alert for
  // a track off the other side of the race. Last.fm often omits the album on a live
  // now-playing submission, and an album side with no album reported does not match —
  // silence is the right answer there, and the scrobble-side alerts at gap 1 and 0 cover
  // the same ground anyway (decision record 0016).
  if (!nowPlayingMatchesEntity(playing, challenger.entity)) return null

  const key = `${playing.artist} ${playing.track}`.toLowerCase()
  if (key === last.key) {
    const age = last.at ? now.getTime() - last.at.getTime() : Infinity
    if (age < NOWPLAYING_REARM_MS) return null
  }

  // The gap is measured BEFORE this track scrobbles, so it is one play behind the
  // outcome: level at 1, and only at 0 does the next play actually take the lead.
  const outcome = gap <= 0
    ? `${challenger.label} passes ${leader.label} for the first time. Don't skip it.`
    : gap === 1
      ? `${challenger.label} draws level with ${leader.label}.`
      : `${challenger.label} closes to ${num(gap - 1)} behind ${leader.label}.`

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
