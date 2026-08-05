import { describe, it, expect } from 'vitest'
import {
  matchTrip,
  candidateWindow,
  planTripPostLinks,
  BOARDING_LEAD_MS,
  ALIGHTING_TRAIL_MS,
  UNKNOWN_ARRIVAL_ABOARD_MS,
  type TripWindow,
  type StoredLink,
  type DesiredLink,
} from './trip-window.js'

function trip(tripId: string, departure: string, arrival: string | null): TripWindow {
  return {
    tripId,
    departureAt: new Date(departure),
    arrivalAt: arrival ? new Date(arrival) : null,
  }
}

/**
 * The four alignments measured against the live archive before this was written.
 * They are the reason the join exists at all, so they are the first thing that has
 * to keep passing.
 */
describe('matchTrip — the real togselfies', () => {
  const kobenhavnMalmo = trip('t1', '2026-06-04T16:59:00Z', '2026-06-04T17:40:00Z')
  const malmoGoteborg = trip('t2', '2026-06-04T18:04:00Z', '2026-06-04T20:35:00Z')
  const goteborgOslo = trip('t3', '2026-06-05T06:10:00Z', '2026-06-05T09:45:00Z')
  const osloBergen = trip('t4', '2026-06-05T10:03:00Z', '2026-06-05T17:08:00Z')
  const arnaBergen = trip('t5', '2026-06-14T14:47:00Z', '2026-06-14T14:54:00Z')
  const all = [kobenhavnMalmo, malmoGoteborg, goteborgOslo, osloBergen, arnaBergen]

  it('binds «Malmø neste!» to the København → Malmö leg (+1m41s)', () => {
    const m = matchTrip(new Date('2026-06-04T17:00:41Z'), all)
    expect(m).toEqual({ tripId: 't1', relation: 'aboard', offsetSeconds: 101 })
  })

  it('binds the X2000 selfie to the Malmö → Göteborg leg (+5m39s)', () => {
    const m = matchTrip(new Date('2026-06-04T18:09:39Z'), all)
    expect(m).toEqual({ tripId: 't2', relation: 'aboard', offsetSeconds: 339 })
  })

  it('binds the #KodeToget selfie to the Göteborg → Oslo leg (+14s)', () => {
    const m = matchTrip(new Date('2026-06-05T06:10:14Z'), all)
    expect(m).toEqual({ tripId: 't3', relation: 'aboard', offsetSeconds: 14 })
  })

  it('binds the Arna selfie to the Arna → Bergen leg at its arrival minute', () => {
    const m = matchTrip(new Date('2026-06-14T14:54:23Z'), all)
    // 14:54:23 is 23s past the 14:54:00 arrival, so it is alighting, not aboard.
    expect(m).toEqual({ tripId: 't5', relation: 'alighting', offsetSeconds: 443 })
  })

  it('binds a mid-journey post to the leg it was written on', () => {
    // The 14:01 togselfie posted during the seven-hour Bergensbanen run — the post
    // that proves the trips are a listening blackout rather than a signal blackout.
    const m = matchTrip(new Date('2026-06-05T14:01:17Z'), all)
    // 10:03:00 → 14:01:17 is 3h58m17s aboard.
    expect(m).toEqual({ tripId: 't4', relation: 'aboard', offsetSeconds: 14297 })
  })
})

