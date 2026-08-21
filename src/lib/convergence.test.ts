import { describe, it, expect } from 'vitest'
import {
  findCrossings,
  orderEvents,
  composeMessage,
  causeText,
  nynorskDuration,
  osloDay,
  osloStamp,
  type ConvergenceEvent,
  type CrossingNote,
} from './convergence.js'

const at = (iso: string) => new Date(iso)

/** `nn-NO` groups thousands with a NO-BREAK SPACE (U+00A0). That is correct in the
 *  push and unreadable in an assertion, so every expectation is written with an
 *  ordinary space and normalised here. */
const plain = (s: string) => s.replace(/ /g, ' ')

function scrobble(
  iso: string,
  track = 'A Song',
  artist = 'An Artist',
  album: string | null = null,
): ConvergenceEvent {
  return {
    at: at(iso),
    key: `${iso} ${track} ${artist}`,
    cause: { kind: 'scrobble', artist, track, album, url: null },
  }
}

function leg(iso: string, km: number, from = 'Oslo S', to = 'Bergen'): ConvergenceEvent {
  return {
    at: at(iso),
    key: `${from} ${to} ${iso}`,
    cause: { kind: 'leg', from, to, journey: null, km },
  }
}

describe('findCrossings', () => {
  it('records nothing when the counters never touch', () => {
    const result = findCrossings(
      [scrobble('2026-01-01T00:00:00Z'), scrobble('2026-01-01T00:01:00Z')],
      { scrobbles: 10, km: 100 },
    )
    expect(result.crossings).toEqual([])
    expect(result.scrobbles).toBe(12)
    expect(result.km).toBe(100)
  })

  it('a scrobble stepping past the kilometres makes an equality, never a crossover', () => {
    // km 100, scrobbles 99 — the next scrobble MUST land level rather than skip past.
    const result = findCrossings(
      [scrobble('2026-01-01T00:00:00Z'), scrobble('2026-01-01T00:05:00Z')],
      { scrobbles: 99, km: 100 },
    )
    expect(result.crossings.map(c => c.kind)).toEqual(['equality'])
    const [equality] = result.crossings
    expect(equality!.value).toBe(100)
    expect(equality!.gap).toBe(0)
    expect(equality!.leader).toBe('tie')
    // …and the following scrobble closes the window rather than opening a crossover.
    expect(equality!.endedAt).toEqual(at('2026-01-01T00:05:00Z'))
  })

  it('leaving an equality window is not a second crossing', () => {
    const result = findCrossings(
      [
        scrobble('2026-01-01T00:00:00Z'),
        scrobble('2026-01-01T00:05:00Z'),
        scrobble('2026-01-01T00:09:00Z'),
      ],
      { scrobbles: 99, km: 100 },
    )
    expect(result.crossings).toHaveLength(1)
    expect(result.crossings[0]!.kind).toBe('equality')
  })

  it('a kilometre lump that jumps clean over zero is a crossover', () => {
    // Scrobbles ahead by 40; a 1,176 km leg overshoots without ever being level.
    const result = findCrossings([leg('2026-10-29T13:12:00Z', 1176)], { scrobbles: 1000, km: 960 })
    expect(result.crossings.map(c => c.kind)).toEqual(['crossover'])
    const [crossover] = result.crossings
    expect(crossover!.gap).toBe(1136)
    expect(crossover!.leader).toBe('km')
    expect(crossover!.value).toBeNull()
  })

  it('a kilometre lump that lands exactly on zero is an equality', () => {
    const result = findCrossings([leg('2026-10-29T13:12:00Z', 40)], { scrobbles: 1000, km: 960 })
    expect(result.crossings.map(c => c.kind)).toEqual(['equality'])
    expect(result.crossings[0]!.value).toBe(1000)
  })

  it('a leg with no distance moves nothing and crosses nothing', () => {
    const result = findCrossings([leg('2026-01-01T00:00:00Z', 0)], { scrobbles: 100, km: 100 })
    expect(result.crossings).toEqual([])
    expect(result.km).toBe(100)
  })

  it('closes a window that was already open at the seed', () => {
    // The seed is level: the equality row exists from an earlier walk, so this walk
    // stamps its end rather than announcing it a second time.
    const result = findCrossings([scrobble('2020-01-11T11:09:45Z')], { scrobbles: 3298, km: 3298 })
    expect(result.crossings).toEqual([])
    expect(result.seedWindowClosedAt).toEqual(at('2020-01-11T11:09:45Z'))
  })

  it('is stable: the same events always yield the same (kind, occurredAt) pairs', () => {
    const events = [
      scrobble('2026-01-01T00:00:00Z'),
      leg('2026-01-02T00:00:00Z', 50),
      scrobble('2026-01-03T00:00:00Z'),
    ]
    const identity = (evts: ConvergenceEvent[]) =>
      findCrossings(evts, { scrobbles: 99, km: 100 })
        .crossings.map(c => `${c.kind}@${c.occurredAt.toISOString()}`)

    expect(identity([...events].reverse())).toEqual(identity(events))
  })

  it('orders a leg before a scrobble at an identical instant', () => {
    const ordered = orderEvents([scrobble('2026-01-01T00:00:00Z'), leg('2026-01-01T00:00:00Z', 5)])
    expect(ordered.map(e => e.cause.kind)).toEqual(['leg', 'scrobble'])
  })

  it('advances the watermark to the last event folded in', () => {
    const result = findCrossings([
      scrobble('2026-01-01T00:00:00Z'),
      scrobble('2026-01-05T00:00:00Z'),
    ])
    expect(result.watermarkAt).toEqual(at('2026-01-05T00:00:00Z'))
  })

  it('has no watermark when there was nothing to fold', () => {
    expect(findCrossings([], { scrobbles: 5, km: 5 }).watermarkAt).toBeNull()
  })
})

