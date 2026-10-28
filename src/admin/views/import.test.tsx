/** @jsxImportSource hono/jsx */
import { describe, it, expect } from 'vitest'
import { ImportPage, StorygraphImportResultPage, TripImportResultPage, TripTrackImportResultPage } from './import.js'
import type { TripTrackImportReport } from '../../jobs/import-trip-tracks.js'
import type { StorygraphImportReport } from '../../jobs/import-storygraph-reads.js'
import type { TripImportResult } from '../import.js'
import type { StoredTrip } from '../../lib/trip-prune.js'

// The result page is the only thing standing between reading a list and deleting the
// trips on it, so what is pinned here is when it offers that button — and, just as
// importantly, when it does not. A confirm form rendered beside a refusal would make
// the threshold advisory.

const trip = (id: string): StoredTrip => ({
  id,
  fromStation: 'Oslo S',
  toStation: 'Hamar',
  key: '2026-08-20 05:34:00',
  departureAt: new Date('2026-08-20T05:34:00Z'),
  departureLocal: new Date('2026-08-20T07:34:00Z'),
  arrivalAt: null,
  journey: 'Røros 2026',
  trainCode: null,
  status: 'Planned',
  distanceKm: 125,
  createdAt: new Date('2026-08-01T00:00:00Z'),
})

const result = (over: Partial<TripImportResult['prune']> = {}): TripImportResult => ({
  total: 4,
  inserted: 0,
  updated: 0,
  unchanged: 4,
  derivedAt: new Date('2026-08-20T12:00:00Z'),
  droppedJourneys: [],
  prune: {
    window: {
      from: new Date('2026-08-20T04:34:00Z'),
      to: new Date('2026-08-20T15:30:00Z'),
      fromKey: '2026-08-20 04:34:00',
      toKey: '2026-08-20 15:30:00',
    },
    inWindow: 5,
    candidates: [trip('a')],
    refusal: null,
    ...over,
  },
})

const render = (r: TripImportResult) => String(TripImportResultPage({ result: r }))

describe('TripImportResultPage', () => {
  it('lists what would go, and says plainly that nothing has gone', () => {
    const html = render(result())
    expect(html).toContain('Stored, but not in this export')
    expect(html).toContain('Nothing here has been deleted')
    expect(html).toContain('2026-08-20 05:34:00')
    expect(html).toContain('Røros 2026')
  })

  it('offers the confirm, carrying the range and the moment the plan was drawn', () => {
    const html = render(result())
    expect(html).toContain('action="/admin/import/trips/prune"')
    expect(html).toContain('name="trip" value="a"')
    expect(html).toContain('name="window_from" value="2026-08-20T04:34:00.000Z"')
    expect(html).toContain('name="window_to" value="2026-08-20T15:30:00.000Z"')
    expect(html).toContain('name="derived_at" value="2026-08-20T12:00:00.000Z"')
  })

  it('offers no confirm at all when the threshold refused', () => {
    // The refusal has to be the end of it. A button beside the explanation would make
    // the threshold a suggestion, which is exactly what it must not be.
    const html = render(result({ refusal: 'too many' }))
    expect(html).toContain('too many')
    expect(html).not.toContain('/admin/import/trips/prune')
  })

  it('says when a journey was deleted but its trips remain', () => {
    const html = render({
      ...result({ candidates: [] }),
      droppedJourneys: [{ journey: 'Champions League Naples', remaining: 14 }],
    })
    expect(html).toContain('Journey <strong>Champions League Naples</strong> was deleted')
    expect(html).toContain('<strong>14</strong> trips remain')
  })

  it('stays quiet about journeys when none was dropped', () => {
    expect(render(result())).not.toContain('Journeys no longer in this export')
  })

  it('offers no confirm when the export accounts for everything in its range', () => {
    const html = render(result({ candidates: [] }))
    expect(html).not.toContain('/admin/import/trips/prune')
    expect(html).not.toContain('Stored, but not in this export')
  })

  it('states the range, so the reader can see what was never eligible', () => {
    expect(render(result())).toContain('2026-08-20 15:30:00')
    expect(render(result())).toContain('5</strong> trips in that range')
  })
})

