import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { notifyMsgeChanged, notifyMsgeDebounced, resetMsgeDebounce } from './msge-webhook.js'

const target = { url: 'http://172.18.0.1:4003/webhook', secret: 'hunter2' }

const originalFetch = globalThis.fetch

beforeEach(() => { vi.restoreAllMocks(); resetMsgeDebounce() })
afterEach(() => { globalThis.fetch = originalFetch; resetMsgeDebounce(); vi.useRealTimers() })

function mockFetch(status: number) {
  const fetchMock = vi.fn(async () => new Response('', { status }))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('notifyMsgeChanged', () => {
  it('POSTs the topic as a path segment, with the header msge.no checks', async () => {
    const fetchMock = mockFetch(202)

    expect(await notifyMsgeChanged('tog', 3, target)).toBe(true)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://172.18.0.1:4003/webhook/tog')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Msge-Token']).toBe('hunter2')
  })

  it('does not double the slash when the base url has a trailing one', async () => {
    const fetchMock = mockFetch(202)
    await notifyMsgeChanged('bok', 1, { ...target, url: 'http://172.18.0.1:4003/webhook/' })
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe('http://172.18.0.1:4003/webhook/bok')
  })

  it('sends nothing when the import changed nothing', async () => {
    // Re-uploading an export is the common case, and waking msge.no to re-read an
    // identical answer would burn its rate-limit slot for no reason.
    const fetchMock = mockFetch(202)
    expect(await notifyMsgeChanged('tuben', 0, target)).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends nothing when no secret is configured', async () => {
    // Inert until the secret is in /srv/bot/.env — the NTFY_PASSWORD shape.
    const fetchMock = mockFetch(202)
    expect(await notifyMsgeChanged('tog', 5, { ...target, secret: '' })).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a drifted secret rather than swallowing it', async () => {
    // 401 is what msge.no answers when WEBHOOK_SECRET no longer matches. Silence
    // here is how the ntfy pushes 401ed for weeks (naustet-server ADR 0011).
    mockFetch(401)
    expect(await notifyMsgeChanged('tog', 2, target)).toBe(false)
  })

  it('reports a receiver whose webhook is switched off', async () => {
    mockFetch(503)
    expect(await notifyMsgeChanged('tog', 2, target)).toBe(false)
  })

  it('never throws when the network is down', async () => {
    // A failed notification must not fail the import that triggered it.
    globalThis.fetch = vi.fn(async () => { throw new Error('fetch failed') }) as unknown as typeof fetch
    await expect(notifyMsgeChanged('tog', 2, target)).resolves.toBe(false)
  })
})

describe('notifyMsgeDebounced', () => {
  it('collapses a burst into one notification per topic', () => {
    vi.useFakeTimers()
    const fetchMock = mockFetch(202)

    for (let i = 0; i < 200; i += 1) notifyMsgeDebounced("tut", Date.now(), target)
    expect(fetchMock).not.toHaveBeenCalled()   // trailing, not leading

    vi.advanceTimersByTime(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps topics apart', () => {
    vi.useFakeTimers()
    const fetchMock = mockFetch(202)

    notifyMsgeDebounced('tut', Date.now(), target)
    notifyMsgeDebounced('bok', Date.now(), target)
    vi.advanceTimersByTime(10_000)

    const urls = (fetchMock.mock.calls as unknown as [string][]).map((c) => c[0])
    expect(urls.sort()).toEqual([
      'http://172.18.0.1:4003/webhook/bok',
      'http://172.18.0.1:4003/webhook/tut',
    ])
  })

  it('still fires during a backfill longer than the ceiling', () => {
    // The trap: a trailing debounce with no ceiling is reset by every new object,
    // so a thirty-minute NeoDB repair would send NOTHING at all. MAX_DELAY_MS caps
    // how long a continuous burst can hold the notification back.
    vi.useFakeTimers()
    const fetchMock = mockFetch(202)

    const start = Date.now()
    for (let t = 0; t <= 90_000; t += 1_000) {
      notifyMsgeDebounced('tut', start + t, target)
      vi.advanceTimersByTime(1_000)
    }
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('does not hold the process open', () => {
    // Without unref() a pending debounce keeps a short-lived script — and vitest —
    // alive for ten seconds after the last assertion.
    const unref = vi.fn()
    const spy = vi.spyOn(globalThis, 'setTimeout').mockReturnValue({ unref } as never)
    notifyMsgeDebounced('film', Date.now(), target)
    expect(unref).toHaveBeenCalled()
    spy.mockRestore()
  })
})
