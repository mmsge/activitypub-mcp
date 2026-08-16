import { describe, it, expect } from 'vitest'
import { dbReason } from './import-youtube-watches.js'

describe('dbReason', () => {
  it('walks past drizzle\'s wrapper to the driver error underneath', () => {
    // This is the whole point. Drizzle's DrizzleQueryError sets its own message to the
    // entire failed statement; the sentence that says what actually went wrong is on the
    // PostgresError it wraps. Reporting the outer one names the query instead of the fault
    // — which is exactly what a 96k-row import did on its first real run.
    const pgError = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), {
      code: '22021',
    })
    const wrapped = Object.assign(
      new Error('Failed query: insert into "youtube_watches" ("id", "account", …) values ($1, $2, …)'),
      { cause: pgError },
    )
    const reason = dbReason(wrapped)
    expect(reason).toContain('invalid byte sequence')
    expect(reason).toContain('22021')
    expect(reason).not.toContain('Failed query')
  })

  it('walks a chain more than one deep', () => {
    const root = new Error('root cause')
    const mid = Object.assign(new Error('middle'), { cause: root })
    const outer = Object.assign(new Error('outer'), { cause: mid })
    expect(dbReason(outer)).toBe('root cause')
  })

  it('uses the error itself when nothing wraps it', () => {
    expect(dbReason(new Error('plain failure'))).toBe('plain failure')
  })

  it('keeps only the first line, so a multi-line dump cannot flood the report', () => {
    expect(dbReason(new Error('first line\nsecond line\nthird line'))).toBe('first line')
  })

  it('appends detail and code when the driver supplies them', () => {
    const e = Object.assign(new Error('duplicate key value violates unique constraint'), {
      detail: 'Key (account, video_id, watched_at_local) already exists.',
      code: '23505',
    })
    const reason = dbReason(e)
    expect(reason).toContain('duplicate key value')
    expect(reason).toContain('already exists')
    expect(reason).toContain('[23505]')
  })

  it('survives a self-referential cause instead of looping forever', () => {
    // Defensive: a cycle here would hang the import rather than report it.
    const e = new Error('cyclic') as Error & { cause?: unknown }
    e.cause = e
    expect(dbReason(e)).toBe('cyclic')
  })

  it('handles a thrown non-error', () => {
    expect(dbReason('just a string')).toBe('just a string')
  })
})
