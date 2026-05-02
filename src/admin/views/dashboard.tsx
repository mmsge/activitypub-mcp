/** @jsxImportSource hono/jsx */
import { Layout } from './layout.js'

interface DashboardData {
  totalActivities: number
  activitiesLast24h: number
  activitiesLast7d: number
  totalObjects: number
  followsAccepted: number
  followsPending: number
  recentActivities: Array<{
    type: string
    actorApId: string
    objectType: string | null
    receivedAt: Date
    processed: boolean
    processingError: string | null
  }>
  lastReceivedAt: Date | null
  deliveryErrors: number
}

export function DashboardPage({ data }: { data: DashboardData }) {
  return (
    <Layout title="Dashboard">
      <h1>Dashboard</h1>
      <div class="grid">
        <div class="card">
          <div class="num">{data.activitiesLast24h}</div>
          <div class="label">Activities (24h)</div>
        </div>
        <div class="card">
          <div class="num">{data.activitiesLast7d}</div>
          <div class="label">Activities (7d)</div>
        </div>
        <div class="card">
          <div class="num">{data.totalObjects}</div>
          <div class="label">Stored Posts</div>
        </div>
        <div class="card">
          <div class="num">{data.followsAccepted}</div>
          <div class="label">Follows Accepted</div>
        </div>
        <div class="card">
          <div class="num" style="color: #fbbf24">{data.followsPending}</div>
          <div class="label">Follows Pending</div>
        </div>
        <div class="card">
          <div class="num" style="color: #f87171">{data.deliveryErrors}</div>
          <div class="label">Delivery Errors</div>
        </div>
      </div>

      {data.lastReceivedAt && (
        <p style="color: #888; margin-bottom: 20px; font-size: 12px;">
          Last activity received: {data.lastReceivedAt.toISOString()}
        </p>
      )}

      <div class="section">
        <h2>Recent Activities</h2>
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Actor</th>
              <th>Object Type</th>
              <th>Received</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.recentActivities.map((a, i) => (
              <tr key={i}>
                <td><span class="badge badge-blue">{a.type}</span></td>
                <td class="truncate mono">{a.actorApId}</td>
                <td>{a.objectType ?? '—'}</td>
                <td class="mono">{a.receivedAt.toISOString().slice(0, 19).replace('T', ' ')}</td>
                <td>
                  {a.processingError
                    ? <span class="badge badge-red">Error</span>
                    : a.processed
                      ? <span class="badge badge-green">OK</span>
                      : <span class="badge badge-yellow">Pending</span>
                  }
                </td>
              </tr>
            ))}
            {data.recentActivities.length === 0 && (
              <tr><td colspan={5} style="color: #666; text-align: center;">No activities yet</td></tr>
            )}
          </tbody>
        </table>
        <p style="margin-top: 8px;"><a href="/admin/activities">View all activities →</a></p>
      </div>
    </Layout>
  )
}
