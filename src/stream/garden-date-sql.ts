import { sql, type SQL } from 'drizzle-orm'

/**
 * The one definition of when a garden note happened, shared by everything that
 * needs to agree about it: the stream lane, the derivation job's counters, and the
 * dateless list at the foot of /kjelde/hage.
 *
 * Two sources, in order of authority:
 *
 *  1. `note_date` — what the note says about itself, hand-written frontmatter of
 *     varying precision ("2024", "2024-03", "2024-03-11").
 *  2. `derived_date` — what jobs/derive-garden-dates.ts worked out from the
 *     BookWyrm reading events for the book the note reviews.
 *
 * They are separate columns and stay that way; this is the only place they are
 * combined. If the lane and the counters computed "has a date" differently, the
 * page would claim a note is undated while showing it in the stream, or the other
 * way round.
 *
 * The regex is the guard, not the WHERE clause: a CASE evaluates its cast only in
 * the branch that matched, so "ein gong i fjor" cannot error the query. Relying on
 * a WHERE to filter first is a bet on evaluation order that Postgres does not take.
 */

const ISO_PREFIX = '^\\d{4}(-\\d{2}(-\\d{2})?)?$'

function assertAlias(alias: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error(`Unusable SQL alias: ${alias}`)
}

/** The note's own frontmatter date as a timestamptz, or NULL if it has none we can read. */
export function ownGardenDateOn(alias: string): SQL {
  assertAlias(alias)
  const d = sql.raw(`${alias}.note_date`)
  return sql`CASE WHEN ${d} ~ ${sql.raw(`'${ISO_PREFIX}'`)} THEN (${d} || CASE
      WHEN ${d} ~ '^\\d{4}$' THEN '-01-01'
      WHEN ${d} ~ '^\\d{4}-\\d{2}$' THEN '-01'
      ELSE '' END)::timestamptz END`
}

/** When the note happened: its own date, else the one recovered from its book. */
export function gardenEventAtOn(alias: string): SQL {
  assertAlias(alias)
  return sql`coalesce(${ownGardenDateOn(alias)}, ${sql.raw(`${alias}.derived_date`)})`
}
