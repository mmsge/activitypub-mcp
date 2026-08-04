import { describe, it, expect } from 'vitest'
import { planGardenSync, type GardenNoteRow } from './sync-garden-content.js'
import type { GardenNoteRef } from '../lib/fetch-garden.js'

const NOW = new Date('2026-07-02T12:00:00Z')
const HOURS = 60 * 60 * 1000

function ref(
  sourcePath: string,
  path = `/${sourcePath}`,
  title = sourcePath,
  date: string | null = null,
  tags: string[] = [],
  bookUrl: string | null = null,
): GardenNoteRef {
  return { sourcePath, path, title, date, tags, bookUrl }
}

function row(overrides: Partial<GardenNoteRow> & { sourcePath: string }): GardenNoteRow {
  return {
    path: `/${overrides.sourcePath}`,
    title: overrides.sourcePath,
    noteDate: null,
    noteTags: [],
    bookUrl: null,
    hasContent: false,
    lastCheckedAt: null,
    deletedAt: null,
    ...overrides,
  }
}

describe('planGardenSync — note dates and tags', () => {
  // The columns landed after the rows did, so every stored row starts with a null
  // date. Without this the backfill never happens and the stream can only place a
  // note by when the crawler first saw it.
  it('re-upserts a stored note whose date is not yet persisted', () => {
    const plan = planGardenSync(
      [ref('a.md', '/a', 'a', '2024-03-11')],
      [row({ sourcePath: 'a.md', path: '/a', title: 'a', hasContent: true, lastCheckedAt: NOW })],
      NOW,
    )
    expect(plan.toUpsertMeta).toHaveLength(1)
    expect(plan.toUpsertMeta[0].date).toBe('2024-03-11')
  })

  it('re-upserts a stored note whose bookwyrm URL is not yet persisted', () => {
    // Same reason as the date above: the column landed after the rows did, so the
    // first pass with it must backfill or no undated review ever gets a date.
    const plan = planGardenSync(
      [ref('b.md', '/b', 'b', null, [], 'https://bookwyrm.social/book/1')],
      [row({ sourcePath: 'b.md', path: '/b', title: 'b', hasContent: true, lastCheckedAt: NOW })],
      NOW,
    )
    expect(plan.toUpsertMeta).toHaveLength(1)
    expect(plan.toUpsertMeta[0].bookUrl).toBe('https://bookwyrm.social/book/1')
  })

  it('leaves a note alone when its bookwyrm URL is unchanged', () => {
    const plan = planGardenSync(
      [ref('b.md', '/b', 'b', null, [], 'https://bookwyrm.social/book/1')],
      [row({
        sourcePath: 'b.md', path: '/b', title: 'b', hasContent: true, lastCheckedAt: NOW,
        bookUrl: 'https://bookwyrm.social/book/1',
      })],
      NOW,
    )
    expect(plan.toUpsertMeta).toHaveLength(0)
  })

  it('re-upserts when the date changes, so an edited note re-dates itself', () => {
    const plan = planGardenSync(
      [ref('a.md', '/a', 'a', '2024-04-01')],
      [row({ sourcePath: 'a.md', path: '/a', title: 'a', noteDate: '2024-03-11', hasContent: true, lastCheckedAt: NOW })],
      NOW,
    )
    expect(plan.toUpsertMeta).toHaveLength(1)
  })

  it('re-upserts when the tags change', () => {
    const plan = planGardenSync(
      [ref('a.md', '/a', 'a', null, ['bok', 'lesing'])],
      [row({ sourcePath: 'a.md', path: '/a', title: 'a', noteTags: ['bok'], hasContent: true, lastCheckedAt: NOW })],
      NOW,
    )
    expect(plan.toUpsertMeta).toHaveLength(1)
  })

  it('leaves an unchanged note alone — no needless write every cycle', () => {
    const plan = planGardenSync(
      [ref('a.md', '/a', 'a', '2024-03-11', ['bok'])],
      [row({
        sourcePath: 'a.md', path: '/a', title: 'a',
        noteDate: '2024-03-11', noteTags: ['bok'], hasContent: true, lastCheckedAt: NOW,
      })],
      NOW,
    )
    expect(plan.toUpsertMeta).toEqual([])
  })

  it('treats a null stored tag list and an empty frontmatter list as the same', () => {
    const plan = planGardenSync(
      [ref('a.md', '/a', 'a')],
      [row({ sourcePath: 'a.md', path: '/a', title: 'a', noteTags: null, hasContent: true, lastCheckedAt: NOW })],
      NOW,
    )
    expect(plan.toUpsertMeta).toEqual([])
  })
})

