/** @jsxImportSource hono/jsx */
import type { FC, PropsWithChildren } from 'hono/jsx'
import { Layout } from './layout.js'
import { Pager, EmptyRow, Cover, Tabs, EnrichBadge, BookBadge, fmtDate, type MediaTab, type QueryParams } from './ui.js'
import type { BookRow, WatchedRow, OtherRow, ScrobbleRow, Page } from '../media-query.js'

// --- shell -------------------------------------------------------------------

const SYNC_JOBS: Array<[string, string]> = [
  ['neodb', 'Sync NeoDB metadata'],
  ['books', 'Sync book metadata'],
  ['reading', 'Sync reading history'],
  ['lastfm', 'Sync Last.fm'],
]

const Shell: FC<PropsWithChildren<{
  tab: MediaTab
  total: number
  notice?: string
  returnTo: string
}>> = ({ tab, total, notice, returnTo, children }) => (
  <Layout title="Media">
    <h1>Media</h1>
    {notice && <div class="notice">{notice}</div>}
    <Tabs active={tab} />
    <div class="filters" style="margin-bottom:20px">
      {SYNC_JOBS.map(([job, label]) => (
        <form method="post" action="/admin/media/sync" style="display:inline">
          <input type="hidden" name="job" value={job} />
          <input type="hidden" name="return" value={returnTo} />
          <button type="submit" class="btn-ghost">{label}</button>
        </form>
      ))}
      <span class="muted" style="align-self:center">
        Syncs run in the background — watch the server log for progress.
      </span>
    </div>
    {children}
    <p class="muted" style="margin-top:12px">{total} total</p>
  </Layout>
)

const ReenrichButton: FC<{ kind: 'book' | 'catalog'; id: string; returnTo: string }> = ({ kind, id, returnTo }) => (
  <form method="post" action="/admin/media/reenrich" style="display:inline">
    <input type="hidden" name="kind" value={kind} />
    <input type="hidden" name="id" value={id} />
    <input type="hidden" name="return" value={returnTo} />
    <button type="submit" class="btn-ghost">Re-enrich</button>
  </form>
)

const HealthFilter: FC<{ value?: string }> = ({ value }) => (
  <select name="health">
    <option value="" selected={!value}>Any state</option>
    <option value="failed" selected={value === 'failed'}>Failed / never enriched</option>
    <option value="ok" selected={value === 'ok'}>Enriched</option>
  </select>
)

const HiddenFilter: FC<{ value?: string }> = ({ value }) => (
  <select name="hidden">
    <option value="" selected={!value}>Hidden and visible</option>
    <option value="only" selected={value === 'only'}>Hidden only</option>
  </select>
)

/**
 * Hide/unhide toggle. `kind` is 'catalogUrl' on the Watched tab, where the row is a mark
 * and `id` is the catalogue URL — hiding acts on the catalogue entry, not one viewing.
 */
const HideButton: FC<{
  kind: 'book' | 'catalog' | 'catalogUrl'
  id: string
  hidden: boolean
  returnTo: string
}> = ({ kind, id, hidden, returnTo }) => (
  <form method="post" action={hidden ? '/admin/media/unhide' : '/admin/media/hide'} style="display:inline">
    <input type="hidden" name="kind" value={kind} />
    <input type="hidden" name="id" value={id} />
    <input type="hidden" name="return" value={returnTo} />
    <button
      type="submit"
      class="btn-ghost"
      title={hidden
        ? 'Serve this again from the MCP tools and REST API'
        : 'Stop serving this from the MCP tools and REST API (not deleted)'}
    >
      {hidden ? 'Unhide' : 'Hide'}
    </button>
  </form>
)

// --- books -------------------------------------------------------------------

