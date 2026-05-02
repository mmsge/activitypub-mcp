/** @jsxImportSource hono/jsx */
import { Layout } from './layout.js'

interface Follow {
  actorApId: string
  status: string
  followedAt: Date
  acceptedAt: Date | null
  handle: string | null
  displayName: string | null
  iconUrl: string | null
}

export function FollowsPage({ follows }: { follows: Follow[] }) {
  return (
    <Layout title="Follows">
      <h1>Follows</h1>
      <p style="color:#888; margin-bottom:20px; font-size:13px">
        Follows are managed via the <code>FOLLOW_ACTORS</code> environment variable and synced on server startup.
      </p>
      <table>
        <thead>
          <tr>
            <th>Actor</th>
            <th>Handle</th>
            <th>Status</th>
            <th>Followed At</th>
            <th>Accepted At</th>
          </tr>
        </thead>
        <tbody>
          {follows.map(f => (
            <tr key={f.actorApId}>
              <td>
                <div style="display:flex; align-items:center; gap:8px">
                  {f.iconUrl && <img src={f.iconUrl} width="24" height="24" style="border-radius:50%" />}
                  <div>
                    <div>{f.displayName ?? f.handle ?? f.actorApId}</div>
                    <div class="mono" style="color:#666;font-size:11px">{f.actorApId}</div>
                  </div>
                </div>
              </td>
              <td class="mono">{f.handle ?? '—'}</td>
              <td>
                {f.status === 'accepted' && <span class="badge badge-green">Accepted</span>}
                {f.status === 'pending' && <span class="badge badge-yellow">Pending</span>}
                {f.status === 'rejected' && <span class="badge badge-red">Rejected</span>}
              </td>
              <td class="mono">{f.followedAt.toISOString().slice(0, 10)}</td>
              <td class="mono">{f.acceptedAt?.toISOString().slice(0, 10) ?? '—'}</td>
            </tr>
          ))}
          {follows.length === 0 && (
            <tr><td colspan={5} style="color:#666;text-align:center">No follows yet. Add handles to FOLLOW_ACTORS and restart.</td></tr>
          )}
        </tbody>
      </table>
    </Layout>
  )
}
