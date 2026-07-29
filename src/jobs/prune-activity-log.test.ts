import { describe, it, expect, vi } from 'vitest'

// getDb() would open a real connection; the disabled path must not reach it.
const getDb = vi.fn(() => {
  throw new Error('getDb() should not be called when pruning is disabled')
})
vi.mock('../db/client.js', () => ({ getDb }))

const { pruneActivityLog } = await import('./prune-activity-log.js')

describe('pruneActivityLog', () => {
  it('is a no-op that never touches the database when retention is 0', async () => {
    await expect(pruneActivityLog(0)).resolves.toBe(0)
    expect(getDb).not.toHaveBeenCalled()
  })

  it('treats a negative window as disabled rather than deleting everything', async () => {
    await expect(pruneActivityLog(-1)).resolves.toBe(0)
    expect(getDb).not.toHaveBeenCalled()
  })
})
