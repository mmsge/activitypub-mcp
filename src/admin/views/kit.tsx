/** @jsxImportSource hono/jsx */
import type { FC, PropsWithChildren, Child } from 'hono/jsx'
import { Layout, HelpInput, HelpButton, HelpPanel } from './layout.js'
import { withQuery, type QueryParams } from './ui.js'
import type { Category, TabDef } from '../categories.js'

// The building blocks of a category page (ADR 0073): tab chips, a search row with its ⓘ,
// optional stats, sections of rows, and "Import og synk" at the bottom. Rows replace the
// old tables, so nothing on a phone scrolls sideways.

export type Tone = 'red' | 'yellow' | 'green' | 'blue' | 'grey' | 'accent'
export type BadgeDef = [label: string, tone: Tone, title?: string]

export const Badge: FC<{ b: BadgeDef }> = ({ b: [label, tone, title] }) => (
  <span class={`badge badge-${tone}`} title={title}>{label}</span>
)

export interface SearchDef {
  /** The query parameter the box writes. */
  name: string
  value?: string
  placeholder: string
}

export interface CategoryPageProps {
  cat: Category
  tab: TabDef
  /** One line shown instead of a search box when the tab has nothing to search. */
  lead?: string
  search?: SearchDef
  /** The tab's ⓘ text. */
  help: Child
  /** Extra filter fields, folded under "Filter" inside the search form. */
  filters?: Child
  /** True when any folded filter is set, so the fold opens to show it. */
  filtersActive?: boolean
  notice?: string
  error?: string
  /** Is a sync running right now, by job. */
  running?: ReadonlySet<string>
  /** The URL this view's POST forms send the browser back to. */
  returnTo: string
}

export const CategoryPage: FC<PropsWithChildren<CategoryPageProps>> = (p) => {
  const helpId = `help-tab-${p.tab.id}`
  return (
    <Layout title={p.cat.label} back={{ href: '/admin', label: 'Oversikt' }} notice={p.notice}>
      <div class="cat">
        {p.cat.tabs.length > 1 && (
          <nav class="tabs" aria-label="Faner">
            {p.cat.tabs.map((t) => (
              <a href={`${p.cat.href}?tab=${t.id}`} class={t.id === p.tab.id ? 'active' : ''}
                aria-current={t.id === p.tab.id ? 'page' : undefined}>{t.label}</a>
            ))}
          </nav>
        )}

        {p.error && (
          <div class="banner-error" role="alert">
            <div class="banner-title">Noko gjekk gale</div>
            <div class="banner-reason">{p.error}</div>
          </div>
        )}

        <div class="hx-wrap">
          <HelpInput id={helpId} />
          {p.search ? (
            <form method="get" action={p.cat.href} class="search">
              <input type="hidden" name="tab" value={p.tab.id} />
              <div class="search-row">
                <input type="search" name={p.search.name} value={p.search.value ?? ''}
                  placeholder={p.search.placeholder} aria-label={p.search.placeholder} />
                <HelpButton for={helpId} label="Om denne fana" />
              </div>
              {p.filters && (
                <details class="drawer" open={p.filtersActive}>
                  <summary>Filter</summary>
                  <div class="drawer-body">
                    {p.filters}
                    <div class="drawer-actions">
                      <button type="submit">Bruk</button>
                      <a class="btn btn-ghost" href={`${p.cat.href}?tab=${p.tab.id}`}>Nullstill</a>
                    </div>
                  </div>
                </details>
              )}
            </form>
          ) : (
            <div class="search-row">
              <div class="lead">{p.lead}</div>
              <HelpButton for={helpId} label="Om denne fana" />
            </div>
          )}
          <HelpPanel>{p.help}</HelpPanel>
        </div>

        {p.children}

        <ImportSync cat={p.cat} running={p.running ?? new Set()} returnTo={p.returnTo} />
      </div>
      <RowMenuSheet />
    </Layout>
  )
}

/** A grid of figures for status-style tabs. `fg` colours the number. */
export const Stats: FC<{ items: Array<{ n: Child; label: Child; tone?: Tone }> }> = ({ items }) => (
  <div class="stats">
    {items.map((s) => (
      <div class="stat-s">
        <div class={`stat-s-n${s.tone ? ` tone-${s.tone}` : ''}`}>{s.n}</div>
        <div class="stat-s-l">{s.label}</div>
      </div>
    ))}
  </div>
)

/**
 * A titled section of rows. `empty` is the specific sentence shown in a dashed box when
 * there are no rows, never a generic "nothing found".
 */
