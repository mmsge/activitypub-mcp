import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Guards on `drizzle/meta/_journal.json`.
 *
 * These exist because of a real incident: migration `0036` was generated with a `when`
 * nine minutes EARLIER than `0035`'s, and it was then silently skipped on the production
 * deploy. Nothing failed — `migrate()` printed "Migrations complete" and the table simply
 * did not exist, which surfaced later as `relation "youtube_videos" does not exist` from
 * the job that needed it.
 *
 * The reason is drizzle's migrator: it reads the single most recent row of
 * `__drizzle_migrations` and applies a journal entry only when
 * `lastDbMigration.created_at < entry.when`. So a new migration dated before the last
 * applied one is not an error, it is a no-op.
 *
 * **A fresh database cannot catch this.** With no rows in `__drizzle_migrations` there is no
 * `lastDbMigration` to compare against, so every entry applies in journal order whatever its
 * timestamp says. The bug only exists on the upgrade path — which is every deploy, and never
 * a local first run. That is precisely why it got through.
 */

const journalPath = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle/meta/_journal.json')
const drizzleDir = dirname(dirname(journalPath))

interface Entry { idx: number; tag: string; when: number }
const entries: Entry[] = JSON.parse(readFileSync(journalPath, 'utf8')).entries

/**
 * 0001 is dated before 0000. It is inert and is deliberately not rewritten: the two have
 * only ever been applied together, on a first run against an empty database, where the
 * comparison above never happens. Every pair after it must be strictly increasing.
 */
const KNOWN_HISTORICAL_INVERSION = '0001_bookwyrm_book_url'

describe('the migration journal', () => {
  it('is strictly increasing in `when`, or a new migration will be SILENTLY SKIPPED', () => {
    const inversions = entries
      .slice(1)
      .map((entry, i) => ({ prev: entries[i], entry }))
      .filter(({ prev, entry }) => entry.when <= prev.when)
      .filter(({ entry }) => entry.tag !== KNOWN_HISTORICAL_INVERSION)
      .map(({ prev, entry }) => `${entry.tag} (${entry.when}) is not after ${prev.tag} (${prev.when})`)

    // If this fails, raise the new migration's `when` above every earlier one. Do NOT lower
    // an existing entry: on a database that has already applied it, the value recorded in
    // __drizzle_migrations is what the comparison uses, and the journal no longer decides.
    expect(inversions).toEqual([])
  })

  it('numbers entries consecutively from 0, so no migration is missing from the chain', () => {
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i))
  })

  it('has a .sql file for every entry, and an entry for every .sql file', () => {
    // An entry with no file aborts the boot; a file with no entry never runs at all, which
    // is the same silent no-op this suite exists to prevent.
    const missingFiles = entries.filter((e) => !existsSync(join(drizzleDir, `${e.tag}.sql`))).map((e) => e.tag)
    expect(missingFiles).toEqual([])

    const tags = new Set(entries.map((e) => e.tag))
    const orphanFiles = readdirSync(drizzleDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .filter((tag) => !tags.has(tag))
    expect(orphanFiles).toEqual([])
  })
})
