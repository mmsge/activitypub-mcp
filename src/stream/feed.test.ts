import { describe, it, expect, vi } from 'vitest'

vi.mock('../config.js', () => ({
  config: { STREAM_DOMAIN: 'meg.msge.no', APP_DOMAIN: 'bot.skvip.lol', STREAM_SOURCES: '' },
}))

const { renderAtom, entryId, entryTitle } = await import('./feed.js')
const at = (s: string) => new Date(s)

const post = {
  refId: 'post:1', eventAt: at('2026-08-03T10:00:00Z'), archivedAt: at('2026-08-03T10:01:00Z'),
  source: 'mastodon' as const, originUrl: 'https://skvip.lol/@markus/1', kind: 'post' as const,
  html: '<p>Hei</p>', contentWarning: null, sensitive: false, language: 'nn',
  attachments: [], hashtags: [], emojis: [], embedUrl: null, thread: [], trip: null,
}

// A film watched in 2016 but marked today: the case that motivates the whole
// published/updated split.
const backdated = {
  refId: 'mark:9', eventAt: at('2016-04-02T00:00:00Z'), archivedAt: at('2026-08-04T09:00:00Z'),
  source: 'neodb' as const, originUrl: 'https://minreol.dk/m/9', kind: 'screen' as const,
  title: 'Ein gammal film', coverUrl: null, category: 'movie', year: 2016,
  comment: 'Sett på kino.', rating: 5, director: null, genre: [], itemUrl: null,
}

const opts = {
  title: 'Meg — straumen',
  alternate: 'https://meg.msge.no/',
  self: 'https://meg.msge.no/feed.atom',
}

describe('renderAtom — the published/updated split', () => {
  it('publishes at the event date and updates at the archive date', () => {
    const xml = renderAtom([backdated], opts)
    expect(xml).toContain('<published>2016-04-02T00:00:00.000Z</published>')
    expect(xml).toContain('<updated>2026-08-04T09:00:00.000Z</updated>')
  })

  it('orders entries by when they entered the archive, not by when they happened', () => {
    // The website orders the other way. If the feed did too, a backdated mark
    // would arrive already buried nine years deep and no subscriber would see it.
    const xml = renderAtom([post, backdated], opts)
    expect(xml.indexOf('mark:9')).toBeLessThan(xml.indexOf('post:1'))
  })

  it('takes the feed-level updated from the newest archive date', () => {
    const xml = renderAtom([post, backdated], opts)
    const feedUpdated = /<updated>([^<]+)<\/updated>/.exec(xml)?.[1]
    expect(feedUpdated).toBe('2026-08-04T09:00:00.000Z')
  })
})

