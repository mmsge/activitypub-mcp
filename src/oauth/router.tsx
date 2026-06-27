/** @jsxImportSource hono/jsx */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { timingSafeEqual } from 'node:crypto'
import { logger } from '../lib/logger.js'
import { verifyAdminPassword } from '../admin/auth.js'
import { AuthorizePage, type AuthorizeParams } from './views/authorize.js'
import {
  getClient,
  registerClient,
  createAuthCode,
  consumeAuthCode,
  issueTokens,
  refreshAccessToken,
  revokeToken,
  verifyPkceS256,
  type StoredClient,
} from './store.js'

const app = new Hono()

// OAuth token/register/revoke may be called cross-origin by browser-based
// clients, so allow CORS. The authorize page is a top-level navigation and
// doesn't need it, but a permissive policy here is harmless.
app.use('/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization'] }))

// --- helpers ---------------------------------------------------------------

function oauthError(c: any, status: number, error: string, description?: string) {
  return c.json({ error, ...(description ? { error_description: description } : {}) }, status, { 'Cache-Control': 'no-store' })
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

/**
 * Match a requested redirect_uri against a client's registered URIs. Exact match,
 * except loopback hosts (RFC 8252) may use any port. If no URI is requested and
 * the client registered exactly one, that one is used.
 */
function resolveRedirectUri(client: StoredClient, requested?: string): string | null {
  if (!requested) return client.redirect_uris.length === 1 ? client.redirect_uris[0] : null
  for (const reg of client.redirect_uris) {
    if (reg === requested) return requested
    try {
      const a = new URL(reg)
      const b = new URL(requested)
      const loopback = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
      if (loopback(a.hostname) && loopback(b.hostname) && a.protocol === b.protocol && a.pathname === b.pathname) {
        return requested
      }
    } catch {
      // not URLs; fall through
    }
  }
  return null
}

/** Authenticate a client on the token/revoke endpoints. Returns the client or an error response. */
async function authenticateClient(c: any, body: Record<string, string>): Promise<StoredClient | Response> {
  const clientId = body.client_id
  if (!clientId) return oauthError(c, 401, 'invalid_client', 'client_id is required')
  const client = await getClient(clientId)
  if (!client) return oauthError(c, 401, 'invalid_client', 'Unknown client_id')
  if (client.client_secret) {
    const provided = body.client_secret
    if (!provided || !safeEqual(provided, client.client_secret)) {
      return oauthError(c, 401, 'invalid_client', 'Invalid client_secret')
    }
  }
  return client
}

/** Read a request body as a flat string map, supporting form-encoded and JSON. */
async function readBody(c: any): Promise<Record<string, string>> {
  const ct = c.req.header('content-type') ?? ''
  if (ct.includes('application/json')) {
    try {
      return (await c.req.json()) as Record<string, string>
    } catch {
      return {}
    }
  }
  const parsed = await c.req.parseBody()
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v
  return out
}

// --- Dynamic Client Registration (RFC 7591) --------------------------------

app.post('/register', async (c) => {
  const body = await readBody(c)
  const redirectUris = (body as any).redirect_uris
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every((u) => typeof u === 'string')) {
    return oauthError(c, 400, 'invalid_client_metadata', 'redirect_uris must be a non-empty array of strings')
  }
  const info = await registerClient({
    redirect_uris: redirectUris,
    token_endpoint_auth_method: (body as any).token_endpoint_auth_method,
    client_name: (body as any).client_name,
    grant_types: (body as any).grant_types,
    response_types: (body as any).response_types,
    scope: (body as any).scope,
  })
  logger.info({ clientId: info.client_id, clientName: info.client_name }, 'OAuth client registered')
  return c.json(info, 201, { 'Cache-Control': 'no-store' })
})

// --- Authorization endpoint ------------------------------------------------

function parseAuthorizeParams(src: Record<string, string | undefined>): AuthorizeParams | null {
  const client_id = src.client_id
  const code_challenge = src.code_challenge
  const code_challenge_method = src.code_challenge_method
  if (!client_id || !code_challenge) return null
  return {
    client_id,
    redirect_uri: src.redirect_uri ?? '',
    code_challenge,
    code_challenge_method: code_challenge_method ?? 'S256',
    state: src.state,
    scope: src.scope,
    resource: src.resource,
  }
}

