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
export function keysetOrderBy(tsCol: PgColumn | SQL, idCol: PgColumn, order: SortOrder): SQL {
  return order === 'asc'
    ? sql`${tsCol} ASC NULLS LAST, ${idCol} ASC`
    : sql`${tsCol} DESC NULLS LAST, ${idCol} DESC`
}

/**
 * WHERE condition selecting rows strictly past the cursor row under the keyset
 * order above. Because nulls sort last in both directions, a non-null cursor is
 * always followed by every null-timestamp row; a null cursor means we're already
 * in that trailing null section, so only later null rows (by id) remain.
 */
export function keysetCondition(
  tsCol: PgColumn | SQL,
  idCol: PgColumn,
  cursor: CursorPayload,
  order: SortOrder,
): SQL {
  if (cursor.p === null) {
    return order === 'asc'
      ? sql`(${tsCol} IS NULL AND ${idCol} > ${cursor.id}::uuid)`
      : sql`(${tsCol} IS NULL AND ${idCol} < ${cursor.id}::uuid)`
  }
  // Bind the ISO string, not a Date: raw sql`` params have no column to drive
  // drizzle's type mapping, so a Date reaches the driver as its toString() form,
  // which Postgres can't cast to timestamptz. The explicit cast handles the string.
  return order === 'asc'
    ? sql`(${tsCol} > ${cursor.p}::timestamptz OR (${tsCol} = ${cursor.p}::timestamptz AND ${idCol} > ${cursor.id}::uuid) OR ${tsCol} IS NULL)`
    : sql`(${tsCol} < ${cursor.p}::timestamptz OR (${tsCol} = ${cursor.p}::timestamptz AND ${idCol} < ${cursor.id}::uuid) OR ${tsCol} IS NULL)`
}
