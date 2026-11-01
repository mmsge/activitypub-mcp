/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import {
  CategoryPage, Section, Row, More, Field, Select, nnDate, nf, statusLabel,
  type CategoryPageProps, type BadgeDef,
} from './kit.js'
import type { BookRow, WatchedRow, OtherRow, GigRow, ScrobbleRow, YoutubeRow, Page } from '../media-query.js'
import type { TheatreVisit } from '../../mcp/tools/theatre.js'
import type { QueryParams } from './ui.js'

// The media tabs of Lesing, Sjåing and Musikk. Same queries and the same POST
// endpoints as the old /admin/media page; rows instead of tables (ADR 0073).

/** What every tab view gets: the page frame, plus the request's query for paging. */
export type TabCtx = Omit<CategoryPageProps, 'help' | 'search' | 'lead' | 'filters' | 'filtersActive'> & {
  q: Record<string, string | undefined>
}

const params = (ctx: TabCtx): QueryParams => {
  const { page: _page, notice: _n, ...rest } = ctx.q
  return { ...rest, tab: ctx.tab.id }
}

const remaining = (d: Page<unknown>) => Math.max(0, d.total - (d.page + 1) * d.rows.length)

/** Enrichment health as a badge, the four states EnrichBadge always had. */
function enrichBadge(enrichedAt: Date | null, fetchError: string | null, attempts: number | null): BadgeDef {
  const n = attempts ?? 0
  if (enrichedAt && !fetchError) return ['Beriga', 'green']
  if (enrichedAt && fetchError) return [`Utdatert · ${n}`, 'yellow', fetchError]
  if (fetchError) return [`Feila · ${n}`, 'red', fetchError]
  return ['Ventar', 'blue']
}

const HEALTH: Array<[string, string]> = [['', 'Alle'], ['failed', 'Feila eller aldri beriga'], ['ok', 'Beriga']]
const HIDDEN: Array<[string, string]> = [['', 'Synlege og skjulte'], ['only', 'Berre skjulte']]

const join = (...parts: Array<string | null | undefined | false>) => parts.filter(Boolean).join(' · ')

// --- Bøker -----------------------------------------------------------------------

export const BooksView: FC<{ ctx: TabCtx; data: Page<BookRow>; actors: string[]; actor?: string }> = ({ ctx, data, actors, actor }) => {
  const q = ctx.q
  return (
    <CategoryPage {...ctx}
      search={{ name: 'title', value: q.title, placeholder: 'Tittel' }}
      help={<>Hylle og lesedatoar kjem frå BookWyrm-innlegga. «Skjul» stoppar at boka blir servert frå MCP og REST. Ho blir ikkje sletta.</>}
      filtersActive={Boolean(q.author || q.format || q.shelf || q.hidden || q.sort)}
      filters={<>
        <Field label="Forfattar"><input name="author" value={q.author ?? ''} /></Field>
        <Field label="Format"><input name="format" value={q.format ?? ''} /></Field>
        <Field label="Hylle"><Select name="shelf" value={q.shelf} options={[['', 'Alle'], ['reading', 'Les no'], ['read', 'Lese'], ['to-read', 'Vil lese']]} /></Field>
        <Field label="Sortering"><Select name="sort" value={q.sort} options={[['', 'Sist lese'], ['enriched', 'Sist beriga']]} /></Field>
        <Field label="Skjulte"><Select name="hidden" value={q.hidden} options={HIDDEN} /></Field>
        {actors.length > 1 && <Field label="Konto"><Select name="actor" value={actor} options={actors.map((a) => [a, a])} /></Field>}
      </>}
    >
      {actors.length === 0 && (
        <div class="notice">BOOKWYRM_ACTORS er ikkje sett, så hylle og lesedatoar kan ikkje reknast ut.</div>
      )}
      <Section isEmpty={data.rows.length === 0} empty="Ingen bøker. Dei kjem når BookWyrm-kontoen blir følgd."
        more={<More base={ctx.cat.href} params={params(ctx)} page={data.page} hasMore={data.hasMore} remaining={remaining(data)} />}>
        {data.rows.map((b) => {
          const badges: BadgeDef[] = []
          const shelf = statusLabel(b.shelf, 'book')
          if (shelf) badges.push([shelf, 'blue'])
          if (!b.fetchedAt) badges.push(['Ikkje beriga', 'grey'])
          return (
            <Row withCover cover={b.coverUrl} title={b.title ?? '—'} titleText={b.title ?? ''} href={b.bookUrl}
              sub={join(b.author, b.pages ? `${b.pages} s.` : null,
                b.finished ? `lese ${nnDate(b.finished)}` : b.started ? `byrja ${nnDate(b.started)}` : null,
                b.rating ? `★ ${b.rating}` : null, b.series)}
              badges={badges} hidden={Boolean(b.hiddenAt)}
              menu={{ kind: 'book', id: b.id, hidden: Boolean(b.hiddenAt), source: b.bookUrl, returnTo: ctx.returnTo }} />
          )
        })}
      </Section>
    </CategoryPage>
  )
}