describe('renderAtom — entry identity and links', () => {
  it('gives every entry a stable tag: id, including ones with no URL', () => {
    expect(entryId(backdated)).toBe('tag:meg.msge.no,2016:mark:9')
    const digest = {
      ...post, refId: 'scrobbleday:2026-08-02', kind: 'scrobble_day' as const,
      day: '2026-08-02', playCount: 3, topArtists: [], tracks: [], originUrl: null,
    }
    expect(entryId(digest as never)).toMatch(/^tag:meg\.msge\.no,\d{4}:scrobbleday:/)
  })

  const entryBlock = (xml: string) => /<entry>[\s\S]*<\/entry>/.exec(xml)?.[0] ?? ''

  it('points each entry at its origin, never at a page here', () => {
    const xml = renderAtom([post], opts)
    expect(xml).toContain('href="https://skvip.lol/@markus/1"')
    // The tag: id legitimately names our domain; no *link* inside an entry may.
    expect(entryBlock(xml)).not.toMatch(/href="[^"]*meg\.msge\.no/)
  })

  it('omits the alternate link when there is no origin', () => {
    const xml = renderAtom([{ ...post, originUrl: null }], opts)
    expect(entryBlock(xml)).not.toContain('rel="alternate"')
  })

  it('gives every entry ids that are unique', () => {
    const xml = renderAtom([post, backdated], opts)
    const ids = [...xml.matchAll(/<id>([^<]+)<\/id>/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('renderAtom — escaping and content', () => {
  it('escapes markup in a title', () => {
    const xml = renderAtom([{ ...post, html: '<p>a &amp; b <b>c</b> </p>' }], opts)
    expect(xml).not.toMatch(/<title>[^<]*<b>/)
    expect(xml).toContain('&amp;')
  })

  it('escapes a title that tries to close the feed', () => {
    const xml = renderAtom([{ ...post, html: '<p>]]&gt;&lt;/feed&gt;</p>' }], opts)
    expect(xml).not.toContain('</feed><')
    expect(xml.match(/<\/feed>/g)?.length).toBe(1)
  })

  it('withholds the body of a post with a content warning', () => {
    // A feed cannot collapse anything, so the warning is all a subscriber gets.
    // This must hold for the title as well as the content: deriving the title from
    // the post text would put the withheld body back in the one field every reader
    // displays.
    const cw = { ...post, sensitive: true, contentWarning: 'Politikk', html: '<p>HEMMELEG</p>' }
    const xml = renderAtom([cw], opts)
    expect(xml).not.toContain('HEMMELEG')
    expect(xml).toContain('Politikk')
  })

  it('still titles a warned post when the warning text is empty', () => {
    const cw = { ...post, sensitive: true, contentWarning: null, html: '<p>HEMMELEG</p>' }
    const xml = renderAtom([cw], opts)
    expect(xml).not.toContain('HEMMELEG')
    expect(xml).toContain('Innhaldsvarsel')
  })

  /**
   * A subscriber's reader resolves a relative src against its own page, so the feed
   * points at the origin CDN where the site points at its own proxy. The title is
   * left alone: it is derived by stripping tags, and an emoji stripped out of a
   * one-word post would leave the entry with no title at all.
   */
  it('draws custom emoji with their origin URLs, not this site\'s proxy paths', () => {
    const emoji = { ...post, html: '<p>Vy :vy: her</p>', emojis: [{ shortcode: 'vy', url: 'https://cdn.masto.host/vy.png' }] }
    const xml = renderAtom([emoji], opts)
    expect(xml).toContain('https://cdn.masto.host/vy.png')
    expect(xml).not.toContain('/bilete/')
    expect(xml).toContain('&lt;img class=&quot;emoji&quot;')
  })

  it('keeps the shortcode out of a warned post\'s feed entry entirely', () => {
    const cw = {
      ...post, sensitive: true, contentWarning: 'Politikk', html: '<p>:vy:</p>',
      emojis: [{ shortcode: 'vy', url: 'https://cdn.masto.host/vy.png' }],
    }
    expect(renderAtom([cw], opts)).not.toContain('cdn.masto.host')
  })

  it('caps the feed at 50 entries', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      ...post, refId: `post:${i}`, archivedAt: at(`2026-08-03T10:${String(i % 60).padStart(2, '0')}:00Z`),
    }))
    expect(renderAtom(many, opts).match(/<entry>/g)?.length).toBe(50)
  })

  it('is well-formed enough to declare itself Atom in Nynorsk', () => {
    const xml = renderAtom([post], opts)
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true)
    expect(xml).toContain('xmlns="http://www.w3.org/2005/Atom"')
    expect(xml).toContain('xml:lang="nn"')
    expect(xml).toContain('rel="self"')
  })
})

describe('entryTitle', () => {
  it('describes each kind in Nynorsk', () => {
    expect(entryTitle(backdated)).toBe('Såg Ein gammal film')
    expect(entryTitle({ ...backdated, kind: 'book_finished', title: 'Ei bok' } as never))
      .toBe('Las ut Ei bok')
    expect(entryTitle({ ...backdated, kind: 'book_comment', title: 'Ei bok' } as never))
      .toBe('Om Ei bok')
  })

  it('never falls through to the post branch for a reading event', () => {
    // The default arm reads entry.html, which a reading event may leave null — an
    // unhandled book kind takes the whole feed down rather than titling one entry
    // oddly. This is the assertion that catches a sixth kind added without a case.
    for (const kind of ['book_started', 'book_finished', 'book_comment', 'book_review', 'book_quote']) {
      const entry = { ...backdated, kind, title: null, html: null, quote: null }
      expect(() => entryTitle(entry as never), kind).not.toThrow()
      expect(entryTitle(entry as never), kind).toContain('ei bok')
    }
  })

  it('falls back to the post text, trimmed of markup', () => {
    expect(entryTitle(post)).toBe('Hei')
  })

  it('truncates a long post rather than putting a paragraph in the title', () => {
    const long = { ...post, html: `<p>${'ord '.repeat(80)}</p>` }
    expect(entryTitle(long).length).toBeLessThanOrEqual(90)
    expect(entryTitle(long).endsWith('…')).toBe(true)
  })
})
