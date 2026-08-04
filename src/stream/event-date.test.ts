import { describe, it, expect } from 'vitest'
import {
  osloDay,
  parsePartialDate,
  markEventDate,
  readingEventDate,
  gardenEventDate,
  compareEntries,
  osloMonthStart,
} from './event-date.js'

describe('osloDay — the day Markus experienced, not the UTC day', () => {
  // Norway is UTC+2 in summer and UTC+1 in winter. A fixed offset misfiles a
  // digest by a day twice a year; arithmetic on the UTC date misfiles every
  // late-evening play all year.
  it('rolls a summer-evening play into the next local day (CEST, UTC+2)', () => {
    expect(osloDay(new Date('2026-06-30T23:30:00Z'))).toBe('2026-07-01')
  })

  it('rolls a winter-evening play into the next local day (CET, UTC+1)', () => {
    expect(osloDay(new Date('2026-01-15T23:30:00Z'))).toBe('2026-01-16')
  })

  it('keeps a summer play before 22:00 UTC on the same local day', () => {
    expect(osloDay(new Date('2026-06-30T21:59:00Z'))).toBe('2026-06-30')
  })

  it('keeps a winter play before 23:00 UTC on the same local day', () => {
    expect(osloDay(new Date('2026-01-15T22:59:00Z'))).toBe('2026-01-15')
  })

  it('places an early-morning UTC play on the same local day', () => {
    expect(osloDay(new Date('2026-06-30T00:30:00Z'))).toBe('2026-06-30')
  })

  it('handles the spring-forward night', () => {
    // Norway springs forward 02:00→03:00 on the last Sunday in March 2026 (the 29th).
    expect(osloDay(new Date('2026-03-29T00:30:00Z'))).toBe('2026-03-29')
    expect(osloDay(new Date('2026-03-28T23:30:00Z'))).toBe('2026-03-29')
  })

  it('handles the autumn-back night', () => {
    // Clocks go back 03:00→02:00 on the last Sunday in October 2026 (the 25th).
    expect(osloDay(new Date('2026-10-24T23:30:00Z'))).toBe('2026-10-25')
    expect(osloDay(new Date('2026-10-25T23:30:00Z'))).toBe('2026-10-26')
  })

  it('always returns a sortable YYYY-MM-DD', () => {
    expect(osloDay(new Date('2026-01-05T12:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('parsePartialDate — hand-written frontmatter', () => {
  it('resolves a bare year to its first day', () => {
    expect(parsePartialDate('2024')?.toISOString()).toBe('2024-01-01T00:00:00.000Z')
  })

  it('resolves a year-month to its first day', () => {
    expect(parsePartialDate('2024-03')?.toISOString()).toBe('2024-03-01T00:00:00.000Z')
  })

  it('takes a full date as written', () => {
    expect(parsePartialDate('2024-03-11')?.toISOString()).toBe('2024-03-11T00:00:00.000Z')
  })

  it('accepts a full timestamp', () => {
    expect(parsePartialDate('2024-03-11T09:15:00Z')?.toISOString()).toBe('2024-03-11T09:15:00.000Z')
  })

  it('tolerates surrounding whitespace', () => {
    expect(parsePartialDate('  2024-03-11 ')?.toISOString()).toBe('2024-03-11T00:00:00.000Z')
  })

  it('returns null for anything it cannot read, rather than the epoch', () => {
    // The failure mode being avoided: an unparseable date silently becoming
    // 1970-01-01 and pinning the note to the bottom of the archive forever.
    for (const bad of ['', '   ', 'i fjor', 'ukjent', 'null', 'March 2024']) {
      expect(parsePartialDate(bad)).toBeNull()
    }
  })

  it('refuses a day-first date rather than reading it as month-first', () => {
    // `new Date('11.03.2024')` returns 3 November. Markus writes Norwegian dates,
    // so accepting that would silently move a note eight months.
    expect(parsePartialDate('11.03.2024')).toBeNull()
    expect(parsePartialDate('11/03/2024')).toBeNull()
  })

  it('returns null for a non-string', () => {
    expect(parsePartialDate(null)).toBeNull()
    expect(parsePartialDate(undefined)).toBeNull()
  })

  it('rejects an implausible year, which is a typo rather than a date', () => {
    expect(parsePartialDate('0202-03-11')).toBeNull()
    expect(parsePartialDate('9999')).toBeNull()
  })
})

describe('markEventDate — the shelf date wins (ADR 0012)', () => {
  const published = new Date('2026-08-01T10:00:00Z')

  it('uses watched_at when present, even a decade before the post', () => {
    const watchedAt = new Date('2016-04-02T00:00:00Z')
    expect(markEventDate({ watchedAt, publishedAt: published })).toEqual(watchedAt)
  })

  it('falls back to published_at when there is no shelf date', () => {
    expect(markEventDate({ watchedAt: null, publishedAt: published })).toEqual(published)
  })

  it('excludes a mark with neither', () => {
    expect(markEventDate({ watchedAt: null, publishedAt: null })).toBeNull()
  })
})

describe('readingEventDate', () => {
  const published = new Date('2026-08-01T10:00:00Z')

  it('places a start on the reader\'s own start date', () => {
    expect(
      readingEventDate({ eventType: 'started_reading', startedDate: '2026-07-02', publishedAt: published })
        ?.toISOString(),
    ).toBe('2026-07-02T00:00:00.000Z')
  })

  it('places a finish on the reader\'s own finish date', () => {
    expect(
      readingEventDate({ eventType: 'finished_reading', finishedDate: '2026-07-20', publishedAt: published })
        ?.toISOString(),
    ).toBe('2026-07-20T00:00:00.000Z')
  })

  it('ignores the wrong end of the pair', () => {
    // A start event must not be dated by a finishedDate that happens to be present.
    expect(
      readingEventDate({ eventType: 'started_reading', finishedDate: '2026-07-20', publishedAt: published }),
    ).toEqual(published)
  })

  it('falls back to the post date when the reader recorded none', () => {
    for (const eventType of ['started_reading', 'finished_reading', 'review', 'quotation']) {
      expect(readingEventDate({ eventType, publishedAt: published })).toEqual(published)
    }
  })

  it('dates a review or quotation by when it was posted', () => {
    expect(
      readingEventDate({ eventType: 'review', startedDate: '2020-01-01', publishedAt: published }),
    ).toEqual(published)
  })

  it('excludes an event with no date at all', () => {
    expect(readingEventDate({ eventType: 'review', publishedAt: null })).toBeNull()
  })
})

describe('gardenEventDate', () => {
  it('uses the frontmatter date', () => {
    expect(gardenEventDate({ noteDate: '2024-03-11' })?.toISOString()).toBe('2024-03-11T00:00:00.000Z')
  })

  it('excludes an undated note rather than guessing', () => {
    expect(gardenEventDate({ noteDate: null })).toBeNull()
    expect(gardenEventDate({ noteDate: 'ein gong i fjor' })).toBeNull()
  })
})

describe('compareEntries — a strict total order', () => {
  const e = (iso: string, refId: string) => ({ eventAt: new Date(iso), refId })

  it('sorts newest first', () => {
    const sorted = [e('2024-01-01T00:00:00Z', 'a:1'), e('2026-01-01T00:00:00Z', 'a:2')]
      .sort(compareEntries)
    expect(sorted[0].refId).toBe('a:2')
  })

  it('breaks ties on ref_id descending, byte-wise like COLLATE "C"', () => {
    const same = '2026-01-01T00:00:00Z'
    const sorted = [e(same, 'post:a'), e(same, 'post:b'), e(same, 'mark:z')].sort(compareEntries)
    expect(sorted.map((x) => x.refId)).toEqual(['post:b', 'post:a', 'mark:z'])
  })

  it('orders uppercase before lowercase, as byte order does', () => {
    // A locale-aware comparison would put these the other way round, and then the
    // JS merge and the SQL ORDER BY would disagree about where a page ends.
    const same = '2026-01-01T00:00:00Z'
    const sorted = [e(same, 'post:A'), e(same, 'post:a')].sort(compareEntries)
    expect(sorted.map((x) => x.refId)).toEqual(['post:a', 'post:A'])
  })

  // The three ordering axioms. The keyset is only correct if these hold: a
  // comparator that is not a strict total order makes "the row after this one"
  // ambiguous, and pages then skip or repeat entries.
  const fixture = [
    e('2026-01-01T00:00:00Z', 'post:a'),
    e('2026-01-01T00:00:00Z', 'post:b'),
    e('2026-01-01T00:00:00Z', 'mark:a'),
    e('2024-06-30T22:00:00Z', 'scrobbleday:2024-06-30'),
    e('2016-04-02T00:00:00Z', 'mark:old'),
    e('2016-04-02T00:00:00Z', 'garden:note'),
  ]

  it('is antisymmetric', () => {
    for (const a of fixture) {
      for (const b of fixture) {
        // `|| 0` normalises -0, which Object.is distinguishes from 0.
        expect(Math.sign(compareEntries(a, b)) || 0).toBe(-Math.sign(compareEntries(b, a)) || 0)
      }
    }
  })

  it('is transitive', () => {
    for (const a of fixture) {
      for (const b of fixture) {
        for (const c of fixture) {
          if (compareEntries(a, b) <= 0 && compareEntries(b, c) <= 0) {
            expect(compareEntries(a, c)).toBeLessThanOrEqual(0)
          }
        }
      }
    }
  })

  it('calls two entries equal only when they are the same entry', () => {
    for (const a of fixture) {
      for (const b of fixture) {
        if (compareEntries(a, b) === 0) {
          expect(a.refId).toBe(b.refId)
          expect(a.eventAt.getTime()).toBe(b.eventAt.getTime())
        }
      }
    }
  })
})

describe('osloMonthStart', () => {
  it('is midnight on the 1st as the clock in Oslo reads it', () => {
    expect(osloMonthStart(2026, 1).toISOString()).toBe('2025-12-31T23:00:00.000Z') // CET
    expect(osloMonthStart(2026, 7).toISOString()).toBe('2026-06-30T22:00:00.000Z') // CEST
  })

  it('derives the offset per month rather than assuming one', () => {
    // Every month of a year, checked by formatting the result back into Oslo: it
    // must read as 00:00:00 on the 1st. A hard-coded +01:00 or +02:00 fails half
    // of these, and a fixed guess fails the two transition months either way.
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Oslo', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    for (const year of [1999, 2016, 2026, 2031]) {
      for (let month = 1; month <= 12; month++) {
        const parts: Record<string, string> = {}
        for (const p of fmt.formatToParts(osloMonthStart(year, month))) parts[p.type] = p.value
        expect([
          Number(parts.year), Number(parts.month), Number(parts.day),
          Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
        ]).toEqual([year, month, 1, 0, 0, 0])
      }
    }
  })

  it('advances strictly, so months can be chained into ranges', () => {
    let prev = osloMonthStart(2025, 1)
    for (let i = 1; i < 36; i++) {
      const next = osloMonthStart(2025 + Math.floor(i / 12), (i % 12) + 1)
      expect(next.getTime()).toBeGreaterThan(prev.getTime())
      prev = next
    }
  })
})
