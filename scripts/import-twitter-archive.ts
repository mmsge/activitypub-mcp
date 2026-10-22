// Import Twitter archives ("Download an archive of your data") as @<username>@twitter.com.
//
//   npm run import-twitter-archive -- <archive-dir> [<archive-dir> …] [options]
//
//     <archive-dir>      the unzipped export — the folder holding `data/` and `assets/`.
//                        Give every account in one run: a reply from one to the other
//                        can then point at a tweet that is actually imported.
//     --dry-run          read, map and report; write no rows and copy no files
//     --no-media         write the rows but do not copy the photos and videos
//     --media-dir=<dir>  where the files go (default: ARCHIVE_MEDIA_DIR, /data/archive).
//                        They are served from there at /archive/media/twitter/…
//     --base-url=<url>   the public origin attachments point at (default https://APP_DOMAIN)
//     --batch=<n>        rows per INSERT (default 500)
//     --examples=<n>     problem examples to print (default 5)
//
// Idempotent: re-running over the same archives updates rows in place and copies nothing
// new. Nothing is ever deleted, and a post hidden by hand (`deleted_at`) stays hidden.
//
// Never reads the archive's email, phone number, IP audit, DMs, likes or follower lists —
// see ADR 0067 for what is kept and why the rest is not.
//
// MEMORY. tweet.js is read and parsed whole; the larger of the two archives is 24 MB of
// JSON, which is roughly 250 MB of heap — fine inside the app container's 512 MB cap when
// run as `docker compose run --rm`, because the app itself is not running in that
// container. If node runs out, raise it:
//
//   NODE_OPTIONS=--max-old-space-size=1024 npm run import-twitter-archive -- …
//
// The run exits non-zero if any row was refused by the database, so a partial import
// cannot look like a clean one.
import { config } from '../src/config.js'
import { closeDb } from '../src/db/client.js'
import { importPlanned, loadArchive, planArchives } from '../src/jobs/import-twitter-archive.js'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const has = (name: string): boolean => argv.includes(`--${name}`)

const dirs = argv.filter((a) => !a.startsWith('--'))
if (dirs.length === 0) {
  console.error('usage: npm run import-twitter-archive -- <archive-dir> [<archive-dir> …] [--dry-run] [--no-media] [--media-dir=D] [--base-url=U]')
  process.exit(2)
}

const dryRun = has('dry-run')
const copyFiles = !has('no-media')
const mediaRoot = flag('media-dir') ?? config.ARCHIVE_MEDIA_DIR
const baseUrl = flag('base-url') ?? `https://${config.APP_DOMAIN}`
const batchSize = Number(flag('batch') ?? '500')
const examples = Number(flag('examples') ?? '5')
if (!Number.isFinite(batchSize) || batchSize < 1) {
  console.error(`--batch must be a positive integer, got ${flag('batch')}`)
  process.exit(2)
}

const n = (x: number) => x.toLocaleString('en-US')
let exitCode = 0

try {
  const archives = dirs.map((d) => {
    console.log(`Reading ${d}`)
    return loadArchive(d)
  })
  const plans = planArchives(archives, baseUrl)

  for (const plan of plans) {
    const s = plan.stats
    console.log(`\n${plan.actor.handle}  (${plan.archive.account.displayName}, account ${plan.archive.account.accountId})`)
    console.log(`  ${n(s.tweets)} tweets  ${s.first?.slice(0, 10)} → ${s.last?.slice(0, 10)}`)
    console.log(`  ${n(s.notes)} own  ${n(s.retweets)} retweets  ${n(s.replies)} replies`)
    console.log(`  ${n(s.withMedia)} with media: ${n(s.mediaFiles)} files in the archive, ${n(s.mediaMissing)} not in it`)
    if (s.entityMismatches > 0) console.log(`  ${n(s.entityMismatches)} entities did not match their text and were left as plain text`)
    if (plan.archive.account.screenNameChanges.length > 0) {
      const names = plan.archive.account.screenNameChanges.map((c) => `${c.changedFrom}→${c.changedTo}`).join(', ')
      console.log(`  renamed: ${names}`)
    }
    if (plan.problems.length > 0) {
      console.log(`  ${plan.problems.length} tweets could not be mapped:`)
      for (const p of plan.problems.slice(0, examples)) console.log(`    ${p.tweetId}: ${p.reason}`)
      exitCode = 1
    }
  }

  if (dryRun) {
    console.log(`\nDry run: nothing written. Media would go to ${mediaRoot}/twitter/<account>/ and be served from ${baseUrl}/archive/media/twitter/…`)
  } else {
    for (const plan of plans) {
      console.log(`\nImporting ${plan.actor.handle} …`)
      const report = await importPlanned(plan, { mediaRoot, copyFiles, batchSize })
      if (report.media) {
        console.log(`  files: ${n(report.media.copied)} copied, ${n(report.media.alreadyThere)} already there, ${n(report.media.missing.length)} missing from the archive`)
      }
      console.log(`  rows:  ${n(report.inserted)} inserted, ${n(report.updated)} updated, ${n(report.failed.length)} refused`)
      for (const f of report.failed.slice(0, examples)) console.log(`    tweet ${f.tweetId}: ${f.reason}`)
      if (report.failed.length > 0) exitCode = 1
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  exitCode = 1
} finally {
  await closeDb().catch(() => {})
}
process.exit(exitCode)