// --- Film og TV ------------------------------------------------------------------

export const WatchedView: FC<{ ctx: TabCtx; data: Page<WatchedRow> }> = ({ ctx, data }) => {
  const q = ctx.q
  return (
    <CategoryPage {...ctx}
      search={{ name: 'title', value: q.title, placeholder: 'Tittel' }}
      help={<>Éi rad per visning, så ein film sett to gonger står to gonger. «Dato ukjend» er merke datert 2000-01-01 på minreol (ADR 0060).</>}
      filtersActive={Boolean(q.director || q.comment || q.from || q.to || q.category || q.health || q.hidden || q.sort || q.showDeleted || q.undated)}
      filters={<>
        <Field label="Regissør"><input name="director" value={q.director ?? ''} /></Field>
        <Field label="Notat"><input name="comment" value={q.comment ?? ''} placeholder="t.d. kino" /></Field>
        <Field label="Frå"><input name="from" type="date" value={q.from ?? ''} /></Field>
        <Field label="Til"><input name="to" type="date" value={q.to ?? ''} /></Field>
        <Field label="Type"><Select name="category" value={q.category} options={[['', 'Film og TV'], ['movie', 'Berre film'], ['tv', 'Berre TV']]} /></Field>
        <Field label="Berikning"><Select name="health" value={q.health} options={HEALTH} /></Field>
        <Field label="Skjulte"><Select name="hidden" value={q.hidden} options={HIDDEN} /></Field>
        <Field label="Sortering"><Select name="sort" value={q.sort} options={[['', 'Sist sett'], ['enriched', 'Sist beriga']]} /></Field>
        <label class="field check"><input type="checkbox" name="showDeleted" value="1" checked={Boolean(q.showDeleted)} /><span>Vis sletta</span></label>
        <label class="field check"><input type="checkbox" name="undated" value="1" checked={Boolean(q.undated)} /><span>Berre ukjend dato</span></label>
      </>}
    >
      <Section isEmpty={data.rows.length === 0} empty="Ingen visningar med dette filteret."
        more={<More base={ctx.cat.href} params={params(ctx)} page={data.page} hasMore={data.hasMore} remaining={remaining(data)} />}>
        {data.rows.map((r) => {
          const badges: BadgeDef[] = []
          const st = statusLabel(r.status, r.category)
          if (st) badges.push([st, 'blue'])
          if (r.deletedAt) badges.push(['Sletta', 'red'])
          if (r.watchedDateUnknown) badges.push(['Dato ukjend', 'grey', `merka ${nnDate(r.publishedAt)}`])
          badges.push(enrichBadge(r.enrichedAt, r.fetchError, r.fetchAttempts))
          return (
            <Row withCover cover={r.coverUrl} title={r.title ?? '—'} titleText={r.title ?? ''} href={r.markUrl ?? r.itemUrl}
              sub={join(r.category === 'tv' ? 'TV' : r.category === 'movie' ? 'Film' : r.itemType,
                r.year ? String(r.year) : null,
                r.watchedDateUnknown ? null : `sett ${nnDate(r.watchedAt ?? r.publishedAt)}`, r.comment)}
              badges={badges} hidden={Boolean(r.hiddenAt)}
              menu={{ kind: 'catalogUrl', id: r.itemUrl, hidden: Boolean(r.hiddenAt), source: r.itemUrl, returnTo: ctx.returnTo }} />
          )
        })}
      </Section>
    </CategoryPage>
  )
}

