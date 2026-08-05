/** @jsxImportSource hono/jsx */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../config.js', () => ({
  config: {
    STREAM_DOMAIN: 'meg.msge.no', APP_DOMAIN: 'bot.skvip.lol', APP_USERNAME: 'bot',
    STREAM_SOURCES: '',
    SESSION_SECRET: 'x'.repeat(32), STREAM_IMAGE_CACHE_MB: 250,
  },
}))

const { JourneyPage } = await import('./journey.js')

const at = (s: string) => new Date(s)
const render = (node: unknown) => String(node)

/** A post as the journey page gets it, hydrated and bound to a leg. */
function post(refId: string, when: string, body: string) {
  return {
    refId, eventAt: at(when), archivedAt: at(when), source: 'mastodon' as const,
    originUrl: `https://skvip.lol/@markus/${refId}`, kind: 'post' as const,
    html: `<p>${body}</p>`, contentWarning: null, sensitive: false, language: 'nn',
    attachments: [], hashtags: [], embedUrl: null, thread: [],
    trip: {
      relation: 'aboard' as const, fromStation: 'Malmö C', toStation: 'Göteborgs central',
      journey: 'NDC Copenhagen 2026', journeySlug: 'ndc-copenhagen-2026',
      operator: 'Statens Järnvägar', distanceKm: 298, night: false,
    },
  }
}

function leg(over: Partial<{
  id: string; fromStation: string; toStation: string; departureAt: Date;
  arrivalAt: Date | null; operator: string | null; distanceKm: number | null;
  night: boolean; postRefIds: string[]
}>) {
  return {
    id: 't1', fromStation: 'Bergen', toStation: 'Oslo S',
    departureAt: at('2026-05-30T04:19:00Z'), arrivalAt: at('2026-05-30T11:07:00Z'),
    operator: 'Vygruppen AS', distanceKm: 478, night: false, postRefIds: [],
    ...over,
  }
}

const journey = {
  name: 'NDC Copenhagen 2026', slug: 'ndc-copenhagen-2026', trips: 3, km: 820,
  tag: 'kodetoget', posts: 3, firstAt: at('2026-05-30T04:19:00Z'),
  lastAt: at('2026-06-05T10:03:00Z'), stations: [], operators: ['Vygruppen AS'],
  legs: [
    leg({ id: 't1', postRefIds: ['post:a'] }),
    leg({
      id: 't2', fromStation: 'Göteborgs central', toStation: 'Malmö C',
      departureAt: at('2026-05-30T15:55:00Z'), arrivalAt: at('2026-05-30T19:20:00Z'),
      operator: 'Øresundståg', distanceKm: 298, postRefIds: [],
    }),
    leg({
      id: 't3', fromStation: 'Malmö C', toStation: 'Københavns Hovedbanegård',
      departureAt: at('2026-05-31T06:05:00Z'), arrivalAt: at('2026-05-31T06:45:00Z'),
      operator: 'Øresundståg', distanceKm: 44, postRefIds: ['post:b', 'post:c'],
    }),
  ],
  postRefIds: ['post:a', 'post:b', 'post:c'],
}

// The router hydrates every post in one go, newest first — the chapters have to
// put them back in the order their leg listed them.
const entries = [
  post('post:c', '2026-05-31T06:30:00Z', 'Over Øresund'),
  post('post:b', '2026-05-31T06:07:00Z', 'På veg over brua'),
  post('post:a', '2026-05-30T08:00:00Z', 'Fyrste etappe'),
]

describe('the journey page reads forwards', () => {
  it('renders one chapter per leg, in departure order', () => {
    const html = render(<JourneyPage journey={journey as never} entries={entries as never} />)
    const chapters = [...html.matchAll(/id="etappe-(\d+)"/g)].map((m) => m[1])
    expect(chapters).toEqual(['1', '2', '3'])
  })

  it('files each post under the leg it was posted on', () => {
    const html = render(<JourneyPage journey={journey as never} entries={entries as never} />)
    const first = html.indexOf('id="etappe-1"')
    const third = html.indexOf('id="etappe-3"')
    expect(html.indexOf('Fyrste etappe')).toBeGreaterThan(first)
    expect(html.indexOf('Fyrste etappe')).toBeLessThan(third)
    expect(html.indexOf('På veg over brua')).toBeGreaterThan(third)
  })

  it('runs oldest first inside a chapter, so scrolling follows the journey', () => {
    // The whole point: start at the top, end at the bottom. The hydrated entries
    // arrive newest-first and must not be rendered in that order.
    const html = render(<JourneyPage journey={journey as never} entries={entries as never} />)
    expect(html.indexOf('På veg over brua')).toBeLessThan(html.indexOf('Over Øresund'))
  })

  it('keeps a leg nobody posted on as a chapter of its own', () => {
    const html = render(<JourneyPage journey={journey as never} entries={entries as never} />)
    expect(html).toContain('id="etappe-2"')
    expect(html).toContain('Ingenting lagt ut på denne etappa.')
  })

  it('gives each chapter its route, clock and facts', () => {
    const html = render(<JourneyPage journey={journey as never} entries={entries as never} />)
    expect(html).toContain('Bergen → Oslo S')
    expect(html).toContain('478 km')
    // Departure → arrival, in Europe/Oslo like every other time on the site.
    expect(html).toContain('06:19 → 13:07')
  })

  it('leaves the clock at the departure when no arrival was recorded', () => {
    const noArrival = { ...journey, legs: [leg({ arrivalAt: null })] }
    const html = render(<JourneyPage journey={noArrival as never} entries={[] as never} />)
    expect(html).toContain('06:19')
    expect(html).not.toContain('06:19 →')
  })

  it('links the route overview at the top to the chapters below it', () => {
    const html = render(<JourneyPage journey={journey as never} entries={entries as never} />)
    expect(html).toContain('href="#etappe-1"')
    expect(html).toContain('href="#etappe-3"')
  })

  it('drops the repeated travel line from the posts inside a chapter', () => {
    // The chapter heading has just said which train this was.
    const html = render(<JourneyPage journey={journey as never} entries={entries as never} />)
    expect(html).toContain('Om bord')
    expect(html).not.toContain('Malmö C → Göteborgs central')
  })

  it('says so plainly when the journey has no legs to show yet', () => {
    const upcoming = { ...journey, legs: [], postRefIds: [] }
    const html = render(<JourneyPage journey={upcoming as never} entries={[] as never} />)
    expect(html).toContain('Ingen etappar på denne reisa enno.')
  })
})
