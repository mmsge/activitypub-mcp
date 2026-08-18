import { describe, it, expect, vi } from 'vitest'
import { type RaceDefinition } from '../../lib/races-config.js'

// Projecting a crossover date is arithmetic, and picking a race is bookkeeping; neither
// must need a database.
const getDb = vi.fn(() => { throw new Error('projectCrossover must not touch the database') })
vi.mock('../../db/client.js', () => ({ getDb }))

const { projectCrossover, resolveRace } = await import('./scrobble-race.js')
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

/**
 * Which race a call is about. The order is the contract, and rule 3 — two bare strings
 * are two artists — is the pre-existing behaviour that must not move.
 */
describe('resolveRace', () => {
  const artistSide = (name: string) =>
    ({ label: name, entity: { type: 'artist' as const, artist: name } })

  const configured: RaceDefinition[] = [
    {
      id: 'maisie-vs-taylor',
      title: 'Maisie Peters vs Taylor Swift',
      topic: 'scrobble-race',
      milestones: [300, 250, 10],
      endgameGap: 10,
      nowplayingGap: 0,
      archived: true,
      leader: artistSide('Taylor Swift'),
      challenger: artistSide('Maisie Peters'),
    },
    {
      id: 'good-witch-vs-florescence',
      title: 'The Good Witch vs Florescence',
      topic: 'scrobble-race-album',
      milestones: [100, 50, 10],
      endgameGap: 10,
      nowplayingGap: 0,
      archived: false,
      leader: {
        label: 'The Good Witch',
        entity: { type: 'album', artist: 'Maisie Peters', albums: ['The Good Witch'] },
      },
      challenger: {
        label: 'Florescence',
        entity: { type: 'album', artist: 'Maisie Peters', albums: ['Florescence'] },
      },
    },
  ]
  const live = configured[1]!
  const resolve = (input: Parameters<typeof resolveRace>[0]) =>
    resolveRace(input, configured, live)

  it('looks up a race by id, archived or not', () => {
    const r = resolve({ race_id: 'maisie-vs-taylor' })
    expect(r).toMatchObject({ adHoc: false })
    expect('race' in r && r.race.id).toBe('maisie-vs-taylor')
  })

  it('names the races it does know when asked for one it does not', () => {
    const r = resolve({ race_id: 'nope' })
    expect('error' in r && r.error).toMatch(/Unknown race "nope"/)
    expect('error' in r && r.error).toMatch(/maisie-vs-taylor, good-witch-vs-florescence/)
  })

  it('treats two bare strings as two artists — the behaviour that predates races.json', () => {
    const r = resolve({ leader: 'ABBA', challenger: 'a-ha' })
    expect('race' in r && r.adHoc).toBe(true)
    expect('race' in r && r.race.leader.entity).toEqual({ type: 'artist', artist: 'ABBA' })
    expect('race' in r && r.race.challenger.entity).toEqual({ type: 'artist', artist: 'a-ha' })
    expect('race' in r && r.race.id).toBe('')
  })

  it('builds an ad-hoc race from entity objects, without touching the config', () => {
    const r = resolve({
      leader: { type: 'track', artist: 'Maisie Peters', tracks: ['Blonde'] },
      challenger: { type: 'track', artist: 'Maisie Peters', tracks: ['Psycho'] },
    })
    expect('race' in r && r.adHoc).toBe(true)
    expect('race' in r && r.race.leader.entity).toEqual({
      type: 'track', artist: 'Maisie Peters', tracks: ['Blonde'],
    })
    expect('race' in r && r.race.title).toBe('Blonde vs Psycho')
  })

  it('mixes a bare string and an object, because a string is just an artist entity', () => {
    const r = resolve({
      leader: 'Taylor Swift',
      challenger: { type: 'album', artist: 'Maisie Peters', albums: ['Florescence'] },
    })
    expect('race' in r && r.race.leader.entity).toEqual({ type: 'artist', artist: 'Taylor Swift' })
    expect('race' in r && r.race.challenger.entity.type).toBe('album')
  })

  it('resolves an explicit pair that IS a configured race to that race, so it keeps its state', () => {
    const r = resolve({ leader: 'Taylor Swift', challenger: 'Maisie Peters' })
    expect('race' in r && r.adHoc).toBe(false)
    expect('race' in r && r.race.id).toBe('maisie-vs-taylor')
  })

  it('still lets one side be given alone, inheriting the other', () => {
    // This worked before races.json (the missing side came from the env pair) and a
    // caller doing it must not start getting an error.
    const r = resolve({ challenger: 'ABBA' })
    expect('race' in r && r.race.leader.entity).toEqual(live.leader.entity)
    expect('race' in r && r.race.challenger.entity).toEqual({ type: 'artist', artist: 'ABBA' })
  })

  it('falls back to the first unresolved race when nothing is named', () => {
    const r = resolve({})
    expect('race' in r && r.race.id).toBe('good-witch-vs-florescence')
  })

  it('says what to do when there is no race at all', () => {
    const r = resolveRace({}, [], null)
    expect('error' in r && r.error).toMatch(/races\.json/)
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

  // race_id is a plain string and must NOT be coerced; it is also the only way to reach
  // a non-artist race over GET, since a query string cannot carry an entity object.
  it('leaves race_id uncoerced', () => {
    const row = endpoints.find(e => e.path === '/scrobble-race')
    expect(row?.numbers).not.toContain('race_id')
    expect(row?.booleans).not.toContain('race_id')
    expect(row?.arrays).not.toContain('race_id')
  })

  it('registers the race list, with include_archived as a boolean', () => {
    const row = endpoints.find(e => e.path === '/scrobble-races')
    expect(row?.name).toBe('list_scrobble_races')
    expect(row?.booleans).toContain('include_archived')
  })
})