export const BooksTab: FC<{
  data: Page<BookRow>
  filters: Record<string, string | undefined>
  actors: string[]
  actor?: string
  notice?: string
  returnTo: string
}> = ({ data, filters, actors, actor, notice, returnTo }) => (
  <Shell tab="books" total={data.total} notice={notice} returnTo={returnTo}>
    <form class="filters" method="get" action="/admin/media">
      <input type="hidden" name="tab" value="books" />
      <input name="title" placeholder="Title" value={filters.title ?? ''} style="width:180px" />
      <input name="author" placeholder="Author" value={filters.author ?? ''} style="width:180px" />
      <input name="format" placeholder="Format" value={filters.format ?? ''} style="width:130px" />
      <select name="shelf">
        <option value="" selected={!filters.shelf}>Any shelf</option>
        <option value="reading" selected={filters.shelf === 'reading'}>Reading</option>
        <option value="read" selected={filters.shelf === 'read'}>Read</option>
        <option value="to-read" selected={filters.shelf === 'to-read'}>To read</option>
      </select>
      <select name="sort">
        <option value="read" selected={filters.sort !== 'enriched'}>Recently read</option>
        <option value="enriched" selected={filters.sort === 'enriched'}>Recently enriched</option>
      </select>
      <HiddenFilter value={filters.hidden} />
      {actors.length > 1 && (
        <select name="actor">
          {actors.map(a => <option value={a} selected={a === actor}>{a}</option>)}
        </select>
      )}
      <button type="submit">Filter</button>
      <a href="/admin/media?tab=books" class="btn btn-ghost">Clear</a>
    </form>

    {actors.length === 0 && (
      <p class="muted" style="margin-bottom:12px">
        BOOKWYRM_ACTORS is not configured, so shelf and reading dates can't be derived.
      </p>
    )}

    <table>
      <thead>
        <tr>
          <th class="cover-cell" />
          <th>Title</th>
          <th>Author</th>
          <th>Shelf</th>
          <th>Started</th>
          <th>Finished</th>
          <th>Rating</th>
          <th>Pages</th>
          <th>Format</th>
          <th>Cached</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {data.rows.map(b => (
          <tr key={b.id} class={b.hiddenAt ? 'hidden-row' : ''}>
            <td class="cover-cell"><Cover url={b.coverUrl} alt={b.title ?? ''} /></td>
            <td>
              <a href={b.bookUrl} target="_blank" rel="noreferrer noopener">{b.title ?? '—'}</a>
              {b.series && <div class="muted">{b.series}</div>}
            </td>
            <td class="truncate">{b.author ?? '—'}</td>
            <td>{b.shelf ? <span class="badge badge-blue">{b.shelf}</span> : '—'}</td>
            <td class="mono">{fmtDate(b.started)}</td>
            <td class="mono">{fmtDate(b.finished)}</td>
            <td class="mono">{b.rating ?? '—'}</td>
            <td class="mono">{b.pages ?? '—'}</td>
            <td>{b.physicalFormat ?? '—'}</td>
            <td>
              <BookBadge fetchedAt={b.fetchedAt} />
              {b.hiddenAt && <span class="badge badge-red" style="margin-left:4px">Hidden</span>}
            </td>
            <td class="row-actions">
              <ReenrichButton kind="book" id={b.id} returnTo={returnTo} />
              <HideButton kind="book" id={b.id} hidden={Boolean(b.hiddenAt)} returnTo={returnTo} />
            </td>
          </tr>
        ))}
        {data.rows.length === 0 && <EmptyRow colspan={11} text="No books found" />}
      </tbody>
    </table>
    <Pager base="/admin/media" page={data.page} hasMore={data.hasMore} params={{ ...filters, tab: 'books' } as QueryParams} />
  </Shell>
)

// --- watched -----------------------------------------------------------------

