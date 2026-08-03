import { describe, it, expect, vi } from 'vitest'

// Projecting a crossover date is arithmetic; it must not need a database.
const getDb = vi.fn(() => { throw new Error('projectCrossover must not touch the database') })
vi.mock('../../db/client.js', () => ({ getDb }))

const { projectCrossover } = await import('./scrobble-race.js')
const { endpoints } = await import('../../rest/table.js')

const NOW = new Date('2026-08-03T12:00:00Z')

describe('projectCrossover', () => {
  it('projects the crossover from the observed closing rate', () => {
    const p = projectCrossover({ gap: 374, netPerDay: 4.4, now: NOW })
    expect(p?.days).toBe(85)
    expect(p?.date).toBe('2026-10-27')
    expect(getDb).not.toHaveBeenCalled()
  })

  it('rounds up — you cannot cross on a fraction of a scrobble', () => {
    expect(projectCrossover({ gap: 10, netPerDay: 3, now: NOW })?.days).toBe(4)
  })

  it('admits there is no projection when the gap is not closing', () => {
    expect(projectCrossover({ gap: 374, netPerDay: 0, now: NOW })).toBeNull()
    expect(projectCrossover({ gap: 374, netPerDay: -2, now: NOW })).toBeNull()
  })

  it('is today at a dead heat, and nothing once already passed', () => {
    expect(projectCrossover({ gap: 0, netPerDay: 4, now: NOW })).toEqual({ date: '2026-08-03', days: 0 })
    expect(projectCrossover({ gap: -5, netPerDay: 4, now: NOW })).toBeNull()
  })
})

describe('/scrobble-race REST registration', () => {
  // A numeric param missing from `numbers` reaches zod as a string: fine on POST,
  // a 400 on GET. Cheap insurance against an asymmetry that is invisible otherwise.
  it('declares pace_days as a number so GET query strings coerce', () => {
    const row = endpoints.find(e => e.path === '/scrobble-race')
    expect(row).toBeDefined()
    expect(row?.name).toBe('get_scrobble_race')
    expect(row?.numbers).toContain('pace_days')
  })
})
