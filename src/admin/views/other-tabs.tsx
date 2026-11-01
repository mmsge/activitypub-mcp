/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import { CategoryPage, Section, Row, More, Field, Stats, nnDate, nf, type BadgeDef } from './kit.js'
import type { TabCtx } from './media-tabs.js'
import type { QueryParams } from './ui.js'
import { actorHandle } from '../attention.js'
import type { getThreadLeaderboard } from '../../mcp/tools/thread-leaderboard.js'
import type { FailingRoot } from '../../lib/thread-store.js'
import type { getPostBreakouts } from '../../mcp/tools/post-breakouts.js'
import type { getStationDiscrepancies, StationComparison } from '../../mcp/tools/station-discrepancies.js'
import type { RestEndpoint } from '../../rest/table.js'
import { SourceBadge } from './ui.js'

// Fediverse, Reiser, LinkedIn and System tabs. Each keeps the data and the rules its old
// page had; the help texts are the old paragraphs, shortened (ADR 0073).

const params = (ctx: TabCtx): QueryParams => {
  const { page: _p, notice: _n, ...rest } = ctx.q
  return { ...rest, tab: ctx.tab.id }
}

const clip = (text: string | null | undefined, at = 90) => {
  if (!text) return '—'
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > at ? `${flat.slice(0, at)}…` : flat
}

const stamp = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : '—')

// --- Aktivitetar --------------------------------------------------------------------

export interface ActivityRow {
  id: string
  type: string
  actorApId: string
  objectType: string | null
  receivedAt: Date
  processed: boolean
  processingError: string | null
  raw: unknown
}

function activityBadge(a: ActivityRow): BadgeDef {
  if (a.processingError) return ['Feil', 'red', a.processingError]
  if (a.processed) return ['OK', 'green']
  return ['Ventar', 'yellow']
}

export const ActivitiesView: FC<{ ctx: TabCtx; rows: ActivityRow[]; page: number; hasMore: boolean }> = ({ ctx, rows, page, hasMore }) => (
  <CategoryPage {...ctx}
    search={{ name: 'type', value: ctx.q.type, placeholder: 'Type (Create, Announce …)' }}
    help={<>Alt innboksen har teke imot, nyaste først. Trykk på ei rad for å sjå JSON-en slik ho kom inn.</>}
    filtersActive={Boolean(ctx.q.actor)}
    filters={<Field label="Aktør-URL"><input name="actor" value={ctx.q.actor ?? ''} /></Field>}
  >
    <Section isEmpty={rows.length === 0} empty="Ingen aktivitetar med dette filteret."
      more={<More base={ctx.cat.href} params={params(ctx)} page={page} hasMore={hasMore} />}>
      {rows.map((a) => (
        <Row title={a.objectType ? `${a.type} · ${a.objectType}` : a.type}
          sub={<span class="mono">{actorHandle(a.actorApId)} · {stamp(a.receivedAt)}</span>}
          badges={[activityBadge(a)]} raw={JSON.stringify(a.raw, null, 2)} />
      ))}
    </Section>
  </CategoryPage>
)

// --- Innlegg ---------------------------------------------------------------------

export interface ObjectRow {
  id: string
  type: string
  actorApId: string
  contentText: string | null
  url: string | null
  publishedAt: Date | null
  attachments: unknown
  deletedAt: Date | null
  raw: unknown
}

function attachmentSummary(att: unknown): string | null {
  const list = att as Array<{ mediaType?: string }> | null
  if (!list?.length) return null
  const images = list.filter((a) => a.mediaType?.startsWith('image/')).length
  const videos = list.filter((a) => a.mediaType?.startsWith('video/')).length
  return [images && `${images} bilete`, videos && `${videos} video`].filter(Boolean).join(', ') || null
}

