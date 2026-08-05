/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import { EntryView } from './entry.js'
import type { Entry } from '../entries.js'
import type { JourneySummary, JourneyDetail } from '../journeys.js'

/**
 * The journey pages.
 *
 * A journey is the one grouping in the archive that is neither a date nor a
 * platform: a named set of trips, and everything published while on them. The
 * timeline can only ever show these posts scattered across the days they happened;
 * here they sit under the journey they belong to.
 *
 * The posts are rendered by the ordinary EntryView, so a togselfie looks the same
 * here as on the front page. A second way to draw a post would eventually disagree
 * with the first — most likely about a content warning.
 */

const DATE_FMT = new Intl.DateTimeFormat('nn-NO', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Oslo',
})
const DAY_FMT = new Intl.DateTimeFormat('nn-NO', {
  day: 'numeric', month: 'short', timeZone: 'Europe/Oslo',
})
const TIME_FMT = new Intl.DateTimeFormat('nn-NO', {
  hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo',
})

/** "4.–14. juni 2026", or a single date when the journey was one day. */
function span(from: Date, to: Date): string {
  const a = DATE_FMT.format(from)
  const b = DATE_FMT.format(to)
  return a === b ? a : `${a} – ${b}`
}

const Facts: FC<{ j: JourneySummary }> = ({ j }) => (
  <p class="facts">
    {[
      `${j.trips} ${j.trips === 1 ? 'etappe' : 'etappar'}`,
      j.km > 0 ? `${j.km.toLocaleString('nn-NO')} km` : null,
      j.posts > 0 ? `${j.posts} ${j.posts === 1 ? 'innlegg' : 'innlegg'}` : null,
    ].filter(Boolean).map((f, i) => <>{i > 0 ? ' · ' : ''}{f}</>)}
  </p>
)

export const JourneyList: FC<{ journeys: JourneySummary[] }> = ({ journeys }) => (
  <section class="journeys">
    <h1>Reiser</h1>
    <p class="lede">
      Kvar reise er ei samling togetappar frå viaduct.world, med alt som vart lagt ut
      undervegs. Emneknaggen er ikkje skriven inn nokon stad — han er den som går att
      i innlegga frå reisa.
    </p>
    {journeys.length === 0 ? <p>Ingen reiser enno.</p> : null}
    <ul class="journey-list">
      {journeys.map((j) => (
        <li>
          <h2><a href={`/reise/${j.slug}`}>{j.name}</a></h2>
          <p class="when">{span(j.firstAt, j.lastAt)}</p>
          <Facts j={j} />
          {j.tag ? <p class="tags"><a href={`/emne/${encodeURIComponent(j.tag)}`}>#{j.tag}</a></p> : null}
        </li>
      ))}
    </ul>
  </section>
)

export const JourneyPage: FC<{ journey: JourneyDetail; entries: Entry[] }> = ({ journey, entries }) => (
  <section class="journey">
    <h1>{journey.name}</h1>
    <p class="when">{span(journey.firstAt, journey.lastAt)}</p>
    <Facts j={journey} />
    {journey.tag ? (
      <p class="tags"><a href={`/emne/${encodeURIComponent(journey.tag)}`}>#{journey.tag}</a></p>
    ) : null}
    {journey.operators.length > 0 ? (
      <p class="operators">{journey.operators.join(' · ')}</p>
    ) : null}

    <h2>Ruta</h2>
    <ol class="legs">
      {journey.legs.map((l) => (
        <li>
          <span class="leg-when">
            {DAY_FMT.format(l.departureAt)} {TIME_FMT.format(l.departureAt)}
          </span>
          {' '}
          <span class="leg-route">{l.fromStation} → {l.toStation}</span>
          {[
            l.operator,
            l.distanceKm ? `${l.distanceKm} km` : null,
            l.night ? 'nattog' : null,
          ].filter(Boolean).map((f) => <span class="leg-fact"> · {f}</span>)}
        </li>
      ))}
    </ol>

    <h2>Undervegs</h2>
    {entries.length === 0 ? (
      <p>Ingenting vart lagt ut på denne reisa.</p>
    ) : (
      <div class="entries">
        {entries.map((e) => <EntryView entry={e} />)}
      </div>
    )}

    <p class="back"><a href="/reise">Alle reiser</a></p>
  </section>
)