// --- Spel, Album, Podkastar, Heile katalogen --------------------------------------

const CATEGORY_LABEL: Record<string, string> = {
  game: 'Spel', music: 'Album', podcast: 'Podkast', book: 'Bok', performance: 'Teater', movie: 'Film', tv: 'TV',
}

export const CatalogueView: FC<{
  ctx: TabCtx
  data: Page<OtherRow>
  /** Fixed NeoDB category for Spel/Album/Podkastar; undefined for the whole catalogue. */
  fixedCategory?: string
  categories: string[]
  empty: string
}> = ({ ctx, data, fixedCategory, categories, empty }) => {
  const q = ctx.q
  return (
    <CategoryPage {...ctx}
      search={{ name: 'title', value: q.title, placeholder: 'Tittel' }}
      help={fixedCategory
        ? <>Katalogoppføringar frå NeoDB-merke i denne kategorien. «Berik på nytt» hentar metadata for éi oppføring.</>
        : <>Alt frå NeoDB unnateke film og TV, med feila berikingar. «Prøv alle feila på nytt» tek opptil 50 om gongen.</>}
      filtersActive={Boolean((!fixedCategory && q.category) || q.health || q.hidden || q.sort)}
      filters={<>
        {!fixedCategory && (
          <Field label="Kategori">
            <Select name="category" value={q.category}
              options={[['', 'Alt utanom film og TV'], ...categories.filter((c) => c !== 'movie' && c !== 'tv')
                .map((c): [string, string] => [c, CATEGORY_LABEL[c] ?? c])]} />
          </Field>
        )}
        <Field label="Berikning"><Select name="health" value={q.health} options={HEALTH} /></Field>
        <Field label="Skjulte"><Select name="hidden" value={q.hidden} options={HIDDEN} /></Field>
        <Field label="Sortering"><Select name="sort" value={q.sort} options={[['', 'Sist beriga'], ['watched', 'Sist merka']]} /></Field>
      </>}
    >
      {!fixedCategory && (
        <form method="post" action="/admin/media/retry-failed">
          <input type="hidden" name="return" value={ctx.returnTo} />
          <button type="submit" class="btn-ghost">Prøv alle feila på nytt</button>
        </form>
      )}
      <Section isEmpty={data.rows.length === 0} empty={empty}
        more={<More base={ctx.cat.href} params={params(ctx)} page={data.page} hasMore={data.hasMore} remaining={remaining(data)} />}>
        {data.rows.map((r) => {
          const badges: BadgeDef[] = [enrichBadge(r.enrichedAt, r.fetchError, r.fetchAttempts)]
          if (r.bookwyrmBookUrl) badges.push(['BookWyrm', 'blue'])
          return (
            <Row withCover cover={r.coverUrl} title={r.displayTitle ?? r.title ?? '—'} titleText={r.displayTitle ?? r.title ?? ''}
              href={r.itemUrl}
              sub={join(fixedCategory ? null : (CATEGORY_LABEL[r.category ?? ''] ?? r.category ?? 'ukjend kategori'),
                r.year ? String(r.year) : null,
                `${nf(r.markCount)} merke`,
                r.latestAt ? `sist ${nnDate(r.latestAt)}` : null)}
              badges={badges} hidden={Boolean(r.hiddenAt)}
              menu={{ kind: 'catalog', id: r.id, hidden: Boolean(r.hiddenAt), source: r.itemUrl, returnTo: ctx.returnTo }} />
          )
        })}
      </Section>
    </CategoryPage>
  )
}

// --- Konsertar ---------------------------------------------------------------------

