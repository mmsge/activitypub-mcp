import { z } from 'zod'
import { convergenceStanding } from '../../jobs/convergence.js'
import { dailyRates, listCrossings } from '../../lib/convergence-store.js'

/**
 * The convergence watcher's read surface: where the two counters stand against each
 * other, every crossing already recorded, and when they are next due to meet.
 *
 * The totals come from the two archives rather than from `convergence_state`. That row
 * is the watcher's cursor, and quoting it would report whatever the watcher last
 * managed instead of what is actually stored — this must agree with
 * `get_scrobble_stats` and `get_train_stats`.
 */

export const getConvergenceSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20)
    .describe('How many recorded crossings to return, newest first.'),
  pace_days: z.number().int().min(1).max(3650).default(365)
    .describe('Trailing window, in days, the per-day rates and the projection are computed over.'),
})

/** When the gap closes at the current net rate. Null when it is not closing at all. */
function projectMeeting(gap: number, netPerDay: number): { days: number; date: string } | null {
  // `gap` is km − scrobbles. It closes when the two rates pull it toward zero: a
  // negative gap needs km to gain, a positive one needs scrobbles to.
  const closing = gap < 0 ? netPerDay : -netPerDay
  if (closing <= 0) return null
  const days = Math.ceil(Math.abs(gap) / closing)
  if (!Number.isFinite(days)) return null
  return {
    days,
    date: new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10),
  }
}

export async function getConvergence(input: z.infer<typeof getConvergenceSchema>) {
  const [standing, rates, rows] = await Promise.all([
    convergenceStanding(),
    dailyRates(input.pace_days),
    listCrossings(input.limit),
  ])

  const netPerDay = rates.km - rates.scrobbles

  return {
    total_scrobbles: standing.scrobbles,
    total_km: standing.km,
    // km − scrobbles. Negative while the listening is ahead.
    gap: standing.gap,
    leader: standing.leader,
    // Whole kilometres per leg, exactly as viaduct stores them — "level" is only exact
    // at that resolution, and nothing here rounds any further.
    kilometre_resolution: 'whole kilometres per leg, as stored',
    // Legs count from the moment they departed, not from a Completed status: viaduct
    // freezes `Planned` on a row it never re-exports. See ADR 0031 and 0056.
    counted_legs: 'departed (departure_at <= now)',
    pace: {
      days: input.pace_days,
      scrobbles_per_day: Number(rates.scrobbles.toFixed(2)),
      km_per_day: Number(rates.km.toFixed(2)),
      net_per_day: Number(netPerDay.toFixed(2)),
    },
    projected_meeting: projectMeeting(standing.gap, netPerDay),
    crossings: rows.map(r => ({
      kind: r.kind,
      occurred_at: r.occurredAt,
      ended_at: r.endedAt,
      held_seconds: r.endedAt
        ? Math.round((r.endedAt.getTime() - r.occurredAt.getTime()) / 1000)
        : null,
      value: r.value,
      gap: r.gap,
      leader: r.leader,
      total_scrobbles: r.scrobbles,
      total_km: r.km,
      historical: r.historical,
      notified_at: r.notifiedAt,
      cause: r.causeKind === 'scrobble'
        ? { kind: 'scrobble', artist: r.causeArtist, track: r.causeTrack, album: r.causeAlbum, url: r.causeUrl }
        : { kind: 'leg', from: r.causeFrom, to: r.causeTo, journey: r.causeJourney, km: r.causeKm },
    })),
  }
}
