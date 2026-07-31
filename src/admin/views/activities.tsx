/** @jsxImportSource hono/jsx */
import { Layout } from './layout.js'
import { Pager, EmptyRow } from './ui.js'

interface Activity {
  id: string
  apId: string
  type: string
  actorApId: string
  objectType: string | null
  receivedAt: Date
  processed: boolean
  processingError: string | null
  raw: unknown
}

interface ActivitiesPageProps {
  activities: Activity[]
  page: number
  hasMore: boolean
  filters: { actor?: string; type?: string }
}

export function ActivitiesPage({ activities, page, hasMore, filters }: ActivitiesPageProps) {
  return (
    <Layout title="Activities">
      <h1>Activities</h1>
      <form class="filters" method="get" action="/admin/activities">
        <input name="actor" placeholder="Actor URL" value={filters.actor ?? ''} style="width: 300px" />
        <input name="type" placeholder="Type (Create, Announce...)" value={filters.type ?? ''} style="width: 180px" />
        <button type="submit">Filter</button>
        <a href="/admin/activities" class="btn" style="background:#333">Clear</a>
      </form>
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Actor</th>
            <th>Object Type</th>
            <th>Received</th>
            <th>Status</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {activities.map(a => (
            <tr key={a.id}>
              <td><span class="badge badge-blue">{a.type}</span></td>
              <td class="truncate mono">{a.actorApId}</td>
              <td>{a.objectType ?? '—'}</td>
              <td class="mono">{a.receivedAt.toISOString().slice(0, 19).replace('T', ' ')}</td>
              <td>
                {a.processingError
                  ? <span class="badge badge-red" title={a.processingError}>Error</span>
                  : a.processed
                    ? <span class="badge badge-green">OK</span>
                    : <span class="badge badge-yellow">Pending</span>
                }
              </td>
              <td>
                <details>
                  <summary>JSON</summary>
                  <pre>{JSON.stringify(a.raw, null, 2)}</pre>
                </details>
              </td>
            </tr>
          ))}
          {activities.length === 0 && <EmptyRow colspan={6} text="No activities found" />}
        </tbody>
      </table>
      <Pager base="/admin/activities" page={page} hasMore={hasMore} params={filters} />
    </Layout>
  )
}
