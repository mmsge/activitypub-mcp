/** @jsxImportSource hono/jsx */
import { Layout } from './layout.js'
import { Pager, EmptyRow } from './ui.js'

export interface LogEntry {
  id: number
  direction: string
  method: string
  url: string
  responseStatus: number | null
  signatureValid: boolean | null
  error: string | null
  actorApId: string | null
  createdAt: Date
  requestBody: string | null
  requestHeaders: unknown
  responseBody: string | null
}

interface LogsPageProps {
  logs: LogEntry[]
  page: number
  hasMore: boolean
  filters: { direction?: string; sigValid?: string; actor?: string }
}

export function LogsPage({ logs, page, hasMore, filters }: LogsPageProps) {
  return (
    <Layout title="Logs">
      <h1>HTTP Logs</h1>
      <form class="filters" method="get" action="/admin/logs">
        <select name="direction">
          <option value="" selected={!filters.direction}>All directions</option>
          <option value="inbound" selected={filters.direction === 'inbound'}>Inbound</option>
          <option value="outbound" selected={filters.direction === 'outbound'}>Outbound</option>
        </select>
        <select name="sigValid">
          <option value="" selected={!filters.sigValid}>Any signature</option>
          <option value="true" selected={filters.sigValid === 'true'}>Valid ✓</option>
          <option value="false" selected={filters.sigValid === 'false'}>Invalid ✗</option>
        </select>
        <input name="actor" placeholder="Actor URL" value={filters.actor ?? ''} style="width:280px" />
        <button type="submit">Filter</button>
        <a href="/admin/logs" class="btn" style="background:#333">Clear</a>
      </form>
      <p class="muted" style="margin-bottom:12px">Auto-refreshes every 10s</p>
      <table>
        <thead>
          <tr>
            <th>Dir</th>
            <th>Method</th>
            <th>URL</th>
            <th>Status</th>
            <th>Sig</th>
            <th>Actor</th>
            <th>Time</th>
            <th>Detail</th>
          </tr>
        </thead>
        {/* Polls the fragment route below, which re-renders exactly these rows for the
            current page and filters. */}
        <tbody
          id="log-rows"
          hx-get={rowsUrl(page, filters)}
          hx-trigger="every 10s"
          hx-swap="innerHTML"
        >
          <LogRows logs={logs} />
        </tbody>
      </table>
      <Pager base="/admin/logs" page={page} hasMore={hasMore} params={filters} />
    </Layout>
  )
}

function rowsUrl(page: number, filters: LogsPageProps['filters']): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries({ ...filters, page: page || undefined })) {
    if (v === undefined || v === null || v === '') continue
    sp.set(k, String(v))
  }
  const qs = sp.toString()
  return qs ? `/admin/logs/rows?${qs}` : '/admin/logs/rows'
}

/** The tbody contents on their own, so the poll can swap them in without a page reload. */
export function LogRows({ logs }: { logs: LogEntry[] }) {
  return (
    <>
      {logs.map(l => <LogRow log={l} />)}
      {logs.length === 0 && <EmptyRow colspan={8} text="No logs yet" />}
    </>
  )
}

function LogRow({ log: l }: { log: LogEntry }) {
  return (
    <tr key={l.id}>
      <td>
        {l.direction === 'inbound'
          ? <span class="badge badge-blue">IN</span>
          : <span class="badge badge-yellow">OUT</span>
        }
      </td>
      <td class="mono">{l.method}</td>
      <td class="truncate mono">{l.url}</td>
      <td class="mono">{l.responseStatus ?? '—'}</td>
      <td>
        {l.signatureValid === null ? '—'
          : l.signatureValid
            ? <span class="valid-yes">✓</span>
            : <span class="valid-no">✗</span>
        }
      </td>
      <td class="truncate mono" style="max-width:200px">{l.actorApId ?? '—'}</td>
      <td class="mono">{l.createdAt.toISOString().slice(0, 19).replace('T', ' ')}</td>
      <td>
        <details>
          <summary>Detail</summary>
          {l.error && <div style="color:#f87171;margin-bottom:4px">{l.error}</div>}
          {l.requestBody && <pre>{l.requestBody.slice(0, 2000)}</pre>}
          {l.responseBody && <pre style="margin-top:4px">{l.responseBody.slice(0, 1000)}</pre>}
        </details>
      </td>
    </tr>
  )
}
