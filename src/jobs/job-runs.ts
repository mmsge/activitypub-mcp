import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { importRuns } from '../db/schema.js'
import { config } from '../config.js'
import { activeRaces } from '../lib/races-config.js'
import { logger } from '../lib/logger.js'

// The scheduler's jobs, and a record of each one's runs, for Admin → System → Jobbar
// (ADR 0073). Runs are rows in `import_runs` with kind `job:<id>`, the table the Import
// list already reads, so a job's last run survives a deploy.
//
// The delivery worker ticks every 30 s, so rows are capped per job: the newest KEEP_PER_JOB
// stay and older ones go in the same call. That is enough to show the last run and a
// recent failure without the table growing with uptime.

export const KEEP_PER_JOB = 20

export interface JobDef {
  id: string
  label: string
  /** How often it runs, in ms, or null when it is not registered on this deployment. */
  intervalMs: () => number | null
  /** What switches it on, said plainly, when it can be off. */
  gate?: string
}

const H = 60 * 60_000
const always = (ms: number) => () => ms

export const JOBS: JobDef[] = [
  { id: 'delivery', label: 'Levering', intervalMs: always(30_000) },
  { id: 'actor-refresh', label: 'Oppfrisk aktørar', intervalMs: always(H) },
  { id: 'scrobbles', label: 'Last.fm og scrobble-kappløp', intervalMs: () => config.LASTFM_SYNC_INTERVAL_SECONDS * 1_000 },
  { id: 'convergence', label: 'Konvergens', intervalMs: () => config.LASTFM_SYNC_INTERVAL_SECONDS * 1_000 },
  {
    id: 'race-nowplaying', label: 'Kappløp, spelar no', gate: 'eit kappløp med nowplaying_gap',
    intervalMs: () => (activeRaces().some((r) => r.nowplayingGap > 0) ? config.RACE_NOWPLAYING_INTERVAL_SECONDS * 1_000 : null),
  },
  { id: 'reading', label: 'Lesehistorikk, hyller og bokmetadata', intervalMs: always(6 * H) },
  { id: 'neodb', label: 'NeoDB-metadata', intervalMs: always(6 * H) },
  { id: 'gigs', label: 'Konsertmetadata', intervalMs: always(6 * H) },
  { id: 'garden', label: 'Hageinnhald', intervalMs: always(6 * H) },
  { id: 'engagement', label: 'Engasjement og breakouts', intervalMs: () => config.ENGAGEMENT_SAMPLE_INTERVAL_MINUTES * 60_000 },
  {
    id: 'breakout-fast-lane', label: 'Breakout, snøggfil', gate: 'BREAKOUT_FAST_LANE_MINUTES',
    intervalMs: () => (config.BREAKOUT_FAST_LANE_MINUTES > 0 ? config.BREAKOUT_FAST_LANE_MINUTES * 60_000 : null),
  },
  {
    id: 'youtube-shorts', label: 'YouTube Shorts', gate: 'YOUTUBE_SHORTS_INTERVAL_HOURS',
    intervalMs: () => (config.YOUTUBE_SHORTS_INTERVAL_HOURS > 0 ? config.YOUTUBE_SHORTS_INTERVAL_HOURS * H : null),
  },
  { id: 'prune-log', label: 'Rydd førespurnadslogg', intervalMs: always(6 * H) },
  { id: 'status-note', label: 'Statusnotat', intervalMs: always(H) },
  { id: 'trip-posts', label: 'Knyt innlegg til turar', intervalMs: always(H) },
  { id: 'stations', label: 'Stasjonar og vêr', intervalMs: always(6 * H) },
  { id: 'trip-lines', label: 'Linjer for turar', intervalMs: always(H) },
  {
    id: 'linkedin', label: 'LinkedIn DMA', gate: 'LINKEDIN_DMA_TOKEN',
    intervalMs: () => (config.LINKEDIN_DMA_TOKEN ? config.LINKEDIN_SYNC_INTERVAL_HOURS * H : null),
  },
  {
    id: 'storygraph', label: 'StoryGraph (sidetal)', gate: 'STORYGRAPH_API_URL og STORYGRAPH_API_TOKEN',
    intervalMs: () => (config.STORYGRAPH_API_URL && config.STORYGRAPH_API_TOKEN ? config.STORYGRAPH_SYNC_INTERVAL_MINUTES * 60_000 : null),
  },
  {
    id: 'threads', label: 'Trådgang', gate: 'THREAD_WALK_INTERVAL_HOURS',
    intervalMs: () => (config.THREAD_WALK_INTERVAL_HOURS > 0 ? config.THREAD_WALK_INTERVAL_HOURS * H : null),
  },
]

