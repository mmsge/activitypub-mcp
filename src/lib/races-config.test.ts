import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { parseRaces, loadRaces, RacesConfigError } from './races-config.js'

/**
 * Loading the race definitions. `parseRaces` is pure — an object in, definitions out —
 * so every rule below is asserted without a filesystem, a database or a mock.
 */

const artist = (name: string) => ({ type: 'artist', artist: name })

const VALID = {
  races: [
    {
      id: 'maisie-vs-taylor',
      title: 'Maisie Peters vs Taylor Swift',
      topic: 'scrobble-race',
      milestones: [1000, 500, 250, 100, 50, 25, 10],
      endgame_gap: 10,
      nowplaying_gap: 0,
      archived: true,
      leader: artist('Taylor Swift'),
      challenger: artist('Maisie Peters'),
    },
    {
      id: 'good-witch-vs-florescence',
      title: 'The Good Witch vs Florescence',
      topic: 'scrobble-race-album',
      milestones: [100, 50, 25, 10],
      endgame_gap: 10,
      leader: { type: 'album', artist: 'Maisie Peters', albums: ['The Good Witch'] },
      challenger: { type: 'album', artist: 'Maisie Peters', albums: ['Florescence'] },
    },
  ],
}

describe('parseRaces — a valid file', () => {
  it('reads every race and resolves its knobs', () => {
    const races = parseRaces(VALID)

    expect(races).toHaveLength(2)
    expect(races[0]).toMatchObject({
      id: 'maisie-vs-taylor',
      title: 'Maisie Peters vs Taylor Swift',
      topic: 'scrobble-race',
      endgameGap: 10,
      nowplayingGap: 0,
      archived: true,
    })
    expect(races[0]!.leader.entity).toEqual({ type: 'artist', artist: 'Taylor Swift' })
    expect(races[1]!.challenger.entity).toEqual({
      type: 'album', artist: 'Maisie Peters', albums: ['Florescence'],
    })
  })

  it('defaults archived to false, so a race is live unless it says otherwise', () => {
    expect(parseRaces(VALID)[1]!.archived).toBe(false)
  })

  it('falls back to the env defaults for every knob a race omits', () => {
    const [race] = parseRaces({
      races: [{
        id: 'bare', title: 'Bare', leader: artist('A'), challenger: artist('B'),
      }],
    })
    // vitest.config.ts leaves the RACE_* vars unset, so these are the schema defaults.
    expect(race!.topic).toBe('scrobble-race')
    expect(race!.endgameGap).toBe(10)
    expect(race!.nowplayingGap).toBe(0)
    expect(race!.milestones[0]).toBe(300)
  })

  it('normalises the ladder to descending and deduped, whatever order it was written in', () => {
    const [race] = parseRaces({
      races: [{
        id: 'ladder', title: 'Ladder', milestones: [10, 100, 10, 50],
        leader: artist('A'), challenger: artist('B'),
      }],
    })
    expect(race!.milestones).toEqual([100, 50, 10])
  })

  it('labels a side from its own names, qualified only when the artists differ', () => {
    const [same, different] = parseRaces({
      races: [
        {
          id: 'same-artist', title: 'Same',
          leader: { type: 'album', artist: 'Maisie Peters', albums: ['The Good Witch'] },
          challenger: { type: 'album', artist: 'Maisie Peters', albums: ['Florescence'] },
        },
        {
          id: 'two-artists', title: 'Two',
          leader: { type: 'album', artist: 'Taylor Swift', albums: ['1989'] },
          challenger: { type: 'album', artist: 'Maisie Peters', albums: ['Florescence'] },
        },
      ],
    })
    // One artist, two records: naming the artist on both sides would say nothing.
    expect(same!.leader.label).toBe('The Good Witch')
    // Two artists: "1989" alone does not say whose.
    expect(different!.leader.label).toBe('Taylor Swift — 1989')
  })

  it('folds a multi-name side into one label', () => {
    const [race] = parseRaces({
      races: [{
        id: 'campaign', title: 'Campaign',
        leader: {
          type: 'album', artist: 'Maisie Peters',
          albums: ['The Good Witch', 'Lost The Breakup'],
        },
        challenger: { type: 'album', artist: 'Maisie Peters', albums: ['Florescence'] },
      }],
    })
    expect(race!.leader.label).toBe('The Good Witch + Lost The Breakup')
  })
})