export const ObjectsView: FC<{ ctx: TabCtx; rows: ObjectRow[]; page: number; hasMore: boolean }> = ({ ctx, rows, page, hasMore }) => (
  <CategoryPage {...ctx}
    search={{ name: 'q', value: ctx.q.q, placeholder: 'Søk i teksten' }}
    help={<>Lagra innlegg frå alle kontoane som blir følgde. Sletta innlegg står att, merka «Sletta».</>}
    filtersActive={Boolean(ctx.q.actor || ctx.q.type)}
    filters={<>
      <Field label="Aktør-URL"><input name="actor" value={ctx.q.actor ?? ''} /></Field>
      <Field label="Type"><input name="type" value={ctx.q.type ?? ''} placeholder="Note, Article …" /></Field>
    </>}
  >
    <Section isEmpty={rows.length === 0} empty="Ingen innlegg med dette filteret."
      more={<More base={ctx.cat.href} params={params(ctx)} page={page} hasMore={hasMore} />}>
      {rows.map((o) => {
        const badges: BadgeDef[] = [[o.type, 'blue']]
        if (o.deletedAt) badges.push(['Sletta', 'red'])
        const att = attachmentSummary(o.attachments)
        return (
          <Row title={clip(o.contentText, 120)}
            sub={<span class="mono">{[actorHandle(o.actorApId), o.publishedAt ? nnDate(o.publishedAt) : null, att].filter(Boolean).join(' · ')}</span>}
            badges={badges} raw={JSON.stringify(o.raw, null, 2)} />
        )
      })}
    </Section>
  </CategoryPage>
)

// --- Følgjer ---------------------------------------------------------------------

export interface FollowRow {
  actorApId: string
  status: string
  followedAt: Date
  acceptedAt: Date | null
  handle: string | null
  displayName: string | null
  iconUrl: string | null
}

const FOLLOW_BADGE: Record<string, BadgeDef> = {
  accepted: ['Godkjend', 'green'],
  pending: ['Ventar', 'yellow'],
  rejected: ['Avvist', 'red'],
}

export const FollowsView: FC<{ ctx: TabCtx; rows: FollowRow[] }> = ({ ctx, rows }) => (
  <CategoryPage {...ctx}
    lead={`${nf(rows.filter((f) => f.status === 'accepted').length)} godkjende, ${nf(rows.filter((f) => f.status === 'pending').length)} ventar`}
    help={<>Styrt av miljøvariabelen <code>FOLLOW_ACTORS</code> og synka når tenaren startar. Ein ventande følgjar kan ta frå nokre minutt til nokre timar.</>}
  >
    <Section isEmpty={rows.length === 0} empty="Ingen følgjer enno. Legg handtak i FOLLOW_ACTORS og start på nytt.">
      {rows.map((f) => (
        <Row title={f.displayName ?? f.handle ?? f.actorApId}
          sub={<span class="mono">{f.handle ?? actorHandle(f.actorApId)} · sidan {nnDate(f.followedAt)}</span>}
          badges={[FOLLOW_BADGE[f.status] ?? [f.status, 'grey']]} />
      ))}
    </Section>
  </CategoryPage>
)

// --- Trådar ----------------------------------------------------------------------

type ThreadReport = Extract<Awaited<ReturnType<typeof getThreadLeaderboard>>, { threads: unknown }>

export const ThreadsView: FC<{ ctx: TabCtx; report: ThreadReport; failures: FailingRoot[] }> = ({ ctx, report, failures }) => {
  const { walk } = report
  const unwalked = Math.max(0, walk.roots_total - walk.roots_walked)
  return (
    <CategoryPage {...ctx}
      lead={walk.blocked_reason ? `Av: ${walk.blocked_reason}` : `Går kvar ${walk.interval_hours}. time · sist ${walk.last_walk_at ? nnDate(walk.last_walk_at) : 'aldri'}`}
      help={<>Rangert etter <strong>svar frå andre</strong>. Rota er node 0 og hans eiga, så ein tråd der han berre snakkar med seg sjølv fell ut. Ingen svartekst står her fordi ingen er lagra (ADR 0057).</>}
    >
      <Stats items={[
        { n: nf(walk.roots_walked), label: `av ${nf(walk.roots_total)} røter gått${unwalked > 0 ? `, ${nf(unwalked)} treng backfill` : ''}` },
        { n: nf(walk.roots_unsettled), label: `ikkje sette, kø for dagleg gang (${walk.settled_days} d)` },
        { n: nf(walk.roots_failing), label: 'gangar som feila', tone: walk.roots_failing > 0 ? 'red' : 'green' },
        { n: walk.blocked_reason ? 'Av' : 'På', label: 'trådgangaren', tone: walk.blocked_reason ? 'red' : 'green' },
      ]} />
      <Section title="Leiartavle" id="leaderboard" isEmpty={report.threads.length === 0}
        empty={walk.roots_walked === 0 ? 'Ingenting gått enno. Køyr npm run walk-threads -- --backfill.' : 'Ingenting gått har fått svar frå andre.'}>
        {report.threads.map((t) => (
          <Row title={clip(t.text, 80)} href={t.url}
            sub={`${nnDate(t.published_at)} · ${t.node_count} nodar, djupn ${t.max_depth}, ${t.external_participant_count} personar · nyaste ${nnDate(t.newest_node_at)}`}
            badges={[t.settled ? ['Sett', 'green'] : ['Open', 'blue']]}
            metric={nf(t.external_node_count)} />
        ))}
      </Section>
      <Section title="Gangar som feila" id="failures"
        help={<>Ein feila henting skriv aldri over eit lagra tre, så ein 404 les ikkje som at samtalen vart tom. Difor er feila lista her.</>}
        isEmpty={failures.length === 0} empty="Ingen gangar feilar.">
        {failures.map((f) => (
          <Row title={f.url ?? f.rootApId} href={f.url ?? f.rootApId}
            sub={<span class="tone-red">{f.walkError}</span>}
            metric={`${f.walkAttempts}×`} badges={[[nnDate(f.walkedAt), 'grey']]} />
        ))}
      </Section>
    </CategoryPage>
  )
}

