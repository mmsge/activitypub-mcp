import { parse } from 'csv-parse/sync'

/**
 * A single train trip parsed from a viaduct.world CSV export. Absolute
 * departure/arrival instants are NOT computed here — `departureLocal`/`arrivalLocal`
 * are wall-clock strings that the importer converts to timestamptz in Postgres via
 * `... AT TIME ZONE <tz>`, which handles DST and overnight legs correctly.
 *
 * Nothing here decides which stored trip a row IS. Identity is
 * `(from_station, to_station, departure_at)`, enforced by a unique index and applied
 * by the importer's upsert (ADR 0048). This file used to carry a SHA-256 of the
 * identifying fields, train code among them — which is exactly what split one journey
 * into a Planned row and a Completed one.
 */
export interface TripRow {
  fromStation: string
  toStation: string
  journey: string | null
  trainCode: string | null
  lineNumber: string | null
  trainName: string | null
  operator: string | null
  mode: string | null
  travelClass: string | null
  seatType: string | null
  seat: string | null
  coach: string | null
  reason: string | null
  continent: string | null
  notes: string | null
  ticket: string | null
  departureLocal: string // "YYYY-MM-DD HH:MM:00"
  arrivalLocal: string | null
  fromTz: string
  toTz: string
  distanceKm: number | null
  delay: number | null
  departureDelay: number | null
  price: string | null
  savings: string | null
  currency: string | null
  cycling: boolean
  wifi: boolean
  diningCar: boolean
  night: boolean
  replacement: boolean
  reservation: boolean
  status: string | null
  tags: string[] | null
  raw: Record<string, string>
  /**
   * The export named no origin timezone and `DEFAULT_TZ` was assumed. Carried so the
   * importer can say so out loud: the assumed zone goes straight into `departure_at`,
   * and identity is compared on `departure_at`, so an export that stopped emitting
   * `from_station_tz` would shift every instant by the local offset and quietly split
   * each trip in two — the one failure mode the tuple key cannot absorb.
   */
  tzAssumed: boolean
}

const DEFAULT_TZ = 'UTC'

function str(v: string | undefined): string | null {
  const t = (v ?? '').trim()
  return t === '' ? null : t
}

function bool(v: string | undefined): boolean {
  return (v ?? '').trim().toLowerCase() === 'true'
}

function int(v: string | undefined): number | null {
  const t = (v ?? '').trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/** Combine an export date + "HH:MM" into a Postgres-friendly local timestamp string. */
function localTimestamp(date: string | undefined, time: string | undefined): string | null {
  const d = (date ?? '').trim()
  if (d === '') return null
  const t = (time ?? '').trim() || '00:00'
  return `${d} ${t}:00`
}

/**
 * Parse a viaduct.world CSV export into trip rows. Throws if the header is missing
 * required columns. Rows lacking from/to station or a departure date are skipped.
 */
export function parseTrainTripsCsv(text: string): TripRow[] {
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: false,
    bom: true,
  }) as Record<string, string>[]

  if (records.length > 0) {
    const required = ['from_station_name', 'to_station_name', 'departure_date']
    const missing = required.filter((c) => !(c in records[0]))
    if (missing.length) {
      throw new Error(`CSV missing required column(s): ${missing.join(', ')}`)
    }
  }

  const rows: TripRow[] = []
  for (const r of records) {
    const fromStation = str(r.from_station_name)
    const toStation = str(r.to_station_name)
    const departureLocal = localTimestamp(r.departure_date, r.departure_time)
    if (!fromStation || !toStation || !departureLocal) continue

    const declaredFromTz = str(r.from_station_tz)
    const fromTz = declaredFromTz ?? DEFAULT_TZ
    const toTz = str(r.to_station_tz) ?? fromTz
    const trainCode = str(r.train_code)
    const tagsRaw = str(r.tags)

    rows.push({
      fromStation,
      toStation,
      journey: str(r.journey),
      trainCode,
      lineNumber: str(r.line_number),
      trainName: str(r.train_name),
      operator: str(r.operator),
      mode: str(r.mode),
      travelClass: str(r.travel_class),
      seatType: str(r.seat_type),
      seat: str(r.seat),
      coach: str(r.coach),
      reason: str(r.reason),
      continent: str(r.continent),
      notes: str(r.notes),
      ticket: str(r.ticket),
      departureLocal,
      arrivalLocal: localTimestamp(r.arrival_date, r.arrival_time),
      fromTz,
      toTz,
      distanceKm: int(r.distance),
      delay: int(r.delay),
      departureDelay: int(r.departure_delay),
      price: str(r.price),
      savings: str(r.savings),
      currency: str(r.currency),
      cycling: bool(r.cycling),
      wifi: bool(r.wifi),
      diningCar: bool(r.dining_car),
      night: bool(r.night),
      replacement: bool(r.replacement),
      reservation: bool(r.reservation),
      status: str(r.status),
      tags: tagsRaw ? tagsRaw.split(',').map((s) => s.trim()).filter(Boolean) : null,
      raw: r,
      tzAssumed: declaredFromTz === null,
    })
  }
  return rows
}
