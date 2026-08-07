import { describe, it, expect, vi } from 'vitest'

vi.mock('../config.js', () => ({
  config: { STREAM_DOMAIN: 'meg.msge.no', APP_DOMAIN: 'bot.skvip.lol', STREAM_SOURCES: '', STREAM_INCLUDE_UNLISTED: false },
}))

const { toAttachments, parseIsoDuration, foldThread } = await import('./query.js')

const video = (url: string, extra: Record<string, unknown> = {}) => ({
  type: 'Document', mediaType: 'video/mp4', url, ...extra,
})

describe('parseIsoDuration', () => {
  it('reads the shapes servers actually send', () => {
    expect(parseIsoDuration('PT16S')).toBe(16)
    expect(parseIsoDuration('PT1M0S')).toBe(60)
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723)
    expect(parseIsoDuration('PT2M')).toBe(120)
  })

  it('rounds fractional seconds rather than carrying them into the display', () => {
    expect(parseIsoDuration('PT4.2S')).toBe(4)
    expect(parseIsoDuration('PT4.6S')).toBe(5)
  })

  it('returns null for anything it cannot read', () => {
    // `P1M` is the one genuinely ambiguous form — a month here, a minute after a T.
    // Guessing is worse than showing no duration at all.
    for (const bad of ['P1M', 'PT', '16', 'sixteen seconds', '', 'PT0S', null, undefined, 42]) {
      expect(parseIsoDuration(bad)).toBeNull()
    }
  })
})

describe('toAttachments', () => {
  it('takes the poster from `icon`', () => {
    const [a] = toAttachments([
      video('https://rullen.no/api/media/clips/u/1.mp4', {
        duration: 'PT16S',
        name: 'Bryggen i sol',
        icon: { type: 'Image', mediaType: 'image/jpeg', url: 'https://rullen.no/api/media/thumbnails/u/9f.jpg' },
      }),
    ])
    expect(a).toMatchObject({
      url: 'https://rullen.no/api/media/clips/u/1.mp4',
      mediaType: 'video/mp4',
      alt: 'Bryggen i sol',
      posterUrl: 'https://rullen.no/api/media/thumbnails/u/9f.jpg',
      durationSeconds: 16,
    })
  })

  it('accepts the other spellings of a poster, and the shapes peers wrap it in', () => {
    const bare = toAttachments([video('https://x.test/1.mp4', { icon: 'https://x.test/p.jpg' })])
    const nested = toAttachments([video('https://x.test/1.mp4', { preview: { url: { href: 'https://x.test/p.jpg' } } })])
    const listed = toAttachments([video('https://x.test/1.mp4', { image: [{ url: 'https://x.test/p.jpg' }] })])
    for (const [a] of [bare, nested, listed]) expect(a.posterUrl).toBe('https://x.test/p.jpg')
  })

  it('leaves posterUrl null rather than falling back to the video file', () => {
    // The whole bug: a video URL in an <img src> renders a broken-image icon, and a
    // browser has nothing to fall back on. No poster must stay no poster.
    const [a] = toAttachments([video('https://rullen.no/api/media/clips/u/1.webm')])
    expect(a.posterUrl).toBeNull()
    expect(a.durationSeconds).toBeNull()
  })

  it('ignores a poster that is not an http(s) URL', () => {
    const [a] = toAttachments([video('https://x.test/1.mp4', { icon: { url: 'javascript:alert(1)' } })])
    expect(a.posterUrl).toBeNull()
  })
})

describe('foldThread', () => {
  const part = (content: string | null, urls: string[]) => ({
    content, url: 'https://rullen.no/@markus/s/c1', attachments: urls.map((u) => video(u)),
  })

  it('drops clip replies that only repeat what the root already shows', () => {
    const root = toAttachments([video('https://x.test/1.mp4'), video('https://x.test/2.mp4')])
    const folded = foldThread([part(null, ['https://x.test/1.mp4']), part('', ['https://x.test/2.mp4'])], root)
    expect(folded).toEqual([])
  })

  it('keeps a reply that says something, but not its duplicate media', () => {
    const root = toAttachments([video('https://x.test/1.mp4')])
    const folded = foldThread([part('<p>Her kjem toget</p>', ['https://x.test/1.mp4'])], root)
    expect(folded).toHaveLength(1)
    expect(folded[0].html).toContain('Her kjem toget')
    expect(folded[0].attachments).toEqual([])
  })

  it('keeps media the root does not have', () => {
    const root = toAttachments([video('https://x.test/1.mp4')])
    const folded = foldThread([part(null, ['https://x.test/9.mp4'])], root)
    expect(folded).toHaveLength(1)
    expect(folded[0].attachments.map((a) => a.url)).toEqual(['https://x.test/9.mp4'])
  })

  // A continuation is its own Note with its own `tag` array, so it carries its own
  // emoji — a shortcode first used halfway down a thread has never been declared on
  // the root, and reusing the root's map would silently leave it as text.
  it('reads each part\'s own custom emoji', () => {
    const folded = foldThread([{
      ...part('<p>og :vy: her</p>', []),
      tags: [{ type: 'Emoji', name: ':vy:', icon: { url: 'https://cdn.masto.host/vy.png' } }],
    }], [])
    expect(folded[0].emojis).toEqual([{ shortcode: 'vy', url: 'https://cdn.masto.host/vy.png' }])
  })

  it('leaves a part with no tags with no emoji', () => {
    expect(foldThread([part('<p>berre tekst</p>', [])], [])[0].emojis).toEqual([])
  })

  it('shows a repeated attachment once, not once per part', () => {
    const folded = foldThread([part(null, ['https://x.test/9.mp4']), part(null, ['https://x.test/9.mp4'])], [])
    expect(folded).toHaveLength(1)
  })

  it('leaves an ordinary thread alone', () => {
    const folded = foldThread([part('<p>Ein</p>', []), part('<p>To</p>', ['https://x.test/7.mp4'])], [])
    expect(folded.map((p) => p.html)).toEqual(['<p>Ein</p>', '<p>To</p>'])
    expect(folded[1].attachments).toHaveLength(1)
  })
})
