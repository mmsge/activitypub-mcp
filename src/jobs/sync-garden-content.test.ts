import { describe, it, expect } from 'vitest'
import { planGardenSync, type GardenNoteRow } from './sync-garden-content.js'
import type { GardenNoteRef } from '../lib/fetch-garden.js'

const NOW = new Date('2026-07-02T12:00:00Z')
const HOURS = 60 * 60 * 1000

function ref(sourcePath: string, path = `/${sourcePath}`, title = sourcePath): GardenNoteRef {
  return { sourcePath, path, title }
}

function row(overrides: Partial<GardenNoteRow> & { sourcePath: string }): GardenNoteRow {
  return {
    path: `/${overrides.sourcePath}`,
    title: overrides.sourcePath,
    hasContent: false,
    lastCheckedAt: null,
    deletedAt: null,
    ...overrides,
  }
}

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
