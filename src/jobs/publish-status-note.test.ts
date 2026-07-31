import { describe, it, expect, vi } from 'vitest'

vi.mock('../crypto/keys.js', () => ({
  getPublicKeyPem: () => '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n',
}))

// Nothing in this suite touches storage; a getDb that throws proves it.
const getDb = vi.fn(() => {
  throw new Error('composing a note must not need a database')
})
vi.mock('../db/client.js', () => ({ getDb }))

const {
  composeIntro, composeStatus, digestOf, shouldPublishStatus,
} = await import('./publish-status-note.js')

describe('composeIntro', () => {
  const note = composeIntro()

  it('repeats the privacy claims, and links the proof', () => {
    expect(note.contentText).toContain('personleg ActivityPub-bot')
    expect(note.contentText).toContain('arkiverer ingenting om deg')
    expect(note.contentText).toContain('tek ikkje imot følgjarar')
    expect(note.contentText).toContain('https://test.local/actor/following')
    expect(note.contentText).toContain('https://test.local/@bot')
  })

  it('names the owner without mentioning them', () => {
    // A bare @user@host renders as plain text without a Mention tag, and tagging the
    // owner would notify him every time the intro is reworded.
    expect(note.content).not.toContain('type="Mention"')
    expect(note.contentText).toContain('Markus eig og driftar han')
  })

  it('renders as paragraphs with the URLs linked', () => {
    expect(note.content.startsWith('<p>')).toBe(true)
    expect(note.content).toContain(
      '<a href="https://test.local/actor/following">https://test.local/actor/following</a>',
    )
  })

  it('is stable, so an unchanged intro never looks edited', () => {
    expect(digestOf(composeIntro().contentText)).toBe(digestOf(note.contentText))
  })
})

describe('composeStatus', () => {
  const stats = {
    followed: 5,
    archived: 12345,
    oldest: new Date('2019-03-03T00:00:00.000Z'),
  }

  it('reports the archive in aggregate and says whose it is not', () => {
    const note = composeStatus(stats)
    expect(note.contentText).toContain('5 kontoar')
    expect(note.contentText).toContain('12')  // thousands-separated, locale-dependent
    expect(note.contentText).toContain('2019')
    expect(note.contentText).toContain('Ingenting av dette er om deg')
    expect(note.contentText).toContain('https://test.local/actor/following')
  })

  it('does not say "1 kontoar"', () => {
    const note = composeStatus({ ...stats, followed: 1 })
    expect(note.contentText).toContain('éin konto')
    expect(note.contentText).not.toContain('1 kontoar')
  })

  it('omits the oldest-post sentence when the archive is empty', () => {
    const note = composeStatus({ followed: 0, archived: 0, oldest: null })
    expect(note.contentText).not.toContain('Det eldste')
  })

  it('changes its digest when the numbers move, and not otherwise', () => {
    const before = digestOf(composeStatus(stats).contentText)
    expect(digestOf(composeStatus({ ...stats }).contentText)).toBe(before)
    expect(digestOf(composeStatus({ ...stats, archived: 12346 }).contentText)).not.toBe(before)
  })
})

describe('shouldPublishStatus', () => {
  const now = new Date('2026-07-31T12:00:00.000Z')
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000)

  it('publishes the first status note', () => {
    expect(shouldPublishStatus({
      intervalHours: 168, latest: null, digest: 'a', now,
    })).toBe(true)
  })

  it('is disabled by an interval of 0, even with nothing published yet', () => {
    expect(shouldPublishStatus({
      intervalHours: 0, latest: null, digest: 'a', now,
    })).toBe(false)
  })

  it('never reposts an identical status, however long it has been', () => {
    // Weekly repetition of numbers that have not moved is noise, not a status.
    expect(shouldPublishStatus({
      intervalHours: 168,
      latest: { digest: 'a', publishedAt: hoursAgo(10_000) },
      digest: 'a',
      now,
    })).toBe(false)
  })

  it('waits out the interval even when the numbers have changed', () => {
    expect(shouldPublishStatus({
      intervalHours: 168,
      latest: { digest: 'a', publishedAt: hoursAgo(167) },
      digest: 'b',
      now,
    })).toBe(false)
  })

  it('publishes once the interval has elapsed and something has changed', () => {
    expect(shouldPublishStatus({
      intervalHours: 168,
      latest: { digest: 'a', publishedAt: hoursAgo(168) },
      digest: 'b',
      now,
    })).toBe(true)
  })
})
