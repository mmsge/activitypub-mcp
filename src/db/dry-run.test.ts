import { describe, it, expect } from 'vitest'
import { dryRunScope, inDryRun } from './dry-run.js'
import { postWebhook } from '../lib/webhook-post.js'

describe('the dry-run scope', () => {
  it('is off outside a preview', () => {
    expect(inDryRun()).toBe(false)
  })

  it('is on for everything awaited inside one, and only there', async () => {
    await dryRunScope.run({}, async () => {
      await Promise.resolve()
      expect(inDryRun()).toBe(true)
    })
    expect(inDryRun()).toBe(false)
  })

  it('sends no webhook from inside a preview: its writes never happened', async () => {
    let called = false
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => { called = true; return new Response('ok') }) as typeof fetch
    try {
      const sent = await dryRunScope.run({}, () =>
        postWebhook({ url: 'http://127.0.0.1:9/x', headerName: 'X-Secret', secret: 's', label: 'test' } as never))
      expect(sent).toBe(false)
      expect(called).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
