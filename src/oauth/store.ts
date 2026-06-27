import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { oauthClients, oauthAuthCodes, oauthTokens } from '../db/schema.js'

// Token / code lifetimes. Access tokens are short-lived; the connector refreshes
// them with the long-lived refresh token. Codes are single-use and expire fast.
export const ACCESS_TTL_MS = 60 * 60 * 1000 // 1h
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30d
const CODE_TTL_MS = 10 * 60 * 1000 // 10m

// The single scope we issue. We don't do granular authorization — any client the
// admin approves gets full read access to the MCP tools.
export const MCP_SCOPE = 'mcp'

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export type StoredClient = {
  client_id: string
  client_secret?: string
  client_name?: string
  redirect_uris: string[]
  token_endpoint_auth_method: string
  scope?: string
}

export type ClientRegistration = {
  redirect_uris: string[]
  token_endpoint_auth_method?: string
  client_name?: string
  grant_types?: string[]
  response_types?: string[]
  scope?: string
}

/** Dynamic Client Registration (RFC 7591). Returns the full client info incl. generated id/secret. */
export async function registerClient(meta: ClientRegistration) {
  const clientId = randomUUID()
  const isPublic = meta.token_endpoint_auth_method === 'none'
  const clientSecret = isPublic ? undefined : randomBytes(32).toString('hex')
  const issuedAt = Math.floor(Date.now() / 1000)

  await getDb().insert(oauthClients).values({
    clientId,
    clientSecret: clientSecret ?? null,
    redirectUris: meta.redirect_uris,
    clientName: meta.client_name ?? null,
    tokenEndpointAuthMethod: meta.token_endpoint_auth_method ?? 'client_secret_basic',
    grantTypes: meta.grant_types ?? ['authorization_code', 'refresh_token'],
    responseTypes: meta.response_types ?? ['code'],
    scope: meta.scope ?? MCP_SCOPE,
  })

  return {
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    client_id_issued_at: issuedAt,
    // 0 = never expires (we don't expire client secrets).
    ...(clientSecret ? { client_secret_expires_at: 0 } : {}),
    redirect_uris: meta.redirect_uris,
    token_endpoint_auth_method: meta.token_endpoint_auth_method ?? 'client_secret_basic',
    grant_types: meta.grant_types ?? ['authorization_code', 'refresh_token'],
    response_types: meta.response_types ?? ['code'],
    ...(meta.client_name ? { client_name: meta.client_name } : {}),
    scope: meta.scope ?? MCP_SCOPE,
  }
}

export async function getClient(clientId: string): Promise<StoredClient | undefined> {
  const [row] = await getDb().select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1)
  if (!row) return undefined
  return {
    client_id: row.clientId,
    client_secret: row.clientSecret ?? undefined,
    client_name: row.clientName ?? undefined,
    redirect_uris: (row.redirectUris as string[]) ?? [],
    token_endpoint_auth_method: row.tokenEndpointAuthMethod,
    scope: row.scope ?? undefined,
  }
}

/** Create a single-use authorization code bound to the PKCE challenge. Returns the plaintext code. */
export async function createAuthCode(params: {
  clientId: string
  redirectUri: string
  codeChallenge: string
  scope?: string
  resource?: string
}): Promise<string> {
  const code = randomBytes(32).toString('hex')
  await getDb().insert(oauthAuthCodes).values({
    codeHash: sha256(code),
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    scope: params.scope ?? MCP_SCOPE,
    resource: params.resource ?? null,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  })
  return code
}

export type ConsumedCode = {
  clientId: string
  redirectUri: string
  codeChallenge: string
  scope?: string
  resource?: string
}

/**
 * Atomically consume an authorization code: fetch it and delete it (single use),
 * returning its record. Returns null if unknown or expired. PKCE verification is
 * done by the caller against `codeChallenge` — the code is invalidated either way.
 */
export async function consumeAuthCode(code: string): Promise<ConsumedCode | null> {
  const db = getDb()
  const hash = sha256(code)
  const [row] = await db.select().from(oauthAuthCodes).where(eq(oauthAuthCodes.codeHash, hash)).limit(1)
  if (!row) return null
  await db.delete(oauthAuthCodes).where(eq(oauthAuthCodes.codeHash, hash))
  if (row.expiresAt < new Date()) return null
  return {
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    codeChallenge: row.codeChallenge,
    scope: row.scope ?? undefined,
    resource: row.resource ?? undefined,
  }
}

export type IssuedTokens = {
  access_token: string
  refresh_token: string
  token_type: 'Bearer'
  expires_in: number
  scope: string
}

/** Issue a fresh access + refresh token pair for a client. */
export async function issueTokens(clientId: string, scope = MCP_SCOPE): Promise<IssuedTokens> {
  const accessToken = randomBytes(32).toString('hex')
  const refreshToken = randomBytes(32).toString('hex')
  const now = Date.now()
  await getDb().insert(oauthTokens).values([
    { tokenHash: sha256(accessToken), type: 'access', clientId, scope, expiresAt: new Date(now + ACCESS_TTL_MS) },
    { tokenHash: sha256(refreshToken), type: 'refresh', clientId, scope, expiresAt: new Date(now + REFRESH_TTL_MS) },
  ])
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    scope,
  }
}

/** Exchange a refresh token for a new access token. Returns null if invalid/expired. */
export async function refreshAccessToken(refreshToken: string): Promise<IssuedTokens | null> {
  const db = getDb()
  const hash = sha256(refreshToken)
  const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.tokenHash, hash)).limit(1)
  if (!row || row.type !== 'refresh') return null
  if (row.expiresAt < new Date()) {
    await db.delete(oauthTokens).where(eq(oauthTokens.tokenHash, hash))
    return null
  }
  // Issue a new access token; keep the existing refresh token valid (no rotation).
  const accessToken = randomBytes(32).toString('hex')
  await db.insert(oauthTokens).values({
    tokenHash: sha256(accessToken),
    type: 'access',
    clientId: row.clientId,
    scope: row.scope ?? MCP_SCOPE,
    expiresAt: new Date(Date.now() + ACCESS_TTL_MS),
  })
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    scope: row.scope ?? MCP_SCOPE,
  }
}

export type VerifiedToken = { clientId: string; scope: string }

/** Verify an access token. Returns its client/scope, or null if invalid/expired. */
export async function verifyAccessToken(token: string): Promise<VerifiedToken | null> {
  const db = getDb()
  const hash = sha256(token)
  const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.tokenHash, hash)).limit(1)
  if (!row || row.type !== 'access') return null
  if (row.expiresAt < new Date()) {
    await db.delete(oauthTokens).where(eq(oauthTokens.tokenHash, hash))
    return null
  }
  return { clientId: row.clientId, scope: row.scope ?? MCP_SCOPE }
}

/** Revoke an access or refresh token (RFC 7009). No-op if unknown. */
export async function revokeToken(token: string): Promise<void> {
  await getDb().delete(oauthTokens).where(eq(oauthTokens.tokenHash, sha256(token)))
}

/** Delete expired codes and tokens. Called periodically alongside session pruning. */
export async function pruneExpiredOauth(): Promise<void> {
  const db = getDb()
  const now = new Date()
  await db.delete(oauthAuthCodes).where(lt(oauthAuthCodes.expiresAt, now))
  await db.delete(oauthTokens).where(lt(oauthTokens.expiresAt, now))
}

/** Verify a PKCE code_verifier against a stored S256 code_challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = createHash('sha256').update(verifier).digest('base64url')
  return computed === challenge
}
