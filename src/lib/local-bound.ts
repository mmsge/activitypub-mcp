/**
 * The shape a hand-written local time bound is allowed to take.
 *
 * A date, optionally a time, optionally a timezone suffix. Callers that read their
 * bounds as local wall clock IGNORE that suffix (ADR 0047) — it is accepted only so a
 * pasted ISO timestamp is not rejected for carrying a `Z`.
 *
 * Validated in zod rather than left to Postgres' cast so a malformed bound is a 400
 * naming the bad value, not a 500 carrying the whole query — the same reason
 * `InvalidCursorError` exists. Lives here because two tools now need the same shape
 * rule with different ideas of what to do with the value: `get_youtube_watches` keeps
 * the time of day, `get_scrobble_timeline` reduces the bound to a calendar date.
 */
export const LOCAL_BOUND_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/

/** The calendar-date part of a bound that has already passed `LOCAL_BOUND_RE`. */
export function localBoundDate(value: string): string {
  return value.trim().slice(0, 10)
}