describe('the 2020 meeting', () => {
  // The one time these two counters have met. Kilometres had stood at 3,298 since the
  // last leg of Fyrste interrail 2016 and the scrobbles climbed to meet them; the
  // window closed on the next song, three minutes and ten seconds later.
  const LONDON_BOY = scrobble('2020-01-11T11:06:35Z', 'London Boy', 'Taylor Swift', 'Lover')
  const NEXT = scrobble('2020-01-11T11:09:45Z', 'Soon You Get Better', 'Taylor Swift', 'Lover')

  it('is found, with its cause and the width of the window', () => {
    const result = findCrossings([LONDON_BOY, NEXT], { scrobbles: 3297, km: 3298 })
    expect(result.crossings).toHaveLength(1)
    const [meeting] = result.crossings
    expect(meeting!.kind).toBe('equality')
    expect(meeting!.value).toBe(3298)
    expect(meeting!.occurredAt).toEqual(at('2020-01-11T11:06:35Z'))
    expect(meeting!.endedAt).toEqual(at('2020-01-11T11:09:45Z'))
    expect(causeText(meeting!.cause)).toBe('Taylor Swift, «London Boy» (Lover)')
  })

  it('reads as history, with the duration and the date it actually happened', () => {
    const [meeting] = findCrossings([LONDON_BOY, NEXT], { scrobbles: 3297, km: 3298 }).crossings
    const message = composeMessage(
      [{ crossing: meeting!, historical: true, previousEqualityAt: null }],
      { scrobbles: 51_959, km: 49_914 },
    )!
    expect(plain(message.title)).toBe('Likt: 3 298')
    expect(plain(message.body)).toContain('stod likt 11.01.2020 kl. 12:06, i 3 min 10 s.')
    expect(plain(message.body)).toContain('Utløyst av: Taylor Swift, «London Boy» (Lover).')
    expect(plain(message.body)).toContain('Fyrste møtet i arkivet.')
    expect(plain(message.body)).toContain('Oppdaga i ettertid')
    expect(plain(message.body)).toContain('Heile kilometer per etappe')
    expect(message.priority).toBe('high')
    expect(message.tags).toEqual(['train', 'headphones'])
  })
})