export const GigsView: FC<{ ctx: TabCtx; data: Page<GigRow>; cities: string[] }> = ({ ctx, data, cities }) => {
  const q = ctx.q
  return (
    <CategoryPage {...ctx}
      search={{ name: 'q', value: q.q, placeholder: 'Artist, stad eller tittel' }}
      help={<>Konsertar frå Gigowl, sorterte på konsertdatoen, ikkje på når dei vart logga. «Utleidd» tyder at RSVP-en er lesen ut av den genererte opningssetninga, ikkje publisert som data.</>}
      filtersActive={Boolean(q.city || q.health || q.hidden || q.sort)}
      filters={<>
        <Field label="By"><Select name="city" value={q.city} options={[['', 'Kvar som helst'], ...cities.map((c): [string, string] => [c, c])]} /></Field>
        <Field label="Berikning"><Select name="health" value={q.health} options={HEALTH} /></Field>
        <Field label="Skjulte"><Select name="hidden" value={q.hidden} options={HIDDEN} /></Field>
        <Field label="Sortering"><Select name="sort" value={q.sort} options={[['', 'Konsertdato'], ['enriched', 'Sist beriga']]} /></Field>
      </>}
    >
      <form method="post" action="/admin/media/retry-failed-gigs">
        <input type="hidden" name="return" value={ctx.returnTo} />
        <button type="submit" class="btn-ghost">Prøv alle feila konsertar på nytt</button>
      </form>
      <Section isEmpty={data.rows.length === 0} empty="Ingen konsertar med dette filteret."
        more={<More base={ctx.cat.href} params={params(ctx)} page={data.page} hasMore={data.hasMore} remaining={remaining(data)} />}>
        {data.rows.map((r) => {
          const badges: BadgeDef[] = []
          const st = statusLabel(r.rsvpStatus)
          if (st) badges.push([st, 'blue'])
          if (r.statusSource === 'template') badges.push(['Utleidd', 'grey', 'Lesen ut av opningssetninga, ikkje publisert som data'])
          if (r.concertStatus && r.concertStatus !== 'scheduled' && r.concertStatus !== 'completed') badges.push([r.concertStatus, 'red'])
          badges.push(enrichBadge(r.enrichedAt, r.fetchError, r.fetchAttempts))
          return (
            <Row title={r.title ?? r.concertUrl} titleText={r.title ?? ''} href={r.concertUrl}
              sub={join(r.gigDate ? nnDate(r.gigDate) : null, r.venueName, r.venueCity,
                r.songCount != null ? `${r.songCount} songar` : null)}
              badges={badges} hidden={Boolean(r.hiddenAt)}
              menu={{ kind: 'gig', id: r.id, hidden: Boolean(r.hiddenAt), source: r.concertUrl, returnTo: ctx.returnTo }} />
          )
        })}
      </Section>
    </CategoryPage>
  )
}

// --- Teater ------------------------------------------------------------------------

const names = (xs: string[]) => (xs.length ? xs.join(', ') : null)

export const TheatreView: FC<{ ctx: TabCtx; data: Page<TheatreVisit> }> = ({ ctx, data }) => {
  const q = ctx.q
  return (
    <CategoryPage {...ctx}
      search={{ name: 'q', value: q.q, placeholder: 'Tittel, omtale eller kommentar' }}
      help={<>Kvar rad er eit merke, så ei ikkje-beriga framsyning er framleis ein kveld i teateret. Ønskjelista er ute med mindre du vel ho.</>}
      filtersActive={Boolean(q.troupe || q.person || q.status)}
      filters={<>
        <Field label="Kompani"><input name="troupe" value={q.troupe ?? ''} /></Field>
        <Field label="Medverkande"><input name="person" value={q.person ?? ''} /></Field>
        <Field label="Status"><Select name="status" value={q.status}
          options={[['', 'Sett (utan ønskjeliste)'], ['complete', 'Fullført'], ['progress', 'Pågår'], ['dropped', 'Avbrote'], ['wishlist', 'Vil sjå']]} /></Field>
      </>}
    >
      <Section isEmpty={data.rows.length === 0} empty="Ingen teaterbesøk med dette filteret."
        more={<More base={ctx.cat.href} params={params(ctx)} page={data.page} hasMore={data.hasMore} remaining={remaining(data)} />}>
        {data.rows.map((r) => {
          const badges: BadgeDef[] = []
          const st = statusLabel(r.status, 'performance')
          if (st) badges.push([st, 'blue'])
          if (r.item_type === 'PerformanceProduction') badges.push(['Oppsetjing', 'blue', 'Merka mot éi oppsetjing, ikkje stykket'])
          if (r.seen_date_unknown) badges.push(['Dato ukjend', 'grey'])
          badges.push(r.enriched
            ? r.fetch_error ? ['Tittel ventar', 'yellow', r.fetch_error] : ['Beriga', 'green']
            : ['Ikkje beriga', 'red'])
          return (
            <Row withCover cover={r.cover_url} title={r.title ?? r.item_url} titleText={r.title ?? ''} href={r.item_url}
              sub={join(r.seen_date_unknown ? null : r.seen_at ? nnDate(r.seen_at) : null, names(r.troupe), names(r.venue),
                names(r.playwright.length ? r.playwright : r.orig_creator))}
              badges={badges} hidden={Boolean(r.hidden)}
              menu={{ kind: 'catalogUrl', id: r.item_url, hidden: Boolean(r.hidden), source: r.item_url, returnTo: ctx.returnTo }} />
          )
        })}
      </Section>
    </CategoryPage>
  )
}

