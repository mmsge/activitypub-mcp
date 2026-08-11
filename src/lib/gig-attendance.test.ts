import { describe, it, expect } from 'vitest'
import {
  collectConcertUrls,
  isGigAttendance,
  normalizeSamklangUrl,
  parseGigAttendance,
  resolveGigStatus,
  splitNoteBlocks,
  SAMKLANG_NS,
} from './gig-attendance.js'

const ACTOR = 'https://samklang.msge.no/brukar/markus'

// The live shape, captured from https://samklang.msge.no/brukar/markus/utboks on
// 2026-08-11 and reproduced byte-for-byte. This is what every one of the 29 attendances
// delivered before Gigowl's ADR 0026 looks like: no status tag, no samklang:attendanceStatus,
// so the RSVP state is recoverable only from the generated opening line.
const DELIVERED_NOTE = {
  id: 'https://samklang.msge.no/oppmote/01KZRJ3RV4PVMV17KJ7P567V1C',
  type: 'Note',
  attributedTo: 'https://samklang.msge.no/brukar/markus',
  cc: 'https://samklang.msge.no/brukar/markus/fylgjarar',
  content:
    '<p>Eg var på Queen + Adam Lambert på Unity Arena i Fornebu, 2022-07-21.</p><p><a href="https://samklang.msge.no/konsert/01KZRJ3NKDAEF25EWQKCEAP8D2">https://samklang.msge.no/konsert/01KZRJ3NKDAEF25EWQKCEAP8D2</a></p><p><a href="https://samklang.msge.no/emneord/konsert" class="hashtag">#konsert</a> <a href="https://samklang.msge.no/emneord/QueenAdamLambert" class="hashtag">#QueenAdamLambert</a></p>',
  published: '2026-08-11T14:02:37.795Z',
  tag: [
    {
      type: 'Link',
      href: 'https://samklang.msge.no/konsert/01KZRJ3NKDAEF25EWQKCEAP8D2',
      mediaType: 'application/activity+json',
      name: 'Konsert',
    },
    { type: 'Hashtag', href: 'https://samklang.msge.no/emneord/konsert', name: '#konsert' },
    {
      type: 'Hashtag',
      href: 'https://samklang.msge.no/emneord/QueenAdamLambert',
      name: '#QueenAdamLambert',
    },
  ],
  to: 'as:Public',
  url: 'https://samklang.msge.no/oppmote/01KZRJ3RV4PVMV17KJ7P567V1C',
} as const

// The shape Gigowl delivers after ADR 0026: the RSVP state as its own Link tag, so no
// second request is needed. Also the shape with a write-up and photos.
const NOTE_WITH_STATUS_TAG = {
  id: 'https://samklang.msge.no/oppmote/ABC',
  type: 'Note',
  content:
    '<p>Eg var på Motorpsycho på Rockefeller i Oslo, 2026-03-14.</p><p>Beste konserten i år.<br />Dei spelte Vortex Surfer til slutt.</p><p><a href="https://samklang.msge.no/konsert/KONS">https://samklang.msge.no/konsert/KONS</a></p><p><a href="https://samklang.msge.no/emneord/konsert" class="hashtag">#konsert</a></p>',
  summary: 'Høg lyd',
  published: '2026-03-15T10:00:00.000Z',
  tag: [
    {
      type: 'Link',
      href: 'https://samklang.msge.no/konsert/KONS',
      mediaType: 'application/activity+json',
      name: 'Konsert',
    },
    { type: 'Link', href: `${SAMKLANG_NS}attended`, name: 'Oppmøte' },
    { type: 'Hashtag', href: 'https://samklang.msge.no/emneord/konsert', name: '#konsert' },
  ],
  attachment: [
    {
      type: 'Image',
      url: 'https://samklang.msge.no/media/2026/03/ABC-1600.webp',
      mediaType: 'image/webp',
      name: 'Scena sett frå balkongen',
      width: 1600,
      height: 1200,
    },
  ],
  url: 'https://samklang.msge.no/oppmote/ABC',
} as const

describe('isGigAttendance', () => {
  it('recognises the Konsert Link tag, which is the discriminator', () => {
    expect(isGigAttendance(DELIVERED_NOTE)).toBe(true)
    expect(isGigAttendance(NOTE_WITH_STATUS_TAG)).toBe(true)
  })

  it('accepts the English tag name Gigowl also emits on its own inbound path', () => {
    expect(
      isGigAttendance({
        tag: [{ type: 'Link', href: 'https://samklang.msge.no/konsert/X', name: 'Concert' }],
      }),
    ).toBe(true)
  })

  it('leaves an ordinary Note alone', () => {
    // No tag at all, a bare hashtag, and a Link that is a mention rather than a concert.
    expect(isGigAttendance({ type: 'Note', content: '<p>God morgon</p>' })).toBe(false)
    expect(isGigAttendance({ tag: { type: 'Hashtag', name: '#konsert' } })).toBe(false)
    expect(isGigAttendance({ tag: [{ type: 'Link', href: 'https://x/y', name: 'Noko anna' }] })).toBe(
      false,
    )
    expect(isGigAttendance(null)).toBe(false)
  })

  it('tolerates tag being a single object rather than an array', () => {
    // AP allows either for `tag`, and reading only one shape is the classic way to pass
    // your own tests and fail on real payloads.
    expect(
      isGigAttendance({
        tag: { type: 'Link', href: 'https://samklang.msge.no/konsert/X', name: 'Konsert' },
      }),
    ).toBe(true)
  })
})

