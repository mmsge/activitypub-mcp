// Import a Google Takeout-shaped watch-history.json into youtube_watches.
//
//   npm run import-youtube-watches -- <path> [options]
//
//     --account=<name>   account for entries that carry none (a real Takeout export
//                        has no account field; the My Activity scrape does)
//     --source=<value>   provenance for entries that carry none. A Takeout import
//                        should pass something other than 'myactivity-console'
//     --batch=<n>        rows per INSERT (default 1000)
//     --dry-run          parse and report, insert nothing
//     --examples=<n>     problem examples to print per reason (default 5)
//
// Idempotent: re-running over an overlapping file inserts only what is missing, so the
// second run of the same file inserts zero. Nothing is ever updated.
//
// MEMORY. The file is read and JSON.parse'd whole — ~500-600 MB of heap for the 46 MB
// archive, which is fine on a normal box but is the reason this is a deliberate one-off
// command rather than part of a deploy. If node runs out of heap, raise it:
//
//   NODE_OPTIONS=--max-old-space-size=2048 npm run import-youtube-watches -- <path>
//
// Nothing is dropped silently: every entry that does not become a row is counted by
// reason and printed, and the run exits non-zero if any entry was rejected, so a
// malformed file cannot look like a clean import.
import { readFileSync } from 'node:fs'
import {
  parseYoutubeWatchHistory,
  summariseProblems,
  isShort,
} from '../src/lib/parse-youtube-takeout.js'
import { importYoutubeWatches } from '../src/jobs/import-youtube-watches.js'
import { closeDb } from '../src/db/client.js'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const has = (name: string): boolean => argv.includes(`--${name}`)

const path = argv.find((a) => !a.startsWith('--'))
if (!path) {
  console.error('usage: npm run import-youtube-watches -- <path> [--account=X] [--source=Y] [--batch=N] [--dry-run]')
  process.exit(2)
}

const dryRun = has('dry-run')
const examplesPerReason = Number(flag('examples') ?? '5')
const batchSize = Number(flag('batch') ?? '1000')
if (!Number.isFinite(batchSize) || batchSize < 1) {
  console.error(`--batch must be a positive integer, got ${flag('batch')}`)
  process.exit(2)
}

const pct = (n: number, of: number) => (of === 0 ? '0.0' : ((n / of) * 100).toFixed(1))

try {
  console.log(`Reading ${path}`)
  const text = readFileSync(path, 'utf8')
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) {
    console.error('Expected the file to be a JSON array of watch entries.')
    process.exit(1)
  }

  const { total, rows, problems } = parseYoutubeWatchHistory(parsed, {
    defaultAccount: flag('account'),
    defaultSource: flag('source'),
  })

  console.log(`\nParsed ${rows.length} of ${total} entries`)

  if (problems.length > 0) {
    console.log(`\n${problems.length} entries could not be imported (${pct(problems.length, total)}%):`)
    for (const { reason, count } of summariseProblems(problems)) {
      console.log(`  ${String(count).padStart(7)}  ${reason}`)
      for (const p of problems.filter((x) => x.reason === reason).slice(0, examplesPerReason)) {
        console.log(`             entry ${p.index}: ${p.sample}`)
      }
    }
  }

  // A shape report before anything is written, so a wrong file is obvious at a glance.
  const accounts = new Map<string, number>()
  for (const r of rows) accounts.set(r.account, (accounts.get(r.account) ?? 0) + 1)
  const withDuration = rows.filter((r) => r.durationSeconds !== null).length
  const times = rows.map((r) => r.watchedAtLocal).sort()

  console.log('\nWhat is in the file:')
  console.log(`  accounts          ${[...accounts].map(([a, n]) => `${a}=${n}`).join(', ') || '(none)'}`)
  console.log(`  distinct videos   ${new Set(rows.map((r) => r.videoId)).size}`)
  console.log(`  distinct channels ${new Set(rows.filter((r) => r.channelId).map((r) => r.channelId)).size} by id, ` +
    `${new Set(rows.filter((r) => r.channelName).map((r) => r.channelName)).size} by name`)
  console.log(`  unresolved        ${rows.filter((r) => r.unresolved).length} (${pct(rows.filter((r) => r.unresolved).length, rows.length)}%)`)
  console.log(`  with a duration   ${withDuration} (${pct(withDuration, rows.length)}%)`)
  console.log(`  Shorts (<180s)    ${rows.filter((r) => isShort(r.durationSeconds)).length} of those with a duration`)
  console.log(`  wall-clock span   ${times[0] ?? '-'} .. ${times.at(-1) ?? '-'}  (Europe/Oslo, local)`)

  if (dryRun) {
    console.log('\n--dry-run: nothing was written.')
    process.exit(problems.length > 0 ? 1 : 0)
  }

  const result = await importYoutubeWatches(rows, { batchSize })

  console.log('\nImport:')
  console.log(`  rows parsed         ${result.total}`)
  console.log(`  duplicates in file  ${result.duplicatesInFile}`)
  console.log(`  inserted            ${result.inserted}`)
  console.log(`  already present     ${result.skipped}`)
  if (problems.length > 0) {
    console.log(`\n${problems.length} entries were NOT imported — see the breakdown above.`)
  }

  await closeDb()
  process.exit(problems.length > 0 ? 1 : 0)
} catch (e) {
  console.error(e)
  await closeDb().catch(() => {})
  process.exit(1)
}
