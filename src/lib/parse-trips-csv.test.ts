import { describe, it, expect } from 'vitest'
import { parseTrainTripsCsv } from './parse-trips-csv.js'

// The parser had no test until ADR 0047 took the identity hash out of it. What is
// pinned here is the part the rest of the import trusts blindly: that a row's
// departure instant is derived from a wall clock and a NAMED zone, and that the parser
// says so when the export named none. Identity is compared on that instant, so a
// silently assumed zone is the one failure the tuple key cannot absorb.

const HEADER =
  'from_station_name,to_station_name,departure_date,departure_time,arrival_date,arrival_time,' +
  'from_station_tz,to_station_tz,journey,train_code,operator,travel_class,distance,delay,status,tags,night'

const row = (cells: string) => `${HEADER}\n${cells}`

describe('parseTrainTripsCsv', () => {
  it('rejects a header missing a required column', () => {
    expect(() => parseTrainTripsCsv('to_station_name,departure_date\nBergen,2026-08-10')).toThrow(
      /missing required column\(s\): from_station_name/,
    )
  })

  it('skips rows without both stations and a departure date rather than failing the file', () => {
    const rows = parseTrainTripsCsv(
      row(
        'Oslo S,Bergen,2026-08-10,16:23,2026-08-10,23:18,Europe/Oslo,Europe/Oslo,Torucon 2026,R 67,Vygruppen AS,C1,484,0,Completed,,false\n' +
          ',Bergen,2026-08-10,16:23,,,,,,,,,,,,,\n' +
          'Oslo S,,2026-08-10,16:23,,,,,,,,,,,,,\n' +
          'Oslo S,Bergen,,16:23,,,,,,,,,,,,,',
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].fromStation).toBe('Oslo S')
  })

  it('keeps the departure as a wall clock, never a Date', () => {
    const [trip] = parseTrainTripsCsv(
      row('Oslo S,Bergen,2026-08-10,16:23,2026-08-10,23:18,Europe/Oslo,Europe/Oslo,,,,,,,,,'),
    )
    expect(trip.departureLocal).toBe('2026-08-10 16:23:00')
    expect(trip.arrivalLocal).toBe('2026-08-10 23:18:00')
  })

  it('defaults a missing time to midnight but not a missing date', () => {
    const [trip] = parseTrainTripsCsv(
      row('Oslo S,Bergen,2026-08-10,,,,Europe/Oslo,Europe/Oslo,,,,,,,,,'),
    )
    expect(trip.departureLocal).toBe('2026-08-10 00:00:00')
    expect(trip.arrivalLocal).toBeNull()
  })

  it('flags the row when the export named no origin zone, and falls back to UTC', () => {
    const [assumed] = parseTrainTripsCsv(
      row('Oslo S,Bergen,2026-08-10,16:23,,,,,,,,,,,,,'),
    )
    expect(assumed.tzAssumed).toBe(true)
    expect(assumed.fromTz).toBe('UTC')

    const [named] = parseTrainTripsCsv(
      row('Oslo S,Bergen,2026-08-10,16:23,,,Europe/Oslo,,,,,,,,,,'),
    )
    expect(named.tzAssumed).toBe(false)
    expect(named.fromTz).toBe('Europe/Oslo')
    // A leg that arrives where it left needs only one zone named.
    expect(named.toTz).toBe('Europe/Oslo')
  })

  it('coerces booleans, integers and tags, and empties to null', () => {
    const [trip] = parseTrainTripsCsv(
      row('Oslo S,Bergen,2026-08-10,16:23,,,Europe/Oslo,,,R 67,,,484.7,,,"tog, natt ,",TRUE'),
    )
    expect(trip.distanceKm).toBe(484)
    expect(trip.delay).toBeNull()
    expect(trip.status).toBeNull()
    expect(trip.tags).toEqual(['tog', 'natt'])
    // Only the literal string "true" is true — "TRUE" included, lower-cased first.
    expect(trip.night).toBe(true)
    expect(trip.trainCode).toBe('R 67')
  })

  it('carries no identity of its own — that is the unique index’s job now', () => {
    const [trip] = parseTrainTripsCsv(
      row('Oslo S,Bergen,2026-08-10,16:23,,,Europe/Oslo,,,R 67,,,484,,Completed,,false'),
    )
    expect(trip).not.toHaveProperty('dedupeKey')
  })

  it('gives a planned leg and its travelled re-export the same identity columns', () => {
    // The story's case: the same journey exported twice, once before departure with no
    // train code and once after with one. Everything identity is built from must match.
    const [planned] = parseTrainTripsCsv(
      row('Oslo S,Bergen,2026-08-10,16:23,2026-08-10,23:18,Europe/Oslo,Europe/Oslo,Torucon 2026,,Vygruppen AS,C1,484,,Planned,,false'),
    )
    const [travelled] = parseTrainTripsCsv(
      row('Oslo S,Bergen,2026-08-10,16:23,2026-08-10,23:18,Europe/Oslo,Europe/Oslo,Torucon 2026,R 67,Vygruppen AS,C1,486,12,Completed,,false'),
    )
    expect([planned.fromStation, planned.toStation, planned.departureLocal, planned.fromTz]).toEqual(
      [travelled.fromStation, travelled.toStation, travelled.departureLocal, travelled.fromTz],
    )
    // …while the attributes that used to split them apart differ freely.
    expect(planned.trainCode).toBeNull()
    expect(travelled.trainCode).toBe('R 67')
    expect(planned.distanceKm).not.toBe(travelled.distanceKm)
  })
})