describe('resolveGigStatus', () => {
  it('prefers the explicit tag over everything else', () => {
    const result = resolveGigStatus(NOTE_WITH_STATUS_TAG, 'Eg har lyst til å sjå noko heilt anna')
    expect(result.status).toBe('attended')
    expect(result.source).toBe('tag')
  })

  it('falls back to the property on a Note fetched from its own URI', () => {
    const result = resolveGigStatus(
      { 'samklang:attendanceStatus': 'going', tag: [] },
      'Eg var på noko anna',
    )
    expect(result.status).toBe('going')
    expect(result.source).toBe('property')
  })

  it('falls back to the generated opening line, which is all the archive has', () => {
    const cases: [string, string][] = [
      ['Eg var på Queen + Adam Lambert på Unity Arena i Fornebu, 2022-07-21.', 'attended'],
      ['Eg skal på Gåte på Sentrum Scene i Oslo, 2026-11-02.', 'going'],
      ['Eg har lyst til å sjå Janove på Olavshallen i Trondheim, 2026-01-17.', 'interested'],
    ]
    for (const [opening, expected] of cases) {
      const result = resolveGigStatus({ tag: [] }, opening)
      expect(result.status).toBe(expected)
      expect(result.source).toBe('template')
    }
  })

  it('returns null rather than guessing when the opening is not one it knows', () => {
    // Recording "wanted to go" as "went" is worse than recording nothing, so an
    // unrecognised opening — a reworded template, another locale — yields nothing.
    for (const opening of ['Var på ein konsert.', 'I went to a gig.', '', null]) {
      expect(resolveGigStatus({ tag: [] }, opening).status).toBeNull()
    }
  })

  it('keeps an unknown state verbatim instead of dropping it', () => {
    const result = resolveGigStatus({ tag: [{ type: 'Link', href: `${SAMKLANG_NS}maybe`, name: 'Oppmøte' }] }, null)
    expect(result.status).toBe('maybe')
    expect(result.known).toBe(false)
    expect(result.source).toBe('tag')
  })
})

describe('splitNoteBlocks', () => {
  const CONCERT = 'https://samklang.msge.no/konsert/KONS'

  it('leaves nothing as the write-up when the attendance carries none', () => {
    const { opening, review } = splitNoteBlocks(
      DELIVERED_NOTE.content,
      'https://samklang.msge.no/konsert/01KZRJ3NKDAEF25EWQKCEAP8D2',
    )
    expect(opening).toBe('Eg var på Queen + Adam Lambert på Unity Arena i Fornebu, 2022-07-21.')
    expect(review).toBeNull()
  })

  it('keeps the write-up and drops the opening, the link and the hashtags', () => {
    const { review } = splitNoteBlocks(NOTE_WITH_STATUS_TAG.content, CONCERT)
    expect(review).toBe('Beste konserten i år.\nDei spelte Vortex Surfer til slutt.')
    expect(review).not.toContain('#konsert')
    expect(review).not.toContain('samklang.msge.no/konsert')
  })

  it('keeps a multi-paragraph write-up as separate paragraphs', () => {
    const content =
      '<p>Eg var på X på Y i Z, 2026-01-01.</p><p>Fyrste avsnitt.</p><p>Andre avsnitt.</p>' +
      `<p><a href="${CONCERT}">${CONCERT}</a></p><p><a href="/emneord/konsert" class="hashtag">#konsert</a></p>`
    expect(splitNoteBlocks(content, CONCERT).review).toBe('Fyrste avsnitt.\n\nAndre avsnitt.')
  })

  it('does not mistake a write-up that starts with a hash for the hashtag block', () => {
    // The hashtag block is identified by its class="hashtag" anchors, not by the text
    // starting with "#" — a write-up is free to start however it likes.
    const content =
      `<p>Eg var på X på Y i Z, 2026-01-01.</p><p>#1 for meg i år.</p><p><a href="${CONCERT}">${CONCERT}</a></p>`
    expect(splitNoteBlocks(content, CONCERT).review).toBe('#1 for meg i år.')
  })

  it('decodes the entities Gigowl escapes on the way out', () => {
    const content = '<p>Eg var på X på Y i Z, 2026-01-01.</p><p>Rock &amp; roll &quot;live&quot;</p>'
    expect(splitNoteBlocks(content, CONCERT).review).toBe('Rock & roll "live"')
  })

  it('survives content with no paragraph markup at all', () => {
    expect(splitNoteBlocks('Eg var på X.', CONCERT)).toEqual({
      opening: 'Eg var på X.',
      review: null,
    })
    expect(splitNoteBlocks(null, CONCERT)).toEqual({ opening: null, review: null })
  })
})

