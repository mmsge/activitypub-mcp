import { sql, type SQL } from 'drizzle-orm'
import { type PgColumn } from 'drizzle-orm/pg-core'

// Shared playedAt/publishedAt-style keyset pagination for the time-ordered
// feed tools (scrobbles, actor posts, reading events).
//
// The ordering timestamp isn't unique (and, for objects.published_at, can even
// be null), so the cursor also carries the row id as a tiebreaker to give a
// strict total order. Ordering is always "<ts> <dir> NULLS LAST, id <dir>", so
// rows with a null timestamp sort to the end in both directions. The cursor is
// an opaque base64url token; callers pass it back verbatim.

export type SortOrder = 'asc' | 'desc'

/**
 * How the cursor's tiebreaker id is typed. Every tool here keys on a uuid primary
 * key; the public stream keys on a synthetic "<kind>:<id>" text label because it
 * merges rows from tables with unrelated ids.
 */
export type IdCast = 'uuid' | 'text'

/** A client sent a cursor token we can't decode — a caller error, not a server fault. */
export class InvalidCursorError extends Error {}

type CursorPayload = { p: string | null; id: string }

export function encodeCursor(ts: Date | null, id: string): string {
  const payload: CursorPayload = { p: ts ? ts.toISOString() : null, id }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeCursor(token: string): CursorPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidCursorError('Invalid cursor: not a valid token')
  }
  const c = parsed as CursorPayload
  const pOk = c && (c.p === null || (typeof c.p === 'string' && !Number.isNaN(Date.parse(c.p))))
  if (!c || typeof c.id !== 'string' || !pOk) {
    throw new InvalidCursorError('Invalid cursor: malformed payload')
  }
  return c
}

/**
 * ORDER BY clause matching the keyset: timestamp then id, NULLS LAST.
 *
 * `tsCol` may be a plain column or a `sql` expression (get_watched sorts on a correlated
 * subquery over `neodb_marks` for the shelf date). An expression must write any column
 * reference table-qualified by hand — drizzle qualifies a bare column only inside WHERE.
 */
export function keysetOrderBy(
  tsCol: PgColumn | SQL,
  idCol: PgColumn | SQL,
  order: SortOrder,
  idCast: IdCast = 'uuid',
): SQL {
  // Must mirror keysetCondition's comparison exactly, collation included — a keyset
  // whose ORDER BY and WHERE disagree silently skips or repeats rows.
  const idExpr = idCast === 'text' ? sql`${idCol} COLLATE "C"` : idCol
  return order === 'asc'
    ? sql`${tsCol} ASC NULLS LAST, ${idExpr} ASC`
    : sql`${tsCol} DESC NULLS LAST, ${idExpr} DESC`
}

/**
 * WHERE condition selecting rows strictly past the cursor row under the keyset
 * order above. Because nulls sort last in both directions, a non-null cursor is
 * always followed by every null-timestamp row; a null cursor means we're already
 * in that trailing null section, so only later null rows (by id) remain.
 */
export function keysetCondition(
  tsCol: PgColumn | SQL,
  idCol: PgColumn | SQL,
  cursor: CursorPayload,
  order: SortOrder,
  idCast: IdCast = 'uuid',
): SQL {
  // The public stream merges lanes whose rows have no common id type, so its
  // tiebreaker is a synthetic "<kind>:<id>" string rather than a uuid. Text
  // comparison is collation-dependent, so force the C collation to keep the
  // ordering byte-stable regardless of the database's lc_collate — the keyset is
  // only correct if the comparison here matches the ORDER BY exactly.
  const id = idCast === 'text'
    ? sql`${cursor.id}::text COLLATE "C"`
    : sql`${cursor.id}::uuid`
  const idExpr = idCast === 'text' ? sql`${idCol} COLLATE "C"` : idCol

  if (cursor.p === null) {
    return order === 'asc'
      ? sql`(${tsCol} IS NULL AND ${idExpr} > ${id})`
      : sql`(${tsCol} IS NULL AND ${idExpr} < ${id})`
  }
  // Bind the ISO string, not a Date: raw sql`` params have no column to drive
  // drizzle's type mapping, so a Date reaches the driver as its toString() form,
  // which Postgres can't cast to timestamptz. The explicit cast handles the string.
  return order === 'asc'
    ? sql`(${tsCol} > ${cursor.p}::timestamptz OR (${tsCol} = ${cursor.p}::timestamptz AND ${idExpr} > ${id}) OR ${tsCol} IS NULL)`
    : sql`(${tsCol} < ${cursor.p}::timestamptz OR (${tsCol} = ${cursor.p}::timestamptz AND ${idExpr} < ${id}) OR ${tsCol} IS NULL)`
}
