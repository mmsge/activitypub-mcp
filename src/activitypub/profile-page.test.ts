import { describe, it, expect } from 'vitest'
import { renderProfilePage } from './profile-page.js'

describe('renderProfilePage', () => {
  const html = renderProfilePage()

  it('renders a complete HTML document in nynorsk', () => {
    expect(html.trimStart()).toMatch(/^<!doctype html>/)
    expect(html).toContain('<html lang="nn">')
    expect(html).toContain('</html>')
  })

  it('says whose it is and that it is a bot', () => {
    expect(html).toContain('personleg ActivityPub-bot')
    expect(html).toContain('class="badge">bot<')
    expect(html).toContain('@bot@test.local')
  })

  it('makes the three claims a stranger needs, not just the friendly one', () => {
    expect(html).toContain('Han arkiverer ingenting om deg')
    expect(html).toContain('Han tek ikkje imot følgjarar')
    expect(html).toContain('Ingenting vert delt vidare')
  })

  it('links every claim to something checkable', () => {
    expect(html).toContain('https://test.local/actor/following')
    expect(html).toContain('https://test.local/actor')
    expect(html).toContain('https://test.local/nodeinfo/2.0')
  })

  it('states the log retention window that is actually configured', () => {
    // Default is 30 days; the sentence must not promise a window nothing enforces.
    expect(html).toContain('logg eldre enn')
    expect(html).toContain('30 dagar vert sletta automatisk')
  })

  it('links the actor document so the page URL resolves to the account', () => {
    expect(html).toContain(
      '<link rel="alternate" type="application/activity+json" href="https://test.local/actor">',
    )
    expect(html).toContain('<link rel="canonical" href="https://test.local/@bot">')
  })

  it('is self-contained — no external stylesheet, font or script', () => {
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<link[^>]+stylesheet/i)
    expect(html).not.toMatch(/https?:\/\/(?!test\.local)/)
  })

  it('serves the fingerprinted avatar as both image and favicon', () => {
    const matches = html.match(/\/assets\/avatar\.png\?v=[0-9a-f]{12}/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  it('says what it posts, rather than claiming an outbox that is no longer empty', () => {
    // The page used to promise "Postar ingenting. Utboksen er tom." while the outbox
    // republished the archive. It now posts status notes, and says so.
    expect(html).toContain('Postar berre om seg sjølv')
    expect(html).not.toContain('Utboksen er tom')
    expect(html).toContain('https://test.local/actor/outbox')
  })

  it('leaves out the notes section entirely when nothing is published', () => {
    // An empty heading reads like something broke.
    expect(html).not.toContain('Siste innlegg')
  })
})

describe('renderProfilePage with notes', () => {
  const note = {
    id: '11111111-2222-4333-8444-555555555555',
    kind: 'intro',
    content: '<p>Dette er ein personleg ActivityPub-bot.</p>',
    contentText: 'Dette er ein personleg ActivityPub-bot.',
    digest: 'deadbeefdeadbeef',
    pinned: true,
    publishedAt: new Date('2026-05-02T10:00:00.000Z'),
    updatedAt: new Date('2026-05-02T10:00:00.000Z'),
  }

  it('lists them, marks the pinned one, and links each permalink', () => {
    const html = renderProfilePage([note])
    expect(html).toContain('Siste innlegg')
    expect(html).toContain('<p>Dette er ein personleg ActivityPub-bot.</p>')
    expect(html).toContain('class="pin">Festa<')
    expect(html).toContain(`href="https://test.local/notes/${note.id}"`)
    expect(html).toContain('datetime="2026-05-02T10:00:00.000Z"')
  })

  it('flags an edited note, and only an edited one', () => {
    expect(renderProfilePage([note])).not.toContain('Endra')
    const edited = { ...note, updatedAt: new Date('2026-06-01T10:00:00.000Z') }
    expect(renderProfilePage([edited])).toContain('Endra')
  })
})
