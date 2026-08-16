// Pull every BookWyrm actor's four reading shelves on demand, rather than waiting
// for the 6-hourly tick.
//
// This is the script to run right after deploying the shelf work: until
// bookwyrm_shelf_marks has live rows, /api/v1/books?shelf= refuses to answer at
// all (deliberately — see ADR 0034's rule that a successful empty crawl is not a
// healthy one), so anything filtering on shelf stays broken until this has run
// once. The server also runs it on startup, so a normal deploy needs nothing; this
// is for re-running it without a restart.
//
// Idempotent. Upserts are always applied; the removal sweep runs only when every
// one of the four shelves fetched completely AND returned exactly as many items as
// its collection claimed. A pull short of that adds and corrects rows but removes
// none, and says so.
//
// No-op when BOOKWYRM_ACTORS is unset.
//
//   npm run sync-bookwyrm-shelves
import { syncBookwyrmShelves } from '../src/jobs/sync-bookwyrm-shelves.js'
import { logger } from '../src/lib/logger.js'

try {
  const results = await syncBookwyrmShelves()

  if (results.length === 0) {
    console.log('No BookWyrm actors configured (BOOKWYRM_ACTORS is empty) — nothing to do.')
    process.exit(0)
  }

  for (const r of results) {
    console.log(`\n${r.actorApId}`)
    console.table(
      r.shelves.map((s) => ({
        shelf: s.shelf,
        fetched: s.count,
        totalItems: s.totalItems ?? '(none)',
        complete: s.complete,
      })),
    )
    console.log(`upserted ${r.upserted} · removed ${r.removed} · verified ${r.verified}`)
  }

  // An unverified pull is the case worth exiting non-zero on: it looks like a
  // success in the log, the upserts landed, and yet membership was NOT reconciled,
  // so anything reading the table is working from a stale removal set.
  const unverified = results.filter((r) => !r.verified)
  if (unverified.length > 0) {
    logger.error(
      { actors: unverified.map((r) => r.actorApId) },
      'shelf pull incomplete for at least one actor — removals were skipped, counts are not trustworthy',
    )
    process.exit(1)
  }

  logger.info(
    { actors: results.length, upserted: results.reduce((n, r) => n + r.upserted, 0) },
    'BookWyrm shelf sync complete',
  )
  process.exit(0)
} catch (e) {
  logger.error(e, 'BookWyrm shelf sync failed')
  process.exit(1)
}
