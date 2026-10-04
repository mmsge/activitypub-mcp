import { describe, it, expect } from 'vitest'
import { classify, parseBooksList, parseEntriesPage, storygraphUrl } from './fetch-storygraph.js'

const trace = (status: number, body: string) => ({ url: 'http://x/api/v1/entries', status, body, durationMs: 1 })

describe('storygraphUrl', () => {
  it('trims trailing slashes and skips empty params', () => {
    expect(storygraphUrl('http://172.18.0.1:4008//', '/api/v1/entries', { since_updated: undefined, cursor: '', limit: '500' }))
      .toBe('http://172.18.0.1:4008/api/v1/entries?limit=500')
  })
})

describe('parseEntriesPage', () => {
  it('reads entries and a null next_cursor as the end', () => {
    expect(parseEntriesPage({ entries: [{ id: 'a' }], next_cursor: null })).toEqual({ entries: [{ id: 'a' }], nextCursor: null })
  })

  it('refuses a body without an entries array — that is not an empty page', () => {
    expect(parseEntriesPage({ next_cursor: null })).toBeNull()
    expect(parseEntriesPage({ entries: [], next_cursor: 42 })).toBeNull()
    expect(parseEntriesPage(null)).toBeNull()
  })
})

describe('parseBooksList', () => {
  it('requires a books array', () => {
    expect(parseBooksList({ books: [] })).toEqual({ books: [] })
    expect(parseBooksList({})).toBeNull()
  })
})

describe('classify', () => {
  it('keeps every failure a failure, with its trace', () => {
    expect(classify(trace(401, '{"detail":"bad token"}'), parseEntriesPage)).toMatchObject({ kind: 'error', status: 401 })
    expect(classify(trace(503, 'token not configured'), parseEntriesPage)).toMatchObject({ kind: 'error', status: 503 })
    expect(classify(trace(0, 'timeout'), parseEntriesPage)).toMatchObject({ kind: 'error', status: 0, message: 'timeout' })
    expect(classify(trace(200, '<html>502</html>'), parseEntriesPage)).toMatchObject({ kind: 'error', message: 'Unparseable JSON body' })
  })

  it('returns data with the trace on a contract-shaped 200', () => {
    const r = classify(trace(200, '{"entries":[],"next_cursor":null}'), parseEntriesPage)
    expect(r).toMatchObject({ kind: 'data', data: { entries: [], nextCursor: null }, trace: { status: 200 } })
  })

  it('clips a long body in the trace', () => {
    const r = classify(trace(500, 'x'.repeat(5000)), parseEntriesPage)
    expect(r.trace.body.length).toBeLessThan(2100)
  })
})