describe('composeMessage', () => {
  const equality: CrossingNote = {
    crossing: {
      kind: 'equality',
      occurredAt: at('2026-10-29T13:12:00Z'),
      value: 53_291,
      gap: 0,
      leader: 'tie',
      scrobbles: 53_291,
      km: 53_291,
      cause: {
        kind: 'scrobble',
        artist: 'Maisie Peters',
        track: 'Guy on a Horse',
        album: null,
        url: null,
      },
      endedAt: null,
    },
    historical: false,
    previousEqualityAt: at('2020-01-11T11:06:35Z'),
  }

  it('says nothing when nothing crossed', () => {
    expect(composeMessage([], { scrobbles: 1, km: 1 })).toBeNull()
  })

  it('announces a live equality in the present tense, with no duration', () => {
    const message = composeMessage([equality], { scrobbles: 53_291, km: 53_291 })!
    expect(plain(message.title)).toBe('Likt: 53 291')
    expect(plain(message.body)).toContain('står likt, 29.10.2026 kl. 14:12.')
    expect(plain(message.body)).not.toContain('i 0 s')
    expect(plain(message.body)).toContain('Førre møte: 11.01.2020.')
    expect(plain(message.body)).not.toContain('Oppdaga i ettertid')
  })

  it('names the new leader and the leg that did it', () => {
    const message = composeMessage([{
      crossing: {
        kind: 'crossover',
        occurredAt: at('2026-10-29T13:12:00Z'),
        value: null,
        gap: 15,
        leader: 'km',
        scrobbles: 49_998,
        km: 50_013,
        cause: {
          kind: 'leg',
          from: 'Praha hl.n.',
          to: 'København H',
          journey: null,
          km: 1176,
        },
        endedAt: null,
      },
      historical: false,
      previousEqualityAt: null,
    }], { scrobbles: 49_998, km: 50_013 })!

    expect(plain(message.title)).toBe('Togkilometer går forbi scrobbles')
    expect(plain(message.body)).toContain('Togkilometer 50 013 · scrobbles 49 998. Forsprang: 15.')
    expect(plain(message.body)).toContain('Praha hl.n.–København H, 1 176 km, 29.10.2026 kl. 14:12.')
    expect(message.priority).toBe('default')
  })

  it('puts a historical crossover in the past tense', () => {
    const message = composeMessage([{
      crossing: {
        kind: 'crossover',
        occurredAt: at('2026-10-29T13:12:00Z'),
        value: null,
        gap: -15,
        leader: 'scrobbles',
        scrobbles: 50_013,
        km: 49_998,
        cause: { kind: 'leg', from: 'A', to: 'B', journey: null, km: 10 },
        endedAt: null,
      },
      historical: true,
      previousEqualityAt: null,
    }], { scrobbles: 50_013, km: 49_998 })!

    expect(plain(message.title)).toBe('Scrobbles gjekk forbi togkilometer')
    expect(plain(message.body)).toContain('Forsprang: 15.')
    expect(plain(message.body)).toContain('Oppdaga i ettertid')
  })

  it('collapses several discoveries into one summary rather than a burst', () => {
    const second: CrossingNote = {
      ...equality,
      crossing: { ...equality.crossing, occurredAt: at('2026-11-02T09:00:00Z') },
      historical: true,
    }
    const message = composeMessage(
      [{ ...equality, historical: true }, second],
      { scrobbles: 53_400, km: 53_500 },
    )!
    expect(plain(message.title)).toBe('2 kryssingar funne')
    expect(plain(message.body)).toContain('Ein import endra historia bakover.')
    expect(plain(message.body)).toContain('2 møte og 0 leiarskifte, frå 29.10.2026 til 02.11.2026.')
    expect(plain(message.body)).toContain('Står no: togkilometer 53 500 · scrobbles 53 400.')
  })
})

describe('formatting', () => {
  it('writes an Oslo day and stamp the way they are read here', () => {
    // 13:12 UTC is 14:12 in Oslo in late October — the label is computed in the zone
    // it is read in, never by UTC arithmetic.
    expect(osloDay(at('2026-10-29T13:12:00Z'))).toBe('29.10.2026')
    expect(osloStamp(at('2026-10-29T13:12:00Z'))).toBe('29.10.2026 kl. 14:12')
  })

  it('does not roll midnight into the wrong day', () => {
    expect(osloStamp(at('2026-01-01T00:00:00Z'))).toBe('01.01.2026 kl. 01:00')
  })

  it('writes durations in at most two units', () => {
    expect(nynorskDuration(190_000)).toBe('3 min 10 s')
    expect(nynorskDuration(45_000)).toBe('45 s')
    expect(nynorskDuration(3_840_000)).toBe('1 t 4 min')
    expect(nynorskDuration(180_000)).toBe('3 min')
    expect(nynorskDuration(183_600_000)).toBe('2 d 3 t')
  })

  it('names a leg with its journey when it has one', () => {
    expect(plain(causeText({
      kind: 'leg', from: 'Oslo S', to: 'Bergen', journey: 'Bryllaupsreisa', km: 471,
    }))).toBe('Oslo S–Bergen (Bryllaupsreisa), 471 km')
  })
})
