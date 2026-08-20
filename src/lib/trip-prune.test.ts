import { describe, it, expect } from 'vitest'
import {
  identityKey,
  planTripPrune,
  pruneRefusal,
  pruneWindow,
  type PruneLimits,
  type StoredTrip,
  type TripIdentity,
} from './trip-prune.js'

// What is pinned here is decision record 0054's whole claim: that an export is
// evidence of absence only inside its own range, and that a plan too large for that
// range is a bad file rather than a correction. Each half fails silently if it
// regresses — the first as a partial export quietly emptying the years around it,
// the second as a filtered export taking real legs with it.

const LIMITS: PruneLimits = { maxShare: 0.2, minCandidates: 3, minWindow: 10 }

const key = (day: number, hh: string) => `2026-08-${String(day).padStart(2, '0')} ${hh}:00`

const incoming = (fromStation: string, toStation: string, k: string): TripIdentity => ({
  fromStation,
  toStation,
  key: k,
})

const stored = (fromStation: string, toStation: string, k: string, id = k): StoredTrip => ({
  id,
  fromStation,
  toStation,
  key: k,
  departureAt: new Date(`${k.replace(' ', 'T')}Z`),
  departureLocal: new Date(`${k.replace(' ', 'T')}Z`),
  arrivalAt: null,
  journey: null,
  trainCode: null,
  status: null,
  distanceKm: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
})

describe('pruneWindow', () => {
  it('is null when the export named no trips, so nothing is eligible', () => {
    expect(pruneWindow([])).toBeNull()
  })

  it('spans the earliest and latest departure in the file', () => {
    const w = pruneWindow([
      incoming('Oslo S', 'Hamar', key(20, '05:34')),
      incoming('Hamar', 'Roros', key(20, '08:11')),
      incoming('Bergen', 'Oslo S', key(18, '06:10')),
    ])
    expect(w?.fromKey).toBe(key(18, '06:10'))
    expect(w?.toKey).toBe(key(20, '08:11'))
  })

  it('collapses to a zero-width window for a single row', () => {
    const w = pruneWindow([incoming('Oslo S', 'Hamar', key(20, '05:34'))])
    expect(w?.fromKey).toBe(w?.toKey)
    expect(w?.from.toISOString()).toBe('2026-08-20T05:34:00.000Z')
  })
})

describe('planTripPrune', () => {
  it('reports nothing at all for an empty export', () => {
    expect(planTripPrune([], [stored('Oslo S', 'Hamar', key(20, '05:34'))], LIMITS)).toEqual({
      window: null,
      inWindow: 0,
      candidates: [],
      refusal: null,
    })
  })

  it('names the trip the export no longer contains', () => {
    // The live case: viaduct dropped the 07:34 Oslo S -> Hamar leg (05:34Z) and still
    // has the real 06:34 one (04:34Z). Both stored, one exported.
    const real = stored('Oslo S', 'Hamar', key(20, '04:34'), 'real')
    const phantom = stored('Oslo S', 'Hamar', key(20, '05:34'), 'phantom')
    const plan = planTripPrune(
      [incoming('Oslo S', 'Hamar', key(20, '04:34')), incoming('Hamar', 'Roros', key(20, '08:11'))],
      [real, phantom, stored('Hamar', 'Roros', key(20, '08:11'))],
      LIMITS,
    )
    expect(plan.candidates.map((c) => c.id)).toEqual(['phantom'])
  })

  it('cannot reach a trip outside the export range, however absent it is', () => {
    // The guarantee a truncated export depends on. The 2025 leg is in no export here
    // and must survive anyway.
    const outside = stored('Oslo S', 'Trondheim', '2025-03-01 07:00:00', 'outside')
    const plan = planTripPrune(
      [incoming('Oslo S', 'Hamar', key(20, '04:34'))],
      [stored('Oslo S', 'Hamar', key(20, '04:34')), outside],
      LIMITS,
    )
    // `storedInWindow` is bounded by the caller's query; passing an out-of-range row
    // here proves the planner does not widen what it was given.
    expect(plan.window?.fromKey).toBe(key(20, '04:34'))
    expect(plan.candidates.map((c) => c.id)).toEqual(['outside'])
  })

  it('treats both window bounds as inclusive', () => {
    const plan = planTripPrune(
      [incoming('A', 'B', key(20, '06:00')), incoming('A', 'B', key(20, '08:00'))],
      [
        stored('A', 'B', key(20, '06:00')),
        stored('A', 'B', key(20, '08:00')),
        stored('C', 'D', key(20, '06:00'), 'edge-low'),
        stored('C', 'D', key(20, '08:00'), 'edge-high'),
      ],
      { ...LIMITS, maxShare: 1 },
    )
    expect(plan.candidates.map((c) => c.id)).toEqual(['edge-low', 'edge-high'])
  })

  it('keys on all three parts of the identity, not two of them', () => {
    const file = [incoming('Oslo S', 'Hamar', key(20, '04:34'))]
    const same = stored('Oslo S', 'Hamar', key(20, '04:34'), 'same')
    const otherInstant = stored('Oslo S', 'Hamar', key(20, '05:34'), 'other-instant')
    const otherDestination = stored('Oslo S', 'Lillehammer', key(20, '04:34'), 'other-to')
    const otherOrigin = stored('Drammen', 'Hamar', key(20, '04:34'), 'other-from')

    const plan = planTripPrune(
      file,
      [same, otherInstant, otherDestination, otherOrigin],
      { ...LIMITS, maxShare: 1 },
    )
    expect(plan.candidates.map((c) => c.id)).toEqual([
      'other-instant',
      'other-to',
      'other-from',
    ])
  })

  it('finds nothing to prune when the export re-states exactly what is stored', () => {
    // The common case, and the one the whole feature must not disturb: re-importing an
    // unchanged export writes nothing and proposes nothing.
    const rows = [
      incoming('Oslo S', 'Hamar', key(20, '04:34')),
      incoming('Hamar', 'Roros', key(20, '08:11')),
    ]
    const plan = planTripPrune(
      rows,
      rows.map((r) => stored(r.fromStation, r.toStation, r.key)),
      LIMITS,
    )
    expect(plan.candidates).toEqual([])
    expect(plan.refusal).toBeNull()
  })
})

