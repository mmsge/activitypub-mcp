import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fetchGarden, fetchGardenNoteRefs, forceRefreshGarden, getDb } = vi.hoisted(() => ({
  fetchGarden: vi.fn(),
  fetchGardenNoteRefs: vi.fn(),
  forceRefreshGarden: vi.fn(),
  getDb: vi.fn(),
}))

vi.mock('../../lib/fetch-garden.js', () => ({
  fetchGarden,
  fetchGardenNoteRefs,
  forceRefreshGarden,
  noteAccessUrl: (p: string) => `https://obsidian.test/${p}`,
  stripFrontmatter: (s: string) => s,
}))
vi.mock('../../db/client.js', () => ({ getDb }))

import { getGardenPage } from './garden-page.js'

const weirdo = {
  title: 'Weirdo',
  url: 'https://markus.plus/melding/bok/weirdo',
  path: '/melding/bok/weirdo',
  section: 'melding',
  sourcePath: '_publish/Bøker/Meldingar/2026/10 - Oktober/Weirdo.md',
  description: null,
  image: null,
  date: null,
  tags: [],
}

describe('getGardenPage — miss triggers one forced cache refresh', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fetchGardenNoteRefs.mockResolvedValue([])
    // No garden_notes rows; the live fetch then persists the note.
    getDb.mockReturnValue({
      select: () => ({ from: () => ({ where: async () => [] }) }),
      insert: () => ({
        values: (v: Record<string, unknown>) => ({
          onConflictDoUpdate: () => ({ returning: async () => [{ ...v, fetchedAt: new Date() }] }),
        }),
      }),
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '# Weirdo', headers: new Headers() })))
  })

  it('refreshes and retries, finding a note published since the last refresh', async () => {
    fetchGarden.mockResolvedValueOnce([]).mockResolvedValueOnce([weirdo])
    forceRefreshGarden.mockResolvedValue(true)

    const res = await getGardenPage({ path: '/melding/bok/weirdo' })
    expect(forceRefreshGarden).toHaveBeenCalledTimes(1)
    expect(res).toMatchObject({ title: 'Weirdo', path: '/melding/bok/weirdo', content: '# Weirdo' })
  })

  it('does not refresh on a hit', async () => {
    fetchGarden.mockResolvedValue([weirdo])
    await getGardenPage({ path: '/melding/bok/weirdo' })
    expect(forceRefreshGarden).not.toHaveBeenCalled()
  })

  it('returns the error without retrying when the refresh is rate-limited or fails', async () => {
    fetchGarden.mockResolvedValue([])
    forceRefreshGarden.mockResolvedValue(false)

    const res = await getGardenPage({ path: '/finst/ikkje' })
    expect(res).toEqual({ error: 'No garden page found for path "/finst/ikkje"' })
    expect(fetchGarden).toHaveBeenCalledTimes(1)
  })
})