export const Section: FC<PropsWithChildren<{
  title?: string
  help?: Child
  id?: string
  isEmpty?: boolean
  empty?: Child
  more?: Child
}>> = ({ title, help, id, isEmpty, empty, more, children }) => {
  const helpId = `help-sec-${id ?? title ?? 'x'}`.replace(/[^a-z0-9-]/gi, '-')
  return (
    <section class="sec hx-wrap">
      {help && <HelpInput id={helpId} />}
      {title && (
        <div class="sec-head">
          <div class="sec-title">{title}</div>
          {help && <HelpButton for={helpId} />}
        </div>
      )}
      {help && <HelpPanel>{help}</HelpPanel>}
      {isEmpty ? (
        <div class="empty-box">{empty ?? 'Ingenting her.'}</div>
      ) : (
        <div class="panel">
          {children}
          {more}
        </div>
      )}
    </section>
  )
}

/** What the ⋯ sheet acts on. Serialised onto the button; the sheet reads it. */
export interface RowMenu {
  /** Which re-enrich/hide endpoint kind the row is (`/admin/media/reenrich`, `/hide`). */
  kind: 'book' | 'catalog' | 'catalogUrl' | 'gig'
  id: string
  hidden: boolean
  source?: string | null
  returnTo: string
}

export interface RowProps {
  title: Child
  /** Plain-text title for the ⋯ sheet heading. */
  titleText?: string
  href?: string | null
  sub?: Child
  badges?: BadgeDef[]
  cover?: string | null
  /** Show the cover slot even when there is no image, so a list stays aligned. */
  withCover?: boolean
  metric?: Child
  action?: Child
  menu?: RowMenu
  /** Raw data shown in a mono block when the row is tapped. */
  raw?: string
  hidden?: boolean
}

export const Row: FC<RowProps> = (r) => {
  const cover = r.withCover || r.cover ? (
    r.cover
      ? <img class="row-cover" src={r.cover} alt="" loading="lazy" referrerpolicy="no-referrer" />
      : <div class="row-cover" aria-hidden="true" />
  ) : null
  const title = r.href
    ? <a href={r.href} target="_blank" rel="noreferrer noopener">{r.title}</a>
    : r.title
  const body = (
    <>
      {cover}
      <div class="r-main">
        <div class="r-title">{title}</div>
        {r.sub && <div class="r-sub">{r.sub}</div>}
        {(r.badges?.length || r.hidden) && (
          <div class="r-badges">
            {r.hidden && <Badge b={['Skjult', 'red']} />}
            {r.badges?.map((b) => <Badge b={b} />)}
          </div>
        )}
      </div>
      {r.metric != null && <div class="r-metric">{r.metric}</div>}
      {r.action}
      {r.menu && (
        <button type="button" class="r-dots" aria-label="Handlingar"
          data-menu={JSON.stringify({
            t: r.titleText ?? (typeof r.title === 'string' ? r.title : ''),
            k: r.menu.kind, i: r.menu.id, h: r.menu.hidden, s: r.menu.source ?? '', r: r.menu.returnTo,
          })}>⋯</button>
      )}
    </>
  )
  const cls = `r${r.hidden ? ' r-hidden' : ''}`
  if (r.raw !== undefined) {
    return (
      <details class={`${cls} r-x`}>
        <summary class="r-row">{body}</summary>
        <pre class="r-raw">{r.raw}</pre>
      </details>
    )
  }
  return <div class={cls}><div class="r-row">{body}</div></div>
}

/** Offset paging as two links at the foot of a list. Search is server-side, so a page is a GET. */
export const More: FC<{ base: string; params: QueryParams; page: number; hasMore: boolean; remaining?: number }> = ({
  base, params, page, hasMore, remaining,
}) => {
  if (!hasMore && page <= 0) return null
  return (
    <div class="more">
      {page > 0 && <a href={withQuery(base, { ...params, page: page - 1 })}>‹ Førre</a>}
      {hasMore && (
        <a href={withQuery(base, { ...params, page: page + 1 })} class="more-next">
          Vis fleire{remaining && remaining > 0 ? ` · ${new Intl.NumberFormat('nn-NO').format(remaining)} til` : ''}
        </a>
      )}
    </div>
  )
}

/** A form field in the Filter fold. */
export const Field: FC<PropsWithChildren<{ label: string }>> = ({ label, children }) => (
  <label class="field"><span>{label}</span>{children}</label>
)

export const Select: FC<{ name: string; value?: string; options: Array<[string, string]> }> = ({ name, value, options }) => (
  <select name={name}>
    {options.map(([v, l]) => <option value={v} selected={(value ?? '') === v}>{l}</option>)}
  </select>
)

