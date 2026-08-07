import { describe, it, expect, vi, beforeEach } from 'vitest'

// The health checks run two real queries; the point of these tests is the contract's
// shape and its redaction rules, not postgres. `getSql` is replaced with a template
// tag that answers whatever the current fixture says.
let sqlImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>

vi.mock('../db/client.js', () => ({
  getSql: () => (strings: TemplateStringsArray, ...values: unknown[]) => sqlImpl(strings, ...values),
}))

const { opsRouter } = await import('./router.js')
const { markSchedulerTick } = await import('../lib/heartbeat.js')

const okRows = async (strings: TemplateStringsArray): Promise<unknown[]> => {
  const text = strings.join(' ')
  if (text.includes('delivery_queue')) return [{ pending: 3, overdue_seconds: 12 }]
  return [{ n: 12408 }]
}

const get = (path: string, host?: string) =>
  opsRouter.request(path, host ? { headers: { host } } : undefined)

beforeEach(() => {
  sqlImpl = okRows
  markSchedulerTick()
})

describe('/healthz', () => {
  it('is exactly the two bytes "ok" — the Compose probe compares them', async () => {
    const res = await get('/healthz')
    expect(res.status).toBe(200)
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(bytes)).toEqual([0x6f, 0x6b])
  })

  it('never carries an ETag, so a conditional GET cannot turn it into a 304', async () => {
    const res = await get('/healthz')
    expect(res.headers.get('etag')).toBeNull()
  })

  it('is not cached', async () => {
    expect((await get('/healthz')).headers.get('cache-control')).toBe('no-store')
  })

  it('does not touch the database — a slow query must not restart the container', async () => {
    sqlImpl = () => {
      throw new Error('the liveness probe must never reach here')
    }
    expect((await get('/healthz')).status).toBe(200)
  })
})

describe('/version', () => {
  it('is JSON, uncached, and names the deployable rather than either domain', async () => {
    const res = await get('/version')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.service).toBe('bot')
  })

  it('carries every contract field, and reports "unknown" rather than guessing', async () => {
    const body = await (await get('/version')).json()
    for (const key of ['service', 'commit', 'commit_short', 'branch', 'commit_time',
      'repo', 'dirty', 'built_at', 'source']) {
      expect(body).toHaveProperty(key)
    }
    // In CI there is no build-info.json (it is written at deploy and gitignored), so
    // this asserts the absent-file path: nulls and "unknown", never a 500, never a
    // fabricated sha.
    expect(['build-info', 'unknown']).toContain(body.source)
    if (body.source === 'unknown') expect(body.commit).toBeNull()
  })

  // Byte-identical, not merely equal: record 0032 decides that `service` names the
  // deployable rather than the host that asked, precisely so /version cannot echo a
  // request-derived value back. Comparing the raw text is what would catch a later
  // "helpful" Host branch.
  it('answers byte-identically whichever host asked — one image behind both', async () => {
    const bot = await (await get('/version', 'bot.skvip.lol')).text()
    const meg = await (await get('/version', 'meg.msge.no')).text()
    const none = await (await get('/version')).text()
    expect(bot).toBe(meg)
    expect(bot).toBe(none)
    expect(JSON.parse(bot).service).toBe('bot')
  })
})

describe('/health', () => {
  it('reports substantive checks with counts and ages', async () => {
    const res = await get('/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.service).toBe('bot')
    expect(typeof body.uptime_seconds).toBe('number')
    expect(typeof body.started_at).toBe('string')
    expect(typeof body.checked_at).toBe('string')

    const names = body.checks.map((c: { name: string }) => c.name)
    expect(names).toEqual(['database', 'queue', 'scheduler'])

    const db = body.checks.find((c: { name: string }) => c.name === 'database')
    expect(db.detail).toBe('reachable; 12408 rows')
    expect(typeof db.latency_ms).toBe('number')

    const queue = body.checks.find((c: { name: string }) => c.name === 'queue')
    expect(queue.detail).toBe('3 pending')
    expect(queue.age_seconds).toBe(12)
  })

  it('is degraded but still 200 when the delivery queue has stopped draining', async () => {
    sqlImpl = async (strings) =>
      strings.join(' ').includes('delivery_queue')
        ? [{ pending: 41, overdue_seconds: 4000 }]
        : [{ n: 12408 }]
    const res = await get('/health')
    // degraded is 200. If it were 503 and anyone pointed a probe at /health, a slow
    // remote inbox would restart-loop the container.
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('degraded')
  })

  it('is 503 only when a check is a real error', async () => {
    sqlImpl = async () => {
      throw new Error('connection to postgres://apuser:hunter2@db:5432/activitypub failed')
    }
    const res = await get('/health')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe('error')
  })

  it('never leaks the exception text — the DSN is in it', async () => {
    sqlImpl = async () => {
      throw new Error('connection to postgres://apuser:hunter2@db:5432/activitypub failed')
    }
    const raw = await (await get('/health')).text()
    for (const secret of ['hunter2', 'apuser', 'postgres://', 'db:5432', '/app/', 'Error']) {
      expect(raw).not.toContain(secret)
    }
  })

  it('reports failures from the fixed vocabulary only', async () => {
    sqlImpl = async () => {
      throw new Error('boom')
    }
    const body = await (await get('/health')).json()
    const allowed = ['connection refused', 'timeout', 'auth failed', 'not found',
      'parse error', 'disk full', 'unavailable']
    for (const check of body.checks) {
      if (check.detail && !/^\d+ (rows|pending)$/.test(check.detail)
        && !/^reachable; \d+ rows$/.test(check.detail)) {
        expect(allowed).toContain(check.detail)
      }
    }
  })

  it('emits no field outside the contract allowlist', async () => {
    const body = await (await get('/health')).json()
    expect(Object.keys(body).sort()).toEqual([
      'checked_at', 'checks', 'commit_short', 'service', 'started_at', 'status',
      'uptime_seconds',
    ])
    for (const check of body.checks) {
      for (const key of Object.keys(check)) {
        expect(['name', 'status', 'latency_ms', 'age_seconds', 'detail']).toContain(key)
      }
    }
  })

  it('does not echo the Host back, on either host', async () => {
    for (const host of ['bot.skvip.lol', 'meg.msge.no']) {
      const raw = await (await get('/health', host)).text()
      expect(raw).not.toContain(host)
    }
  })
})
