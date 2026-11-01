/** @jsxImportSource hono/jsx */
import { describe, it, expect } from 'vitest'
import { LogsPage, LogRows, logFilterOf, logTime, type LogEntry } from './logs.js'

const now = new Date('2026-11-01T12:00:00Z')

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  id: 1,
  direction: 'outbound',
  method: 'POST',
  url: 'https://bookwyrm.social/inbox',
  responseStatus: 500,
  signatureValid: null,
  error: 'Remote returned 500 Internal Server Error',
  actorApId: 'https://bookwyrm.social/user/reader',
  createdAt: new Date('2026-11-01T09:18:02Z'),
  requestBody: '{"type":"Create"}',
  requestHeaders: {},
  responseBody: null,
  ...over,
})

describe('logFilterOf', () => {
  it('reads the chip', () => {
    expect(logFilterOf({ f: 'feil' })).toBe('feil')
    expect(logFilterOf({})).toBe('alle')
    expect(logFilterOf({ f: 'nonsense' })).toBe('alle')
  })

  it('keeps the old direction and sigValid links meaning what they meant', () => {
    expect(logFilterOf({ direction: 'outbound' })).toBe('ut')
    expect(logFilterOf({ direction: 'inbound' })).toBe('inn')
    expect(logFilterOf({ sigValid: 'false' })).toBe('ugyldig')
  })
})

describe('logTime', () => {
  it('is a clock time today and a date before that, in Oslo time', () => {
    expect(logTime(new Date('2026-11-01T09:18:02Z'), now)).toBe('10:18:02')
    expect(logTime(new Date('2026-10-31T09:18:02Z'), now)).toBe('31. okt. 10:18')
  })
})

describe('a log card', () => {
  it('shows direction, method, a failing status in red, the URL and the handle', () => {
    const html = String(LogRows({ logs: [entry()], now }))
    expect(html).toContain('>UT</span>')
    expect(html).toContain('class="mono log-status tone-red">500<')
    expect(html).toContain('https://bookwyrm.social/inbox')
    expect(html).toContain('@reader@bookwyrm.social')
  })

  it('puts the error and the body behind the tap', () => {
    const html = String(LogRows({ logs: [entry()], now }))
    expect(html).toMatch(/<details class="log-card">[\s\S]*<\/summary><div class="log-detail"><div class="log-error">Remote returned 500/)
    expect(html).toContain('{&quot;type&quot;:&quot;Create&quot;}')
  })

  it('marks an inbound signature either way, and says when there is no body', () => {
    const html = String(LogRows({ logs: [entry({ direction: 'inbound', method: 'GET', responseStatus: 401, signatureValid: false, error: null, requestBody: null })], now }))
    expect(html).toContain('>INN</span>')
    expect(html).toContain('title="Ugyldig signatur">✗</span>')
    expect(html).toContain('(ingen body)')
  })

  it('says what an empty filter means', () => {
    expect(String(LogRows({ logs: [], now }))).toContain('Ingen førespurnader med dette filteret.')
  })
})

describe('LogsPage', () => {
  it('marks the chip in use, keeps the actor filter in every link, and polls the same view', () => {
    const html = String(LogsPage({ logs: [entry()], page: 0, hasMore: true, filter: 'ut', actor: 'https://a.example/users/b', now }))
    expect(html).toContain('<a href="/admin/logs?f=ut&amp;actor=https%3A%2F%2Fa.example%2Fusers%2Fb" class="active" aria-current="page">Ut</a>')
    expect(html).toContain('hx-get="/admin/logs/rows?f=ut&amp;actor=https%3A%2F%2Fa.example%2Fusers%2Fb"')
    expect(html).toContain('@b@a.example')
    expect(html).toContain('Eldre ›')
  })

  it('holds the poll while a card is open', () => {
    const html = String(LogsPage({ logs: [], page: 0, hasMore: false, filter: 'alle', now }))
    expect(html).toContain("every 10s [!document.querySelector(&#39;#log-rows details[open]&#39;)]")
  })
})
