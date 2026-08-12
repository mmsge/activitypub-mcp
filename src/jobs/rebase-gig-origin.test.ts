import { describe, it, expect } from 'vitest'
import { rebaseJsonValue } from './rebase-gig-origin.js'

// The DB half of this job is exercised against a real Postgres rather than mocked; what is
// worth unit-testing is the walker that reaches URIs buried inside `lineup`, `setlists`,
// `details` and `photos` — the columns where a missed string is invisible until a join
// silently returns nothing.
describe('rebaseJsonValue', () => {
  it('moves URIs at any depth and leaves everything else alone', () => {
    const before = {
      lineup: [{ artistUrl: 'https://samklang.msge.no/artist/A1', name: 'Nokon', position: 0, role: null }],
      setlists: [
        {
          id: 'https://samklang.msge.no/setliste/S1',
          artistUrl: 'https://samklang.msge.no/artist/A1',
          entries: [{ songTitle: 'Bak et halleluja', isEncore: true }],
        },
      ],
      details: { artistUris: ['https://samklang.msge.no/artist/A1'], summary: 'Nokon (headliner)' },
      photos: [{ url: 'https://samklang.msge.no/media/2026/03/A1-1600.webp', altText: 'Scena', width: 1600 }],
    }

    expect(rebaseJsonValue(before)).toEqual({
      lineup: [{ artistUrl: 'https://gigowl.social/artist/A1', name: 'Nokon', position: 0, role: null }],
      setlists: [
        {
          id: 'https://gigowl.social/setlist/S1',
          artistUrl: 'https://gigowl.social/artist/A1',
          entries: [{ songTitle: 'Bak et halleluja', isEncore: true }],
        },
      ],
      details: { artistUris: ['https://gigowl.social/artist/A1'], summary: 'Nokon (headliner)' },
      photos: [{ url: 'https://gigowl.social/media/2026/03/A1-1600.webp', altText: 'Scena', width: 1600 }],
    })
  })

  it('does not move the vocabulary, and is idempotent', () => {
    // A stored tag array is the shape this matters most for: the status tag's href IS the
    // vocabulary, and moving it would make the RSVP state unreadable.
    const tags = [
      { type: 'Link', href: 'https://samklang.msge.no/konsert/K', name: 'Konsert' },
      { type: 'Link', href: 'https://samklang.msge.no/ns#attended', name: 'Oppmøte' },
    ]
    const once = rebaseJsonValue(tags)
    expect(once).toEqual([
      { type: 'Link', href: 'https://gigowl.social/gig/K', name: 'Konsert' },
      { type: 'Link', href: 'https://samklang.msge.no/ns#attended', name: 'Oppmøte' },
    ])
    expect(rebaseJsonValue(once)).toEqual(once)
  })

  it('passes non-strings through untouched', () => {
    expect(rebaseJsonValue(null)).toBeNull()
    expect(rebaseJsonValue(42)).toBe(42)
    expect(rebaseJsonValue(true)).toBe(true)
    expect(rebaseJsonValue([])).toEqual([])
  })
})