const kindOf = (id: string) => `job:${id}`

/**
 * Run a scheduled job, log a failure the way the scheduler always has, and record the
 * outcome. Never throws: a timer callback that throws is an unhandled rejection, and a
 * failed write of the record must not be mistaken for a failed job.
 */
/** `errorMessage` null: the job logs its own failures, so only record. */
export async function runJob(id: string, errorMessage: string | null, fn: () => Promise<unknown>): Promise<void> {
  const started = Date.now()
  let error: string | null = null
  try {
    await fn()
  } catch (e) {
    if (errorMessage) logger.error(e, errorMessage)
    error = e instanceof Error ? e.message : String(e)
  }
  await recordJobRun(id, Date.now() - started, error)
}

async function recordJobRun(id: string, ms: number, error: string | null): Promise<void> {
  const kind = kindOf(id)
  try {
    const db = getDb()
    await db.insert(importRuns).values({
      kind,
      ok: error === null,
      summary: error === null ? `${ms} ms` : null,
      error: error?.slice(0, 2000) ?? null,
    })
    const keep = db.select({ id: importRuns.id }).from(importRuns)
      .where(eq(importRuns.kind, kind)).orderBy(desc(importRuns.ranAt)).limit(KEEP_PER_JOB)
    await db.delete(importRuns).where(and(eq(importRuns.kind, kind), notInArray(importRuns.id, keep)))
  } catch (e) {
    logger.warn({ err: e, job: id }, 'Could not record job run')
  }
}

export interface JobStatus {
  job: JobDef
  intervalMs: number | null
  last: { ranAt: Date; ok: boolean; summary: string | null; error: string | null } | null
  /** The newest failure still kept, when the last run was not it. */
  lastFailure: { ranAt: Date; error: string | null } | null
}

/** Every job with its newest run and newest kept failure. */
export async function jobStatuses(): Promise<JobStatus[]> {
  const db = getDb()
  const kinds = JOBS.map((j) => kindOf(j.id))
  const [latest, failures] = await Promise.all([
    db.selectDistinctOn([importRuns.kind]).from(importRuns)
      .where(inArray(importRuns.kind, kinds)).orderBy(importRuns.kind, desc(importRuns.ranAt)),
    db.selectDistinctOn([importRuns.kind]).from(importRuns)
      .where(and(inArray(importRuns.kind, kinds), sql`NOT ${importRuns.ok}`))
      .orderBy(importRuns.kind, desc(importRuns.ranAt)),
  ])
  const byKind = new Map(latest.map((r) => [r.kind, r]))
  const failByKind = new Map(failures.map((r) => [r.kind, r]))
  return JOBS.map((job) => {
    const last = byKind.get(kindOf(job.id)) ?? null
    const fail = failByKind.get(kindOf(job.id)) ?? null
    return {
      job,
      intervalMs: job.intervalMs(),
      last: last && { ranAt: last.ranAt, ok: last.ok, summary: last.summary, error: last.error },
      lastFailure: fail && last && fail.id !== last.id ? { ranAt: fail.ranAt, error: fail.error } : null,
    }
  })
}