describe('matchTrip — window edges', () => {
  const t = trip('t1', '2026-06-05T10:00:00Z', '2026-06-05T12:00:00Z')

  it('counts a post at the exact departure second as aboard, not boarding', () => {
    // The Göteborg selfie landed 14s after departure; a rule that put such posts on
    // the platform would mislabel the tightest matches in the archive.
    expect(matchTrip(new Date('2026-06-05T10:00:00Z'), [t])).toMatchObject({ relation: 'aboard' })
  })

  it('counts a post at the exact arrival second as aboard, not alighting', () => {
    expect(matchTrip(new Date('2026-06-05T12:00:00Z'), [t])).toMatchObject({ relation: 'aboard' })
  })

  it('classifies the platform half-hour before departure as boarding, with a negative offset', () => {
    const m = matchTrip(new Date('2026-06-05T09:45:00Z'), [t])
    expect(m).toEqual({ tripId: 't1', relation: 'boarding', offsetSeconds: -900 })
  })

  it('includes the last instant of the boarding lead', () => {
    const at = new Date(t.departureAt.getTime() - BOARDING_LEAD_MS)
    expect(matchTrip(at, [t])).toMatchObject({ relation: 'boarding' })
  })

  it('excludes a post one second before the boarding lead opens', () => {
    const at = new Date(t.departureAt.getTime() - BOARDING_LEAD_MS - 1000)
    expect(matchTrip(at, [t])).toBeNull()
  })

  it('includes the last instant of the alighting trail', () => {
    const at = new Date(t.arrivalAt!.getTime() + ALIGHTING_TRAIL_MS)
    expect(matchTrip(at, [t])).toMatchObject({ relation: 'alighting' })
  })

  it('excludes a post one second after the alighting trail closes', () => {
    const at = new Date(t.arrivalAt!.getTime() + ALIGHTING_TRAIL_MS + 1000)
    expect(matchTrip(at, [t])).toBeNull()
  })

  it('returns null when there are no trips at all', () => {
    expect(matchTrip(new Date('2026-06-05T10:30:00Z'), [])).toBeNull()
  })
})

describe('matchTrip — overlapping legs', () => {
  // The real Sjælland rundt pair: Roskilde→Næstved arrives 17:01, Næstved→
  // København departs 17:10. A post in the gap is in both windows.
  const arriving = trip('a', '2026-06-02T16:26:00Z', '2026-06-02T17:01:00Z')
  const departing = trip('b', '2026-06-02T17:10:00Z', '2026-06-02T17:55:00Z')
  const legs = [arriving, departing]

  it('gives a post in the connection gap to the nearer leg', () => {
    // 17:05 is +4m from the arrival and −5m from the next departure.
    const m = matchTrip(new Date('2026-06-02T17:05:00Z'), legs)
    expect(m).toMatchObject({ tripId: 'a', relation: 'alighting' })
  })

  it('gives a post later in the gap to the departing leg', () => {
    // 17:07 is +6m from the arrival and −3m from the next departure.
    const m = matchTrip(new Date('2026-06-02T17:07:00Z'), legs)
    expect(m).toMatchObject({ tripId: 'b', relation: 'boarding' })
  })

  it('prefers aboard over an edge even when the edge is closer', () => {
    // Aboard the long leg by 20 minutes, but only 2 minutes from another's departure.
    const long = trip('long', '2026-06-02T10:00:00Z', '2026-06-02T18:00:00Z')
    const other = trip('other', '2026-06-02T10:22:00Z', '2026-06-02T11:00:00Z')
    const m = matchTrip(new Date('2026-06-02T10:20:00Z'), [long, other])
    expect(m).toMatchObject({ tripId: 'long', relation: 'aboard' })
  })

  it('is stable when two candidates tie exactly', () => {
    // Identical windows: the tie-break falls through departure to the id, so the
    // answer cannot flip between runs.
    const x = trip('x', '2026-06-02T10:00:00Z', '2026-06-02T11:00:00Z')
    const y = trip('y', '2026-06-02T10:00:00Z', '2026-06-02T11:00:00Z')
    const at = new Date('2026-06-02T10:30:00Z')
    expect(matchTrip(at, [x, y])?.tripId).toBe('x')
    expect(matchTrip(at, [y, x])?.tripId).toBe('x')
  })
})

