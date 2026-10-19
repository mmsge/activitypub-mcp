import { describe, it, expect } from 'vitest'
import { parseDatesRead, parseStorygraphCsv, parseStorygraphDay, storygraphIsbn13 } from './parse-storygraph-csv.js'

const HEADER =
  'Title,Authors,Contributors,ISBN/UID,Format,Read Status,Date Added,Last Date Read,Dates Read,Read Count,Moods,Pace,Star Rating,Review,Owned?'

describe('parseStorygraphDay', () => {
  it('reads StoryGraph slashes and ISO hyphens as the same day', () => {
    expect(parseStorygraphDay('2024/03/15')).toBe('2024-03-15')
    expect(parseStorygraphDay('2024-3-5')).toBe('2024-03-05')
  })
  it('refuses a day that does not exist', () => {
    expect(parseStorygraphDay('2024/02/30')).toBeNull()
    expect(parseStorygraphDay('15/03/2024')).toBeNull()
    // Postgres DATE has no year 0, and one bad cell must not abort the whole import.
    expect(parseStorygraphDay('0000/01/01')).toBeNull()
  })
})

describe('parseDatesRead', () => {
  it('reads one range', () => {
    expect(parseDatesRead('2024/03/15-2024/03/17').reads).toEqual([{ started: '2024-03-15', finished: '2024-03-17' }])
  })

  it('keeps several comma-separated ranges as separate reads, oldest first', () => {
    expect(parseDatesRead('2026/05/28-2026/05/29, 2024/09/29-2024/10/02').reads).toEqual([
      { started: '2024-09-29', finished: '2024-10-02' },
      { started: '2026-05-28', finished: '2026-05-29' },
    ])
  })

  it('reads a lone day as a finish and a half-open range as whichever end it has', () => {
    expect(parseDatesRead('2024/03/17').reads).toEqual([{ started: null, finished: '2024-03-17' }])
    expect(parseDatesRead('2024/03/15-').reads).toEqual([{ started: '2024-03-15', finished: null }])
    expect(parseDatesRead('-2024/03/17').reads).toEqual([{ started: null, finished: '2024-03-17' }])
  })

  it('drops exact duplicates', () => {
    expect(parseDatesRead('2024/03/15-2024/03/17, 2024/03/15-2024/03/17').reads).toHaveLength(1)
  })

  it('reports a reversed range or garbage instead of guessing', () => {
    const out = parseDatesRead('2024/03/17-2024/03/15, someday, 2024/03/20')
    expect(out.reads).toEqual([{ started: null, finished: '2024-03-20' }])
    expect(out.unparsed).toEqual(['2024/03/17-2024/03/15', 'someday'])
  })

  it('is empty for an empty cell', () => {
    expect(parseDatesRead(null)).toEqual({ reads: [], unparsed: [] })
  })
})

describe('storygraphIsbn13', () => {
  it('keeps a valid ISBN-13 and expands an ISBN-10', () => {
    expect(storygraphIsbn13('978-0-14-303943-3')).toBe('9780143039433')
    expect(storygraphIsbn13('0143039431')).toBe('9780143039433')
  })
  it('is null for a StoryGraph uid or a bad checksum', () => {
    expect(storygraphIsbn13('a1b2c3d4-e5f6')).toBeNull()
    expect(storygraphIsbn13('9780143039434')).toBeNull()
  })
})

describe('parseStorygraphCsv', () => {
  it('parses the export, quoting and all, and keeps none of the out-of-scope columns', () => {
    const csv = [
      HEADER,
      '"Om udregning af rumfang I",Solvej Balle,,9788793718180,paperback,read,2024/03/01,2024/03/17,2024/03/15-2024/03/17,1,"reflective, slow",slow,4.5,"A review",Yes',
      'Ducks,Kate Beaton,,9781770462892,hardcover,read,2024/09/01,2026/05/29,"2024/09/29-2024/10/02, 2026/05/28-2026/05/29",2,,,5,,No',
      'Some Future Book,"Author One, Author Two",,a1b2c3,ebook,to-read,2025/01/01,,,0,,,,,No',
    ].join('\n')
    const rows = parseStorygraphCsv(csv)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      title: 'Om udregning af rumfang I',
      authors: ['Solvej Balle'],
      isbn13: '9788793718180',
      uid: '9788793718180',
      readStatus: 'read',
      reads: [{ started: '2024-03-15', finished: '2024-03-17' }],
      datesReadRaw: '2024/03/15-2024/03/17',
      unparsed: [],
    })
    expect(rows[1].reads).toHaveLength(2)
    expect(rows[2]).toMatchObject({ authors: ['Author One', 'Author Two'], isbn13: null, reads: [] })
    expect(JSON.stringify(rows)).not.toMatch(/review|reflective|4\.5/i)
  })

  it('falls back to Last Date Read when Dates Read is empty', () => {
    const rows = parseStorygraphCsv(`${HEADER}\nOld,A,,,,read,,2019/06/01,,1,,,,,`)
    expect(rows[0].reads).toEqual([{ started: null, finished: '2019-06-01' }])
  })

  it('refuses a CSV that is not a StoryGraph export', () => {
    expect(() => parseStorygraphCsv('from_station_name,to_station_name\nA,B')).toThrow(/Title, Authors, Dates Read/)
  })
})
