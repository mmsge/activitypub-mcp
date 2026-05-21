/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import { Layout } from './layout.js'
import type { LinkedInPollResult } from '../../jobs/linkedin-poll.js'

export interface LinkedInPageData {
  configured: boolean      // LINKEDIN_CLIENT_* env vars are set
  connected: boolean       // token row exists in DB
  memberUrn?: string
  displayName?: string
  accessTokenExpiresAt?: Date
  refreshTokenExpiresAt?: Date | null
  lastPolledAt?: Date | null
  postCount: number
  scopes?: string
}

export const LinkedInPage: FC<{
  data: LinkedInPageData
  pollResult?: LinkedInPollResult | null
}> = ({ data, pollResult }) => (
  <Layout title="LinkedIn">
    <h1>LinkedIn</h1>

    {!data.configured && (
      <div class="error" style="margin-bottom: 24px;">
        LinkedIn is not configured. Set <code>LINKEDIN_CLIENT_ID</code> and{' '}
        <code>LINKEDIN_CLIENT_SECRET</code> in your <code>.env</code> file and restart the server.
        See the README for setup instructions.
      </div>
    )}

    {pollResult && (
      <div class="section">
        <div class="grid" style="margin-bottom: 12px;">
          <div class="card">
            <div class="num">{pollResult.total}</div>
            <div class="label">Snapshots fetched</div>
          </div>
          <div class="card">
            <div class="num" style="color: #4ade80;">{pollResult.imported}</div>
            <div class="label">New posts imported</div>
          </div>
          <div class="card">
            <div class="num" style="color: #888;">{pollResult.skipped}</div>
            <div class="label">Already stored</div>
          </div>
          <div class="card">
            <div class="num" style="color: #f87171;">{pollResult.errors.length}</div>
            <div class="label">Errors</div>
          </div>
        </div>
        {pollResult.errors.length > 0 && (
          <pre>{pollResult.errors.slice(0, 10).join('\n')}</pre>
        )}
      </div>
    )}

    {data.connected ? (
      <div class="section">
        <h2>Connected Account</h2>
        <table>
          <tbody>
            {data.displayName && (
              <tr><td style="color:#888; width:180px">Name</td><td>{data.displayName}</td></tr>
            )}
            <tr><td style="color:#888">Member URN</td><td class="mono">{data.memberUrn}</td></tr>
            <tr>
              <td style="color:#888">Access token expires</td>
              <td>{data.accessTokenExpiresAt?.toISOString() ?? '—'}</td>
            </tr>
            {data.refreshTokenExpiresAt && (
              <tr>
                <td style="color:#888">Refresh token expires</td>
                <td>{data.refreshTokenExpiresAt.toISOString()}</td>
              </tr>
            )}
            <tr>
              <td style="color:#888">Last polled</td>
              <td>{data.lastPolledAt ? data.lastPolledAt.toISOString() : 'Never'}</td>
            </tr>
            <tr>
              <td style="color:#888">Stored posts</td>
              <td>{data.postCount}</td>
            </tr>
            {data.scopes && (
              <tr><td style="color:#888">Scopes</td><td class="mono">{data.scopes}</td></tr>
            )}
          </tbody>
        </table>

        <div class="filters" style="margin-top: 16px;">
          <form method="post" action="/admin/linkedin/poll">
            <button type="submit">Poll Now</button>
          </form>
          <form method="post" action="/admin/linkedin/disconnect"
            onsubmit="return confirm('Disconnect LinkedIn? Stored posts will be kept.')">
            <button type="submit" style="background: #b91c1c;">Disconnect</button>
          </form>
          <a href="/admin/objects?source=linkedin" class="btn" style="background: #333;">View Posts</a>
        </div>
      </div>
    ) : (
      data.configured && (
        <div class="section">
          <h2>Connect Your LinkedIn Account</h2>
          <p style="color: #888; margin-bottom: 16px; line-height: 1.5;">
            This will redirect you to LinkedIn to authorize access to your post history
            via the Member Data Portability API. Your app must have the{' '}
            <strong>Member Data Portability (Self-Serve)</strong> product approved on the
            LinkedIn Developer portal.
          </p>
          <a href="/admin/linkedin/connect" class="btn">Connect LinkedIn</a>
        </div>
      )
    )}
  </Layout>
)
