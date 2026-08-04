import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// config is read at call time, so the domain can be swapped per test.
vi.mock('../config.js', () => ({ config: { STREAM_DOMAIN: 'meg.msge.no' } }))

const { isStreamHost, streamEnabled, streamOrigin } = await import('./host.js')
const { config } = await import('../config.js')

const withDomain = (domain: string, fn: () => void) => {
  const previous = config.STREAM_DOMAIN
  ;(config as { STREAM_DOMAIN: string }).STREAM_DOMAIN = domain
  try { fn() } finally { (config as { STREAM_DOMAIN: string }).STREAM_DOMAIN = previous }
}

beforeEach(() => { (config as { STREAM_DOMAIN: string }).STREAM_DOMAIN = 'meg.msge.no' })
afterEach(() => { (config as { STREAM_DOMAIN: string }).STREAM_DOMAIN = 'meg.msge.no' })

describe('isStreamHost', () => {
  it('matches the configured domain', () => {
    expect(isStreamHost('meg.msge.no')).toBe(true)
  })

  it('ignores a port and case', () => {
    expect(isStreamHost('MEG.MSGE.NO:443')).toBe(true)
    expect(isStreamHost('meg.msge.no:3000')).toBe(true)
    expect(isStreamHost('  Meg.Msge.No  ')).toBe(true)
  })

  it('does not match the bot host — the two sites never share a router', () => {
    expect(isStreamHost('bot.skvip.lol')).toBe(false)
  })

  it('does not match a subdomain or a lookalike', () => {
    // Substring matching here would hand the public site to anyone who can point
    // a hostname at the box.
    for (const host of [
      'evil.meg.msge.no',
      'meg.msge.no.evil.example',
      'notmeg.msge.no',
      'meg.msge.non',
      'msge.no',
    ]) {
      expect(isStreamHost(host)).toBe(false)
    }
  })

  it('does not match the healthcheck, which must reach the bot app', () => {
    // The container probe calls http://127.0.0.1:3000/healthz. If an unknown Host
    // defaulted to the stream, the probe would be answered by the wrong app.
    expect(isStreamHost('127.0.0.1:3000')).toBe(false)
    expect(isStreamHost('localhost:3000')).toBe(false)
  })

  it('treats a missing Host as not the stream', () => {
    expect(isStreamHost(null)).toBe(false)
    expect(isStreamHost(undefined)).toBe(false)
    expect(isStreamHost('')).toBe(false)
  })

  it('is off entirely when STREAM_DOMAIN is unset', () => {
    // The off-switch: the feature ships and deploys before anything is visible.
    withDomain('', () => {
      expect(isStreamHost('meg.msge.no')).toBe(false)
      expect(isStreamHost('anything')).toBe(false)
      expect(streamEnabled()).toBe(false)
    })
  })

  it('reports enabled and an origin when configured', () => {
    expect(streamEnabled()).toBe(true)
    expect(streamOrigin()).toBe('https://meg.msge.no')
  })
})