const ImportSync: FC<{ cat: Category; running: ReadonlySet<string>; returnTo: string }> = ({ cat, running, returnTo }) => {
  if (cat.imports.length === 0 && cat.sync.length === 0) return null
  return (
    <section class="sec">
      <div class="sec-head"><div class="sec-title">Import og synk</div></div>
      <div class="panel">
        {cat.imports.map((k) => (
          <a class="is-row" href={`/admin/import#${k.anchor}`}>
            <span class="badge badge-accent">{k.verb}</span>
            <div class="r-main">
              <div class="r-title">{k.label}</div>
              <div class="r-sub">{k.sub}</div>
            </div>
            <span class="chev">›</span>
          </a>
        ))}
        {cat.sync.map((j) => {
          const busy = running.has(j.job)
          return (
            <form class="is-row" method="post" action="/admin/media/sync">
              <span class="badge badge-grey">Synk</span>
              <div class="r-main">
                <div class="r-title">{j.label}</div>
                <div class="r-sub">{busy ? 'Køyrer no' : 'Køyrer i bakgrunnen'}</div>
              </div>
              <input type="hidden" name="job" value={j.job} />
              <input type="hidden" name="return" value={returnTo} />
              <button type="submit" class="btn-run" disabled={busy}>{busy ? 'Køyrer' : 'Køyr'}</button>
            </form>
          )
        })}
      </div>
    </section>
  )
}

/**
 * One ⋯ sheet per page, filled from the tapped row. The only script on a category page:
 * the forms inside are plain POSTs, and the sheet is a native <dialog>.
 */
const RowMenuSheet: FC = () => (
  <>
    <dialog id="rowmenu" class="sheet" aria-label="Handlingar" onclick="if(event.target===this)this.close()">
      <div class="sheet-body">
        <div class="grab" />
        <div class="rm-head"><div class="rm-title" /></div>
        <form method="post" action="/admin/media/reenrich" class="rm-form">
          <input type="hidden" name="kind" />
          <input type="hidden" name="id" />
          <input type="hidden" name="return" />
          <button type="submit" class="rm-item">Berik på nytt</button>
        </form>
        <form method="post" action="/admin/media/hide" class="rm-form rm-hide">
          <input type="hidden" name="kind" />
          <input type="hidden" name="id" />
          <input type="hidden" name="return" />
          <button type="submit" class="rm-item">Skjul</button>
        </form>
        <a class="rm-item rm-source" href="#" target="_blank" rel="noreferrer noopener">Opne kjelde ↗</a>
        <div class="rm-note">
          «Skjul» stoppar at raden blir servert frå MCP og REST. Ho blir ikkje sletta, og ein ny
          berikning tek henne ikkje fram att.
        </div>
      </div>
    </dialog>
    <script dangerouslySetInnerHTML={{ __html: ROW_MENU_JS }} />
  </>
)

const ROW_MENU_JS = `
document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('[data-menu]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  var m = JSON.parse(b.getAttribute('data-menu'));
  var d = document.getElementById('rowmenu');
  d.querySelector('.rm-title').textContent = m.t;
  d.querySelectorAll('.rm-form').forEach(function (f) {
    f.elements.kind.value = m.k; f.elements.id.value = m.i; f.elements['return'].value = m.r;
  });
  var hide = d.querySelector('.rm-hide');
  hide.action = m.h ? '/admin/media/unhide' : '/admin/media/hide';
  hide.querySelector('button').textContent = m.h ? 'Vis igjen' : 'Skjul';
  var src = d.querySelector('.rm-source');
  src.hidden = !m.s; src.href = m.s || '#';
  d.showModal();
}, true);
`

/** Display labels for NeoDB/BookWyrm/Gigowl status values. Raw values stay in JSON views. */
export function statusLabel(status: string | null | undefined, category?: string | null): string | null {
  if (!status) return null
  const wish = category === 'book' ? 'Vil lese'
    : category === 'music' || category === 'podcast' ? 'Vil høyre'
    : category === 'game' ? 'Vil spele'
    : 'Vil sjå'
  const map: Record<string, string> = {
    complete: 'Fullført',
    progress: 'Pågår',
    wishlist: wish,
    dropped: 'Avbrote',
    went: 'Var der',
    going: 'Skal dit',
    interested: 'Interessert',
    reading: 'Les no',
    read: 'Lese',
    'to-read': 'Vil lese',
  }
  return map[status] ?? status
}

/** "14. sep. 2026" in Oslo time, or "—". */
export function nnDate(d: Date | string | null | undefined): string {
  if (!d) return '—'
  const date = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return '—'
  return NN_DATE.format(date)
}

const NN_DATE = new Intl.DateTimeFormat('nn-NO', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Oslo',
})

export const nf = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('nn-NO').format(n))
