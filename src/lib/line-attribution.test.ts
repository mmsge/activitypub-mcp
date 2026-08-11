import { describe, it, expect } from 'vitest'
import { attributeLeg, defaultRegistry, type Leg } from './line-attribution.js'

/**
 * Every leg below is a real one out of the archive, with the distance viaduct
 * actually recorded. That matters: the registry's kilometre posts are an independent
 * measurement, and these tests are what says the two agree closely enough to be
 * worth publishing.
 */

const leg = (from: string, to: string, km: number | null, seconds: number | null = 3600): Leg => ({
  fromStation: from,
  toStation: to,
  distanceKm: km,
  durationSeconds: seconds,
})

const kmOn = (a: ReturnType<typeof attributeLeg>, slug: string): number | undefined =>
  a.legs.find((l) => l.lineSlug === slug)?.onLineKm

/** The distance partition — crossing rows sit outside it by design. */
const partition = (a: ReturnType<typeof attributeLeg>) => a.legs.filter((l) => !l.crossed)
const crossed = (a: ReturnType<typeof attributeLeg>) => a.legs.filter((l) => l.crossed)

describe('a trip wholly on one line', () => {
  it('gives Ål→Bergen to Bergensbanen alone, and only the overlapping part', () => {
    const a = attributeLeg(leg('Ål', 'Bergen', 233))
    expect(a.status).toBe('resolved')
    expect(partition(a).map((l) => l.lineSlug)).toEqual(['bergensbanen'])
    // 233 of Bergensbanen's 371 km, not the whole line.
    expect(kmOn(a, 'bergensbanen')).toBe(233)
  })

  it('gives Oslo S→Hønefoss only the 112 km it covers, not all of Bergensbanen', () => {
    const a = attributeLeg(leg('Oslo S', 'Hønefoss', 112))
    expect(a.status).toBe('resolved')
    expect(kmOn(a, 'bergensbanen')).toBeUndefined()
    expect(partition(a).reduce((s, l) => s + l.onLineKm, 0)).toBeCloseTo(112, 1)
  })

  it('matches Raumabanen almost exactly — 114 recorded, 114.2 in the registry', () => {
    const a = attributeLeg(leg('Dombås', 'Åndalsnes', 114))
    expect(partition(a).map((l) => l.lineSlug)).toEqual(['raumabanen'])
    expect(a.scaleFactor).toBeGreaterThan(0.99)
    expect(a.scaleFactor).toBeLessThan(1.01)
    expect(a.scaleSuspect).toBe(false)
  })
})

describe('a trip across several lines', () => {
  const bergenOslo = attributeLeg(leg('Bergen', 'Oslo S', 478, 7 * 3600))

  it('splits Bergen→Oslo S across every line it uses', () => {
    expect(bergenOslo.status).toBe('resolved')
    expect(partition(bergenOslo).map((l) => l.lineSlug).sort()).toEqual(
      ['bergensbanen', 'drammenbanen', 'randsfjordbanen', 'sorlandsbanen'],
    )
  })

  it('sums the per-line kilometres to the recorded distance', () => {
    const total = partition(bergenOslo).reduce((s, l) => s + l.onLineKm, 0)
    expect(total).toBeCloseTo(478, 1)
  })

  it('gives Bergensbanen the lion\'s share, and not the whole 478', () => {
    expect(kmOn(bergenOslo, 'bergensbanen')).toBeGreaterThan(350)
    expect(kmOn(bergenOslo, 'bergensbanen')).toBeLessThan(380)
  })

  it('prorates the time by distance, summing back to the trip duration', () => {
    const total = partition(bergenOslo).reduce((s, l) => s + (l.onLineSeconds ?? 0), 0)
    expect(total).toBeCloseTo(7 * 3600, -1)
  })

  it('states the scale factor rather than swallowing the disagreement', () => {
    expect(bergenOslo.scaleFactor).not.toBeNull()
    expect(bergenOslo.scaleFactor!).toBeCloseTo(478 / 483.9, 2)
    expect(bergenOslo.scaleSuspect).toBe(false)
  })

  it('sums Oslo S→Trondheim to the recorded 546 across Gardermobanen and Dovrebanen', () => {
    const a = attributeLeg(leg('Oslo S', 'Trondheim', 546))
    expect(a.status).toBe('resolved')
    expect(partition(a).map((l) => l.lineSlug).sort()).toEqual(['dovrebanen', 'gardermobanen'])
    expect(partition(a).reduce((s, l) => s + l.onLineKm, 0)).toBeCloseTo(546, 1)
  })

  it('finds the Göteborg→Oslo route over two countries without an override', () => {
    const a = attributeLeg(leg('Göteborgs central', 'Oslo S', 344))
    expect(a.status).toBe('resolved')
    expect(a.method).toBe('kmposts')
    expect(partition(a).map((l) => l.lineSlug).sort()).toEqual(['norge-vanerbanan', 'ostfoldbanen'])
  })
})

