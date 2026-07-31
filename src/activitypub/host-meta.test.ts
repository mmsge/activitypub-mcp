import { describe, it, expect } from 'vitest'
import { hostMetaRouter } from './host-meta.js'

const TEMPLATE = 'https://test.local/.well-known/webfinger?resource={uri}'

describe('host-meta', () => {
  // Friendica, GNU Social and several WebFinger clients fetch host-meta first to learn
  // where the WebFinger endpoint lives, and give up on the account when it 404s — even
  // though ours sits exactly where they would have guessed.
  it('points the XRD form at our webfinger endpoint', async () => {
    const res = await hostMetaRouter.request('/host-meta')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/xrd+xml')

    const xml = await res.text()
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0"')
    expect(xml).toContain(`rel="lrdd"`)
    // {uri} is a placeholder the caller substitutes, so it must survive un-encoded.
    expect(xml).toContain(`template="${TEMPLATE}"`)
  })

  it('serves the same thing as JRD for callers that ask for JSON', async () => {
    const res = await hostMetaRouter.request('/host-meta.json')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/jrd+json')
    expect(await res.json()).toEqual({
      links: [{ rel: 'lrdd', type: 'application/jrd+json', template: TEMPLATE }],
    })
  })

  it('is readable cross-origin', async () => {
    for (const path of ['/host-meta', '/host-meta.json']) {
      const res = await hostMetaRouter.request(path)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
    }
  })
})
