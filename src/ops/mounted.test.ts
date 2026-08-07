import { describe, it, expect, vi } from 'vitest'

// One container, two Hono apps behind a Host-header dispatcher (ADR 0018). The bot
// app is built inside src/index.ts, which starts the server on import and so cannot
// be imported here — it is covered by the booted check in `make verify`. This file
// pins the half that is importable: the public stream app must serve the ops
// contract too, ahead of its own notFound() handler, which would otherwise answer a
// missing ops path with a 404 HTML page.
vi.mock('../db/client.js', () => ({
  getSql: () => async (strings: TemplateStringsArray) =>
    strings.join(' ').includes('delivery_queue')
      ? [{ pending: 0, overdue_seconds: 0 }]
      : [{ n: 1 }],
}))

const { streamApp } = await import('../stream/router.js')

describe('the stream host serves the ops contract', () => {
  it('answers /healthz with exactly "ok"', async () => {
    const res = await streamApp.request('/healthz', { headers: { host: 'meg.msge.no' } })
    expect(res.status).toBe(200)
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([0x6f, 0x6b])
  })

  it('answers /version as JSON, not as the stream 404 page', async () => {
    const res = await streamApp.request('/version', { headers: { host: 'meg.msge.no' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect((await res.json()).service).toBe('bot')
  })

  it('answers /health as JSON, not as the stream 404 page', async () => {
    const res = await streamApp.request('/health', { headers: { host: 'meg.msge.no' } })
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await res.json()).service).toBe('bot')
  })
})

describe('robots.txt keeps the ops paths out of the index', () => {
  it('on the stream host', async () => {
    const { renderRobots } = await import('../stream/meta.js')
    const body = renderRobots()
    for (const path of ['/healthz', '/version', '/health']) {
      expect(body).toContain(`Disallow: ${path}`)
    }
  })
})
