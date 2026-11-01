import { describe, it, expect, beforeEach } from 'vitest'
import { stashUpload, takeUpload, notePending, clearPending, PENDING_TTL_MS, PENDING_MAX } from './import-pending.js'

describe('pending uploads', () => {
  beforeEach(() => clearPending())

  it('hands an upload back once, to the import it was stashed for', () => {
    const token = stashUpload('trips', { file: 'csv' }, 1000)
    expect(takeUpload(token, 'youtube', 1000)).toBeNull()
    expect(takeUpload(token, 'trips', 1000)?.body).toEqual({ file: 'csv' })
    expect(takeUpload(token, 'trips', 1000)).toBeNull()
  })

  it('forgets an upload after ten minutes', () => {
    const token = stashUpload('trips', {}, 0)
    expect(takeUpload(token, 'trips', PENDING_TTL_MS + 1)).toBeNull()
  })

  it('keeps only the newest few', () => {
    const tokens = Array.from({ length: PENDING_MAX + 1 }, (_, i) => stashUpload('trips', { i: String(i) }, i))
    expect(takeUpload(tokens[0]!, 'trips', 10)).toBeNull()
    expect(takeUpload(tokens[PENDING_MAX]!, 'trips', 10)?.body).toEqual({ i: String(PENDING_MAX) })
  })

  it('carries what the preview listed to the confirm', () => {
    const token = stashUpload('trips', {}, 0)
    notePending(token, { pruneIds: ['a', 'b'] })
    expect(takeUpload(token, 'trips', 0)?.pruneIds).toEqual(['a', 'b'])
  })
})