// --- Breakouts -------------------------------------------------------------------

type BreakoutReport = Extract<Awaited<ReturnType<typeof getPostBreakouts>>, { actors: unknown }>

const RUNG: Record<string, BadgeDef> = { p90: ['p90', 'blue'], p99: ['p99', 'yellow'], best: ['rekord', 'green'] }
const rung = (r: string): BadgeDef => RUNG[r] ?? [r, 'blue']

function unarmed(reason: string | null, n: number, need: number): BadgeDef {
  if (reason === 'no_posts') return ['Ingenting målt', 'red', 'Ingenting skåra i vindauget. Sjå om kontoen i det heile blir henta.']
  if (reason === 'no_engagement_data') return [`Opphavet melder ingen tal (${n}, alle null)`, 'red', 'Kjem aldri til å gå av.']
  return [`For få innlegg (${n}/${need})`, 'yellow']
}

export const BreakoutsView: FC<{ ctx: TabCtx; report: BreakoutReport }> = ({ ctx, report }) => {
  const armed = report.actors.flatMap((a) => a.armed.map((p) => ({ a, p })))
  return (
    <CategoryPage {...ctx}
      lead={report.blocked_reason ? `Av: ${report.blocked_reason}` : `Varslar til ${report.topic}`}
      help={<>Ein post sin skåre er <strong>toppen</strong> over heile historikken, aldri siste måling: tal går ned, og eit tilbaketrekt hjarte skal ikkje senke lista (ADR 0036). Vekter {report.weights.favourites} / {report.weights.reblogs} / {report.weights.replies}, golv {report.floor}.</>}
    >
      <Stats items={[
        { n: report.blocked_reason ? 'Av' : 'På', label: 'breakout-varsel', tone: report.blocked_reason ? 'red' : 'green' },
        { n: nf(armed.length), label: 'klare til å gå av no', tone: armed.length > 0 ? 'yellow' : undefined },
        { n: nf(report.recent.length), label: 'varsla nyleg' },
        { n: report.fast_lane_minutes === 0 ? 'Av' : `${report.fast_lane_minutes} min`, label: `snøggfil · samandrag ${report.digest_hour < 0 ? 'av' : `kl. ${report.digest_hour}`}` },
      ]} />
      <Section title="Kvar lista ligg" id="bars" isEmpty={report.actors.length === 0} empty="Ingen kontoar blir følgde."
        help={<>Persentilane er over dei siste {report.actors[0]?.baseline.window_days ?? '—'} dagane, rekorden er for all tid. Talet etter pila er det ein post faktisk må nå.</>}>
        {report.actors.map((a) => (
          <Row title={a.actor}
            sub={`${a.baseline.posts_in_window} innlegg · median ${Math.round(a.baseline.median)} · p90 → ${a.thresholds.p90} · p99 → ${a.thresholds.p99} · rekord ${a.baseline.best} → ${a.thresholds.best}`}
            badges={[a.baseline.established ? ['Etablert', 'green'] : unarmed(a.baseline.reason, a.baseline.posts_in_window, report.min_posts)]} />
        ))}
      </Section>
      <Section title="Klare no" id="armed" isEmpty={armed.length === 0} empty="Ingenting er klart."
        help={<>På ein verkande tenar tømmer denne seg innan ein time. Ei rad som blir ståande tyder at pushen feilar, ikkje at ingenting kvalifiserer.</>}>
        {armed.map(({ a, p }) => (
          <Row title={clip(p.text, 70)} href={p.url}
            sub={`${a.actor} · ${p.favourites} / ${p.reblogs} / ${p.replies} · no ${p.score}`}
            badges={[rung(p.would_fire), ...(p.spent_rung ? [[`brukt ${RUNG[p.spent_rung]?.[0] ?? p.spent_rung}`, 'grey'] as BadgeDef] : []),
              ...(p.visibility && p.visibility !== 'public' ? [[p.visibility, 'yellow'] as BadgeDef] : [])]}
            metric={nf(p.peak_score)} />
        ))}
      </Section>
      <Section title="Alt varsla" id="recent" isEmpty={report.recent.length === 0}
        empty="Ingenting varsla enno. Første køyring frø stilt, med vilje.">
        {report.recent.map((r) => (
          <Row title={clip(r.text, 70)} href={r.url}
            sub={`${nnDate(r.fired_at)} · ${r.actor} · topp ${r.peak_score}, no ${r.current_score}`}
            badges={[rung(r.rung)]} metric={nf(r.score)} />
        ))}
      </Section>
    </CategoryPage>
  )
}

