import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ttlMemo } from './memo.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('ttlMemo', () => {
  it('loads once and serves the cached value', async () => {
    const load = vi.fn(async () => 'x')
    const memo = ttlMemo<string>({ ttlMs: 1000, max: 10 })
    expect(await memo.get('k', load)).toBe('x')
    expect(await memo.get('k', load)).toBe('x')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('reloads once the entry is older than the TTL', async () => {
    let n = 0
    const load = async () => `v${++n}`
    const memo = ttlMemo<string>({ ttlMs: 1000, max: 10 })
    expect(await memo.get('k', load)).toBe('v1')
    vi.advanceTimersByTime(1001)
    expect(await memo.get('k', load)).toBe('v2')
  })

  it('collapses concurrent misses into one load', async () => {
    // Without this a cold key under a burst of traffic runs the query once per
    // request — which on a public page is exactly when it is most expensive.
    let resolve!: (v: string) => void
    const load = vi.fn(() => new Promise<string>((r) => { resolve = r }))
    const memo = ttlMemo<string>({ ttlMs: 1000, max: 10 })

    const all = Promise.all([memo.get('k', load), memo.get('k', load), memo.get('k', load)])
    resolve('once')
    expect(await all).toEqual(['once', 'once', 'once'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not cache a rejection', async () => {
    const memo = ttlMemo<string>({ ttlMs: 1000, max: 10 })
    await expect(memo.get('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(memo.size()).toBe(0)
    expect(await memo.get('k', async () => 'recovered')).toBe('recovered')
  })

  it('evicts oldest-first past the cap', async () => {
    const memo = ttlMemo<string>({ ttlMs: 10_000, max: 3 })
    for (const k of ['a', 'b', 'c', 'd']) await memo.get(k, async () => k)
    expect(memo.size()).toBe(3)

    // 'a' was evicted, so it reloads; 'd' is still resident.
    const reload = vi.fn(async () => 'reloaded')
    expect(await memo.get('a', reload)).toBe('reloaded')
    expect(reload).toHaveBeenCalledTimes(1)

    const noReload = vi.fn(async () => 'should not run')
    expect(await memo.get('d', noReload)).toBe('d')
    expect(noReload).not.toHaveBeenCalled()
  })

  it('never exceeds the cap, however many distinct keys arrive', async () => {
    // The backstop against a crawler minting entries faster than they expire.
    const memo = ttlMemo<number>({ ttlMs: 10_000, max: 5 })
    for (let i = 0; i < 500; i++) await memo.get(`k${i}`, async () => i)
    expect(memo.size()).toBe(5)
  })

  it('clears', async () => {
    const memo = ttlMemo<string>({ ttlMs: 10_000, max: 5 })
    await memo.get('a', async () => 'a')
    memo.clear()
    expect(memo.size()).toBe(0)
  })
})
