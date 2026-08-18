import { z } from 'zod'
import { config } from '../../config.js'
import {
  countRacePlays, countRacePlaysSince, latestPlay, loadRaceState,
} from '../../lib/race-store.js'
import {
  artistEntity, raceEntitySchema, type RaceEntity,
} from '../../lib/race-entity.js'
import {
  adHocRace, getRaces, legacyEnvRace, type RaceDefinition,
} from '../../lib/races-config.js'
import { logger } from '../../lib/logger.js'
import { tightestCrossed } from '../../lib/scrobble-race.js'

/**
 * A side, as callers may give it.
 *
 * Deliberately NOT `z.string().transform(...)`: server.tool() hands `schema.shape` to the
 * MCP SDK's JSON-Schema converter, and a transform turns the union into a pipe that
 * converts lossily. The bare string is normalised in the handler instead, where it is
 * also the thing that guarantees rule 3 below is not a separate code path from rule 2.
 */
const raceSideInput = z.union([z.string().min(1), raceEntitySchema])

export const getScrobbleRaceSchema = z.object({
  race_id: z.string().optional()
    .describe('Id of a configured race (see list_scrobble_races). Wins over leader/challenger.'),
  leader: raceSideInput.optional()
    .describe('The side in front. A bare string is an exact artist name; an object is {"type":"artist"|"album"|"track","artist":…,"albums":[…],"tracks":[…]}. Object form needs the POST endpoint, not a GET query string.'),
  challenger: raceSideInput.optional()
    .describe('The side catching up. Same shape as leader.'),
  pace_days: z.number().int().min(1).max(3650).default(90)
    .describe('Trailing window (days) used for the plays/day figures and the projected crossover date.'),
})

/**
 * When does the challenger catch up, at the observed net closing rate? Null when the
 * gap is not closing — a projection of Infinity, or a date in the past, is worse than
 * admitting there isn't one.
 */
export function projectCrossover(opts: {
  gap: number
  netPerDay: number
  now?: Date
}): { date: string; days: number } | null {
  const { gap, netPerDay } = opts
  const now = opts.now ?? new Date()
  if (gap < 0) return null // already crossed
  if (gap === 0) return { date: now.toISOString().slice(0, 10), days: 0 }
  if (netPerDay <= 0) return null
  // You can't cross on a fraction of a scrobble, so always round up.
  const days = Math.ceil(gap / netPerDay)
  return { date: new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10), days }
}

const asEntity = (side: string | RaceEntity): RaceEntity =>
  typeof side === 'string' ? artistEntity(side) : side

export type RaceResolution =
  | { race: RaceDefinition; adHoc: boolean }
  | { error: string }

/**
 * Which race a call is about.
 *
 * Pure, and separate from the handler, so every rule is testable without a database.
 * The order is the contract:
 *
 *   1. `race_id` names a configured race.
 *   2. `leader` and `challenger` given as objects build an ad-hoc race.
 *   3. `leader` and `challenger` given as bare strings are two artists — the behaviour
 *      that predates races.json. It is not its own branch: a string becomes an artist
 *      entity first, and then rule 2 handles it. That is what makes "unchanged" a
 *      structural property rather than a promise.
 *   4. Nothing given falls back to the first unresolved configured race — unless the
 *      retired RACE_*_ARTIST env vars are still set, which win for one release.
 *
 * Passing only ONE side has always been allowed (it inherited the other from the env
 * pair), so it still is: the missing side comes from whatever rule 4 resolves.
 */
export function resolveRace(
  input: { race_id?: string; leader?: string | RaceEntity; challenger?: string | RaceEntity },
  races: RaceDefinition[] = getRaces(),
  fallback: RaceDefinition | null = legacyEnvRace() ?? races.find(r => !r.archived) ?? null,
): RaceResolution {
  if (input.race_id) {
    const race = races.find(r => r.id === input.race_id)
    if (!race) {
      const known = races.map(r => r.id).join(', ') || 'none configured'
      return { error: `Unknown race "${input.race_id}". Configured races: ${known}.` }
    }
    return { race, adHoc: false }
  }

  if (input.leader || input.challenger) {
    const leader = input.leader ? asEntity(input.leader) : fallback?.leader.entity
    const challenger = input.challenger ? asEntity(input.challenger) : fallback?.challenger.entity
    if (!leader || !challenger) {
      return {
        error: 'No race configured — pass race_id, or both leader and challenger, or add a race to races.json.',
      }
    }
    // An explicit pair that happens to BE a configured race resolves to it, so the tool
    // reports that race's notifier state instead of pretending it has none.
    const configured = races.find(
      r => sameShape(r.leader.entity, leader) && sameShape(r.challenger.entity, challenger),
    )
    return configured ? { race: configured, adHoc: false } : { race: adHocRace(leader, challenger), adHoc: true }
  }

  if (!fallback) {
    return {
      error: 'No race configured — pass race_id, or both leader and challenger, or add a race to races.json.',
    }
  }
  return { race: fallback, adHoc: fallback.id === '' }
}

