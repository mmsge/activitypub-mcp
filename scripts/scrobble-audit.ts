// How much of the scrobble history is a play that was cut short — a track started and
// then skipped or restarted, which a scrobbler that submits at track start turns into a
// genuine Last.fm scrobble.
//
// Read-only: pure SELECTs inside a READ ONLY transaction. It changes no count anywhere,
// and it deletes nothing. Deciding what to do about the numbers is a separate act.
// See decision record 0029.
//
//   npm run scrobble-audit
import { auditScrobbles } from '../src/jobs/scrobble-audit.js'
import { THRESHOLDS } from '../src/lib/scrobble-audit.js'
import { logger } from '../src/lib/logger.js'

const pct = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(2)}%` : '—')

try {
  const r = await auditScrobbles()

  console.log(`\nRace: ${r.params.leader} (leader) vs ${r.params.challenger} (challenger)`)
  console.log(
    `${r.totalPlays.toLocaleString('en-GB')} stored plays · session ceiling ${r.params.ceilingSeconds}s · ` +
    `duration = p${r.params.percentile * 100} over ≥${r.params.minDurationObservations} observations`,
  )
  console.log(
    `${r.sameTrackRestarts.toLocaleString('en-GB')} sub-60s plays are followed by the SAME track again — ` +
    `restarts, which only a scrobble submitted at track start can produce.\n`,
  )

  console.log('Overall, per threshold:')
  console.table(THRESHOLDS.map(t => {
    const o = r.overall[t.id]
    return {
      threshold: t.label,
      suspect: o.suspect,
      'suspect %': pct(o.suspect, o.plays),
      kept: o.kept,
      unbounded: o.unbounded,
      'no estimate': o.noEstimate,
    }
  }))

  console.log('\nThe head-to-head, corrected at each threshold (reported only — nothing is applied):')
  console.table(r.race.map(l => ({
    threshold: l.label,
    [`${r.params.leader} suspect`]: l.leaderSuspect,
    [`${r.params.challenger} suspect`]: l.challengerSuspect,
    'gap now': l.gap,
    'gap corrected': l.correctedGap,
    change: l.gapDelta >= 0 ? `+${l.gapDelta}` : String(l.gapDelta),
    'unbounded (L/C)': `${l.leaderUnbounded}/${l.challengerUnbounded}`,
  })))

  console.log('\nWhen it started — sub-60s share per Oslo year:')
  console.table(r.byYear.map(y => ({
    year: y.year,
    plays: y.plays,
    'suspect <60s': y.suspectUnder60s,
    share: `${y.pct.toFixed(2)}%`,
  })))

  console.log('\nPer artist (racers first, then by volume) — suspect counts:')
  console.table(r.perArtist.map(a => ({
    artist: a.artist,
    plays: a.totals.lt60s.plays,
    '<30s': a.totals.lt30s.suspect,
    '<60s': a.totals.lt60s.suspect,
    'half length': a.totals.halfDuration.suspect,
    "Last.fm's rule": a.totals.lastfmRule.suspect,
  })))

  console.log('\nTightest plays on record:')
  console.table(r.evidence.map(e => ({
    playedAt: e.playedAt.toISOString(),
    artist: e.artist,
    track: e.track,
    seconds: e.playSeconds,
    restart: e.sameTrackNext ? 'same track again' : '',
  })))

  console.log('\nRead-only: nothing was deleted, migrated or recounted.')
  process.exit(0)
} catch (e) {
  logger.error(e, 'Scrobble audit failed')
  process.exit(1)
}
