import { describe, it, expect } from 'vitest'
import {
  artistEntity, countMatching, entityCondition, entityLabel, matchesEntity,
  nowPlayingMatchesEntity, sameEntity, type PlayRow, type RaceEntity,
} from './race-entity.js'
import { raceCountQuery } from './race-store.js'

/**
 * What counts as a play for a side.
 *
 * Two halves that have to agree: `matchesEntity`, which the crossover walk and these
 * tests use, and `entityCondition`, which the database uses. There is no Postgres in
 * this suite, so the fixture below verifies the predicate and the rendered-SQL
 * assertions verify the query — the honest limit is that the second is a check on the
 * SQL we emit, not on what Postgres does with it.
 */

const play = (artistName: string, albumName: string | null, trackName: string): PlayRow =>
  ({ artistName, albumName, trackName })

/** A seeded fixture standing in for the scrobbles table. */
const FIXTURE: PlayRow[] = [
  play('Maisie Peters', 'The Good Witch', 'Body Better'),
  play('Maisie Peters', 'The Good Witch', 'Lost The Breakup'),
  play('Maisie Peters', 'The Good Witch', 'Body Better'),
  play('Maisie Peters', 'Lost The Breakup', 'Lost The Breakup'),
  play('Maisie Peters', 'Florescence', 'The Song'),
  play('Maisie Peters', 'Florescence', 'Blonde'),
  play('Maisie Peters', null, 'Psycho'),
  play('Taylor Swift', '1989', 'Style'),
  play('Taylor Swift', '1989', 'Blank Space'),
  play('Taylor Swift', 'Lover', 'Cruel Summer'),
  // The credit a substring match would fold into "Taylor Swift", moving a finish line.
  play('Taylor Swift feat. Bon Iver', 'folklore', 'exile'),
  // Casing that is not the same name. Exact means exact.
  play('taylor swift', '1989', 'Style'),
]

describe('matchesEntity — each type against the fixture', () => {
  it('an artist entity counts every play credited to exactly that artist', () => {
    expect(countMatching(FIXTURE, artistEntity('Taylor Swift'))).toBe(3)
    expect(countMatching(FIXTURE, artistEntity('Maisie Peters'))).toBe(7)
  })

  it('does not fold in a feat. credit or a different casing', () => {
    const taylor = artistEntity('Taylor Swift')
    expect(matchesEntity(play('Taylor Swift feat. Bon Iver', 'folklore', 'exile'), taylor)).toBe(false)
    expect(matchesEntity(play('taylor swift', '1989', 'Style'), taylor)).toBe(false)
  })

  it('an album entity counts plays from that record only', () => {
    const goodWitch: RaceEntity = {
      type: 'album', artist: 'Maisie Peters', albums: ['The Good Witch'],
    }
    expect(countMatching(FIXTURE, goodWitch)).toBe(3)
  })

  it('an album entity ignores a play with no album at all', () => {
    const florescence: RaceEntity = {
      type: 'album', artist: 'Maisie Peters', albums: ['Florescence'],
    }
    expect(matchesEntity(play('Maisie Peters', null, 'Psycho'), florescence)).toBe(false)
    expect(countMatching(FIXTURE, florescence)).toBe(2)
  })

  it('a track entity counts that song, by that artist, from any record', () => {
    const song: RaceEntity = {
      type: 'track', artist: 'Maisie Peters', tracks: ['Lost The Breakup'],
    }
    // Once from the album, once from the single's own album row.
    expect(countMatching(FIXTURE, song)).toBe(2)
  })

  it('a track entity does not count the same title by another artist', () => {
    const style: RaceEntity = { type: 'track', artist: 'Taylor Swift', tracks: ['Style'] }
    expect(countMatching(FIXTURE, style)).toBe(1) // not the lowercase-artist row
  })
})

/**
 * The reason albums and tracks are LISTS: Last.fm files a single under its own album
 * name, so one campaign is several album rows. A list folds them back together.
 */
describe('a multi-name side sums its parts and counts each play once', () => {
  const campaign: RaceEntity = {
    type: 'album',
    artist: 'Maisie Peters',
    albums: ['The Good Witch', 'Lost The Breakup'],
  }

  it('equals the sum of the parts', () => {
    const parts = campaign.albums.map(album =>
      countMatching(FIXTURE, { type: 'album', artist: 'Maisie Peters', albums: [album] }))
    expect(parts).toEqual([3, 1])
    expect(countMatching(FIXTURE, campaign)).toBe(4)
  })

  it('counts a single row once, not once per name it could have matched', () => {
    // A row whose album is named twice in the list is still one play.
    const doubled: RaceEntity = {
      type: 'album', artist: 'Maisie Peters', albums: ['Florescence', 'Florescence'],
    }
    expect(countMatching(FIXTURE, doubled)).toBe(2) // the two Florescence rows, not four
    expect(matchesEntity(play('Maisie Peters', 'Florescence', 'Blonde'), doubled)).toBe(true)
  })
})

