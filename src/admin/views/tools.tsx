/** @jsxImportSource hono/jsx */
import { Layout } from './layout.js'
import type { RestEndpoint } from '../../rest/table.js'

interface Param {
  name: string
  required: boolean
  type: string
}

export interface InfraRoute {
  methods: string
  path: string
  description: string
}

/**
 * Hand-maintained list of the non-data routes mounted by the server. These are
 * not in any central registry, so keep this in sync with `src/index.ts` and the
 * federation / OAuth routers if routes change.
 */
export const INFRA_ROUTES: InfraRoute[] = [
  { methods: 'GET', path: '/actor', description: 'ActivityPub actor document' },
  { methods: 'GET', path: '/users/{username}', description: 'Actor document (username alias)' },
  { methods: 'POST', path: '/actor/inbox', description: 'Inbox (also /users/{username}/inbox and shared /inbox)' },
  { methods: 'GET', path: '/actor/outbox', description: 'Outbox collection' },
  { methods: 'GET', path: '/actor/followers', description: 'Followers collection' },
  { methods: 'GET', path: '/actor/following', description: 'Following collection' },
  { methods: 'GET', path: '/.well-known/webfinger', description: 'WebFinger actor discovery' },
  { methods: 'GET', path: '/nodeinfo', description: 'NodeInfo discovery' },
  { methods: 'GET', path: '/nodeinfo/2.0', description: 'NodeInfo 2.0 document' },
  { methods: 'GET', path: '/.well-known/oauth-authorization-server', description: 'OAuth authorization server metadata' },
  { methods: 'GET', path: '/.well-known/oauth-protected-resource', description: 'OAuth protected resource metadata' },
  { methods: 'POST', path: '/oauth/register', description: 'Dynamic client registration' },
  { methods: 'GET / POST', path: '/oauth/authorize', description: 'OAuth authorization endpoint' },
  { methods: 'POST', path: '/oauth/token', description: 'OAuth token endpoint' },
  { methods: 'POST', path: '/oauth/revoke', description: 'OAuth token revocation' },
  { methods: 'ALL', path: '/mcp', description: 'MCP transport (Streamable HTTP)' },
  { methods: 'GET', path: '/api/v1/', description: 'REST API discovery document' },
  { methods: 'GET', path: '/health', description: 'Health check' },
  { methods: 'GET', path: '/admin/*', description: 'Admin UI (this dashboard)' },
]

/** Derive the parameter list for an endpoint from its Zod schema. */
function paramsFor(ep: RestEndpoint): Param[] {
  const typeOf = (name: string): string => {
    if (ep.numbers.includes(name)) return 'number'
    if (ep.booleans.includes(name)) return 'boolean'
    if (ep.arrays.includes(name)) return 'array'
    return 'string'
  }
  return Object.entries(ep.schema.shape).map(([name, field]) => ({
    name,
    required: !(field as { isOptional(): boolean }).isOptional(),
    type: typeOf(name),
  }))
}

export function ToolsPage({ endpoints, infra }: { endpoints: RestEndpoint[]; infra: InfraRoute[] }) {
  return (
    <Layout title="Tools & Endpoints">
      <h1>Tools &amp; Endpoints</h1>
      <p style="color:#888; margin-bottom:20px; font-size:13px">
        The MCP tools and HTTP API exposed by this running server. The data API is read live from
        the endpoint registry; every MCP tool has a matching <code>/api/v1</code> REST endpoint
        returning identical data.
      </p>

      <div class="grid">
        <div class="card">
          <div class="num">{endpoints.length}</div>
          <div class="label">MCP Tools</div>
        </div>
        <div class="card">
          <div class="num">{endpoints.length}</div>
          <div class="label">REST Endpoints</div>
        </div>
        <div class="card">
          <div class="num">{infra.length}</div>
          <div class="label">Infra / Federation Routes</div>
        </div>
      </div>

      <div class="section">
        <h2>Data API — MCP tools &amp; REST endpoints</h2>
        <table>
          <thead>
            <tr>
              <th>MCP Tool</th>
              <th>REST Endpoint</th>
              <th>Methods</th>
              <th>Parameters</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map(ep => {
              const params = paramsFor(ep)
              return (
                <tr key={ep.name}>
                  <td class="mono">{ep.name}</td>
                  <td class="mono">/api/v1{ep.path}</td>
                  <td>
                    <span class="badge badge-green">GET</span>{' '}
                    <span class="badge badge-blue">QUERY</span>{' '}
                    <span class="badge badge-blue">POST</span>
                  </td>
                  <td>
                    {params.length === 0 && <span style="color:#666">—</span>}
                    {params.map(p => (
                      <div key={p.name} class="mono" style="font-size:11px; margin-bottom:2px">
                        {p.name}{' '}
                        <span style={p.required ? 'color:#fbbf24' : 'color:#666'}>
                          {p.required ? 'required' : 'optional'}
                        </span>{' '}
                        <span style="color:#60a5fa">{p.type}</span>
                      </div>
                    ))}
                  </td>
                  <td style="max-width:420px">{ep.description}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div class="section">
        <h2>Infrastructure &amp; federation routes</h2>
        <table>
          <thead>
            <tr>
              <th>Methods</th>
              <th>Path</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {infra.map(r => (
              <tr key={r.path}>
                <td class="mono">{r.methods}</td>
                <td class="mono">{r.path}</td>
                <td>{r.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  )
}
