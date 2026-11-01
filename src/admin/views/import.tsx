/** @jsxImportSource hono/jsx */
import type { FC, PropsWithChildren, Child } from 'hono/jsx'
import { Layout, HelpInput, HelpButton, HelpPanel } from './layout.js'
import { Section, Row, Stats, nf, nnDate, type BadgeDef } from './kit.js'
import { CATEGORIES, category } from '../categories.js'
import { IMPORT_KINDS, importKind, type ImportKind } from '../import-kinds.js'
import type { ImportRun } from '../import-runs.js'
import type { ImportResult, TripImportResult } from '../import.js'
import type { ParseProblem, ParseNormalisation } from '../../lib/parse-youtube-takeout.js'
import type { RowFailure } from '../../jobs/import-youtube-watches.js'
import type { ApplyPruneResult } from '../prune-trips.js'
import type { StorygraphImportReport } from '../../jobs/import-storygraph-reads.js'
import type { StorygraphReadRange } from '../../lib/parse-storygraph-csv.js'
import type { TripTrackImportReport } from '../../jobs/import-trip-tracks.js'
import { getBookwyrmActors } from '../../config.js'

// Import, rebuilt from the mobile handoff (ADR 0073, phase 3): a list grouped by
// category with each import's last run, one page per import, and result pages that end
// the same two-step flow. Every form posts where it always did. Dry run comes later and
// adds its "Sjå over" step between the two.

// --- list ------------------------------------------------------------------------

/** "i dag 10:21", "i går", or a date; the run's outcome rides along as the tone. */
export function lastRunText(run: ImportRun | undefined, now = new Date()): { text: string; failed: boolean } | null {
  if (!run) return null
  const day = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' })
  const today = day(now)
  const yesterday = day(new Date(now.getTime() - 86_400_000))
  const when = day(run.ranAt) === today
    ? `i dag ${run.ranAt.toLocaleTimeString('nn-NO', { timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit' })}`
    : day(run.ranAt) === yesterday ? 'i går' : nnDate(run.ranAt)
  return { text: run.ok ? when : `${when} · feila`, failed: !run.ok }
}

