// Walk the conversations rooted in Markus' own toots and store their SHAPE — ids, links,
// depths and @user@host handles, never a word of anyone's reply. Idempotent and
// resumable: progress lives in `thread_roots`, the queue is ordered oldest-walk-first,
// and each thread's node set is replaced in one transaction, so killing this mid-run
// loses nothing and running it twice is cheap.
//
//   npm run walk-threads -- --dry-run
//
// The default is the INCREMENTAL pass the scheduler runs: unsettled threads only. The
// full pass over every root — the one that also picks up a settled thread that quietly
// gained a reply — is:
//
//   npm run walk-threads -- --backfill --max-requests=2500
//
// One request covers a whole thread (Mastodon's context endpoint returns the entire
// descendant subtree), so --max-requests is also the number of threads a run covers.
// About 2,000 roots is ~35 minutes at the default one-second spacing.
import { walkThreads } from '../src/jobs/walk-threads.js'
import { closeDb } from '../src/db/client.js'

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

const num = (name: string): number | undefined => {
  const raw = arg(name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    console.error(`--${name} must be a non-negative integer, got "${raw}"`)
    process.exit(1)
  }
  return n
}

try {
  const dryRun = flag('dry-run')
  const result = await walkThreads({
    mode: flag('backfill') ? 'backfill' : 'incremental',
    maxRequests: num('max-requests'),
    dryRun,
    // A backfill of two thousand threads takes half an hour with nothing on screen,
    // which is indistinguishable from a hang. The scheduled run still logs only its
    // summary line.
    onProgress: (p) => {
      if (p.done % 25 !== 0 && p.done !== p.total) return
      const pct = p.total === 0 ? 100 : Math.round((p.done / p.total) * 100)
      console.log(
        `  ${String(pct).padStart(3)}%  ${p.done}/${p.total} asked — ${p.walked} walked, ${p.failed} failed`,
      )
    },
  })

  console.log(dryRun ? '\nDRY RUN — nothing was written.' : '')
  const line = (label: string, value: string | number) =>
    console.log(`  ${String(value).padStart(7)}  ${label}`)

  console.log(`\n${result.mode} run:`)
  if (result.actors?.length) {
    const from = result.actors.every(a => a.source === 'followed') ? ' (from followed accounts)' : ''
    console.log(`  walking roots by ${result.actors.map(a => a.handle).join(', ')}${from}`)
  }
  line('roots in the queue', result.candidates)
  line('threads asked about', result.requested)
  line('threads walked', result.walked)
  line('walks failed', result.failed)
  line('nodes written', result.nodesWritten)
  console.log('\n  replies not kept:')
  line('followers-only or direct', result.dropped.visibility)
  line('host in THREAD_SKIP_HOSTS', result.dropped.skippedHost)
  line('unparseable id or handle', result.dropped.unparseable)
  line('orphaned (parent dropped)', result.dropped.orphaned)

  if (result.stopped) console.log(`\n  stopped: ${result.stopped}`)
  if (result.stopped === 'rate_limited') {
    console.log('  The instance refused three times running. Re-run later; progress is kept.')
  }
  if (result.stopped === 'bounded') {
    console.log('  Request budget spent. Re-run to continue where this left off.')
  }
  // Two different problems, two different fixes — and the stored handles are printed so
  // neither needs a psql session to work out.
  if (result.stopped === 'not_configured' || result.stopped === 'no_match') {
    console.log(
      result.stopped === 'not_configured'
        ? '\n  Nothing configured, and no followed Mastodon account to fall back to.\n' +
          '  Set THREAD_ACTORS (or OWNER_ACTOR) in /srv/bot/.env to one of the handles below.'
        : '\n  THREAD_ACTORS/OWNER_ACTOR is set, but it matched nothing in the archive.\n' +
          '  It has to match one of the handles below exactly (an actor URL works too).',
    )
    const stored = result.storedHandles ?? []
    console.log(
      stored.length === 0
        ? '\n  The `actors` table is EMPTY — nothing has been ingested yet, so this is not a\n' +
          '  thread-walk problem. Check the follow/ingest side first.'
        : `\n  Stored accounts (${stored.length}):\n${stored.map(h => `    ${h}`).join('\n')}`,
    )
  }
} finally {
  await closeDb()
}
