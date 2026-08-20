import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  buildDepartureKeyQuery,
  buildTrainTripsUpsert,
  departureInstantSql,
  tripUpsertRules,
} from './import.js'
import {
  DEPARTURE_KEY_FORMAT,
  buildStoredInWindowSelect,
  buildTripPruneDelete,
  departureKeySql,
} from './prune-trips.js'
import type { TripRow } from '../lib/parse-trips-csv.js'

// Rendered-SQL assertions, not DB round-trips (vitest has no database) — the same shape
// as media-query.test.ts. What is pinned here is ADR 0048's whole claim: that a trip is
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

// The prune's half of ADR 0054: an export is evidence of absence only inside its own
// range, and the two sides of that comparison have to be built by the same expression.
// A stored key in one shape and an incoming key in another does not fail loudly — it
// makes every stored trip look absent, which the threshold would then refuse and call
// a bad file.

const dialect = new PgDialect()
const render = (q: { toSQL(): { sql: string } }) => q.toSQL().sql

const tripRow = (departureLocal: string, fromTz: string): TripRow =>
  ({ fromStation: 'Oslo S', toStation: 'Hamar', departureLocal, fromTz }) as TripRow

describe('the departure-instant expression', () => {
  it('derives the instant from a wall clock and a NAMED zone', () => {
    expect(dialect.sqlToQuery(departureInstantSql('2026-08-20 07:34:00', 'Europe/Oslo'))).toEqual({
      sql: '($1::timestamp AT TIME ZONE $2)',
      params: ['2026-08-20 07:34:00', 'Europe/Oslo'],
      typings: ['none', 'none'],
    })
  })

  it('is the one expression the key query also builds its instant from', () => {
    // Not a style point. The prune compares a resolved incoming instant against the
    // stored one, so a second spelling here would be a second answer to "when did this
    // leave" — and every stored trip would read as absent from the export.
    const shape = dialect
      .sqlToQuery(departureInstantSql(sql`v.local`, sql`v.tz`))
      .sql
    expect(shape).toBe('(v.local::timestamp AT TIME ZONE v.tz)')
    expect(dialect.sqlToQuery(buildDepartureKeyQuery([tripRow('2026-08-20 06:34:00', 'Europe/Oslo')])).sql)
      .toContain(shape)
  })
})

describe('buildDepartureKeyQuery', () => {
  const q = () =>
    dialect.sqlToQuery(
      buildDepartureKeyQuery([
        tripRow('2026-08-20 06:34:00', 'Europe/Oslo'),
        tripRow('2026-08-20 07:34:00', 'Europe/Oslo'),
      ]),
    )

  it('derives the instant in Postgres, not in JS', () => {
    expect(q().sql).toContain('::timestamp AT TIME ZONE')
  })

  it('casts every parameter inside its VALUES row, not on the outer column', () => {
    // Postgres resolves the VALUES rowtype before the outer select's casts, and
    // postgres-js sends strings with no type OID: cast outside and the whole query
    // fails with "failed to determine data type of parameter $1".
    expect(q().sql).toContain('::int, $')
    expect(q().sql).toMatch(/\$\d+::text, \$\d+::text\)/)
  })

  it('tags each row with its index, so the answer is not trusted to arrive in order', () => {
    expect(q().sql).toContain('v.i as i')
    expect(q().sql).toContain('as v(i, local, tz)')
    expect(q().params).toEqual([0, '2026-08-20 06:34:00', 'Europe/Oslo', 1, '2026-08-20 07:34:00', 'Europe/Oslo'])
  })

  it('renders the identity key exactly as the stored side does', () => {
    const incoming = q().sql
    const storedSide = dialect.sqlToQuery(departureKeySql(sql`x`)).sql
    const shape = storedSide.replace('x', '')
    expect(incoming).toContain(`at time zone 'UTC', '${DEPARTURE_KEY_FORMAT}'`)
    expect(shape).toContain(`at time zone 'UTC', '${DEPARTURE_KEY_FORMAT}'`)
  })

  it('sends the format as literal SQL, so both sides cannot drift on a parameter', () => {
    expect(q().params).not.toContain(DEPARTURE_KEY_FORMAT)
  })
})

describe('buildStoredInWindowSelect', () => {
  const q = () => render(buildStoredInWindowSelect(new Date(0), new Date(1)) as never)

  it('bounds the read on departure_at and nothing else', () => {
    const where = q().slice(q().indexOf(' where '), q().indexOf(' order by '))
    expect(where).toContain('"departure_at" >=')
    expect(where).toContain('"departure_at" <=')
    expect(where).not.toContain('from_station')
    expect(where).not.toContain('"status"')
  })

  it('selects what the prune log line and the result page need', () => {
    for (const column of ['journey', 'train_code', 'status', 'distance_km', 'created_at']) {
      expect(q()).toContain(`"${column}"`)
    }
  })
})

describe('buildTripPruneDelete', () => {
  const q = () => render(buildTripPruneDelete(['a', 'b']) as never)

  it('deletes by primary key and by nothing else', () => {
    // The highest-value assertion here. A mis-built plan can name the wrong trips; no
    // statement in this codebase can remove MORE rows than the plan named.
    expect(q()).toContain('delete from "train_trips" where "train_trips"."id" in ')
    for (const column of ['from_station', 'to_station', 'departure_at', 'journey', 'status']) {
      const where = q().slice(q().indexOf(' where '), q().indexOf(' returning '))
      expect(where).not.toContain(column)
    }
  })

  it('returns the row it removed, so the log describes what went and not what was meant', () => {
    expect(q()).toContain(' returning ')
    for (const column of ['from_station', 'to_station', 'departure_at', 'journey', 'train_code']) {
      expect(q().slice(q().indexOf(' returning '))).toContain(`"${column}"`)
    }
  })
})
