import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { publishNtfy } from './ntfy.js'
import { logger } from './logger.js'

const target = { url: 'https://n.msge.no', topic: 'scrobble-race', user: 'markus', password: 'hunter2' }

const originalFetch = globalThis.fetch

beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { globalThis.fetch = originalFetch })

describe('publishNtfy', () => {
  it('posts the topic in a JSON body and authenticates as the shared user', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const ok = await publishNtfy(
      { title: '7 to go', body: 'x', tags: ['fire'], priority: 'max', click: 'https://last.fm/t' },
      target,
    )

    expect(ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://n.msge.no')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('markus:hunter2').toString('base64')}`)
    expect(JSON.parse(init.body as string)).toMatchObject({
      topic: 'scrobble-race', title: '7 to go', message: 'x', tags: ['fire'], priority: 5,
      click: 'https://last.fm/t',
    })
  })

  it('carries non-ASCII titles through intact — the reason we publish JSON, not headers', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await publishNtfy({ title: 'Maisie når Taylor — “Body Better”', body: 'y' }, target)

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).title).toBe('Maisie når Taylor — “Body Better”')
  })

  it('returns false and logs loudly on a 401 rather than swallowing it', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})

    await expect(publishNtfy({ title: 't', body: 'b' }, target)).resolves.toBe(false)
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401 }),
      'NTFY PUBLISH FAILED',
    )
  })

  it('does not throw when the network is down', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    vi.spyOn(logger, 'error').mockImplementation(() => {})

    await expect(publishNtfy({ title: 't', body: 'b' }, target)).resolves.toBe(false)
  })

  it('is a no-op without a password, and never reaches the network', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(publishNtfy({ title: 't', body: 'b' }, { ...target, password: '' })).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('defaults to normal priority when none is given', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await publishNtfy({ title: 't', body: 'b' }, target)

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).priority).toBe(3)
  })
})
