// Import a TikTok archive file as @<username>@tiktok.com.
//
//   npm run import-tiktok-archive -- <tiktok-archive.json> [options]
//
//     <tiktok-archive.json>  the file `npm run build-tiktok-archive` wrote on the Mac. Not
//                            TikTok's own export: that never leaves the Mac.
//     --dry-run              read, map and report; write nothing
//     --batch=<n>            rows per INSERT (default 500)
//     --examples=<n>         problem examples to print (default 5)
//
// The same import as Admin → Import → TikTok-arkiv, for when the browser is not to hand.
// Idempotent: re-running over the same file updates rows in place. Nothing is ever deleted,
// and a post hidden by hand (`deleted_at`) stays hidden. Never dials tiktok.com and stores
// no files. See ADR 0078.
//
// The run exits non-zero if any post could not be read or any row was refused by the
// database, so a partial import cannot look like a clean one.
import { readFileSync } from 'node:fs'
import { closeDb } from '../src/db/client.js'
import { importTiktokArchive, planTiktokArchive } from '../src/jobs/import-tiktok-archive.js'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const has = (name: string): boolean => argv.includes(`--${name}`)

const files = argv.filter((a) => !a.startsWith('--'))
if (files.length !== 1) {
  console.error('usage: npm run import-tiktok-archive -- <tiktok-archive.json> [--dry-run] [--batch=N] [--examples=N]')
  process.exit(2)
}

const dryRun = has('dry-run')
const batchSize = Number(flag('batch') ?? '500')
const examples = Number(flag('examples') ?? '5')
if (!Number.isInteger(batchSize) || batchSize < 1) {
  console.error(`--batch must be a positive integer, got ${flag('batch')}`)
  process.exit(2)
}

const n = (x: number) => x.toLocaleString('en-US')
let exitCode = 0

try {
  console.log(`Reading ${files[0]}`)
  const plan = planTiktokArchive(JSON.parse(readFileSync(files[0]!, 'utf8')))
  const s = plan.stats
  console.log(`\n${plan.actor.handle}  (${plan.actor.displayName}, file built ${plan.generatedAt ?? 'at an unknown time'})`)
  console.log(`  ${n(s.posts)} of ${n(s.inFile)} posts  ${s.first?.slice(0, 10) ?? '–'} → ${s.last?.slice(0, 10) ?? '–'}`)
  console.log(`  ${n(s.videos)} videos  ${n(s.photos)} photo posts`)
  console.log(`  ${n(s.onProfile)} with a page on TikTok, ${n(s.offProfile)} known only from the export (no link)`)
  if (plan.problems.length > 0) {
    console.log(`  ${n(plan.problems.length)} posts could not be read:`)
    for (const p of plan.problems.slice(0, examples)) console.log(`    #${p.index} ${p.postedAt ?? '?'}: ${p.reason}`)
    exitCode = 1
  }

  if (dryRun) {
    console.log('\nDry run: nothing written.')
  } else {
    console.log(`\nImporting ${plan.actor.handle} …`)
    const report = await importTiktokArchive(plan, { batchSize })
    console.log(`  rows: ${n(report.inserted)} inserted, ${n(report.updated)} updated, ${n(report.failed.length)} refused`)
    for (const f of report.failed.slice(0, examples)) console.log(`    ${f.id}: ${f.reason}`)
    if (report.failed.length > 0) exitCode = 1
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  exitCode = 1
} finally {
  await closeDb().catch(() => {})
}
process.exit(exitCode)