// --- Synlegheit ------------------------------------------------------------------

export interface VisibilityCount {
  actorApId: string
  handle: string | null
  software: string | null
  visibility: string
  count: number
}

export interface VisibilitySample {
  apId: string
  url: string | null
  visibility: string
  publishedAt: Date | null
  contentText: string | null
  to: string | null
  cc: string | null
}

export interface VisibilityData {
  counts: VisibilityCount[]
  withheld: VisibilitySample[]
  publishable: VisibilitySample[]
  unknownTotal: number
  streamEnabled: boolean
  streamDomain: string
  includeUnlisted: boolean
  configuredHandles: string[]
  unresolvedHandles: string[]
  markCounts: { total: number; withNote: number; withoutNote: number }
}

const VIS: Record<string, BadgeDef> = {
  public: ['Offentleg', 'green'],
  unlisted: ['Ulista', 'yellow'],
  private: ['Følgjarar/direkte', 'grey'],
  unknown: ['Ukjend', 'red'],
}

export const VisibilityView: FC<{ ctx: TabCtx; d: VisibilityData }> = ({ ctx, d }) => {
  const grand = d.counts.reduce((s, c) => s + c.count, 0)
  const publicTotal = d.counts.filter((c) => c.visibility === 'public').reduce((s, c) => s + c.count, 0)
  const byActor = new Map<string, VisibilityCount[]>()
  for (const c of d.counts) {
    const key = c.handle ?? c.actorApId
    byActor.set(key, [...(byActor.get(key) ?? []), c])
  }
  return (
    <CategoryPage {...ctx}
      lead={d.streamEnabled ? `Straumen er oppe på ${d.streamDomain}` : 'Straumen er av (STREAM_DOMAIN er tom)'}
      help={<>Sjekken før den offentlege straumen. Klassifiseringa feilar lukka: utan lesbar <code>to</code>/<code>cc</code> blir eit innlegg halde tilbake. Sjå over at det haldne bør haldast, og at eit utval offentlege verkeleg var offentlege hos opphavet.</>}
    >
      <Stats items={[
        { n: nf(publicTotal), label: `av ${nf(grand)} innlegg er offentlege`, tone: 'green' },
        { n: d.includeUnlisted ? 'Med' : 'Utan', label: 'ulista innlegg i straumen', tone: d.includeUnlisted ? 'yellow' : undefined },
        { n: nf(d.unknownTotal), label: 'utan lesbar adressering', tone: d.unknownTotal > 0 ? 'red' : undefined },
        { n: nf(d.markCounts.withoutNote), label: `av ${nf(d.markCounts.total)} NeoDB-merke manglar Note-en sin`, tone: d.markCounts.withoutNote > 0 ? 'yellow' : undefined },
      ]} />
      <Section title="Kjelder" id="sources" isEmpty={d.configuredHandles.length === 0} empty="STREAM_SOURCES er tom, så ingenting kan publiserast.">
        {d.configuredHandles.map((h) => (
          <Row title={<span class="mono">{h}</span>}
            badges={[d.unresolvedHandles.includes(h) ? ['Ukjend aktør, utelaten', 'red'] : ['OK', 'green']]} />
        ))}
      </Section>
      <Section title="Per konto" id="counts" isEmpty={d.counts.length === 0} empty="Ingen innlegg lagra.">
        {[...byActor.entries()].map(([handle, rows]) => (
          <Row title={handle} sub={rows[0]?.software ?? undefined}
            badges={rows.sort((a, b) => b.count - a.count).map((r): BadgeDef => {
              const [label, tone] = VIS[r.visibility] ?? [r.visibility, 'grey']
              return [`${label} ${nf(r.count)}`, tone]
            })} />
        ))}
      </Section>
      <Section title="Utval haldne tilbake" id="withheld" isEmpty={d.withheld.length === 0} empty="Ingenting halde tilbake."
        help={<>Sjekk at kvart av desse verkeleg skal haldast tilbake. Trykk for adresseringa slik ho er lagra.</>}>
        {d.withheld.map((r) => (
          <Row title={clip(r.contentText)} sub={nnDate(r.publishedAt)} badges={[VIS[r.visibility] ?? [r.visibility, 'grey']]}
            raw={`to: ${r.to ?? '—'}\ncc: ${r.cc ?? '—'}`} />
        ))}
      </Section>
      <Section title="Utval som blir publiserte" id="publishable" isEmpty={d.publishable.length === 0} empty="Ingenting å publisere."
        help={<>Opne nokre hos opphavet og stadfest at dei verkeleg er offentlege der.</>}>
        {d.publishable.map((r) => (
          <Row title={clip(r.contentText)} sub={nnDate(r.publishedAt)}
            action={r.url ? <a class="btn r-act" href={r.url} target="_blank" rel="noopener">Opne ↗</a> : undefined} />
        ))}
      </Section>
    </CategoryPage>
  )
}