describe('entityCondition — the SQL half of the same predicate', () => {
  const sqlFor = (e: RaceEntity) =>
    raceCountQuery(e, artistEntity('Nobody At All')).toSQL()

  it('matches an artist with plain equality, so the btree index serves it', () => {
    const { sql } = sqlFor(artistEntity('Taylor Swift'))
    expect(sql).toContain('"artist_name" = $')
    // lower()/ilike would seq-scan the whole table on every sync tick, forever.
    expect(sql).not.toContain('lower(')
    expect(sql).not.toContain('ilike')
  })

  it('matches an album on the artist AND one IN list, never a union of counts', () => {
    const { sql, params } = sqlFor({
      type: 'album', artist: 'Maisie Peters', albums: ['The Good Witch', 'Lost The Breakup'],
    })
    expect(sql).toContain('"album_name" in (')
    expect(sql).not.toContain('union')
    expect(params).toContain('The Good Witch')
    expect(params).toContain('Lost The Breakup')
  })

  it('matches a track the same way', () => {
    const { sql, params } = sqlFor({
      type: 'track', artist: 'Maisie Peters', tracks: ['Blonde'],
    })
    expect(sql).toContain('"track_name" in (')
    expect(params).toContain('Blonde')
  })

  it('counts both sides in one pass, so a side with no plays reads as 0 rather than absent', () => {
    const { sql } = raceCountQuery(artistEntity('Taylor Swift'), artistEntity('Maisie Peters')).toSQL()
    expect(sql.match(/count\(\*\) filter/g)).toHaveLength(2)
    expect(sql).not.toContain('group by')
  })
})

describe('entityLabel and sameEntity', () => {
  it('names a side by what it actually matches', () => {
    expect(entityLabel(artistEntity('Maisie Peters'))).toBe('Maisie Peters')
    expect(entityLabel({ type: 'album', artist: 'M', albums: ['A', 'B'] })).toBe('A + B')
    expect(entityLabel({ type: 'track', artist: 'M', tracks: ['Blonde'] })).toBe('Blonde')
  })

  it('recognises two sides that would count the same plays, whatever order they list', () => {
    const a: RaceEntity = { type: 'album', artist: 'M', albums: ['A', 'B'] }
    const b: RaceEntity = { type: 'album', artist: 'M', albums: ['B', 'A'] }
    expect(sameEntity(a, b)).toBe(true)
    expect(sameEntity(a, { type: 'album', artist: 'M', albums: ['A'] })).toBe(false)
    expect(sameEntity(artistEntity('M'), a)).toBe(false)
  })
})

/**
 * The live now-playing read is a different comparison from a stored row: it is what
 * Last.fm reports mid-song, against a hand-written name, so it is case-insensitive —
 * as the pre-existing artist check always was.
 */
describe('nowPlayingMatchesEntity', () => {
  const live = (artist: string, track: string, album: string | null = null) =>
    ({ artist, track, album })

  it('is case-insensitive on the artist', () => {
    expect(nowPlayingMatchesEntity(live('maisie peters', 'Blonde'), artistEntity('Maisie Peters')))
      .toBe(true)
  })

  it('matches an album side only when the live read names that album', () => {
    const florescence: RaceEntity = {
      type: 'album', artist: 'Maisie Peters', albums: ['Florescence'],
    }
    expect(nowPlayingMatchesEntity(live('Maisie Peters', 'Blonde', 'florescence'), florescence)).toBe(true)
    expect(nowPlayingMatchesEntity(live('Maisie Peters', 'Blonde', 'The Good Witch'), florescence)).toBe(false)
    // Many scrobblers omit the album on a now-playing submission. No album, no match —
    // an artist-only fallback would fire the decisive alert for the OTHER side of a
    // same-artist album race.
    expect(nowPlayingMatchesEntity(live('Maisie Peters', 'Blonde', null), florescence)).toBe(false)
  })

  it('matches a track side on the song', () => {
    const song: RaceEntity = { type: 'track', artist: 'Maisie Peters', tracks: ['Blonde'] }
    expect(nowPlayingMatchesEntity(live('Maisie Peters', 'blonde'), song)).toBe(true)
    expect(nowPlayingMatchesEntity(live('Maisie Peters', 'Psycho'), song)).toBe(false)
  })
})
