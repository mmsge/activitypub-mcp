// Where each account's engagement bar actually sits, and what would fire right now.
//
// This is the honest check to run BEFORE setting BREAKOUT_ENABLED=1: it reads the real
// archive, prints the percentiles, the thresholds and the armed list, and pushes
// nothing. If p90 comes out at 3 on an account, you want to know that here rather than
// from your phone at four in the morning.
//
// It works with the feature switched off — baselines and thresholds are computed live
// from `objects` + `engagement_snapshots`, never from the notifier's state.
//
//   npm run post-breakouts
//
// Pass --notify to actually run the ladder and send whatever it decides. That is the
// end-to-end check of the ntfy path; it obeys BREAKOUT_ENABLED and NTFY_PASSWORD like
// the scheduled job does, and it will latch the rungs it announces.
import { getPostBreakouts } from '../src/mcp/tools/post-breakouts.js'
import { runPostBreakout } from '../src/jobs/post-breakout.js'
import { logger } from '../src/lib/logger.js'

const notify = process.argv.includes('--notify')

try {
  if (notify) {
    logger.info('Running the breakout ladder for real — this may push and will latch rungs')
    await runPostBreakout()
  }

  const report = await getPostBreakouts({ days: 30, limit: 20 })
  if ('error' in report) {
    logger.error({ error: report.error }, 'Could not build the breakout report')
    process.exit(1)
  }

  console.log(
    report.blocked_reason
      ? `\nNotifier INERT: ${report.blocked_reason}\n`
      : `\nNotifier ARMED, pushing to "${report.topic}"\n`,
  )

  console.table(report.actors.map(a => ({
    account: a.actor,
    posts: a.baseline.posts_in_window,
    median: Math.round(a.baseline.median),
    p90: `${Math.round(a.baseline.p90)} → ${a.thresholds.p90}`,
    p99: `${Math.round(a.baseline.p99)} → ${a.thresholds.p99}`,
    record: `${a.baseline.best} → ${a.thresholds.best}`,
    // The single most useful column: an account that is not established fires nothing
    // at all, and that is a completely different silence from "nothing qualifies".
    established: a.baseline.established ? 'yes' : `NO (${a.baseline.reason})`,
  })))

  const armed = report.actors.flatMap(a => a.armed.map(p => ({
    account: a.actor,
    would_fire: p.would_fire,
    spent: p.spent_rung ?? '—',
    peak: p.peak_score,
    now: p.score,
    counts: `${p.favourites}/${p.reblogs}/${p.replies}`,
    post: (p.text ?? '').replace(/\s+/g, ' ').slice(0, 50),
  })))

  console.log(`\nArmed right now: ${armed.length}`)
  if (armed.length) console.table(armed)

  console.log(`\nAnnounced in the last 30 days: ${report.recent.length}`)
  if (report.recent.length) {
    console.table(report.recent.map(r => ({
      when: r.fired_at instanceof Date ? r.fired_at.toISOString() : String(r.fired_at),
      rung: r.rung,
      account: r.actor,
      score: r.score,
      peak: r.peak_score,
      now: r.current_score,
      post: (r.text ?? '').replace(/\s+/g, ' ').slice(0, 50),
    })))
  }

  if (!notify && armed.length && !report.blocked_reason) {
    console.log(
      '\nThese are armed and the notifier is live, so the next scheduled tick will announce them.',
    )
  }

  process.exit(0)
} catch (e) {
  logger.error(e, 'Breakout report failed')
  process.exit(1)
}
