import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { notifyTripsChanged } from './trip-webhook.js'
import { logger } from './logger.js'

const target = { url: 'http://172.18.0.1:4031/webhook/tog', secret: 'hunter2' }

const originalFetch = globalThis.fetch

beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { globalThis.fetch = originalFetch })

function mockFetch(status: number) {
  const fetchMock = vi.fn(async () => new Response('', { status }))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('notifyTripsChanged', () => {
  it('POSTs the shared secret in the header bartenderen checks', async () => {
    const fetchMock = mockFetch(200)

    expect(await notifyTripsChanged(3, target)).toBe(true)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://172.18.0.1:4031/webhook/tog')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Bartenderen-Token']).toBe('hunter2')
  })

  it('wakes bartenderen for a run that only deleted', async () => {
    // A confirmed prune inserts and updates nothing. It is still the change that
    // matters most to the receiver: the trip removed is often the very one it was
    // advertising as the next departure (ADR 0054).
    mockFetch(200)
    expect(await notifyTripsChanged(2, target)).toBe(true)
  })

  it('sends nothing when the import changed nothing', async () => {
    // Re-uploading an export is the common case, and waking a service to
    // recompute an identical answer is pure noise — it would read the same legs,
    // render the same string and write nothing.
    const fetchMock = mockFetch(200)
    expect(await notifyTripsChanged(0, target)).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends nothing when no secret is configured', async () => {
    const fetchMock = mockFetch(200)
    expect(await notifyTripsChanged(3, { ...target, secret: '' })).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('logs a drifted secret loudly rather than swallowing the 403', async () => {
    // The failure this exists to catch: bartenderen's WEBHOOK_SECRET and ours
    // diverge, every notification 403s, and nothing ever says so. See
    // naustet-server ADR 0011 — weeks of silently-401ing ntfy pushes.
    mockFetch(403)
    const err = vi.spyOn(logger, 'error').mockImplementation(() => {})

    expect(await notifyTripsChanged(3, target)).toBe(false)

    expect(err).toHaveBeenCalledWith({ status: 403 }, 'TRIP WEBHOOK FAILED')
  })

  it('logs a receiver with its own webhook disabled (503) the same way', async () => {
    mockFetch(503)
    const err = vi.spyOn(logger, 'error').mockImplementation(() => {})
    expect(await notifyTripsChanged(3, target)).toBe(false)
    expect(err).toHaveBeenCalledWith({ status: 503 }, 'TRIP WEBHOOK FAILED')
  })

  it('never throws on a network failure — the import must still succeed', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch failed') }) as unknown as typeof fetch
    const err = vi.spyOn(logger, 'error').mockImplementation(() => {})

    await expect(notifyTripsChanged(3, target)).resolves.toBe(false)

    expect(err).toHaveBeenCalledWith(
      { error: 'fetch failed' }, 'TRIP WEBHOOK FAILED (network)')
  })

  it('logs the error MESSAGE, not the error object', async () => {
    // pino serialises `cause`, which on a connection failure carries the address
    // we dialled — an IP in a log line, which the box's logging convention
    // forbids. The message alone ("fetch failed", the timeout's abort reason)
    // names no host.
    const withCause = new Error('fetch failed')
    ;(withCause as Error & { cause?: unknown }).cause = { address: '172.18.0.1', port: 4031 }
    globalThis.fetch = vi.fn(async () => { throw withCause }) as unknown as typeof fetch
    const err = vi.spyOn(logger, 'error').mockImplementation(() => {})

    await notifyTripsChanged(3, target)

    const [payload] = err.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(payload).toEqual({ error: 'fetch failed' })
    expect(JSON.stringify(payload)).not.toContain('172.18.0.1')
  })

  it('never logs the secret, on any path', async () => {
    mockFetch(403)
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const err = vi.spyOn(logger, 'error').mockImplementation(() => {})

    await notifyTripsChanged(3, target)
    await notifyTripsChanged(0, target)
    await notifyTripsChanged(3, { ...target, secret: '' })

    const logged = JSON.stringify([...info.mock.calls, ...err.mock.calls])
    expect(logged).not.toContain('hunter2')
  })
})
