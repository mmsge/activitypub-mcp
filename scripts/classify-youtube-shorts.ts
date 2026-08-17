// Classify the watched YouTube videos as Shorts, cheapest signal first. Idempotent and
// resumable: progress lives in `youtube_videos`, so running it twice in a row does nothing
// the second time and killing it mid-run loses nothing.
//
//   npm run classify-youtube-shorts -- --dry-run
//
// Stage 0 is offline and free and settles about a third of the archive. Stage 1 needs
// YOUTUBE_API_KEY and covers 50 videos per quota unit, so the whole backlog is about 1,846
// units against a 10,000/day allowance — drain it in one pass with:
//
//   npm run classify-youtube-shorts -- --max-api-calls=1900
//
// Stage 2 is the HTTP probe, the ONLY stage that can confirm a Short. YouTube 429s after a
// couple of requests, so it is off unless asked for and paced in seconds per video:
//
//   npm run classify-youtube-shorts -- --probe --max-probes=200
import { classifyYoutubeShorts } from '../src/jobs/classify-youtube-shorts.js'
import { logger } from '../src/lib/logger.js'

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
  const result = await classifyYoutubeShorts({
    dryRun,
    probe: flag('probe') || undefined,
    maxApiCalls: num('max-api-calls'),
    maxProbes: num('max-probes'),
  })

  const { stage0, stage1, stage2 } = result

  console.log(dryRun ? '\nDRY RUN — nothing was written.\n' : '')
  const line = (n: number, label: string, outcome: string) =>
    console.log(`  ${n.toLocaleString('en').padStart(7)}  ${label.padEnd(20)} -> ${outcome}`)

  console.log(`Stage 0, offline, over ${stage0.examined.toLocaleString('en')} newly examined video(s):`)
  line(stage0.unclassifiable, 'no duration', 'unknown, terminal')
  line(stage0.falseByWatchDate, 'watched pre 2020-09', 'false, certain')
  line(stage0.falseByEraLimit, 'over the era limit', 'false, certain')
  line(stage0.ambiguous, 'everything else', 'still ambiguous')

  if (stage1.stopped !== 'dry_run') {
    console.log(`\nStage 1, videos.list: ${stage1.calls} call(s), ${stage1.quotaUnits} quota unit(s), ` +
      `${stage1.videos} video(s) asked about, ${stage1.classified} settled, ${stage1.missing} missing` +
      (stage1.stopped ? ` (stopped: ${stage1.stopped})` : ''))
  }
  if (stage2.stopped !== 'dry_run') {
    console.log(`Stage 2, probe: ${stage2.probes} probe(s), ${stage2.short} Short, ` +
      `${stage2.notShort} not, ${stage2.errors} error(s)` +
      (stage2.stopped ? ` (stopped: ${stage2.stopped})` : ''))
  }

  console.log(`\n${result.pending.toLocaleString('en')} still to decide, ` +
    `${result.terminal.toLocaleString('en')} terminal (never retried), ` +
    `${result.gaveUp.toLocaleString('en')} given up on.`)

  if (result.pending > 0 && !dryRun) {
    console.log('Not finished. Run again — it picks up only what is still unclassified.')
  }

  logger.info(result, 'YouTube Shorts classification run finished')
  process.exit(0)
} catch (e) {
  logger.error(e, 'YouTube Shorts classification failed')
  process.exit(1)
}