describe('parseGigAttendance', () => {
  it('parses the live delivered Note', () => {
    const parsed = parseGigAttendance(DELIVERED_NOTE, ACTOR)!
    expect(parsed).not.toBeNull()
    expect(parsed.concertUrl).toBe('https://samklang.msge.no/konsert/01KZRJ3NKDAEF25EWQKCEAP8D2')
    expect(parsed.actorApId).toBe(ACTOR)
    expect(parsed.status).toBe('attended')
    expect(parsed.statusSource).toBe('template')
    expect(parsed.review).toBeNull()
    expect(parsed.hashtags).toEqual(['#konsert', '#QueenAdamLambert'])
    expect(parsed.photos).toEqual([])
    expect(parsed.noteApId).toBe('https://samklang.msge.no/oppmote/01KZRJ3RV4PVMV17KJ7P567V1C')
    expect(parsed.postId).toBe('01KZRJ3RV4PVMV17KJ7P567V1C')
  })

  it('reads published as the logging time, not the night of the gig', () => {
    // The prose says 2022-07-21; the Note publishes in 2026 because Gigowl stamps it with
    // the attendance's updatedAt. Nothing here may treat this as the gig date — that is
    // what the concert record is for.
    const parsed = parseGigAttendance(DELIVERED_NOTE, ACTOR)!
    expect(parsed.publishedAt?.getUTCFullYear()).toBe(2026)
    expect(parsed).not.toHaveProperty('gigDate')
  })

  it('parses a write-up, a content warning and photos with their alt text', () => {
    const parsed = parseGigAttendance(NOTE_WITH_STATUS_TAG, ACTOR)!
    expect(parsed.status).toBe('attended')
    expect(parsed.statusSource).toBe('tag')
    expect(parsed.review).toBe('Beste konserten i år.\nDei spelte Vortex Surfer til slutt.')
    expect(parsed.contentWarning).toBe('Høg lyd')
    expect(parsed.photos).toEqual([
      {
        url: 'https://samklang.msge.no/media/2026/03/ABC-1600.webp',
        mediaType: 'image/webp',
        altText: 'Scena sett frå balkongen',
        width: 1600,
        height: 1200,
      },
    ])
  })

  it('prefers the samklang:concert property over the tag href', () => {
    const parsed = parseGigAttendance(
      { ...NOTE_WITH_STATUS_TAG, 'samklang:concert': 'https://samklang.msge.no/konsert/MERGED' },
      ACTOR,
    )!
    expect(parsed.concertUrl).toBe('https://samklang.msge.no/konsert/MERGED')
  })

  it('returns null for anything that is not an attendance', () => {
    expect(parseGigAttendance({ type: 'Note', content: '<p>hei</p>' }, ACTOR)).toBeNull()
    expect(parseGigAttendance(null, ACTOR)).toBeNull()
  })
})

describe('normalizeSamklangUrl', () => {
  it('collapses the forms the same concert arrives in', () => {
    const canonical = 'https://samklang.msge.no/konsert/KONS'
    expect(normalizeSamklangUrl('https://samklang.msge.no/konsert/KONS/')).toBe(canonical)
    expect(normalizeSamklangUrl('https://samklang.msge.no/konsert/KONS#top')).toBe(canonical)
    expect(normalizeSamklangUrl('https://samklang.msge.no/konsert/KONS?ref=x')).toBe(canonical)
    expect(normalizeSamklangUrl('  https://samklang.msge.no/konsert/KONS  ')).toBe(canonical)
  })

  it('returns null for what is not a URL at all', () => {
    expect(normalizeSamklangUrl(null)).toBeNull()
    expect(normalizeSamklangUrl('')).toBeNull()
    expect(normalizeSamklangUrl(42)).toBeNull()
  })
})

describe('collectConcertUrls', () => {
  it('yields the one concert an attendance references', () => {
    expect(collectConcertUrls(DELIVERED_NOTE)).toEqual([
      'https://samklang.msge.no/konsert/01KZRJ3NKDAEF25EWQKCEAP8D2',
    ])
  })

  it('yields nothing for an ordinary post', () => {
    expect(collectConcertUrls({ type: 'Note', content: 'hei' })).toEqual([])
  })
})