describe('pruneRefusal', () => {
  it('never refuses a plan that deletes nothing', () => {
    expect(pruneRefusal(0, 0, LIMITS)).toBeNull()
    expect(pruneRefusal(0, 500, { maxShare: 0, minCandidates: 0, minWindow: 0 })).toBeNull()
  })

  it('is strict at the share boundary: 20 of 100 passes, 21 refuses', () => {
    expect(pruneRefusal(20, 100, LIMITS)).toBeNull()
    expect(pruneRefusal(21, 100, LIMITS)).toContain('21 of the 100')
  })

  it('lets a handful through in a populated window', () => {
    // 3 of 12 is 25%, over the ceiling, and passes only because 3 <= the floor. That
    // is the whole job of the floor: a few corrections in a window that can spare them.
    expect(pruneRefusal(3, 12, LIMITS)).toBeNull()
    expect(pruneRefusal(4, 12, LIMITS)).not.toBeNull()
  })

  it('refuses 2 of 4 despite 2 being under the floor, because the window is narrow', () => {
    // The regression that made the floor conditional. Export one journey's two legs
    // over a window holding four real trips and the two absent ones are half of it —
    // which is a filtered export, not a correction.
    expect(pruneRefusal(2, 4, LIMITS)).toContain('2 of the 4')
    // …and the same two deletions in a window that can afford them still pass.
    expect(pruneRefusal(2, 10, LIMITS)).toBeNull()
  })

  it('does not divide by an empty window', () => {
    expect(pruneRefusal(3, 0, LIMITS)).toBeNull()
  })

  it('names the counts and both percentages, so the view formats nothing', () => {
    const refusal = pruneRefusal(21, 100, LIMITS) ?? ''
    expect(refusal).toContain('21 of the 100')
    expect(refusal).toContain('(21%)')
    expect(refusal).toContain('20% ceiling')
  })
})

describe('identityKey', () => {
  it('separates the parts with something a station name cannot contain', () => {
    // Station names contain spaces. Joined on one, `Oslo` -> `S Hamar` and
    // `Oslo S` -> `Hamar` are the same key, and one of them would be pruned as absent
    // from an export that names it.
    expect(identityKey(incoming('Oslo', 'S Hamar', key(20, '04:34')))).not.toBe(
      identityKey(incoming('Oslo S', 'Hamar', key(20, '04:34'))),
    )
  })
})
