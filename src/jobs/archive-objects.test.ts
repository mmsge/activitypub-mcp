import { describe, it, expect, vi, beforeEach } from 'vitest'

// The batched upsert, without a database: every INSERT is recorded, and one row is made
// to fail so the row-by-row fallback can be watched isolating it.

const inserts: Array<Array<{ apId: string }>> = []
let refuse = new Set<string>()

vi.mock('../db/client.js', () => ({
  getDb: () => ({
    insert: () => ({
      values: (rows: Array<{ apId: string }>) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            inserts.push(rows)
            const bad = rows.find((r) => refuse.has(r.apId))
            if (bad) throw Object.assign(new Error('value too long'), { code: '22001' })
            // Even ap_ids "already exist", so the split between inserted and updated shows.
            return rows.map((r) => ({ created: Number(r.apId.slice(-1)) % 2 === 1 }))
          },
        }),
      }),
    }),
  }),
}))

const { upsertObjectRows } = await import('./archive-objects.js')

const row = (n: number) => ({ id: String(n), row: { apId: `https://x/${n}` } as never })

beforeEach(() => {
  inserts.length = 0
  refuse = new Set()
})

describe('upsertObjectRows', () => {
  it('writes in batches and counts inserts and updates', async () => {
    const r = await upsertObjectRows([1, 2, 3, 4, 5].map(row), { batchSize: 2, label: 'test' })
    expect(inserts.map((b) => b.length)).toEqual([2, 2, 1])
    expect(r).toEqual({ inserted: 3, updated: 2, failed: [] })
  })

  it('retries a refused batch row by row and names the one bad row', async () => {
    refuse = new Set(['https://x/3'])
    const r = await upsertObjectRows([1, 2, 3, 4].map(row), { batchSize: 4, label: 'test' })
    // The batch, then each of its four rows on its own.
    expect(inserts.map((b) => b.length)).toEqual([4, 1, 1, 1, 1])
    expect(r.inserted + r.updated).toBe(3)
    expect(r.failed).toEqual([{ id: '3', reason: 'value too long [22001]' }])
  })
})
