/** @jsxImportSource hono/jsx */
import { Layout } from './layout.js'

interface LogEntry {
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
      <p style="color:#888;font-size:12px;margin-bottom:12px" hx-get="/admin/logs?partial=1" hx-trigger="every 10s" hx-swap="none">
        Auto-refreshes every 10s
      </p>
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
        <tbody id="log-rows" hx-get="/admin/logs/rows" hx-trigger="every 10s" hx-swap="innerHTML">
          {logs.map(l => <LogRow log={l} />)}
          {logs.length === 0 && (
            <tr><td colspan={8} style="color:#666;text-align:center">No logs yet</td></tr>
          )}
        </tbody>
      </table>
      <div style="display:flex;gap:12px;margin-top:16px">
        {page > 0 && <a href={`/admin/logs?page=${page - 1}`} class="btn">← Previous</a>}
        {hasMore && <a href={`/admin/logs?page=${page + 1}`} class="btn">Next →</a>}
      </div>
    </Layout>
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