export const WatchedTab: FC<{
  data: Page<WatchedRow>
  filters: Record<string, string | undefined>
  notice?: string
  returnTo: string
}> = ({ data, filters, notice, returnTo }) => (
  <Shell tab="watched" total={data.total} notice={notice} returnTo={returnTo}>
    <form class="filters" method="get" action="/admin/media">
      <input type="hidden" name="tab" value="watched" />
      <input name="title" placeholder="Title" value={filters.title ?? ''} style="width:180px" />
      <input name="director" placeholder="Director" value={filters.director ?? ''} style="width:150px" />
      <input name="comment" placeholder="Note (e.g. kino)" value={filters.comment ?? ''} style="width:150px" />
      <input name="from" placeholder="From YYYY-MM-DD" value={filters.from ?? ''} style="width:150px" />
      <input name="to" placeholder="To YYYY-MM-DD" value={filters.to ?? ''} style="width:150px" />
      <select name="category">
        <option value="" selected={!filters.category}>Film & TV</option>
        <option value="movie" selected={filters.category === 'movie'}>Film only</option>
        <option value="tv" selected={filters.category === 'tv'}>TV only</option>
      </select>
      <HealthFilter value={filters.health} />
      <HiddenFilter value={filters.hidden} />
      <select name="sort">
        <option value="watched" selected={filters.sort !== 'enriched'}>Recently watched</option>
        <option value="enriched" selected={filters.sort === 'enriched'}>Recently enriched</option>
      </select>
      <label class="muted" style="align-self:center">
        <input type="checkbox" name="showDeleted" value="1" checked={Boolean(filters.showDeleted)} /> show deleted
      </label>
      <button type="submit">Filter</button>
      <a href="/admin/media?tab=watched" class="btn btn-ghost">Clear</a>
    </form>

    <p class="muted" style="margin-bottom:12px">
      One row per viewing — a title watched twice appears twice.
    </p>

    <table>
      <thead>
        <tr>
          <th class="cover-cell" />
          <th>Title</th>
          <th>Type</th>
          <th>Watched</th>
          <th>Status</th>
          <th>Note</th>
          <th>Year</th>
          <th>Enrichment</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {data.rows.map(r => (
          <tr key={r.id} class={r.deletedAt || r.hiddenAt ? 'hidden-row' : ''}>
            <td class="cover-cell"><Cover url={r.coverUrl} alt={r.title ?? ''} /></td>
            <td>
              <a href={r.markUrl ?? r.itemUrl} target="_blank" rel="noreferrer noopener">
                {r.title ?? '—'}
              </a>
              {r.deletedAt && <span class="badge badge-red" style="margin-left:6px">Deleted</span>}
            </td>
            <td>{r.itemType ?? r.category ?? '—'}</td>
            <td class="mono">{fmtDate(r.watchedAt ?? r.publishedAt)}</td>
            <td>{r.status ? <span class="badge badge-blue">{r.status}</span> : '—'}</td>
            <td class="truncate">{r.comment ?? '—'}</td>
            <td class="mono">{r.year ?? '—'}</td>
            <td>
              <EnrichBadge enrichedAt={r.enrichedAt} fetchError={r.fetchError} fetchAttempts={r.fetchAttempts} />
              {r.hiddenAt && <span class="badge badge-red" style="margin-left:4px">Hidden</span>}
            </td>
            <td class="row-actions">
              <form method="post" action="/admin/media/reenrich" style="display:inline">
                <input type="hidden" name="kind" value="catalogUrl" />
                <input type="hidden" name="id" value={r.itemUrl} />
                <input type="hidden" name="return" value={returnTo} />
                <button type="submit" class="btn-ghost">Re-enrich</button>
              </form>
              <HideButton kind="catalogUrl" id={r.itemUrl} hidden={Boolean(r.hiddenAt)} returnTo={returnTo} />
            </td>
          </tr>
        ))}
        {data.rows.length === 0 && <EmptyRow colspan={9} text="No viewings found" />}
      </tbody>
    </table>
    <Pager base="/admin/media" page={data.page} hasMore={data.hasMore} params={{ ...filters, tab: 'watched' } as QueryParams} />
  </Shell>
)

// --- other media -------------------------------------------------------------