function sameShape(a: RaceEntity, b: RaceEntity): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export async function getScrobbleRace(input: z.infer<typeof getScrobbleRaceSchema>) {
  const resolved = resolveRace(input)
  // Re-wrapped as a literal rather than returned straight through: TypeScript only
  // normalises a union of object literals returned from the same function, and that
  // normalisation is what lets a caller read `.notifications` without narrowing first.
  // Returning the variable instead would break every existing call site's types.
  if ('error' in resolved) return { error: resolved.error }
  const { race, adHoc } = resolved
  if (adHoc && !input.leader && !input.challenger) {
    logger.warn(
      { leader: race.leader.label, challenger: race.challenger.label },
      'Answering from the deprecated RACE_LEADER_ARTIST/RACE_CHALLENGER_ARTIST pair — move the race into races.json',
    )
  }

  const leader = race.leader.entity
  const challenger = race.challenger.entity
  const since = new Date(Date.now() - input.pace_days * 86_400_000)
  const [totals, recent, leaderLast, challengerLast, state] = await Promise.all([
    countRacePlays(leader, challenger),
    countRacePlaysSince(leader, challenger, since),
    latestPlay(leader),
    latestPlay(challenger),
    // An ad-hoc race has no id, so it has no notification state of its own — and it is
    // not asked for one, rather than asking and being handed null.
    race.id ? loadRaceState(race.id) : Promise.resolve(null),
  ])

  const gap = totals.leaderPlays - totals.challengerPlays
  const leaderPerDay = recent.leaderPlays / input.pace_days
  const challengerPerDay = recent.challengerPlays / input.pace_days
  const netPerDay = challengerPerDay - leaderPerDay
  const crossover = projectCrossover({ gap, netPerDay })

  // The rung the watcher will actually announce on the next play that moves the number.
  // Derived from tightestCrossed — the notifier's own predicate — rather than from a
  // second, independent comparison. The two drifted apart once already: with `m < gap`
  // this reported 200 at a gap of 250 while the notifier was about to fire 250, because
  // tightestCrossed is inclusive. Any rung the gap has already reached but no alert has
  // spent is still owed; only past that do we look for the next one down.
  const milestones = race.milestones
  const spent = state?.lastMilestone ?? null
  const crossed = tightestCrossed(gap, milestones)
  const owed = crossed != null && (spent == null || crossed < spent) ? crossed : null
  const nextMilestone =
    gap < 0 || state?.overtakenAt
      ? null // the race is run; the next alert is the overtake, not a rung
      : (owed ?? milestones.find(m => m < (spent ?? Infinity) && m < gap) ?? null)

  return {
    race_id: race.id || null,
    title: race.title,
    archived: race.archived,
    leader: {
      artist: leader.artist,
      label: race.leader.label,
      entity: leader,
      plays: totals.leaderPlays,
      last_played_at: leaderLast?.playedAt ?? null,
      last_track: leaderLast?.track ?? null,
    },
    challenger: {
      artist: challenger.artist,
      label: race.challenger.label,
      entity: challenger,
      plays: totals.challengerPlays,
      last_played_at: challengerLast?.playedAt ?? null,
      last_track: challengerLast?.track ?? null,
    },
    gap,
    leader_ahead: gap > 0,
    plays_to_level: Math.max(0, gap),
    plays_to_overtake: Math.max(0, gap + 1),
    pace: {
      window_days: input.pace_days,
      leader_plays_per_day: Number(leaderPerDay.toFixed(2)),
      challenger_plays_per_day: Number(challengerPerDay.toFixed(2)),
      net_closing_per_day: Number(netPerDay.toFixed(2)),
      projected_crossover_date: crossover?.date ?? null,
      projected_days: crossover?.days ?? null,
    },
    notifications: state
      ? {
          armed: Boolean(config.NTFY_PASSWORD),
          topic: race.topic,
          last_milestone: state.lastMilestone,
          next_milestone: nextMilestone,
          // The countdown band, and whether the race has ever been inside it. Armed is
          // read from the persisted latch rather than compared live against the gap:
          // the leader scrobbling twice must not report a race that reached its
          // endgame as no longer in one. See decision record 0022.
          endgame_gap: race.endgameGap,
          endgame_armed: Boolean(state.endgameArmedAt),
          nowplaying_gap: race.nowplayingGap,
          overtaken_at: state.overtakenAt,
        }
      : {
          armed: false,
          topic: null,
          last_milestone: tightestCrossed(gap, milestones),
          next_milestone: nextMilestone,
          endgame_gap: race.endgameGap,
          // No stored state for this race, so nothing has ever observed it armed.
          endgame_armed: false,
          nowplaying_gap: race.nowplayingGap,
          overtaken_at: null,
        },
  }
}
