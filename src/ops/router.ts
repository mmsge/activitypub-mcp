import { Hono } from 'hono'
import { getSql } from '../db/client.js'
import { lastSchedulerTick } from '../lib/heartbeat.js'
import { BUILD_INFO, SLUG } from './build-info.js'

/**
 * The box's ops contract: /healthz, /version and /health.
 *
 * Box-wide convention — naustet-server ADR 0022 and its
 * docs/health-and-version-contract.md. Three fixed paths answering three different
 * questions:
 *
 *   /healthz  is the process alive?      (container probe; dependency-free)
 *   /version  which commit is running?   (deploy badges — the IMAGE, not the checkout)
 *   /health   is it working, and what isn't?
 *
 * ONE ROUTER, MOUNTED ON BOTH APPS. This process serves two sites on port 3000
 * behind a Host-header dispatcher (bot.skvip.lol and meg.msge.no — see ADR 0018),
 * and both need all three routes: the container probe calls
 * http://127.0.0.1:3000/healthz with no Host at all, which the dispatcher sends to
 * the bot app, while anything reaching the box for the stream host must not 404 on
 * the same paths. Mounting the same router twice is what keeps the two answers from
 * drifting. The payload is identical on both hosts on purpose — one image, one
 * commit, one deployable (ADR 0032).
 *
 * REDACTION. /health and /version are public and unauthenticated. Everything below
 * is on the contract's allowlist: statuses, ages, latencies, counts, and `detail`
 * strings from a fixed vocabulary. Never a path, a hostname, a port, an env var, a
 * DSN, a table name, or an exception message — this app holds fediverse credentials
 * and a full archive, and the exception text from a failed query is exactly the kind
 * of thing that names them. Errors are classified, never stringified.
 */
export const opsRouter = new Hono()

const NO_STORE = { 'Cache-Control': 'no-store' } as const

const STARTED_MS = Date.now()

/** How long a health probe waits on the database before calling it slow. */
const DB_TIMEOUT_MS = 2_000

/**
 * The scheduler's shortest interval is 30s (delivery). Ten missed beats is a dead
 * timer, not a slow one.
 */
const SCHEDULER_STALE_SECONDS = 300

/** Grace period before a scheduler that has never beaten counts against health. */
const SCHEDULER_GRACE_SECONDS = 120

/**
 * A queued delivery is retried every 30s with backoff, so being overdue for a
 * quarter of an hour means the worker is not draining the queue.
 */
const QUEUE_OVERDUE_SECONDS = 900

type CheckStatus = 'ok' | 'degraded' | 'error'

/**
 * The closed vocabulary this service reports.
 *
 * `name` values: `database`, `queue`, `scheduler`.
 * `detail` values: the contract's fixed words (`timeout`, `unavailable`, …) or a
 * plain count. Nothing else may appear here.
 */
interface Check {
  name: 'database' | 'queue' | 'scheduler'
  status: CheckStatus
  latency_ms?: number
  age_seconds?: number
  detail?: string
}

/** Reject rather than hang: an unreachable database must not wedge /health. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

class TimeoutError extends Error {}

/**
 * The archive is reachable and has content in it.
 *
 * A count, not `SELECT 1`: a database that answers but has lost its data answers
 * `SELECT 1` perfectly well. The number is a non-identifying cardinal, which the
 * contract's allowlist permits.
 */
async function checkDatabase(): Promise<Check> {
  const t0 = Date.now()
  try {
    const sql = getSql()
    const rows = await withTimeout(
      sql<{ n: number }[]>`select count(*)::int as n from objects`,
      DB_TIMEOUT_MS,
    )
    const n = rows[0]?.n ?? 0
    return {
      name: 'database',
      status: 'ok',
      latency_ms: Date.now() - t0,
      detail: `reachable; ${n} rows`,
    }
  } catch (e) {
    // Classified word only. str(e) here would carry the connection string.
    return e instanceof TimeoutError
      ? { name: 'database', status: 'degraded', latency_ms: Date.now() - t0, detail: 'timeout' }
      : { name: 'database', status: 'error', latency_ms: Date.now() - t0, detail: 'unavailable' }
  }
}