describe('matchTrip — trips with no recorded arrival', () => {
  const open = trip('open', '2026-06-05T10:00:00Z', null)

  it('counts the half-hour after departure as aboard', () => {
    const m = matchTrip(new Date('2026-06-05T10:20:00Z'), [open])
    expect(m).toMatchObject({ tripId: 'open', relation: 'aboard' })
  })

  it('still classifies boarding normally', () => {
    expect(matchTrip(new Date('2026-06-05T09:50:00Z'), [open])).toMatchObject({ relation: 'boarding' })
  })

  it('never invents an alighting, or a duration past what is known', () => {
    const past = new Date(open.departureAt.getTime() + UNKNOWN_ARRIVAL_ABOARD_MS + 1000)
    expect(matchTrip(past, [open])).toBeNull()
  })
})

describe('matchTrip — corrupt rows', () => {
  it('does not drop a trip whose arrival precedes its departure', () => {
    // A backwards row is bad data, not a zero-length trip. Matching nothing would
    // silently lose every post around it.
    const backwards = trip('bad', '2026-06-05T10:00:00Z', '2026-06-05T09:00:00Z')
    expect(matchTrip(new Date('2026-06-05T10:00:00Z'), [backwards])).toMatchObject({
      relation: 'aboard',
    })
  })
})

describe('candidateWindow', () => {
  it('spans from the earliest boarding lead to the latest alighting trail', () => {
    const w = candidateWindow([
      trip('a', '2026-06-05T10:00:00Z', '2026-06-05T12:00:00Z'),
      trip('b', '2026-06-06T08:00:00Z', '2026-06-06T09:00:00Z'),
    ])
    expect(w?.from.toISOString()).toBe('2026-06-05T09:30:00.000Z')
    expect(w?.to.toISOString()).toBe('2026-06-06T09:30:00.000Z')
  })

  it('extends past a null arrival by the aboard fallback only', () => {
    const w = candidateWindow([trip('a', '2026-06-05T10:00:00Z', null)])
    expect(w?.to.toISOString()).toBe('2026-06-05T10:30:00.000Z')
  })

  it('is null for an empty trip set', () => {
    expect(candidateWindow([])).toBeNull()
  })
})

describe('planTripPostLinks', () => {
  const desired = (objectApId: string, tripId: string, offsetSeconds = 60): DesiredLink => ({
    objectApId,
    tripId,
    relation: 'aboard',
    offsetSeconds,
  })
  const stored = (objectApId: string, tripId: string, offsetSeconds = 60): StoredLink => ({
    objectApId,
    tripId,
    relation: 'aboard',
    offsetSeconds,
  })

  it('inserts links that are not stored yet', () => {
    const plan = planTripPostLinks([desired('p1', 't1')], [])
    expect(plan.toInsert).toHaveLength(1)
    expect(plan.toUpdate).toHaveLength(0)
    expect(plan.toDelete).toHaveLength(0)
  })

  it('writes nothing when a re-run derives the same links', () => {
    // The idempotence claim in ADR 0022: a second run reports zeroes.
    const plan = planTripPostLinks([desired('p1', 't1')], [stored('p1', 't1')])
    expect(plan).toEqual({ toInsert: [], toUpdate: [], toDelete: [] })
  })

  it('updates a link whose trip changed', () => {
    // A corrected arrival time re-classifies the posts around it.
    const plan = planTripPostLinks([desired('p1', 't2')], [stored('p1', 't1')])
    expect(plan.toUpdate).toEqual([desired('p1', 't2')])
    expect(plan.toDelete).toHaveLength(0)
  })

  it('updates a link whose relation changed but whose trip did not', () => {
    const plan = planTripPostLinks(
      [{ objectApId: 'p1', tripId: 't1', relation: 'alighting', offsetSeconds: 60 }],
      [stored('p1', 't1')],
    )
    expect(plan.toUpdate).toHaveLength(1)
  })

  it('updates a link whose offset drifted', () => {
    const plan = planTripPostLinks([desired('p1', 't1', 90)], [stored('p1', 't1', 60)])
    expect(plan.toUpdate).toHaveLength(1)
  })

  it('deletes a stored link that no longer matches any trip', () => {
    const plan = planTripPostLinks([], [stored('p1', 't1')])
    expect(plan.toDelete).toEqual(['p1'])
  })
})
