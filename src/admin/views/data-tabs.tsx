/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import { CategoryPage, Section, Row, Stats, Field, Select, nf, nnDate, type BadgeDef } from './kit.js'
import { withQuery } from './ui.js'
import type { TabCtx } from './media-tabs.js'
import type { getReadingEvents } from '../../mcp/tools/reading-events.js'
import type { getTrainTrips } from '../../mcp/tools/train-trips.js'
import type { getLinkedinPosts } from '../../mcp/tools/linkedin-posts.js'
import type { getLinkedinStats } from '../../mcp/tools/linkedin-stats.js'
import type { JobStatus } from '../../jobs/job-runs.js'

// The tabs that had no page before the redesign: Lesingar, Turar, Ruter, LinkedIn
// Innlegg and Statistikk, and Jobbar (ADR 0073). Each reads the same handler its MCP
// tool answers with, so a tab cannot disagree with the tool about what is stored.

const clip = (text: string | null | undefined, at = 110) => {
  if (!text) return null
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > at ? `${flat.slice(0, at)}…` : flat
}
const join = (...parts: Array<string | null | undefined | false>) => parts.filter(Boolean).join(' · ')
const restParams = (ctx: TabCtx) => {
  const { page: _p, cursor: _c, notice: _n, ...rest } = ctx.q
  return { ...rest, tab: ctx.tab.id }
}

/** A cursor-paged list ends in one link: the next page, if there is one. */
const NextLink: FC<{ ctx: TabCtx; cursor: string | null }> = ({ ctx, cursor }) => (
  <div class="more">
    {ctx.q.cursor && <a href={withQuery(ctx.cat.href, restParams(ctx))}>‹ Nyaste</a>}
    {cursor && <a class="more-next" href={withQuery(ctx.cat.href, { ...restParams(ctx), cursor })}>Vis fleire</a>}
  </div>
)

/** Offset paging for the tools that page by number. */
const PageLinks: FC<{ ctx: TabCtx; page: number; hasMore: boolean }> = ({ ctx, page, hasMore }) => (
  page <= 1 && !hasMore ? null : (
    <div class="more">
      {page > 1 && <a href={withQuery(ctx.cat.href, { ...restParams(ctx), page: page - 1 })}>‹ Førre</a>}
      {hasMore && <a class="more-next" href={withQuery(ctx.cat.href, { ...restParams(ctx), page: page + 1 })}>Vis fleire</a>}
    </div>
  )
)

// --- Lesing → Lesingar -----------------------------------------------------------

type ReadingResult = Extract<Awaited<ReturnType<typeof getReadingEvents>>, { events: unknown }>

export const EVENT_LABEL: Record<string, [string, BadgeDef[1]]> = {
  started_reading: ['Byrja', 'blue'],
  finished_reading: ['Lese ut', 'green'],
  stopped_reading: ['Slutta', 'yellow'],
  review: ['Omtale', 'accent'],
  rating: ['Karakter', 'accent'],
  comment: ['Kommentar', 'grey'],
  quotation: ['Sitat', 'grey'],
  note: ['Notat', 'grey'],
  shelved: ['Hylla', 'grey'],
}