export const ImportListPage: FC<{ runs: Map<string, ImportRun>; now?: Date }> = ({ runs, now }) => (
  <Layout title="Import" nav="import">
    <div class="stack">
      {CATEGORIES.map((c) => {
        const kinds = IMPORT_KINDS.filter((k) => k.category === c.id)
        if (kinds.length === 0) return null
        return (
          <section class="sec">
            <div class="sec-head"><div class="sec-title">{c.label}</div></div>
            <div class="panel">
              {kinds.map((k) => {
                const last = lastRunText(runs.get(k.id), now)
                return (
                  <a class="is-row" href={`/admin/import/${k.id}`}>
                    <div class="r-main">
                      <div class="r-title">{k.label}</div>
                      <div class="r-sub">{k.sub}</div>
                    </div>
                    {last && <div class={`last-run${last.failed ? ' tone-red' : ''}`} title={runs.get(k.id)?.summary ?? runs.get(k.id)?.error ?? ''}>{last.text}</div>}
                    <span class="chev">›</span>
                  </a>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  </Layout>
)

// --- one import ------------------------------------------------------------------

const Steps: FC<{ at: 'form' | 'done' }> = ({ at }) => (
  <div class="steps" aria-label="Steg">
    <div class={`step${at === 'form' ? ' on' : ' past'}`}><div class="step-bar" /><div class="step-l">Vel fil</div></div>
    <div class={`step${at === 'done' ? ' on' : ''}`}><div class="step-bar" /><div class="step-l">Ferdig</div></div>
  </div>
)

const KindHead: FC<{ kind: ImportKind }> = ({ kind }) => (
  <div class="hx-wrap">
    <HelpInput id={`help-imp-${kind.id}`} />
    <div class="search-row">
      <div class="lead">{kind.sub}</div>
      <HelpButton for={`help-imp-${kind.id}`} label="Korleis verkar det?" />
    </div>
    <HelpPanel>{kind.help.map((p) => <p>{p}</p>)}</HelpPanel>
  </div>
)

/** Shows the chosen file's name in the picker, and blocks a second submit while one runs. */
const IMPORT_JS = `
document.querySelectorAll('.picker input[type=file]').forEach(function (i) {
  i.addEventListener('change', function () {
    var f = i.files && i.files[0];
    var p = i.closest('.picker');
    p.classList.toggle('picked', !!f);
    p.querySelector('.picker-title').textContent = f ? f.name : 'Vel fil';
    p.querySelector('.picker-sub').textContent = f ? (Math.round(f.size / 1024).toLocaleString('nn-NO') + ' kB · trykk for å byte') : p.dataset.accept;
  });
});
document.querySelectorAll('form.imp-form').forEach(function (f) {
  f.addEventListener('submit', function () {
    var b = f.querySelector('button[type=submit]');
    b.disabled = true; b.textContent = b.dataset.busy;
  });
});
`

export const ImportKindPage: FC<{ kind: ImportKind; error?: string; bookwyrmActors?: string[] }> = ({
  kind, error, bookwyrmActors = getBookwyrmActors(),
}) => {
  const fields = (kind.fields ?? []).map((f) =>
    kind.id === 'storygraph' && f.name === 'actor'
      ? { ...f, suggestions: bookwyrmActors, value: bookwyrmActors[0] ?? '' }
      : f)
  return (
    <Layout title={kind.label} nav="import" back={{ href: '/admin/import', label: 'Import' }}>
      <div class="stack imp">
        <KindHead kind={kind} />
        {kind.fileField && <Steps at="form" />}
        {error && (
          <div class="banner-error" role="alert">
            <div class="banner-title">Importen feila. Ingenting vart lagra.</div>
            <div class="banner-reason">{error}</div>
          </div>
        )}
        <form class="imp-form" method="post" action={`/admin/import/${kind.id}`}
          enctype={kind.fileField ? 'multipart/form-data' : undefined}>
          {kind.fileField && (
            <label class="picker" data-accept={kind.accept}>
              <input type="file" name={kind.fileField} accept={kind.accept} required />
              <span class="picker-title">Vel fil</span>
              <span class="picker-sub mono">{kind.accept}</span>
            </label>
          )}
          {fields.map((f) => (
            <label class="field">
              <span>{f.label}</span>
              <input name={f.name} placeholder={f.placeholder} value={f.value ?? ''} required={f.required}
                list={f.suggestions?.length ? `dl-${f.name}` : undefined} />
              {f.suggestions?.length ? (
                <datalist id={`dl-${f.name}`}>{f.suggestions.map((s) => <option value={s} />)}</datalist>
              ) : null}
            </label>
          ))}
          <button type="submit" class="btn-primary"
            data-busy={kind.fileField ? 'Les fila …' : 'Køyrer …'}>{kind.primary}</button>
        </form>
      </div>
      <script dangerouslySetInnerHTML={{ __html: IMPORT_JS }} />
    </Layout>
  )
}

// --- results ---------------------------------------------------------------------

/** The end of the flow: a green banner, the figures, the detail, and the way back. */
const Done: FC<PropsWithChildren<{
  kindId: string
  title?: string
  banner: Child
  tone?: 'green' | 'yellow' | 'red'
  note?: Child
}>> = ({ kindId, title, banner, tone = 'green', note, children }) => {
  const kind = importKind(kindId)
  const cat = kind ? category(kind.category) : undefined
  return (
    <Layout title={title ?? kind?.label ?? 'Import'} nav="import" back={{ href: '/admin/import', label: 'Import' }}>
      <div class="stack imp">
        {kind?.fileField && <Steps at="done" />}
        <div class={`done-banner tone-bg-${tone}`} role="status">
          <div class="done-title">{banner}</div>
          {note && <div class="done-note">{note}</div>}
        </div>
        {children}
        <div class="done-actions">
          {cat && <a class="btn btn-ghost" href={cat.href}>Tilbake til {cat.label}</a>}
          <a class="btn btn-ghost" href="/admin">Til oversikt</a>
        </div>
      </div>
    </Layout>
  )
}

/** Generic result for the archive, the crawl and the two maintenance runs. */
export const ImportResultPage: FC<{ result: ImportResult; actor: string; kind?: string }> = ({ result, actor, kind = 'archive' }) => (
  <Done kindId={kind} banner={result.errors.length ? `Ferdig, med ${nf(result.errors.length)} feil` : 'Ferdig'}
    tone={result.errors.length ? 'yellow' : 'green'} note={actor || undefined}>
    <Stats items={[
      { n: nf(result.total), label: 'totalt' },
      { n: nf(result.imported), label: 'importerte', tone: 'green' },
      { n: nf(result.skipped), label: 'fanst frå før' },
      { n: nf(result.errors.length), label: 'feil', tone: result.errors.length ? 'red' : undefined },
    ]} />
    {result.errors.length > 0 && (
      <Section title={`Feil (første ${Math.min(result.errors.length, 20)})`} id="errors">
        <Row title="Detaljar" sub="Trykk for å sjå" raw={result.errors.slice(0, 20).join('\n')} />
      </Section>
    )}
  </Done>
)

const byReason = <T extends { reason?: string; kind?: string }>(list: T[]) => {
  const m = new Map<string, T[]>()
  for (const x of list) {
    const key = x.reason ?? x.kind ?? 'ukjend'
    m.set(key, [...(m.get(key) ?? []), x])
  }
  return [...m].sort((a, b) => b[1].length - a[1].length)
}

/**
 * The watch-history importer reports entries it refused and values it CHANGED. A
 * normalisation is not an error, the row survives, but the archive no longer says
 * exactly what the source said, and that must never be silent. See ADR 0047.
 */
export const YoutubeImportResultPage: FC<{
  total: number
  parsed: number
  inserted: number
  skipped: number
  problems: ParseProblem[]
  normalisations: ParseNormalisation[]
  failed: RowFailure[]
}> = ({ total, parsed, inserted, skipped, problems, normalisations, failed }) => (
  <Done kindId="youtube" banner={`${nf(inserted)} nye visningar`} note={`${nf(parsed)} av ${nf(total)} oppføringar lesne`}
    tone={problems.length + failed.length ? 'yellow' : 'green'}>
    <Stats items={[
      { n: nf(total), label: 'oppføringar i fila' },
      { n: nf(inserted), label: 'lagt til', tone: 'green' },
      { n: nf(skipped), label: 'fanst frå før' },
      { n: nf(normalisations.length), label: 'normaliserte', tone: normalisations.length ? 'blue' : undefined },
      { n: nf(problems.length + failed.length), label: 'ikkje importerte', tone: problems.length + failed.length ? 'red' : undefined },
    ]} />
    {normalisations.length > 0 && (
      <Section title="Normaliserte, lagra men endra" id="normalised"
        help={<>Desse radene er i databasen, men ikkje med verdien fila gav. Vist så endringa aldri er stille.</>}>
        {byReason(normalisations).map(([k, list]) => (
          <Row title={k} metric={nf(list.length)} raw={list.slice(0, 20).map((n) => `oppføring ${n.index}: ${n.from} -> ${n.to}`).join('\n')} />
        ))}
      </Section>
    )}
    {problems.length > 0 && (
      <Section title="Kunne ikkje lesast" id="problems">
        {byReason(problems).map(([reason, list]) => (
          <Row title={reason} metric={nf(list.length)} raw={list.slice(0, 10).map((p) => `oppføring ${p.index}: ${p.sample}`).join('\n')} />
        ))}
      </Section>
    )}
    {failed.length > 0 && (
      <Section title="Avviste av databasen" id="failed">
        {byReason(failed).map(([reason, list]) => (
          <Row title={reason} metric={nf(list.length)} raw={list.slice(0, 10).map((f) => `rad ${f.index}: ${f.account} ${f.watchedAtLocal} ${f.videoId}`).join('\n')} />
        ))}
      </Section>
    )}
  </Done>
)

/**
 * The trips import also lists the trips this export NO LONGER CONTAINS. Nothing on this
 * page has been deleted: the confirm form is the only route to `applyTripPrune`, and it
 * is rendered only when the plan is one the threshold would accept. See ADR 0054.
 */
export const TripImportResultPage: FC<{ result: TripImportResult }> = ({ result }) => {
  const { prune } = result
  const canConfirm = prune.refusal === null && prune.candidates.length > 0
  const n = prune.candidates.length
  return (
    <Done kindId="trips" banner={`${nf(result.inserted)} nye, ${nf(result.updated)} oppdaterte`}
      note="viaduct.world, CSV" tone={n ? 'yellow' : 'green'}>
      <Stats items={[
        { n: nf(result.total), label: 'rader i fila' },
        { n: nf(result.inserted), label: 'nye', tone: 'green' },
        { n: nf(result.updated), label: 'oppdaterte', tone: 'blue' },
        { n: nf(result.unchanged), label: 'uendra' },
      ]} />
      {prune.window && (
        <p class="muted">
          Eksporten dekkjer <strong class="mono">{prune.window.fromKey}</strong> til{' '}
          <strong class="mono">{prune.window.toKey}</strong> UTC, og arkivet har{' '}
          <strong>{prune.inWindow}</strong> turar i det tidsrommet. Berre dei kan fjernast.
        </p>
      )}
      {prune.refusal && (
        <div class="banner-error" role="alert">
          <div class="banner-title">Ingenting blir fjerna</div>
          <div class="banner-reason">{prune.refusal}</div>
        </div>
      )}
      {result.droppedJourneys.length > 0 && (
        <Section title="Reiser som ikkje lenger er med" id="journeys"
          help={<>Arkivet arkiverer framleis turane under reisa sitt namn, fordi ei tom reise i ein eksport aldri tømmer ei lagra. Slett turane i viaduct og importer på nytt for å fjerne dei òg.</>}>
          {result.droppedJourneys.map((d) => (
            <Row title={d.journey} sub={`Reisa vart sletta, men ${d.remaining} ${d.remaining === 1 ? 'tur står' : 'turar står'} att.`} />
          ))}
        </Section>
      )}
      {n > 0 && (
        <section class="sec sec-warn">
          <div class="sec-head"><div class="sec-title tone-yellow">Ikkje i denne eksporten</div></div>
          <p class="muted">
            Ingenting her er sletta. {canConfirm
              ? 'Les lista, og stadfest under for å fjerne dei. Innlegg knytte til ein fjerna tur blir knytte til rett tur på nytt.'
              : 'Fjerninga vart avvist, så det er ingenting å stadfeste.'}
          </p>
          <div class="panel">
            {prune.candidates.map((t) => (
              <Row title={`${t.fromStation} → ${t.toStation}`}
                sub={<span class="mono">{t.key} UTC{t.journey ? ` · ${t.journey}` : ''}{t.trainCode ? ` · ${t.trainCode}` : ''}</span>}
                badges={t.status ? [[TRIP_STATUS[t.status] ?? t.status, 'grey'] as BadgeDef] : undefined}
                metric={t.distanceKm != null ? `${t.distanceKm} km` : undefined} />
            ))}
          </div>
          {canConfirm && prune.window && (
            // The trips are posted back by id, and every guarantee this page makes is
            // re-established server-side before anything is deleted, so this list can
            // only ever narrow what goes.
            <form method="post" action="/admin/import/trips/prune">
              {prune.candidates.map((t) => <input type="hidden" name="trip" value={t.id} />)}
              <input type="hidden" name="window_from" value={prune.window.from.toISOString()} />
              <input type="hidden" name="window_to" value={prune.window.to.toISOString()} />
              <input type="hidden" name="derived_at" value={result.derivedAt.toISOString()} />
              <button type="submit" class="btn-danger">Fjern {n} {n === 1 ? 'tur' : 'turar'}</button>
            </form>
          )}
        </section>
      )}
    </Done>
  )
}

const TRIP_STATUS: Record<string, string> = { Planned: 'Planlagd', Completed: 'Fullført', Cancelled: 'Innstilt' }

/** The outcome of a confirmed prune. */
export const TripPruneResultPage: FC<{ result: ApplyPruneResult }> = ({ result }) => (
  <Done kindId="trips" title="Fjerning" tone={result.refusal ? 'red' : result.deleted ? 'green' : 'yellow'}
    banner={result.deleted > 0 ? `${nf(result.deleted)} ${result.deleted === 1 ? 'tur fjerna' : 'turar fjerna'}` : 'Ingenting fjerna'}
    note="Innlegg knytte til ein fjerna tur er knytte til rett tur på nytt. Ingen innlegg er sletta, og kvar fjerna tur står i serverloggen.">
    {result.refusal && (
      <div class="banner-error" role="alert">
        <div class="banner-title">Avvist</div>
        <div class="banner-reason">{result.refusal}</div>
      </div>
    )}
    <Stats items={[
      { n: nf(result.deleted), label: 'fjerna', tone: result.deleted ? 'red' : undefined },
      { n: nf(result.rejected.length), label: 'avslått' },
      { n: nf(result.orphaned.length), label: 'innlegg utan tur', tone: result.orphaned.length ? 'yellow' : undefined },
    ]} />
    {result.rejected.length > 0 && (
      <Section title="Avslått" id="rejected"
        help={<>Tilbydd av resultatsida, men avvist her fordi databasen ikkje lenger er samd med det sida sa.</>}>
        {result.rejected.map((r) => <Row title={<span class="mono">{r.id}</span>} sub={r.reason} />)}
      </Section>
    )}
    {result.orphaned.length > 0 && (
      <Section title="Innlegg utan tur" id="orphaned"
        help={<>Desse innlegga fell utanfor alle turane som er att, som oftast med rette. Den timevise utleiinga plukkar dei opp om ikkje.</>}>
        <Row title={`${nf(result.orphaned.length)} innlegg`} sub="Trykk for å sjå" raw={result.orphaned.join('\n')} />
      </Section>
    )}
  </Done>
)

/** The outcome of a viaduct.world GPX import. See ADR 0070. */
export const TripTrackImportResultPage: FC<{ report: TripTrackImportReport }> = ({ report }) => (
  <Done kindId="trip-tracks" banner={`${nf(report.tracksInFile)} ruter lesne`} note="viaduct.world, GPX"
    tone={report.unmatched.length || report.problems.length ? 'yellow' : 'green'}>
    <Stats items={[
      { n: nf(report.tracksInserted), label: 'nye', tone: 'green' },
      { n: nf(report.tracksUpdated), label: 'oppdaterte', tone: 'blue' },
      { n: nf(report.tracksUnchanged), label: 'uendra' },
      { n: nf(report.tracksDeleted), label: 'fjerna', tone: report.tracksDeleted ? 'red' : undefined },
      { n: nf(report.matched), label: 'kopla til ein tur', tone: 'green' },
      { n: nf(report.unmatched.length), label: 'utan tur å koplast til', tone: report.unmatched.length ? 'yellow' : undefined },
      { n: nf(report.departedTripsWithoutTrack), label: 'gjennomførte turar utan rute' },
      { n: nf(report.waypointsInFile), label: `stasjonspunkt (+${report.waypointsInserted} / −${report.waypointsDeleted}), ${nf(report.pointsStored)} punkt i alt` },
    ]} />
    {report.unmatched.length > 0 && (
      <Section title="Ruter utan tur" id="unmatched"
        help={<>Lagra, men ingen CSV-tur har desse stasjonane og denne lokale avgangstida. Som oftast er CSV-eksporten eldre enn GPX-en. Ein nyare CSV-import koplar dei utan å importere GPX-en på nytt.</>}>
        {report.unmatched.map((u) => (
          <Row title={`${u.fromStation} → ${u.toStation}`}
            sub={<span class="mono">{u.departureLocal} lokal · viaduct {u.viaductTripId}</span>} />
        ))}
      </Section>
    )}
    {report.problems.length > 0 && (
      <Section title="Spor som ikkje kunne lesast" id="problems">
        {report.problems.map((p) => <Row title={p.track} sub={p.reason} />)}
      </Section>
    )}
  </Done>
)

const range = (r: StorygraphReadRange): string => `${r.started ?? '?'} → ${r.finished ?? '?'}`

const CONFLICT: Record<string, string> = {
  disagree: 'Datoane er ulike',
  start_after_finish: 'Start ville kome etter slutt',
}

/** The outcome of a StoryGraph read-dates import. See ADR 0063. */
export const StorygraphImportResultPage: FC<{ report: StorygraphImportReport }> = ({ report }) => (
  <Done kindId="storygraph" banner={`${nf(report.booksMatched)} bøker kopla`}
    note={<>Mot <span class="mono">{report.actorApId}</span>: {nf(report.readsInserted)} lesingar lagt til, {nf(report.readsUpdated)} oppdaterte, {nf(report.readsUnchanged)} uendra, {nf(report.readsDeleted)} fjerna fordi StoryGraph ikkje lenger listar dei.</>}
    tone={report.conflicts.length || report.unmatched.length ? 'yellow' : 'green'}>
    <Stats items={[
      { n: nf(report.rowsRead), label: `rader lesne, ${nf(report.rowsWithReads)} med lesingar` },
      { n: nf(report.booksMatched), label: `bøker kopla (${report.matchedByIsbn} på ISBN, ${report.matchedByTitle} på tittel)`, tone: 'green' },
      { n: nf(report.startsFilled + report.finishesFilled), label: `datoar fylte (${report.startsFilled} start, ${report.finishesFilled} slutt)`, tone: 'blue' },
      { n: nf(report.readsAdded), label: 'lesingar BookWyrm aldri såg', tone: 'blue' },
      { n: nf(report.unmatched.length), label: 'bøker utan treff', tone: report.unmatched.length ? 'yellow' : undefined },
      { n: nf(report.conflicts.length), label: 'konfliktar (BookWyrm vann)', tone: report.conflicts.length ? 'yellow' : undefined },
    ]} />
    {report.conflicts.length > 0 && (
      <Section title="Konfliktar" id="conflicts"
        help={<>Begge kjeldene hadde ein dato for same lesing, og dei er usamde. Datoen frå BookWyrm er den som blir servert. Ingenting her vart endra.</>}>
        {report.conflicts.map((c) => (
          <Row title={c.book ?? '—'}
            sub={<span class="mono">{c.field}: BookWyrm {c.bookwyrm} · StoryGraph {c.storygraph}</span>}
            badges={[[CONFLICT[c.reason] ?? 'Slutt ville kome før start', 'yellow']]} />
        ))}
      </Section>
    )}
    {report.unmatched.length > 0 && (
      <Section title="Utan treff" id="unmatched"
        help={<>Lagra, men ingen BookWyrm-bok passa på ISBN-13 eller tittel og forfattar, så lesetenestene viser ikkje desse. Ein seinare import koplar dei når boka er på BookWyrm.</>}>
        {report.unmatched.map((u) => (
          <Row title={u.title} sub={<>{u.authors.join(', ') || '—'} · <span class="mono">{u.reads.map(range).join(', ')}</span></>} />
        ))}
      </Section>
    )}
    {report.unparsed.length > 0 && (
      <Section title="Intervall som ikkje kunne lesast" id="unparsed">
        {report.unparsed.map((u) => <Row title={u.title} sub={<span class="mono">{u.value}</span>} />)}
      </Section>
    )}
  </Done>
)
