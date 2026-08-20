import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { postWebhook } from './webhook-post.js'
import { logger } from './logger.js'

const base = { url: 'http://172.18.0.1:4003/webhook/tog', headerName: 'X-Test-Token', secret: 'hunter2', label: 'TEST WEBHOOK' }

const originalFetch = globalThis.fetch
beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { globalThis.fetch = originalFetch })

function mockFetch(status: number) {
  const fetchMock = vi.fn(async () => new Response('', { status }))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('postWebhook', () => {
  it('sends the secret in the named header and nothing else', async () => {
    const fetchMock = mockFetch(200)
    expect(await postWebhook(base)).toBe(true)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['X-Test-Token']).toBe('hunter2')
    // No body, so no Content-Type: a receiver taking a pure ping gets a pure ping.
    expect(headers['Content-Type']).toBeUndefined()
    expect(init.body).toBeUndefined()
  })

  it('sets Content-Type only when there is a body', async () => {
    const fetchMock = mockFetch(200)
    await postWebhook({ ...base, body: '{"a":1}' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(init.body).toBe('{"a":1}')
  })

  it('never throws when the network is down', async () => {
    // A failed notification must never fail the durable act that triggered it.
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch failed') }) as unknown as typeof fetch
    await expect(postWebhook(base)).resolves.toBe(false)
  })

  it('logs a non-2xx loudly, with the status', async () => {
    // hetzner-server ADR 0011: weeks of silently-401ing ntfy pushes hidden behind
    // `curl -sf … || true`. This line is the only thing that makes a drifted
    // secret visible.
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    mockFetch(401)
    expect(await postWebhook(base)).toBe(false)
    expect(spy).toHaveBeenCalledWith({ status: 401 }, 'TEST WEBHOOK FAILED')
  })

  it('labels each caller, so "which webhook failed" is answerable from the message', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    mockFetch(500)
    await postWebhook({ ...base, label: 'MSGE WEBHOOK' })
    expect(spy).toHaveBeenCalledWith({ status: 500 }, 'MSGE WEBHOOK FAILED')
  })

  it('logs the error MESSAGE, never the error object', async () => {
    // pino serialises `cause`, and on a connection failure `cause` carries the
    // address we dialled. That is an IP in a log line, which the box's logging
    // convention forbids.
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    const err = new Error('fetch failed')
    ;(err as Error & { cause?: unknown }).cause = { address: '172.18.0.1', port: 4003 }
    globalThis.fetch = vi.fn(async () => { throw err }) as unknown as typeof fetch

    await postWebhook(base)

    const payload = JSON.stringify(spy.mock.calls[0][0])
    expect(payload).not.toContain('172.18.0.1')
    expect(payload).toContain('fetch failed')
  })

  it('never logs the secret', async () => {
    const err = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    mockFetch(403)
    await postWebhook(base)
    expect(JSON.stringify(err.mock.calls)).not.toContain('hunter2')
  })
})