export const OtherTab: FC<{
  data: Page<OtherRow>
  filters: Record<string, string | undefined>
  categories: string[]
  notice?: string
  returnTo: string
}> = ({ data, filters, categories, notice, returnTo }) => (
  <Shell tab="other" total={data.total} notice={notice} returnTo={returnTo}>
    <form class="filters" method="get" action="/admin/media">
      <input type="hidden" name="tab" value="other" />
      <input name="title" placeholder="Title" value={filters.title ?? ''} style="width:200px" />
      <select name="category">
        <option value="" selected={!filters.category}>Everything but film & TV</option>
        {categories.filter(c => c !== 'movie' && c !== 'tv').map(c => (
          <option value={c} selected={filters.category === c}>{c}</option>
        ))}
      </select>
      <HealthFilter value={filters.health} />
      <HiddenFilter value={filters.hidden} />
      <select name="sort">
        <option value="enriched" selected={filters.sort !== 'watched'}>Recently enriched</option>
        <option value="watched" selected={filters.sort === 'watched'}>Recently marked</option>
      </select>
      <button type="submit">Filter</button>
      <a href="/admin/media?tab=other" class="btn btn-ghost">Clear</a>
    </form>

    {/* Its own form — a form nested inside another form is invalid HTML and browsers
        silently drop the inner one, so the button would do nothing. */}
    <form method="post" action="/admin/media/retry-failed" style="margin-bottom:16px">
      <input type="hidden" name="return" value={returnTo} />
      <button type="submit" class="btn-ghost">Retry all failed enrichments</button>
    </form>

    <table>
      <thead>
        <tr>
          <th class="cover-cell" />
          <th>Title</th>
          <th>Category</th>
          <th>Type</th>
          <th>Year</th>
          <th>Marks</th>
          <th>Last marked</th>
          <th>Enrichment</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {data.rows.map(r => (
          <tr key={r.id} class={r.hiddenAt ? 'hidden-row' : ''}>
            <td class="cover-cell"><Cover url={r.coverUrl} alt={r.title ?? ''} /></td>
            <td>
              <a href={r.itemUrl} target="_blank" rel="noreferrer noopener">
                {r.displayTitle ?? r.title ?? '—'}
              </a>
              {r.bookwyrmBookUrl && (
                <a href="/admin/media?tab=books" class="badge badge-blue" style="margin-left:6px">
                  BookWyrm
                </a>
              )}
            </td>
            <td>{r.category ?? <span class="muted">unknown</span>}</td>
            <td>{r.itemType ?? '—'}</td>
            <td class="mono">{r.year ?? '—'}</td>
            <td class="mono">{r.markCount}</td>
            <td class="mono">{fmtDate(r.latestAt)}</td>
            <td>
              <EnrichBadge enrichedAt={r.enrichedAt} fetchError={r.fetchError} fetchAttempts={r.fetchAttempts} />
              {r.hiddenAt && <span class="badge badge-red" style="margin-left:4px">Hidden</span>}
            </td>
            <td class="row-actions">
              <ReenrichButton kind="catalog" id={r.id} returnTo={returnTo} />
              <HideButton kind="catalog" id={r.id} hidden={Boolean(r.hiddenAt)} returnTo={returnTo} />
            </td>
          </tr>
        ))}
        {data.rows.length === 0 && <EmptyRow colspan={9} text="No items found" />}
      </tbody>
    </table>
    <Pager base="/admin/media" page={data.page} hasMore={data.hasMore} params={{ ...filters, tab: 'other' } as QueryParams} />
  </Shell>
)

// --- scrobbles ---------------------------------------------------------------

export const ScrobblesTab: FC<{
  data: Page<ScrobbleRow>
  filters: Record<string, string | undefined>
  notice?: string
  returnTo: string
}> = ({ data, filters, notice, returnTo }) => (
  <Shell tab="scrobbles" total={data.total} notice={notice} returnTo={returnTo}>
    <form class="filters" method="get" action="/admin/media">
      <input type="hidden" name="tab" value="scrobbles" />
      <input name="artist" placeholder="Artist" value={filters.artist ?? ''} style="width:200px" />
      <input name="album" placeholder="Album" value={filters.album ?? ''} style="width:200px" />
      <select name="sort">
        <option value="plays" selected={filters.sort !== 'recent'}>Most played</option>
        <option value="recent" selected={filters.sort === 'recent'}>Recently played</option>
      </select>
      <button type="submit">Filter</button>
      <a href="/admin/media?tab=scrobbles" class="btn btn-ghost">Clear</a>
    </form>

    <p class="muted" style="margin-bottom:12px">
      Rolled up by artist and album. Read-only — scrobbles carry no catalogue metadata to
      re-enrich, and nothing here can be hidden.
    </p>

    <table>
      <thead>
        <tr>
          <th class="cover-cell" />
          <th>Artist</th>
          <th>Album</th>
          <th>Plays</th>
          <th>First</th>
          <th>Last</th>
        </tr>
      </thead>
      <tbody>
        {data.rows.map(r => (
          <tr key={`${r.artistName}::${r.albumName ?? ''}`}>
            <td class="cover-cell"><Cover url={r.image} alt={r.albumName ?? r.artistName} /></td>
            <td>{r.artistName}</td>
            <td>{r.albumName ?? <span class="muted">(no album)</span>}</td>
            <td class="mono">{r.plays}</td>
            <td class="mono">{fmtDate(r.firstPlayed)}</td>
            <td class="mono">{fmtDate(r.lastPlayed)}</td>
          </tr>
        ))}
        {data.rows.length === 0 && <EmptyRow colspan={6} text="No scrobbles found" />}
      </tbody>
    </table>
    <Pager base="/admin/media" page={data.page} hasMore={data.hasMore} params={{ ...filters, tab: 'scrobbles' } as QueryParams} />
  </Shell>
)
