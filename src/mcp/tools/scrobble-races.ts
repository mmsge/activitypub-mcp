import { z } from 'zod'
import { countRacePlays, loadRaceStates } from '../../lib/race-store.js'
import { getRaces } from '../../lib/races-config.js'

export const listScrobbleRacesSchema = z.object({
  include_archived: z.boolean().default(true)
    .describe('Include races already resolved. They stay queryable; the notifier skips them.'),
})

/**
 * Every configured race, with its standings.
 *
 * The standings are here rather than behind a second call because the question this
 * answers is "which race do I want?", and an id and a title alone rarely settle it. One
 * count query per race plus ONE batched state read — not one state read per race.
 *
 * Deliberately no pace and no last-played: those cost four more queries per race and are
 * what get_scrobble_race is for.
 */
export async function listScrobbleRaces(input: z.infer<typeof listScrobbleRacesSchema>) {
  const races = getRaces().filter(r => input.include_archived || !r.archived)
  const [counts, states] = await Promise.all([
    Promise.all(races.map(r => countRacePlays(r.leader.entity, r.challenger.entity))),
    loadRaceStates(races.map(r => r.id)),
  ])

  return {
    total: races.length,
    races: races.map((race, i) => {
      const { leaderPlays, challengerPlays } = counts[i]!
      const gap = leaderPlays - challengerPlays
      const state = states.get(race.id)
      return {
        race_id: race.id,
        title: race.title,
        archived: race.archived,
        topic: race.topic,
        leader: {
          artist: race.leader.entity.artist,
          label: race.leader.label,
          entity: race.leader.entity,
          plays: leaderPlays,
        },
        challenger: {
          artist: race.challenger.entity.artist,
          label: race.challenger.label,
          entity: race.challenger.entity,
          plays: challengerPlays,
        },
        gap,
        leader_ahead: gap > 0,
        plays_to_overtake: Math.max(0, gap + 1),
        overtaken_at: state?.overtakenAt ?? null,
      }
    }),
  }
}
