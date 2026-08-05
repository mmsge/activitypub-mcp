/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import { EntryView } from './entry.js'
import type { Entry } from '../entries.js'
import type { JourneySummary, JourneyDetail, JourneyLeg } from '../journeys.js'

/**
 * The journey pages.
 *
 * A journey is the one grouping in the archive that is neither a date nor a
 * platform: a named set of trips, and everything published while on them. The
 * timeline can only ever show these posts scattered across the days they happened;
 * here they sit under the journey they belong to.
 *
 * The detail page is the one view on the site that runs *forwards*. Everywhere else
 * is newest-first, because a stream is something you check; a journey is something
 * you read, and reading it means starting where the journey started. Each leg is a
 * chapter, in departure order, with the posts made on that leg underneath it in the
 * order they were written — so scrolling from the top follows the trip from
 * departure to arrival.
 *
 * The posts are rendered by the ordinary EntryView, so a togselfie looks the same
 * here as on the front page. A second way to draw a post would eventually disagree
 * with the first — most likely about a content warning. It is passed `briefTrip`,
 * which drops the "Om bord · Malmö C → Göteborgs central · 298 km" line the
 * timeline needs: inside a chapter the heading has just said that.
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

/** The anchor a chapter is reached by, and that "Ruta" links to. */
function legAnchor(i: number): string {
  return `etappe-${i + 1}`
}

/** "06:19 → 13:07", or just the departure where no arrival was recorded. */
function legClock(l: JourneyLeg): string {
  const dep = TIME_FMT.format(l.departureAt)
  return l.arrivalAt ? `${dep} → ${TIME_FMT.format(l.arrivalAt)}` : dep
}

function legFacts(l: JourneyLeg): string[] {
  return [
    l.operator,
    l.distanceKm ? `${l.distanceKm} km` : null,
    l.night ? 'nattog' : null,
  ].filter((f): f is string => Boolean(f))
}

/**
 * One chapter: a leg, then what was posted on it.
 *
 * A leg with nothing posted on it is still a chapter. Skipping it would leave gaps
 * in a route the page has just listed in full, and a train ride nobody wrote
 * anything on is a fact about the journey rather than an empty slot.
 */
const Chapter: FC<{ leg: JourneyLeg; index: number; entries: Entry[] }> = ({ leg, index, entries }) => (
  <section class="chapter" id={legAnchor(index)}>
    <h2 class="chapter-head">
      <span class="chapter-no">{index + 1}</span>
      <span class="leg-route">{leg.fromStation} → {leg.toStation}</span>
    </h2>
    <p class="chapter-when">
      <span class="leg-when">{DATE_FMT.format(leg.departureAt)} · {legClock(leg)}</span>
      {legFacts(leg).map((f) => <span class="leg-fact"> · {f}</span>)}
    </p>
    {entries.length === 0 ? (
      <p class="chapter-empty">Ingenting lagt ut på denne etappa.</p>
    ) : (
      <div class="entries">
        {entries.map((e) => <EntryView entry={e} briefTrip />)}
      </div>
    )}
  </section>
)

export const JourneyPage: FC<{ journey: JourneyDetail; entries: Entry[] }> = ({ journey, entries }) => {
  // The router hydrates every post on the journey in one go, newest first. Index it
  // so each chapter can pick out its own without a query per leg, and read it back
  // in the order the leg listed them — oldest first, the way the chapter reads.
  const byRefId = new Map(entries.map((e) => [e.refId, e]))
  const chapters = journey.legs.map((leg) => ({
    leg,
    entries: leg.postRefIds.map((r) => byRefId.get(r)).filter((e): e is Entry => e != null),
  }))

  return (
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
        {journey.legs.map((l, i) => (
          <li>
            <a href={`#${legAnchor(i)}`}>
              <span class="leg-when">
                {DAY_FMT.format(l.departureAt)} {TIME_FMT.format(l.departureAt)}
              </span>
              {' '}
              <span class="leg-route">{l.fromStation} → {l.toStation}</span>
            </a>
            {legFacts(l).map((f) => <span class="leg-fact"> · {f}</span>)}
          </li>
        ))}
      </ol>

      {chapters.length === 0 ? (
        <p>Ingen etappar på denne reisa enno.</p>
      ) : (
        chapters.map((c, i) => <Chapter leg={c.leg} index={i} entries={c.entries} />)
      )}

      <p class="back"><a href="/reise">Alle reiser</a></p>
    </section>
  )
}
