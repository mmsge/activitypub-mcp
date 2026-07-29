import { describe, it, expect, vi } from 'vitest'

// The real keypair lives in the database and getPublicKeyPem() throws until
// ensureKeys() has run, which needs a live DB. The actor document just embeds
// whatever string it returns.
vi.mock('../crypto/keys.js', () => ({
  getPublicKeyPem: () => '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n',
}))

const { buildActorDocument, getProfilePageUrl } = await import('./actor.js')

describe('buildActorDocument', () => {
  const doc = buildActorDocument() as Record<string, any>

  it('is a Service, so clients render it as a bot rather than a person', () => {
    expect(doc.type).toBe('Service')
  })

  it('advertises the readable profile page as its url', () => {
    expect(doc.url).toBe(getProfilePageUrl())
    expect(doc.url).toBe('https://test.local/@bot')
    // The url must not be the actor id: that would send browsers to the JSON.
    expect(doc.url).not.toBe(doc.id)
  })

  it('signals that it is not openly followable', () => {
    expect(doc.manuallyApprovesFollowers).toBe(true)
  })

  it('is discoverable, and declares the namespaces for the fields it uses', () => {
    expect(doc.discoverable).toBe(true)
    const ctx = doc['@context'].find((e: unknown) => typeof e === 'object')
    expect(ctx).toMatchObject({
      PropertyValue: 'schema:PropertyValue',
      value: 'schema:value',
      discoverable: 'toot:discoverable',
    })
  })

  it('publishes a truthful join date', () => {
    expect(doc.published).toBe('2026-05-02T00:00:00.000Z')
  })

  it('states in the bio what it archives and what it keeps about others', () => {
    expect(doc.summary).toContain('Personleg ActivityPub-bot')
    // "arkiverer", not "lagrar": inbound requests hit a short-lived debug log, so the
    // stronger verb would overstate it.
    expect(doc.summary).toContain('arkiverer ingenting om deg')
    expect(doc.summary).not.toContain('lagrar ingenting')
    expect(doc.summary).toContain('vert avviste automatisk')
  })

  it('carries at most four metadata fields, the most Mastodon will show', () => {
    expect(doc.attachment.length).toBeLessThanOrEqual(4)
    expect(doc.attachment.every((f: any) => f.type === 'PropertyValue')).toBe(true)
  })

  it('leads the metadata with the privacy claim and a way to verify it', () => {
    const fields = Object.fromEntries(
      doc.attachment.map((f: any) => [f.name, f.value]),
    )
    // The window has to match the retention that is actually enforced (default 30).
    expect(fields['Lagrar om deg']).toBe('Ingenting — berre ein teknisk logg i 30 dagar')
    expect(fields['Følgjer']).toContain('/actor/following')
  })

  it('points icon and header at fingerprinted PNGs', () => {
    for (const img of [doc.icon, doc.image]) {
      expect(img.type).toBe('Image')
      expect(img.mediaType).toBe('image/png')
      expect(img.url).toMatch(/^https:\/\/test\.local\/assets\/\w+\.png\?v=[0-9a-f]{12}$/)
    }
    expect(doc.icon.url).not.toBe(doc.image.url)
  })

  it('keeps the federation plumbing intact', () => {
    expect(doc.id).toBe('https://test.local/actor')
    expect(doc.inbox).toBe('https://test.local/actor/inbox')
    expect(doc.outbox).toBe('https://test.local/actor/outbox')
    expect(doc.followers).toBe('https://test.local/actor/followers')
    expect(doc.following).toBe('https://test.local/actor/following')
    expect(doc.endpoints.sharedInbox).toBe('https://test.local/inbox')
    expect(doc.publicKey.id).toBe('https://test.local/actor#main-key')
    expect(doc.publicKey.publicKeyPem).toContain('BEGIN PUBLIC KEY')
    expect(doc['@context']).toContain('https://www.w3.org/ns/activitystreams')
    expect(doc['@context']).toContain('https://w3id.org/security/v1')
  })

  it('omits owner attribution when OWNER_ACTOR is unset', () => {
    // OWNER_ACTOR defaults to '' in the test env — the profile must still be valid,
    // just without the "who runs this" link.
    expect(doc.attributedTo).toBeUndefined()
    expect(doc.summary).toContain('Markus')
  })
})
