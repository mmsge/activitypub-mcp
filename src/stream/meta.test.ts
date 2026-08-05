import { describe, it, expect, vi } from 'vitest'

vi.mock('../config.js', () => ({
  config: {
    STREAM_DOMAIN: 'meg.msge.no',
    APP_DOMAIN: 'bot.skvip.lol',
    APP_USERNAME: 'bot',
    STREAM_SOURCES: '@markus@skvip.lol|mastodon,@mvrkws@bookwyrm.social|bookwyrm',
  },
}))

const { renderHead, renderRobots, renderSitemap } = await import('./meta.js')

const entry = {
  refId: 'post:1', eventAt: new Date('2026-08-03T10:00:00Z'),
  archivedAt: new Date('2026-08-03T10:01:00Z'), source: 'mastodon' as const,
  originUrl: 'https://skvip.lol/@markus/1', kind: 'post' as const,
  html: '<p>Hei</p>', contentWarning: null, sensitive: false, language: 'nn',
  attachments: [], hashtags: [], embedUrl: null, thread: [],
}

const base = {
  title: 'Meg', description: 'Alt Markus legg ut.',
  canonical: 'https://meg.msge.no/', entries: [entry],
}

describe('renderHead', () => {
  it('emits Open Graph and Twitter tags', () => {
    const head = renderHead(base)
    expect(head).toContain('property="og:title" content="Meg"')
    expect(head).toContain('content="nn_NO"')
    expect(head).toContain('name="twitter:card" content="summary_large_image"')
  })

  it('emits JSON-LD that parses', () => {
    const head = renderHead(base)
    const blocks = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    expect(blocks.length).toBe(2)
    for (const [, json] of blocks) {
      expect(() => JSON.parse(json.replace(/\\u003c/g, '<'))).not.toThrow()
    }
  })

  it('escapes < inside JSON-LD so it cannot close its own script element', () => {
    // `</script` is legal inside a JSON string and illegal inside HTML. The values
    // that reach JSON-LD come from the database — an origin URL here — so
    // unescaped, one row could end the block and drop the rest into the document.
    const head = renderHead({
      ...base,
      entries: [{ ...entry, originUrl: 'https://x.example/</script><script>alert(1)</script>' }],
    })
    expect(head).not.toContain('</script><script>alert(1)')
    expect(head).toContain('\\u003c')
  })

  it('escapes markup in the OG description', () => {
    const head = renderHead({ ...base, description: 'a "b" <c>' })
    expect(head).not.toMatch(/content="a "b"/)
    expect(head).toContain('&quot;')
  })

  it('links the accounts as the same person', () => {
    const head = renderHead(base)
    expect(head).toContain('https://skvip.lol/@markus')
    expect(head).toContain('https://bookwyrm.social/@mvrkws')
  })

  it('dates the page from the newest entry, not from now', () => {
    expect(renderHead(base)).toContain('content="2026-08-03T10:00:00.000Z"')
  })

  it('points the item list at origins, never at pages here', () => {
    const head = renderHead(base)
    expect(head).toContain('https://skvip.lol/@markus/1')
  })

  it('copes with an empty stream', () => {
    const head = renderHead({ ...base, entries: [] })
    expect(head).toContain('og:title')
    expect(head).not.toContain('article:modified_time')
  })
})

describe('renderRobots', () => {
  it('allows the site and names the sitemap', () => {
    const txt = renderRobots()
    expect(txt).toContain('Allow: /')
    expect(txt).toContain('Sitemap: https://meg.msge.no/sitemap.xml')
  })

  it('keeps crawlers out of the cursor space', () => {
    // Unbounded and self-similar: a crawler walking it would page the whole
    // archive one request at a time and mint a cache entry at every step.
    expect(renderRobots()).toContain('Disallow: /*?etter=')
  })
})

describe('renderSitemap', () => {
  it('is well-formed XML with absolute locations', () => {
    const xml = renderSitemap([
      { loc: 'https://meg.msge.no/' },
      { loc: 'https://meg.msge.no/arkiv/2026/08', lastmod: '2026-08-31' },
    ])
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"')
    expect(xml.match(/<url>/g)?.length).toBe(2)
    expect(xml).toContain('<lastmod>2026-08-31</lastmod>')
  })

  it('escapes a location', () => {
    expect(renderSitemap([{ loc: 'https://meg.msge.no/emne/a&b' }])).toContain('a&amp;b')
  })

  it('omits lastmod when unknown, rather than inventing one', () => {
    expect(renderSitemap([{ loc: 'https://meg.msge.no/' }])).not.toContain('<lastmod>')
  })
})