describe('routings that are genuinely open', () => {
  const noOverrides = { ...defaultRegistry(), overrides: [] }

  it('calls Oslo S→Trondheim ambiguous when nothing pins it — Dovre or Røros', () => {
    const a = attributeLeg(leg('Oslo S', 'Trondheim', 546), noOverrides)
    expect(a.status).toBe('ambiguous')
    expect(a.reason).toMatch(/two routes within/)
  })

  it('calls Bergen→Oslo S ambiguous when nothing pins it — Drammen or Roa', () => {
    const a = attributeLeg(leg('Bergen', 'Oslo S', 478), noOverrides)
    expect(a.status).toBe('ambiguous')
  })

  it('settles both once the override exists, and says so', () => {
    for (const a of [
      attributeLeg(leg('Oslo S', 'Trondheim', 546)),
      attributeLeg(leg('Bergen', 'Oslo S', 478)),
    ]) {
      expect(a.status).toBe('resolved')
      expect(a.method).toBe('override_pair')
      expect(a.overrideReason).toBeTruthy()
    }
  })

  it('applies an override in the direction it was not written in', () => {
    const there = attributeLeg(leg('Bergen', 'Oslo S', 478))
    const back = attributeLeg(leg('Oslo S', 'Bergen', 478))
    expect(back.method).toBe('override_pair')
    expect(partition(back).map((l) => l.lineSlug).sort())
      .toEqual(partition(there).map((l) => l.lineSlug).sort())
  })

  it('would otherwise take the Roa route for Oslo S→Hønefoss, which is why it is pinned', () => {
    const a = attributeLeg(leg('Oslo S', 'Hønefoss', 112), noOverrides)
    // Not ambiguous — 98 km via Roa beats 112.5 via Drammen outright, and is wrong.
    expect(a.status).toBe('resolved')
    expect(partition(a).map((l) => l.lineSlug)).toContain('gjovikbanen')
    // With the override it goes the way the train goes.
    const pinned = attributeLeg(leg('Oslo S', 'Hønefoss', 112))
    expect(partition(pinned).map((l) => l.lineSlug)).toContain('drammenbanen')
  })
})

describe('named crossings', () => {
  it('counts the Øresund bridge once for København H→Malmö C', () => {
    const a = attributeLeg(leg('Københavns Hovedbanegård', 'Malmö C', 44))
    expect(crossed(a).map((l) => l.lineSlug)).toEqual(['oresundsbroa'])
  })

  it('counts it once in each direction, so a day return is two crossings', () => {
    const out = attributeLeg(leg('Københavns Hovedbanegård', 'Malmö C', 44))
    const back = attributeLeg(leg('Malmö C', 'Københavns Hovedbanegård', 42))
    const total = [...crossed(out), ...crossed(back)].filter((l) => l.lineSlug === 'oresundsbroa')
    expect(total).toHaveLength(2)
  })

  it('counts it for a trip whose endpoints are nowhere near it', () => {
    const a = attributeLeg(leg('Göteborgs central', 'Hamburg Hbf', 840))
    expect(crossed(a).map((l) => l.lineSlug)).toContain('oresundsbroa')
    expect(crossed(a).map((l) => l.lineSlug)).toContain('storebeltsbrua')
  })

  it('does not count a crossing the trip stopped short of', () => {
    // Ørestad is on the Danish side; Nørreport to Vesterport never leaves Copenhagen.
    const a = attributeLeg(leg('Nørreport', 'Vesterport', 1))
    expect(crossed(a)).toHaveLength(0)
  })

  it('counts the Channel Tunnel on London→Bruxelles, where neither end is a portal', () => {
    const a = attributeLeg(leg('London St. Pancras', 'Bruxelles-Midi - Brussel-Zuid', 372))
    expect(crossed(a).map((l) => l.lineSlug)).toContain('kanaltunnelen')
  })

  it('does not count the Channel Tunnel on Bruxelles→Paris', () => {
    const a = attributeLeg(leg('Bruxelles-Midi - Brussel-Zuid', 'Paris Nord', 313))
    expect(crossed(a).map((l) => l.lineSlug)).not.toContain('kanaltunnelen')
  })

  it('counts Ulrikstunnelen on the nine kilometres from Arna to Bergen', () => {
    const a = attributeLeg(leg('Arna', 'Bergen', 9))
    expect(crossed(a).map((l) => l.lineSlug)).toContain('ulrikstunnelen')
  })

  it('keeps crossings out of the distance partition', () => {
    const a = attributeLeg(leg('Københavns Hovedbanegård', 'Malmö C', 44))
    expect(partition(a).reduce((s, l) => s + l.onLineKm, 0)).toBeCloseTo(44, 1)
  })
})

describe('what it refuses to answer', () => {
  it('leaves a ferry crossing unresolved rather than inventing a line', () => {
    const a = attributeLeg(leg('Hundested', 'Rorvig', 5))
    expect(a.status).toBe('unresolved')
    expect(a.legs).toHaveLength(0)
    expect(a.reason).toBeTruthy()
  })

  it('names the station it did not recognise', () => {
    const a = attributeLeg(leg('Bergen', 'Ulaanbaatar', 6000))
    expect(a.status).toBe('unresolved')
    expect(a.reason).toContain('Ulaanbaatar')
  })

  it('refuses a leg that starts where it ends', () => {
    expect(attributeLeg(leg('Bergen', 'Bergen', 0)).status).toBe('unresolved')
  })
})

describe('scaling and proration edge cases', () => {
  it('does not scale when the trip has no recorded distance', () => {
    const a = attributeLeg(leg('Dombås', 'Åndalsnes', null))
    expect(a.status).toBe('resolved')
    expect(a.scaleFactor).toBeNull()
    expect(kmOn(a, 'raumabanen')).toBeCloseTo(114.2, 1)
  })

  it('leaves the time null when the trip has no duration', () => {
    const a = attributeLeg(leg('Dombås', 'Åndalsnes', 114, null))
    expect(a.legs.every((l) => l.onLineSeconds === null)).toBe(true)
  })

  it('does not cry wolf over rounding on a very short leg', () => {
    // Viaduct records 3 km to Jåttåvågen; the registry says 4.4. Both are "about right".
    const a = attributeLeg(leg('Stavanger', 'Jåttåvågen', 3))
    expect(a.status).toBe('resolved')
    expect(a.scaleSuspect).toBe(false)
  })

  it('does flag a long leg whose registry length is far off', () => {
    const a = attributeLeg(leg('Dombås', 'Åndalsnes', 500))
    expect(a.scaleSuspect).toBe(true)
  })
})