// --- Stasjonar -------------------------------------------------------------------

type StationReport = Awaited<ReturnType<typeof getStationDiscrepancies>>

const pos = (lat: number | null, lon: number | null) => (lat == null || lon == null ? '—' : `${lat.toFixed(4)}, ${lon.toFixed(4)}`)
const osm = (lat: number, lon: number) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`

const PinButton: FC<{ s: StationComparison }> = ({ s }) => (
  <form method="post" action="/admin/stations/pin" style="margin:0">
    <input type="hidden" name="name" value={s.name} />
    <input type="hidden" name="latitude" value={String(s.viaduct_latitude)} />
    <input type="hidden" name="longitude" value={String(s.viaduct_longitude)} />
    <button type="submit" class="r-act" title="Fest til viaduct-posisjonen">Fest</button>
  </form>
)

const StationRow: FC<{ s: StationComparison; showDistance: boolean }> = ({ s, showDistance }) => (
  <Row title={s.name}
    sub={<>
      <span class="mono">lagra {pos(s.latitude, s.longitude)}</span>
      {s.display_name && <> · {s.display_name}{s.country_code ? ` (${s.country_code.toUpperCase()})` : ''}</>}
      <br />
      {s.viaduct_latitude != null && s.viaduct_longitude != null
        ? <a class="mono" href={osm(s.viaduct_latitude, s.viaduct_longitude)} target="_blank" rel="noopener">viaduct {pos(s.viaduct_latitude, s.viaduct_longitude)}</a>
        : null}
    </>}
    badges={s.source === 'manual' ? [['Manuell', 'grey']] : undefined}
    metric={showDistance ? `${s.distance_km} km` : undefined}
    action={<PinButton s={s} />} />
)

export const StationsView: FC<{ ctx: TabCtx; report: StationReport }> = ({ ctx, report }) => (
  <CategoryPage {...ctx}
    lead={`Samanlikna med viaduct sine eigne posisjonar, ${report.min_km} km eller meir er usemje`}
    help={<>Kvar stasjon ein tur nemner, mot viaduct.world sitt waypoint med same namn frå GPX-importen. «Fest» flyttar stasjonen dit og merkar han manuell, så geokodaren aldri flyttar han att. Ei flytting på {report.min_km} km eller meir tømmer òg landet og vêret (ADR 0072).</>}
  >
    {report.coverage.viaduct_waypoints === 0 && (
      <div class="banner-error"><div class="banner-title">Ingen viaduct-waypoints lagra</div>
        <div class="banner-reason">Importer GPX-fila under Import først.</div></div>
    )}
    <Stats items={[
      { n: nf(report.disagreeing.length), label: `${report.min_km} km eller meir frå viaduct`, tone: report.disagreeing.length ? 'yellow' : undefined },
      { n: nf(report.coverage.agreeing), label: 'samde med viaduct', tone: 'green' },
      { n: nf(report.not_geocoded.length), label: 'ikkje geokoda, viaduct har posisjon' },
      { n: nf(report.no_waypoint.length), label: 'utan viaduct-waypoint' },
    ]} />
    <Section title="Usamde" id="disagreeing" isEmpty={report.disagreeing.length === 0} empty="Alle stasjonar er samde med viaduct.">
      {report.disagreeing.map((s) => <StationRow s={s} showDistance={true} />)}
    </Section>
    {report.not_geocoded.length > 0 && (
      <Section title="Ikkje geokoda" id="not-geocoded">
        {report.not_geocoded.map((s) => <StationRow s={s} showDistance={false} />)}
      </Section>
    )}
    {report.no_waypoint.length > 0 && (
      <Section title="Utan viaduct-waypoint" id="no-waypoint">
        <div class="r"><div class="r-row"><div class="r-sub">{report.no_waypoint.join(' · ')}</div></div></div>
      </Section>
    )}
  </CategoryPage>
)

// --- LinkedIn --------------------------------------------------------------------

export interface LinkedinHealth {
  enabled: boolean
  status: import('../../lib/source-health.js').TokenStatus
  lastSuccessAt: Date | null
  lastDataAt: Date | null
  lastError: string | null
  /** What the last attempt concluded and on what evidence. See ADR 0039. */
  lastNote: string | null
  lastHttpStatus: number | null
  posts: number
  metricRows: number
  latestExport: string | null
}

export const LinkedinView: FC<{ ctx: TabCtx; data: LinkedinHealth }> = ({ ctx, data }) => (
  <CategoryPage {...ctx}
    lead={`Siste eksport: ${data.latestExport ?? 'ingen'}`}
    help={<>Innlegga kjem frå DMA-API-et (LINKEDIN_DMA_TOKEN), tala frå XLSX-eksporten under Import. Eit avvist token stoppar nye innlegg, men det som alt er lagra er framleis gyldig (ADR 0033, 0034, 0039).</>}
  >
    {data.status === 'unauthorized' && (
      <div class="banner-error" role="alert">
        <div class="banner-title">Tokenet blir avvist</div>
        <div class="banner-reason">Lag eit nytt (sjå LinkedIn-delen av README) og køyr npm run sync-linkedin.</div>
      </div>
    )}
    {data.status === 'stale' && <div class="notice">Synken har ikkje fullført på ei stund, så innlegga står still.</div>}
    {data.status === 'awaiting_data' && (
      <div class="notice">
        Synken fullfører, men LinkedIn har ikkje laga <code>MEMBER_SHARE_INFO</code> enno. Kom profilsonden tilbake med
        data, er det ingenting å fikse, og eit nytt token startar berre ventinga på nytt. Køyr{' '}
        <code>npm run probe-linkedin</code> for å sjå no.
      </div>
    )}
    {!data.enabled && <div class="notice">LINKEDIN_DMA_TOKEN er tom, så synken er av.</div>}
    <Stats items={[
      { n: nf(data.posts), label: 'innlegg (DMA)' },
      { n: nf(data.metricRows), label: 'statistikkrader (XLSX)' },
    ]} />
    <Section title="DMA-synk" id="dma">
      <Row title="Status" sub={`Sist OK ${stamp(data.lastSuccessAt)} · data sist ${stamp(data.lastDataAt)}`}
        action={<span style="padding-right:8px"><SourceBadge status={data.status} lastError={data.lastError}
          lastSuccessAt={data.lastSuccessAt} lastDataAt={data.lastDataAt} /></span>} />
      {data.lastHttpStatus !== null && <Row title="Siste svar" metric={`HTTP ${data.lastHttpStatus}`} />}
      {data.lastNote && <Row title="Siste notat" raw={data.lastNote} sub="Trykk for å sjå" />}
    </Section>
  </CategoryPage>
)

// --- Verktøy ---------------------------------------------------------------------

export interface InfraRoute {
  methods: string
  path: string
  description: string
}

/**
 * Hand-maintained list of the non-data routes mounted by the server. These are
 * not in any central registry, so keep this in sync with `src/index.ts` and the
 * federation / OAuth routers if routes change.
 */
export const INFRA_ROUTES: InfraRoute[] = [
  { methods: 'GET', path: '/actor', description: 'ActivityPub actor document' },
  { methods: 'GET', path: '/users/{username}', description: 'Actor document (username alias)' },
  { methods: 'POST', path: '/actor/inbox', description: 'Inbox (also /users/{username}/inbox and shared /inbox)' },
  { methods: 'GET', path: '/actor/outbox', description: 'Outbox collection' },
  { methods: 'GET', path: '/actor/followers', description: 'Followers collection' },
  { methods: 'GET', path: '/actor/following', description: 'Following collection' },
  { methods: 'GET', path: '/.well-known/webfinger', description: 'WebFinger actor discovery' },
  { methods: 'GET', path: '/nodeinfo', description: 'NodeInfo discovery' },
  { methods: 'GET', path: '/nodeinfo/2.0', description: 'NodeInfo 2.0 document' },
  { methods: 'GET', path: '/.well-known/oauth-authorization-server', description: 'OAuth authorization server metadata' },
  { methods: 'GET', path: '/.well-known/oauth-protected-resource', description: 'OAuth protected resource metadata' },
  { methods: 'POST', path: '/oauth/register', description: 'Dynamic client registration' },
  { methods: 'GET / POST', path: '/oauth/authorize', description: 'OAuth authorization endpoint' },
  { methods: 'POST', path: '/oauth/token', description: 'OAuth token endpoint' },
  { methods: 'POST', path: '/oauth/revoke', description: 'OAuth token revocation' },
  { methods: 'ALL', path: '/mcp', description: 'MCP transport (Streamable HTTP)' },
  { methods: 'GET', path: '/api/v1/', description: 'REST API discovery document' },
  { methods: 'GET', path: '/health', description: 'Health check' },
  { methods: 'GET', path: '/admin/*', description: 'Admin UI (this dashboard)' },
]

function paramsFor(ep: RestEndpoint) {
  const typeOf = (name: string): string => {
    if (ep.numbers.includes(name)) return 'number'
    if (ep.booleans.includes(name)) return 'boolean'
    if (ep.arrays.includes(name)) return 'array'
    return 'string'
  }
  return Object.entries(ep.schema.shape).map(([name, field]) => ({
    name,
    required: !(field as { isOptional(): boolean }).isOptional(),
    type: typeOf(name),
  }))
}

export const ToolsView: FC<{ ctx: TabCtx; endpoints: RestEndpoint[]; infra: InfraRoute[] }> = ({ ctx, endpoints, infra }) => {
  const term = (ctx.q.q ?? '').toLowerCase()
  const shown = term
    ? endpoints.filter((e) => e.name.toLowerCase().includes(term) || e.description.toLowerCase().includes(term))
    : endpoints
  return (
    <CategoryPage {...ctx}
      search={{ name: 'q', value: ctx.q.q, placeholder: 'Søk i verktøy' }}
      help={<>MCP-verktøya og HTTP-API-et denne tenaren eksponerer, lese direkte frå registeret. Kvart MCP-verktøy har eit tilsvarande <code>/api/v1</code>-endepunkt som svarar med same data.</>}
    >
      <Stats items={[
        { n: nf(endpoints.length), label: 'MCP-verktøy og REST-endepunkt' },
        { n: nf(infra.length), label: 'infrastruktur- og federeringsruter' },
      ]} />
      <Section title="Data-API" id="api" isEmpty={shown.length === 0} empty="Ingen verktøy samsvarar med søket.">
        {shown.map((ep) => (
          <Row title={<span class="mono">{ep.name}</span>}
            sub={<><span class="mono">/api/v1{ep.path}</span><br />{ep.description}</>}
            raw={paramsFor(ep).map((p) => `${p.name}  ${p.type}${p.required ? '  påkravd' : ''}`).join('\n') || '(ingen parametrar)'} />
        ))}
      </Section>
      <Section title="Infrastruktur og federering" id="infra">
        {infra.map((r) => (
          <Row title={<span class="mono">{r.path}</span>} sub={r.description} badges={[[r.methods, 'grey']]} />
        ))}
      </Section>
    </CategoryPage>
  )
}