describe('parseRaces — a file that must not load', () => {
  it('rejects duplicate ids, and names every one of them', () => {
    const dup = {
      races: [
        { id: 'a', title: 'One', leader: artist('X'), challenger: artist('Y') },
        { id: 'a', title: 'Two', leader: artist('P'), challenger: artist('Q') },
        { id: 'b', title: 'Three', leader: artist('M'), challenger: artist('N') },
        { id: 'b', title: 'Four', leader: artist('R'), challenger: artist('S') },
      ],
    }
    expect(() => parseRaces(dup)).toThrow(RacesConfigError)
    expect(() => parseRaces(dup)).toThrow(/duplicate race id "a", "b"/)
  })

  it('rejects an entity missing the keys its type requires', () => {
    expect(() => parseRaces({
      races: [{
        id: 'no-albums', title: 'No albums',
        leader: { type: 'album', artist: 'Maisie Peters' },
        challenger: artist('Taylor Swift'),
      }],
    })).toThrow(/albums/)
  })

  it('rejects an empty album list — a side that matches nothing is not a side', () => {
    expect(() => parseRaces({
      races: [{
        id: 'empty', title: 'Empty',
        leader: { type: 'album', artist: 'Maisie Peters', albums: [] },
        challenger: artist('Taylor Swift'),
      }],
    })).toThrow(/albums/)
  })

  it('rejects an unknown entity type', () => {
    expect(() => parseRaces({
      races: [{
        id: 'unknown', title: 'Unknown',
        leader: { type: 'song', artist: 'Maisie Peters', songs: ['Blonde'] },
        challenger: artist('Taylor Swift'),
      }],
    })).toThrow(/leader/)
  })

  it('rejects a race against itself — its gap is 0 forever and it can never resolve', () => {
    expect(() => parseRaces({
      races: [{
        id: 'mirror', title: 'Mirror',
        leader: { type: 'album', artist: 'Maisie Peters', albums: ['Florescence'] },
        challenger: { type: 'album', artist: 'Maisie Peters', albums: ['Florescence'] },
      }],
    })).toThrow(/races a side against itself/)
  })

  it('rejects an id that is not usable as a key, a log field and a query param', () => {
    expect(() => parseRaces({
      races: [{ id: 'Not An Id', title: 'X', leader: artist('A'), challenger: artist('B') }],
    })).toThrow(/id/)
  })

  it('rejects a file with no races array at all', () => {
    expect(() => parseRaces({ race: [] })).toThrow(RacesConfigError)
  })
})

describe('loadRaces — reading the file', () => {
  const fixture = join(import.meta.dirname, '__fixtures__', 'races.json')

  it('reads a file from the given path, which is what RACES_CONFIG_PATH overrides', () => {
    const races = loadRaces(fixture)
    expect(races.map(r => r.id)).toEqual(['fixture-artists', 'fixture-albums'])
    expect(races[0]!.topic).toBe('fixture-topic')
    expect(races[1]!.archived).toBe(true)
  })

  it('is an error, not an off-switch, when the named file is not there', () => {
    expect(() => loadRaces(join(import.meta.dirname, '__fixtures__', 'nope.json')))
      .toThrow(/cannot read/)
  })

  it('says so when the file is not JSON at all', () => {
    expect(() => loadRaces(join(import.meta.dirname, 'races-config.ts')))
      .toThrow(/not valid JSON/)
  })
})

describe('the repo’s own races.json', () => {
  it('loads', () => {
    const races = loadRaces('races.json')
    expect(races.length).toBeGreaterThan(0)
    expect(races.map(r => r.id)).toContain('maisie-vs-taylor')
  })
})