const sgReport = (over: Partial<StorygraphImportReport> = {}): StorygraphImportReport => ({
  actorApId: 'https://bookwyrm.social/user/mvrkws',
  rowsRead: 3,
  rowsWithReads: 2,
  booksMatched: 1,
  matchedByIsbn: 1,
  matchedByTitle: 0,
  unmatched: [],
  readsInserted: 2,
  readsUpdated: 0,
  readsUnchanged: 0,
  readsDeleted: 0,
  startsFilled: 1,
  finishesFilled: 0,
  readsAdded: 0,
  conflicts: [],
  unparsed: [],
  ...over,
})

describe('StoryGraph read dates import', () => {
  it('offers the upload with the configured BookWyrm actor prefilled', () => {
    const html = String(<ImportPage bookwyrmActors={['@mvrkws@bookwyrm.social']} />)
    expect(html).toContain('action="/admin/import/storygraph"')
    expect(html).toContain('value="@mvrkws@bookwyrm.social"')
  })

  it('lists conflicts and unmatched books, and says BookWyrm was kept', () => {
    const html = String(
      <StorygraphImportResultPage
        report={sgReport({
          conflicts: [{ book: 'Ducks', field: 'finished', bookwyrm: '2024-10-02', storygraph: '2024-10-03', reason: 'disagree' }],
          unmatched: [{ title: 'Only On StoryGraph', authors: ['A Writer'], reads: [{ started: null, finished: '2023-01-02' }] }],
        })}
      />,
    )
    expect(html).toContain('Conflicts (BookWyrm kept)')
    expect(html).toContain('2024-10-03')
    expect(html).toContain('Only On StoryGraph')
    expect(html).toContain('? → 2023-01-02')
  })

  it('shows neither table when there is nothing to list', () => {
    const html = String(<StorygraphImportResultPage report={sgReport()} />)
    expect(html).not.toContain('<h2>Conflicts</h2>')
    expect(html).not.toContain('<h2>Unmatched</h2>')
  })
})

const gpxReport = (over: Partial<TripTrackImportReport> = {}): TripTrackImportReport => ({
  tracksInFile: 299,
  waypointsInFile: 749,
  tracksInserted: 299,
  tracksUpdated: 0,
  tracksUnchanged: 0,
  tracksDeleted: 0,
  waypointsInserted: 749,
  waypointsUnchanged: 0,
  waypointsDeleted: 0,
  pointsStored: 117437,
  matched: 298,
  unmatched: [],
  departedTripsWithoutTrack: 3,
  problems: [],
  ...over,
})

describe('GPX import', () => {
  it('has its own form, separate from the CSV one', () => {
    const html = String(ImportPage({ bookwyrmActors: [] }))
    expect(html).toContain('action="/admin/import/trip-tracks"')
    expect(html).toContain('action="/admin/import/trips"')
  })

  it('lists the routes with no trip to join', () => {
    const html = String(
      TripTrackImportResultPage({
        report: gpxReport({
          matched: 297,
          unmatched: [
            { viaductTripId: '1735507', fromStation: 'Oslo S', toStation: 'Bergen', departureLocal: '2021-09-26 23:25:00' },
          ],
        }),
      }),
    )
    expect(html).toContain('Routes with no trip to join')
    expect(html).toContain('1735507')
    expect(html).toContain('2021-09-26 23:25:00')
  })

  it('stays quiet when every route joined', () => {
    const html = String(TripTrackImportResultPage({ report: gpxReport() }))
    expect(html).not.toContain('Routes with no trip to join')
    expect(html).not.toContain('could not be read')
  })
})
