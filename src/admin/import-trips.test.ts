import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { buildTrainTripsUpsert, tripUpsertRules } from './import.js'

// Rendered-SQL assertions, not DB round-trips (vitest has no database) — the same shape
// as media-query.test.ts. What is pinned here is ADR 0047's whole claim: that a trip is
// identified by when it left and between where, that a re-export improves a stored trip
// instead of duplicating it, and that a repeat import writes nothing at all. Each of the
// three fails silently if it regresses: the first as a second copy of a journey, the
// second as a leg stuck on Planned forever, the third as a no-op import that rewrites
// every row it touched.

const rendered = () =>
  (
    buildTrainTripsUpsert([
      {
        fromStation: 'Oslo S',
        toStation: 'Bergen',
        departureLocal: sql`'2026-08-10 16:23:00'::timestamp`,
        departureAt: sql`('2026-08-10 16:23:00'::timestamp AT TIME ZONE 'Europe/Oslo')`,
        raw: {},
      },
    ]) as never as { toSQL(): { sql: string } }
  ).toSQL().sql

describe('train trips upsert', () => {
  it('conflicts on the identity tuple, and on nothing else', () => {
    const q = rendered()
    expect(q).toContain('on conflict ("from_station","to_station","departure_at") do update')
    // The hash it replaced. Train code in the key is what stored one journey twice.
    expect(q).not.toContain('dedupe_key')
    expect(q).not.toContain('do nothing')
  })

  it('lets an incoming value improve a stored one, but never blank it', () => {
    const q = rendered()
    for (const column of ['train_code', 'delay', 'distance_km', 'operator', 'travel_class']) {
      expect(q).toContain(`"${column}" = coalesce(excluded."${column}", "train_trips"."${column}")`)
    }
  })

  it('lets status move, which is what turns Planned into Completed', () => {
    expect(rendered()).toContain('"status" = coalesce(excluded."status", "train_trips"."status")')
  })

  it('never touches the columns identity is derived from', () => {
    const { set } = tripUpsertRules()
    for (const key of ['fromStation', 'toStation', 'departureAt', 'departureLocal', 'fromTz']) {
      expect(set).not.toHaveProperty(key)
    }
  })

  it('moves arrival as a unit, so the clock, the instant and the zone cannot disagree', () => {
    const q = rendered()
    for (const column of ['arrival_local', 'arrival_at', 'to_tz']) {
      expect(q).toContain(
        `"${column}" = case when excluded."arrival_at" is not null then excluded."${column}" else "train_trips"."${column}" end`,
      )
    }
  })

  it('ORs the amenity flags rather than overwriting them', () => {
    // They are NOT NULL DEFAULT false, so an absent flag is indistinguishable from a
    // denied one and coalesce would let a quiet export erase the dining car.
    expect(rendered()).toContain('"dining_car" = ("train_trips"."dining_car" or excluded."dining_car")')
  })

  it('guards every updated column, so an unchanged re-import writes nothing', () => {
    const { set } = tripUpsertRules()
    const q = rendered()
    const where = q.slice(q.indexOf(' where '), q.indexOf(' returning '))

    // Every column the SET writes has to appear in the guard, or a repeat import would
    // rewrite the row on account of the one column nobody compared. Both rules are
    // generated from the same pass, so this pins that they stay generated from it.
    for (const key of Object.keys(set)) {
      const column = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
      expect(where, `"${column}" is missing from the idempotency guard`).toContain(
        `is distinct from "train_trips"."${column}"`,
      )
    }
    // …and nothing beyond them, so the guard cannot quietly become always-true.
    expect(where.split(' is distinct from ')).toHaveLength(Object.keys(set).length + 1)
  })

  it('reports whether each returned row was inserted or matched', () => {
    // xmax is 0 on a tuple this statement inserted; without it an insert that should
    // have been a match is indistinguishable from a match in the logs.
    expect(rendered()).toContain('(xmax = 0)')
  })
})