/**
 * The outbound delivery queue is draining.
 *
 * This is the check that catches the failure nobody sees from the outside: the site
 * keeps serving, the database keeps answering, and Follow/Accept/Create activities
 * quietly stop reaching other instances. Depth plus the age of the oldest *overdue*
 * item — an item scheduled for the future is backoff working as intended, not a
 * backlog.
 */
async function checkQueue(): Promise<Check> {
  const t0 = Date.now()
  try {
    const sql = getSql()
    const rows = await withTimeout(
      sql<{ pending: number; overdue_seconds: number }[]>`
        select count(*)::int as pending,
               coalesce(
                 greatest(extract(epoch from now() - min(next_attempt_at)), 0),
                 0
               )::int as overdue_seconds
        from delivery_queue
        where delivered_at is null
      `,
      DB_TIMEOUT_MS,
    )
    const pending = rows[0]?.pending ?? 0
    const overdue = rows[0]?.overdue_seconds ?? 0
    return {
      name: 'queue',
      status: overdue > QUEUE_OVERDUE_SECONDS ? 'degraded' : 'ok',
      latency_ms: Date.now() - t0,
      age_seconds: overdue,
      detail: `${pending} pending`,
    }
  } catch (e) {
    return e instanceof TimeoutError
      ? { name: 'queue', status: 'degraded', latency_ms: Date.now() - t0, detail: 'timeout' }
      : { name: 'queue', status: 'error', latency_ms: Date.now() - t0, detail: 'unavailable' }
  }
}

/**
 * The background timers are still firing.
 *
 * Every ingest in this app — scrobbles, reading history, garden crawl, delivery —
 * is a setInterval in src/jobs/scheduler.ts. If they stop, the app looks perfectly
 * healthy from every other angle while going stale.
 */
function checkScheduler(): Check {
  const last = lastSchedulerTick()
  const uptime = Math.floor((Date.now() - STARTED_MS) / 1000)
  if (last === null) {
    // Startup runs blocking syncs before the port binds and the first delivery beat
    // is 30s later, so a young process with no beat yet is not a fault.
    return uptime < SCHEDULER_GRACE_SECONDS
      ? { name: 'scheduler', status: 'ok' }
      : { name: 'scheduler', status: 'degraded', detail: 'unavailable' }
  }
  const age = Math.floor((Date.now() - last) / 1000)
  return {
    name: 'scheduler',
    status: age > SCHEDULER_STALE_SECONDS ? 'degraded' : 'ok',
    age_seconds: age,
  }
}

function worst(checks: Check[]): CheckStatus {
  if (checks.some((c) => c.status === 'error')) return 'error'
  if (checks.some((c) => c.status === 'degraded')) return 'degraded'
  return 'ok'
}

/**
 * Liveness. Dependency-free on purpose: the Compose healthcheck restarts the
 * container on this, so wiring it to the database would restart-loop the app every
 * time postgres hiccuped. The body is exactly `ok` — two bytes, no trailing newline
 * — because the probe compares it.
 */
opsRouter.get('/healthz', (c) => c.text('ok', 200, NO_STORE))

/**
 * The running image's git identity, baked in at deploy by
 * scripts/generate-build-info.sh. Absent file ⇒ source "unknown"; never a guess, and
 * never a 500. `no-store` matters: caching the endpoint used to detect staleness
 * defeats the endpoint.
 */
opsRouter.get('/version', (c) => c.json(BUILD_INFO, 200, NO_STORE))

/** Readiness. `degraded` is 200; only `error` is 503. */
opsRouter.get('/health', async (c) => {
  const checks: Check[] = [...(await Promise.all([checkDatabase(), checkQueue()])), checkScheduler()]
  const status = worst(checks)
  return c.json(
    {
      status,
      service: SLUG,
      commit_short: BUILD_INFO.commit_short,
      started_at: new Date(STARTED_MS).toISOString(),
      uptime_seconds: Math.floor((Date.now() - STARTED_MS) / 1000),
      checked_at: new Date().toISOString(),
      checks,
    },
    status === 'error' ? 503 : 200,
    NO_STORE,
  )
})