export const ReadingEventsView: FC<{ ctx: TabCtx; result: ReadingResult | { error: string }; actors: string[]; actor?: string }> = ({
  ctx, result, actors, actor,
}) => (
  <CategoryPage {...ctx}
    lead={actor ? `Frå ${actor}` : 'Ingen BookWyrm-konto er sett opp'}
    help={<>Lesehendingane slik get_reading_events ser dei: kvar start, slutt, omtale og kommentar frå BookWyrm. Lesevindauget til boka, med StoryGraph-datoar der BookWyrm manglar, står under tittelen (ADR 0063).</>}
    filtersActive={Boolean(ctx.q.event_type || (ctx.q.actor && actors.length > 1))}
    filters={<>
      <Field label="Type">
        <Select name="event_type" value={ctx.q.event_type}
          options={[['', 'Alle'], ...Object.entries(EVENT_LABEL).map(([k, [l]]): [string, string] => [k, l])]} />
      </Field>
      {actors.length > 1 && <Field label="Konto"><Select name="actor" value={actor} options={actors.map((a) => [a, a])} /></Field>}
    </>}
  >
    {'error' in result ? (
      <div class="banner-error"><div class="banner-title">Kunne ikkje hente lesingane</div><div class="banner-reason">{result.error}</div></div>
    ) : (
      <Section isEmpty={result.events.length === 0} empty="Ingen lesehendingar med dette filteret."
        more={<NextLink ctx={ctx} cursor={result.next_cursor} />}>
        {result.events.map((e) => {
          const [label, tone] = EVENT_LABEL[e.event_type] ?? [e.event_type, 'grey' as const]
          const window = e.book_started_date || e.book_finished_date
            ? `${e.book_started_date ?? '?'} → ${e.book_finished_date ?? '…'}` : null
          return (
            <Row title={e.book_title ?? e.review_title ?? '—'} href={e.ap_id}
              sub={join(e.book_author, nnDate(e.published_at), window, e.rating ? `★ ${e.rating}` : null,
                clip(e.quote ?? e.comment, 90), e.progress ? `side ${e.progress}` : null)}
              badges={[[label, tone]]} />
          )
        })}
      </Section>
    )}
  </CategoryPage>
)

// --- Reiser → Turar --------------------------------------------------------------

type TripsResult = Awaited<ReturnType<typeof getTrainTrips>>

const TRIP_STATUS: Record<string, BadgeDef> = {
  Completed: ['Fullført', 'green'],
  Planned: ['Planlagd', 'blue'],
  Cancelled: ['Innstilt', 'red'],
}