describe('planGardenSync', () => {
  it('inserts and fetches a brand-new note', () => {
    const plan = planGardenSync([ref('a.md')], [], NOW)
    expect(plan.toUpsertMeta).toEqual([ref('a.md')])
    expect(plan.toSoftDelete).toEqual([])
    expect(plan.toFetch).toEqual([ref('a.md')])
  })

  it('retries missing-content rows every run, even when recently checked', () => {
    const rows = [row({ sourcePath: 'a.md', hasContent: false, lastCheckedAt: NOW })]
    const plan = planGardenSync([ref('a.md')], rows, NOW)
    expect(plan.toFetch).toEqual([ref('a.md')])
    expect(plan.toUpsertMeta).toEqual([]) // metadata unchanged
  })

  it('leaves freshly-checked fetched rows alone', () => {
    const rows = [
      row({ sourcePath: 'a.md', hasContent: true, lastCheckedAt: new Date(NOW.getTime() - 1 * HOURS) }),
    ]
    const plan = planGardenSync([ref('a.md')], rows, NOW)
    expect(plan.toFetch).toEqual([])
  })

  it('re-checks fetched rows older than the recheck window', () => {
    const rows = [
      row({ sourcePath: 'a.md', hasContent: true, lastCheckedAt: new Date(NOW.getTime() - 25 * HOURS) }),
      row({ sourcePath: 'b.md', hasContent: true, lastCheckedAt: null }),
    ]
    const plan = planGardenSync([ref('a.md'), ref('b.md')], rows, NOW)
    expect(plan.toFetch).toEqual([ref('a.md'), ref('b.md')])
  })

  it('orders missing content before stale re-checks', () => {
    const rows = [
      row({ sourcePath: 'stale.md', hasContent: true, lastCheckedAt: new Date(NOW.getTime() - 25 * HOURS) }),
    ]
    const plan = planGardenSync([ref('stale.md'), ref('new.md')], rows, NOW)
    expect(plan.toFetch.map((r) => r.sourcePath)).toEqual(['new.md', 'stale.md'])
  })

  it('soft-deletes rows that left the cache doc, but never deleted ones again', () => {
    const rows = [
      row({ sourcePath: 'gone.md', hasContent: true, lastCheckedAt: NOW }),
      row({ sourcePath: 'already-gone.md', deletedAt: NOW }),
    ]
    const plan = planGardenSync([ref('a.md')], rows, NOW)
    expect(plan.toSoftDelete).toEqual(['gone.md'])
  })

  it('resurrects a soft-deleted note that reappears', () => {
    const rows = [row({ sourcePath: 'back.md', path: '/back.md', title: 'back.md', deletedAt: NOW })]
    const plan = planGardenSync([ref('back.md', '/back.md', 'back.md')], rows, NOW)
    expect(plan.toUpsertMeta).toEqual([ref('back.md', '/back.md', 'back.md')])
    expect(plan.toSoftDelete).toEqual([])
  })

  it('re-upserts metadata when the permalink or title changed', () => {
    const rows = [row({ sourcePath: 'a.md', path: '/old', title: 'Old', hasContent: true, lastCheckedAt: NOW })]
    const plan = planGardenSync([ref('a.md', '/new', 'New')], rows, NOW)
    expect(plan.toUpsertMeta).toEqual([ref('a.md', '/new', 'New')])
  })
})