app.get('/authorize', async (c) => {
  const q = c.req.query()
  const client = await getClient(q.client_id ?? '')
  if (!client) return c.html('<h1>Invalid client_id</h1>', 400)

  const redirectUri = resolveRedirectUri(client, q.redirect_uri)
  if (!redirectUri) return c.html('<h1>Invalid redirect_uri</h1>', 400)

  // From here errors go back to the client via redirect (OAuth 2.1).
  if ((q.response_type ?? '') !== 'code') {
    return c.redirect(`${redirectUri}?error=unsupported_response_type${q.state ? `&state=${encodeURIComponent(q.state)}` : ''}`)
  }
  if (!q.code_challenge || (q.code_challenge_method ?? 'S256') !== 'S256') {
    return c.redirect(`${redirectUri}?error=invalid_request&error_description=${encodeURIComponent('PKCE S256 required')}${q.state ? `&state=${encodeURIComponent(q.state)}` : ''}`)
  }

  const params = parseAuthorizeParams({ ...q, redirect_uri: redirectUri })!
  return c.html(<AuthorizePage clientName={clientLabel(client)} params={params} />)
})

app.post('/authorize', async (c) => {
  const body = await readBody(c)
  const client = await getClient(body.client_id ?? '')
  if (!client) return c.html('<h1>Invalid client_id</h1>', 400)
  const redirectUri = resolveRedirectUri(client, body.redirect_uri)
  if (!redirectUri) return c.html('<h1>Invalid redirect_uri</h1>', 400)

  const params = parseAuthorizeParams(body)
  if (!params) return c.html('<h1>Missing OAuth parameters</h1>', 400)
  params.redirect_uri = redirectUri

  if (!body.password || !(await verifyAdminPassword(body.password))) {
    return c.html(<AuthorizePage clientName={clientLabel(client)} params={params} error="Invalid password" />, 401)
  }

  const code = await createAuthCode({
    clientId: client.client_id,
    redirectUri,
    codeChallenge: params.code_challenge,
    scope: params.scope,
    resource: params.resource,
  })
  const url = new URL(redirectUri)
  url.searchParams.set('code', code)
  if (params.state) url.searchParams.set('state', params.state)
  logger.info({ clientId: client.client_id }, 'OAuth authorization granted')
  return c.redirect(url.toString())
})

// --- Token endpoint --------------------------------------------------------

app.post('/token', async (c) => {
  const body = await readBody(c)
  const client = await authenticateClient(c, body)
  if (client instanceof Response) return client

  const grantType = body.grant_type
  if (grantType === 'authorization_code') {
    if (!body.code || !body.code_verifier) return oauthError(c, 400, 'invalid_request', 'code and code_verifier are required')
    const record = await consumeAuthCode(body.code)
    if (!record || record.clientId !== client.client_id) return oauthError(c, 400, 'invalid_grant', 'Invalid or expired authorization code')
    if (body.redirect_uri && body.redirect_uri !== record.redirectUri) return oauthError(c, 400, 'invalid_grant', 'redirect_uri mismatch')
    if (!verifyPkceS256(body.code_verifier, record.codeChallenge)) return oauthError(c, 400, 'invalid_grant', 'PKCE verification failed')
    const tokens = await issueTokens(client.client_id, record.scope)
    return c.json(tokens, 200, { 'Cache-Control': 'no-store' })
  }

  if (grantType === 'refresh_token') {
    if (!body.refresh_token) return oauthError(c, 400, 'invalid_request', 'refresh_token is required')
    const tokens = await refreshAccessToken(body.refresh_token)
    if (!tokens) return oauthError(c, 400, 'invalid_grant', 'Invalid or expired refresh token')
    return c.json(tokens, 200, { 'Cache-Control': 'no-store' })
  }

  return oauthError(c, 400, 'unsupported_grant_type', `Unsupported grant_type: ${grantType ?? '(none)'}`)
})

// --- Revocation (RFC 7009) -------------------------------------------------

app.post('/revoke', async (c) => {
  const body = await readBody(c)
  const client = await authenticateClient(c, body)
  if (client instanceof Response) return client
  if (body.token) await revokeToken(body.token)
  // Per spec, revocation always returns 200 even for unknown tokens.
  return c.json({}, 200, { 'Cache-Control': 'no-store' })
})

// A human-friendly label for a client on the consent screen.
function clientLabel(client: StoredClient): string {
  return client.client_name || 'An application'
}

export { app as oauthRouter }