// --- Scrobblar ---------------------------------------------------------------------

export const ScrobblesView: FC<{ ctx: TabCtx; data: Page<ScrobbleRow> }> = ({ ctx, data }) => {
  const q = ctx.q
  return (
    <CategoryPage {...ctx}
      search={{ name: 'artist', value: q.artist, placeholder: 'Artist' }}
      help={<>Samla per artist og album. Berre lesing: scrobblar har ingen katalogdata å berike, og ingenting her kan skjulast.</>}
      filtersActive={Boolean(q.album || q.sort)}
      filters={<>
        <Field label="Album"><input name="album" value={q.album ?? ''} /></Field>
        <Field label="Sortering"><Select name="sort" value={q.sort} options={[['', 'Mest spela'], ['recent', 'Sist spela']]} /></Field>
      </>}
    >
      <Section isEmpty={data.rows.length === 0} empty="Ingen scrobblar med dette filteret."
        more={<More base={ctx.cat.href} params={params(ctx)} page={data.page} hasMore={data.hasMore} remaining={remaining(data)} />}>
        {data.rows.map((r) => (
          <Row withCover cover={r.image} title={r.albumName ?? '(utan album)'} sub={join(r.artistName,
            r.lastPlayed ? `sist ${nnDate(r.lastPlayed)}` : null)} metric={nf(r.plays)} />
        ))}
      </Section>
    </CategoryPage>
  )
}

// --- YouTube -----------------------------------------------------------------------

export const YoutubeView: FC<{ ctx: TabCtx; data: Page<YoutubeRow>; accounts: string[] }> = ({ ctx, data, accounts }) => {
  const q = ctx.q
  return (
    <CategoryPage {...ctx}
      search={{ name: 'channel', value: q.channel, placeholder: 'Kanal' }}
      help={<>Samla per kanal og talt i visningar. Importert for hand frå Google Takeout. Sletta og private videoar har ingen kanal og står under «(utan kanal)»: dei er ekte visningar.</>}
      filtersActive={Boolean(q.title || q.account || q.sort)}
      filters={<>
        <Field label="Videotittel"><input name="title" value={q.title ?? ''} /></Field>
        <Field label="Konto"><Select name="account" value={q.account} options={[['', 'Alle kontoar'], ...accounts.map((a): [string, string] => [a, a])]} /></Field>
        <Field label="Sortering"><Select name="sort" value={q.sort} options={[['', 'Mest sett'], ['recent', 'Sist sett']]} /></Field>
      </>}
    >
      <Section isEmpty={data.rows.length === 0} empty="Ingen YouTube-visningar. Importer Takeout-fila under Import."
        more={<More base={ctx.cat.href} params={params(ctx)} page={data.page} hasMore={data.hasMore} remaining={remaining(data)} />}>
        {data.rows.map((r) => (
          <Row title={r.channelName ?? '(utan kanal)'}
            sub={join(`${nf(r.videos)} videoar`, r.lastWatched ? `sist ${r.lastWatched.slice(0, 10)}` : null)}
            metric={nf(r.watches)} />
        ))}
      </Section>
    </CategoryPage>
  )
}