/** "fre. 14. aug. 2026 07:34" on the station's own clock. */
function localDeparture(at: Date | string | null, tz: string | null): string {
  if (!at) return '—'
  const d = typeof at === 'string' ? new Date(at) : at
  try {
    return d.toLocaleString('nn-NO', { timeZone: tz ?? 'Europe/Oslo', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ')
  }
}

export const TripsView: FC<{ ctx: TabCtx; result: TripsResult; page: number; now?: Date }> = ({ ctx, result, page, now }) => (
  <CategoryPage {...ctx}
    search={{ name: 'station', value: ctx.q.station, placeholder: 'Stasjon' }}
    help={<>Togturane frå viaduct.world-importen, nyaste først. Tida er klokka på avgangsstasjonen. Ein etappe som har gått tel som gjennomført sjølv om viaduct framleis seier «Planlagd» (ADR 0031).</>}
    filtersActive={Boolean(ctx.q.journey || ctx.q.year || ctx.q.status)}
    filters={<>
      <Field label="Reise"><input name="journey" value={ctx.q.journey ?? ''} /></Field>
      <Field label="År"><input name="year" inputmode="numeric" value={ctx.q.year ?? ''} /></Field>
      <Field label="Status"><Select name="status" value={ctx.q.status} options={[['', 'Alle'], ['Completed', 'Fullført'], ['Planned', 'Planlagd']]} /></Field>
    </>}
  >
    <Section isEmpty={result.trips.length === 0} empty="Ingen turar. Importer CSV-fila frå viaduct.world under Import."
      more={<PageLinks ctx={ctx} page={page} hasMore={result.next_cursor !== null} />}>
      {result.trips.map((t) => {
        const badges: BadgeDef[] = []
        // Departed counts as done whatever viaduct says: it freezes "Planned" on a row
        // imported once and never re-exported (ADR 0031).
        const departed = t.departureAt != null && new Date(t.departureAt).getTime() <= (now ?? new Date()).getTime()
        if (t.status === 'Planned' && departed) badges.push(['Gått', 'green', 'viaduct seier framleis Planned'])
        else if (t.status) badges.push(TRIP_STATUS[t.status] ?? [t.status, 'grey'])
        if (t.night) badges.push(['Natt', 'grey'])
        return (
          <Row title={`${t.from} → ${t.to}`}
            sub={join(localDeparture(t.departureAt, t.fromTz), t.journey, t.trainCode, t.operator)}
            badges={badges}
            metric={t.distanceKm != null ? `${nf(Number(t.distanceKm))} km` : undefined} />
        )
      })}
    </Section>
  </CategoryPage>
)

// --- Reiser → Ruter --------------------------------------------------------------

export interface RouteRow {
  viaductTripId: string
  fromStation: string
  toStation: string
  departureLocal: string
  measuredKm: number | null
  pointCount: number
  segments: number[][][] | null
  tripId: string | null
  journey: string | null
}

/**
 * A route's shape as a small SVG: an equirectangular projection scaled by the cosine of
 * the mean latitude, so Norway is not drawn twice as wide as it is. Each segment is its
 * own polyline and gaps are never bridged (ADR 0071); points are thinned to at most
 * `max` per segment, which a 56 px thumbnail cannot tell from the full track.
 */
export function routeSvgPath(segments: number[][][], size = 56, pad = 4, max = 60): string[] {
  const all = segments.flat()
  if (all.length < 2) return []
  const meanLat = all.reduce((s, p) => s + (p[1] ?? 0), 0) / all.length
  const k = Math.cos((meanLat * Math.PI) / 180) || 1
  const xs = all.map((p) => (p[0] ?? 0) * k)
  const ys = all.map((p) => p[1] ?? 0)
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const span = Math.max(maxX - minX, maxY - minY) || 1
  const scale = (size - pad * 2) / span
  const offX = pad + ((size - pad * 2) - (maxX - minX) * scale) / 2
  const offY = pad + ((size - pad * 2) - (maxY - minY) * scale) / 2
  return segments.filter((s) => s.length >= 2).map((seg) => {
    const step = Math.max(1, Math.ceil(seg.length / max))
    const pts = seg.filter((_, i) => i % step === 0 || i === seg.length - 1)
    return pts.map((p, i) => {
      const x = offX + ((p[0] ?? 0) * k - minX) * scale
      const y = offY + (maxY - (p[1] ?? 0)) * scale
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    }).join('')
  })
}

const RouteThumb: FC<{ segments: number[][][] | null }> = ({ segments }) => {
  const paths = segments ? routeSvgPath(segments) : []
  return (
    <svg class="route-thumb" viewBox="0 0 56 56" width="56" height="56" aria-hidden="true">
      {paths.map((d) => <path d={d} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />)}
    </svg>
  )
}

export const RoutesView: FC<{ ctx: TabCtx; rows: RouteRow[]; page: number; hasMore: boolean; coverage: { tracks: number; matched: number } }> = ({
  ctx, rows, page, hasMore, coverage,
}) => (
  <CategoryPage {...ctx}
    search={{ name: 'station', value: ctx.q.station, placeholder: 'Stasjon' }}
    help={<>Lina kvar etappe teikna i GPX-eksporten frå viaduct.world, kopla til turen med same stasjonar og lokale avgangstid. Den målte lengda blir vist, men aldri talt med i noko total (ADR 0070, 0071).</>}
    filtersActive={Boolean(ctx.q.matched || ctx.q.year)}
    filters={<>
      <Field label="År"><input name="year" inputmode="numeric" value={ctx.q.year ?? ''} /></Field>
      <Field label="Kopling"><Select name="matched" value={ctx.q.matched} options={[['', 'Alle'], ['yes', 'Med tur'], ['no', 'Utan tur']]} /></Field>
    </>}
  >
    <Stats items={[
      { n: nf(coverage.tracks), label: 'ruter lagra' },
      { n: nf(coverage.tracks - coverage.matched), label: 'utan tur å koplast til', tone: coverage.tracks - coverage.matched ? 'yellow' : undefined },
    ]} />
    <Section isEmpty={rows.length === 0} empty="Ingen ruter. Importer GPX-fila frå viaduct.world under Import."
      more={<PageLinks ctx={ctx} page={page} hasMore={hasMore} />}>
      {rows.map((r) => (
        <div class="r"><div class="r-row">
          <RouteThumb segments={r.segments} />
          <div class="r-main">
            <div class="r-title">{r.fromStation} → {r.toStation}</div>
            <div class="r-sub">{join(r.departureLocal.slice(0, 16), r.journey, `${nf(r.pointCount)} punkt`)}</div>
            {!r.tripId && <div class="r-badges"><span class="badge badge-yellow">Utan tur</span></div>}
          </div>
          {r.measuredKm != null && <div class="r-metric">{nf(r.measuredKm)} km</div>}
        </div></div>
      ))}
    </Section>
  </CategoryPage>
)

const PCT = new Intl.NumberFormat('nn-NO', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const pct = (v: number | null) => (v == null ? '—' : `${PCT.format(v * 100)} %`)

// --- LinkedIn → Innlegg ----------------------------------------------------------

type PostsResult = Awaited<ReturnType<typeof getLinkedinPosts>>

export const LinkedinPostsView: FC<{ ctx: TabCtx; result: PostsResult }> = ({ ctx, result }) => (
  <CategoryPage {...ctx}
    lead={`${nf(result.total)} innlegg`}
    help={<>Innlegga frå DMA-API-et, med dei siste tala frå XLSX-eksporten der dei finst. «Ventar på tal» tyder at ingen eksport har dekt innlegget enno.</>}
  >
    <Section isEmpty={result.posts.length === 0} empty="Ingen LinkedIn-innlegg enno. Dei kjem når DMA-synken har fått dei."
      more={<PageLinks ctx={ctx} page={result.page} hasMore={result.page * 25 < result.total} />}>
      {result.posts.map((p) => {
        const badges: BadgeDef[] = []
        if (!p.latest_metrics) badges.push(['Ventar på tal', 'grey'])
        if (p.is_reshare) badges.push(['Deling', 'blue'])
        if (!p.has_content) badges.push(['Berre tal', 'yellow', 'Eksporten har tal for eit innlegg synken ikkje har henta enno'])
        return (
          <Row title={clip(p.commentary, 90) ?? '(utan tekst)'} href={p.url}
            sub={join(p.posted_at ? nnDate(p.posted_at) : null,
              p.latest_metrics ? `${nf(p.latest_metrics.engagements)} engasjement` : null,
              p.latest_metrics?.engagement_rate != null ? pct(p.latest_metrics.engagement_rate) : null)}
            badges={badges}
            metric={p.latest_metrics ? nf(p.latest_metrics.impressions) : undefined} />
        )
      })}
    </Section>
  </CategoryPage>
)

// --- LinkedIn → Statistikk -------------------------------------------------------

type StatsResult = Awaited<ReturnType<typeof getLinkedinStats>>

const WEEKDAY_NN = ['', 'Måndag', 'Tysdag', 'Onsdag', 'Torsdag', 'Fredag', 'Laurdag', 'Sundag']

export const LinkedinStatsView: FC<{ ctx: TabCtx; stats: StatsResult }> = ({ ctx, stats }) => {
  const t = stats.totals
  return (
    <CategoryPage {...ctx}
      lead={t.first_posted ? `${t.first_posted} til ${t.last_posted}` : 'Ingen innlegg med dato'}
      help={<>Same tal som get_linkedin_stats, i Oslo-tid. Medianane er over innlegg med tal frå ein eksport, og <strong>n</strong> står ved kvar vekedag: med nokre titals innlegg kan ein dag kvile på eitt eller to, og då er rangeringa eit hint, ikkje ein dom.</>}
    >
      <Stats items={[
        { n: nf(t.posts), label: `innlegg, ${nf(t.posts_with_metrics)} med tal` },
        { n: nf(t.total_impressions), label: 'visningar i alt' },
        { n: nf(t.median_impressions != null ? Math.round(t.median_impressions) : null), label: `median visningar (${nf(t.impressions_p25 != null ? Math.round(t.impressions_p25) : null)} til ${nf(t.impressions_p75 != null ? Math.round(t.impressions_p75) : null)})` },
        { n: pct(t.median_engagement_rate), label: `median engasjement (${pct(t.engagement_rate_p25)} til ${pct(t.engagement_rate_p75)})` },
      ]} />
      <Section title="Per vekedag" id="weekday" isEmpty={stats.by_weekday.length === 0} empty="Ingen innlegg med dato.">
        {stats.by_weekday.map((w) => (
          <Row title={WEEKDAY_NN[w.weekday] ?? w.weekday_name}
            sub={`${w.posts} innlegg, n = ${w.n} · median ${nf(w.median_impressions != null ? Math.round(w.median_impressions) : null)} visningar`}
            badges={w.n < 3 ? [['Få innlegg', 'grey']] : undefined}
            metric={pct(w.median_engagement_rate)} />
        ))}
      </Section>
      <Section title="Kopling" id="join"
        help={<>Innlegga og tala er kopla på ein id henta frå kvar kjelde si URL. Null kopla mot tal på begge sider tyder at nøklane ikkje møtest.</>}>
        <Row title="Innlegg og eksportar" raw={JSON.stringify(stats.join_health, null, 2)} sub="Trykk for å sjå" />
      </Section>
    </CategoryPage>
  )
}

// --- System → Jobbar -------------------------------------------------------------

/** "kvar 30. sekund", "kvar time", "kvar 6. time", "kvar 7. dag". */
export function everyText(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `kvart ${s}. sekund`
  const m = Math.round(s / 60)
  if (m < 60) return m === 1 ? 'kvart minutt' : `kvart ${m}. minutt`
  const h = Math.round(m / 60)
  if (h < 24 || h % 24 !== 0) return h === 1 ? 'kvar time' : `kvar ${h}. time`
  const d = h / 24
  return d === 1 ? 'kvar dag' : `kvar ${d}. dag`
}

const ago = (d: Date, now: Date) => {
  const s = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000))
  if (s < 90) return `${s} s sidan`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min sidan`
  const h = Math.round(m / 60)
  if (h < 36) return `${h} t sidan`
  return nnDate(d)
}

export const JobsView: FC<{ ctx: TabCtx; jobs: JobStatus[]; now?: Date }> = ({ ctx, jobs, now = new Date() }) => {
  const active = jobs.filter((j) => j.intervalMs !== null)
  const failing = active.filter((j) => j.last && !j.last.ok)
  return (
    <CategoryPage {...ctx}
      lead={`${active.length} av ${jobs.length} jobbar er på`}
      help={<>Kvar jobb schedulereren køyrer, kor ofte, og korleis siste køyring gjekk. Køyringane blir lagra (dei siste 20 per jobb), så historikken overlever ein deploy. Ein jobb som er av, er slått av i .env.</>}
    >
      <Stats items={[
        { n: nf(active.length), label: 'jobbar på' },
        { n: nf(failing.length), label: 'feila siste køyring', tone: failing.length ? 'red' : 'green' },
      ]} />
      <Section title="Jobbar" id="jobs">
        {jobs.map((j) => {
          const badges: BadgeDef[] = []
          if (j.intervalMs === null) badges.push(['Av', 'grey', j.job.gate ? `Slå på med ${j.job.gate}` : undefined])
          else if (!j.last) badges.push(['Ikkje køyrd enno', 'blue'])
          else badges.push(j.last.ok ? ['OK', 'green'] : ['Feila', 'red'])
          if (j.lastFailure) badges.push([`Feila ${ago(j.lastFailure.ranAt, now)}`, 'yellow', j.lastFailure.error ?? undefined])
          const err = j.last && !j.last.ok ? j.last.error : j.lastFailure?.error
          return (
            <Row title={j.job.label}
              sub={join(j.intervalMs !== null ? everyText(j.intervalMs) : j.job.gate ? `av, slå på med ${j.job.gate}` : 'av',
                j.last ? `sist ${ago(j.last.ranAt, now)}` : null, j.last?.ok ? j.last.summary : null)}
              badges={badges}
              raw={err ?? undefined} />
          )
        })}
      </Section>
    </CategoryPage>
  )
}
