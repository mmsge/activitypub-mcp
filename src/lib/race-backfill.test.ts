import { describe, it, expect, vi } from 'vitest'
import { type CrossoverRow } from './race-store.js'

// Reconstructing where the lead changed is a walk over rows already in hand. It must
// not need a database, and this proves it.
vi.mock('../db/client.js', () => ({
  getDb: () => { throw new Error('findCrossover must not touch the database') },
}))

const { findCrossover } = await import('./race-backfill.js')

let clock = Date.parse('2026-08-01T00:00:00Z')
/** One play, a minute after the last. The ordering is the input; the times just label it. */
function row(side: 'leader' | 'challenger', track: string): CrossoverRow {
  clock += 60_000
  return { side, playedAt: new Date(clock), track, url: `https://last.fm/${track}` }
}

describe('findCrossover', () => {
  it('returns the play at which the challenger first goes ahead', () => {
    const rows = [
      row('leader', 'Style'),          // 1-0
      row('challenger', 'Blonde'),     // 1-1
      row('leader', 'Cruel Summer'),   // 2-1
      row('challenger', 'Psycho'),     // 2-2
      row('challenger', 'Body Better'),// 2-3  ← the lead changes here
      row('challenger', 'The Song'),   // 2-4
    ]

    const crossover = findCrossover(rows)

    expect(crossover?.track).toBe('Body Better')
    expect(crossover?.at).toEqual(rows[4]!.playedAt)
    expect(crossover?.url).toBe('https://last.fm/Body Better')
    expect(crossover).toMatchObject({ leaderPlays: 2, challengerPlays: 3 })
  })

  it('is not the last play — which is what a naive seed would have recorded', () => {
    const rows = [
      row('leader', 'Style'),
      row('challenger', 'Blonde'),
      row('challenger', 'Psycho'),     // ← here
      row('challenger', 'The Song'),
      row('challenger', 'Coming Of Age'),
    ]
    expect(findCrossover(rows)?.track).toBe('Psycho')
    expect(findCrossover(rows)?.track).not.toBe('Coming Of Age')
  })

  it('is not the dead heat — level is not won (decision record 0016)', () => {
    const rows = [
      row('leader', 'Style'),
      row('challenger', 'Blonde'),     // 1-1, level, not a crossover
      row('challenger', 'Psycho'),     // 2-1 for the challenger ← here
    ]
    expect(findCrossover(rows)?.track).toBe('Psycho')
  })

  it('takes the FIRST crossing when the lead changes hands more than once', () => {
    const rows = [
      row('challenger', 'Blonde'),     // 0-1 ← here, immediately
      row('leader', 'Style'),          // 1-1
      row('leader', 'Cruel Summer'),   // 2-1, leader back in front
      row('challenger', 'Psycho'),     // 2-2
      row('challenger', 'The Song'),   // 2-3, crosses again
    ]
    expect(findCrossover(rows)?.track).toBe('Blonde')
  })

  it('is null for a race the challenger has never led', () => {
    expect(findCrossover([
      row('leader', 'Style'),
      row('challenger', 'Blonde'),
      row('leader', 'Cruel Summer'),
      row('challenger', 'Psycho'),
    ])).toBeNull()
  })

  it('is null for no plays at all', () => {
    expect(findCrossover([])).toBeNull()
  })

  it('always returns a challenger play — nothing else can push the count over', () => {
    const rows = [row('challenger', 'Blonde'), row('leader', 'Style')]
    const crossover = findCrossover(rows)!
    expect(rows.find(r => r.playedAt === crossover.at)!.side).toBe('challenger')
  })
})
