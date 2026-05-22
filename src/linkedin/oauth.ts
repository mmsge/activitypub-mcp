/**
 * LinkedIn OAuth 2.0 helpers for the Member Data Portability (DMA) API.
 *
 * Required scopes (request whichever your Developer app is approved for):
 *   r_dma_portability_self_serve   — self-service DMA product
 *   r_dma_portability_3rd_party    — 3rd-party DMA product
 *   r_basicprofile                 — needed to resolve the member URN
 *   openid, profile                — OpenID Connect (easier profile access)
 *
 * LinkedIn Developer docs:
 *   https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/
 */
import { config, getLinkedInRedirectUri } from '../config.js'
import { encryptToken, decryptToken } from './crypto.js'
import { getDb } from '../db/client.js'
import { linkedinAuth } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { logger } from '../lib/logger.js'

const AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization'
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken'
const PROFILE_URL = 'https://api.linkedin.com/v2/userinfo'

// Scopes to request — adjust to what your app has been approved for
const SCOPES = [
  'openid',
  'profile',
  'r_dma_portability_self_serve',
]

export interface LinkedInTokenResponse {
  access_token: string
  expires_in: number         // seconds
  refresh_token?: string
  refresh_token_expires_in?: number
  scope: string
}

export interface LinkedInProfile {
  sub: string  // member URN (urn:li:person:…) or just the numeric ID
  name?: string
  picture?: string
  vanityName?: string
}

/** Build the OAuth authorization URL to redirect the user to. */
export function buildAuthUrl(state: string): string {
  if (!config.LINKEDIN_CLIENT_ID) throw new Error('LINKEDIN_CLIENT_ID not configured')
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.LINKEDIN_CLIENT_ID,
    redirect_uri: getLinkedInRedirectUri(),
    state,
    scope: SCOPES.join(' '),
  })
  return `${AUTH_URL}?${params}`
}

/** Exchange an auth code for tokens and store them in DB. Returns the member URN. */
export async function exchangeCode(code: string): Promise<string> {
  if (!config.LINKEDIN_CLIENT_ID || !config.LINKEDIN_CLIENT_SECRET) {
    throw new Error('LinkedIn client credentials not configured')
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: getLinkedInRedirectUri(),
      client_id: config.LINKEDIN_CLIENT_ID,
      client_secret: config.LINKEDIN_CLIENT_SECRET,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`LinkedIn token exchange failed (${res.status}): ${body}`)
  }
  const tokens = await res.json() as LinkedInTokenResponse

  // Resolve member URN / sub via userinfo
  const profile = await fetchProfile(tokens.access_token)
  // LinkedIn OpenID sub is typically the numeric member ID; make it a URN
  const memberUrn = profile.sub.startsWith('urn:') ? profile.sub : `urn:li:person:${profile.sub}`

  await storeTokens(memberUrn, tokens)
  logger.info({ memberUrn }, 'LinkedIn OAuth connected')
  return memberUrn
}

/** Fetch the OpenID Connect userinfo to resolve member identity. */
async function fetchProfile(accessToken: string): Promise<LinkedInProfile> {
  const res = await fetch(PROFILE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Failed to fetch LinkedIn profile: ${res.status}`)
  return res.json() as Promise<LinkedInProfile>
}

/** Store (or update) tokens in the DB, encrypted at rest. */
async function storeTokens(memberUrn: string, tokens: LinkedInTokenResponse): Promise<void> {
  const db = getDb()
  const now = new Date()
  const accessTokenExpiresAt = new Date(now.getTime() + tokens.expires_in * 1000)
  const refreshTokenExpiresAt = tokens.refresh_token_expires_in
    ? new Date(now.getTime() + tokens.refresh_token_expires_in * 1000)
    : null

  const values = {
    memberUrn,
    accessTokenEnc: encryptToken(tokens.access_token),
    accessTokenExpiresAt,
    refreshTokenEnc: tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
    refreshTokenExpiresAt,
    scopes: tokens.scope,
    updatedAt: now,
  }

  await db.insert(linkedinAuth)
    .values({ ...values, createdAt: now })
    .onConflictDoUpdate({ target: linkedinAuth.memberUrn, set: values })
}

/** Retrieve a valid access token, refreshing if needed. Returns null if not connected. */
export async function getValidAccessToken(): Promise<{ token: string; memberUrn: string } | null> {
  const db = getDb()
  const rows = await db.select().from(linkedinAuth).limit(1)
  if (rows.length === 0) return null
  const row = rows[0]

  const now = new Date()
  // Refresh if expiring in the next 5 minutes
  const expiresAt = row.accessTokenExpiresAt
  if (expiresAt > new Date(now.getTime() + 5 * 60_000)) {
    return { token: decryptToken(row.accessTokenEnc), memberUrn: row.memberUrn }
  }

  // Try refresh
  if (row.refreshTokenEnc && row.refreshTokenExpiresAt && row.refreshTokenExpiresAt > now) {
    logger.info('Refreshing LinkedIn access token')
    const refreshToken = decryptToken(row.refreshTokenEnc)
    try {
      const refreshed = await refreshAccessToken(refreshToken)
      await storeTokens(row.memberUrn, refreshed)
      return { token: refreshed.access_token, memberUrn: row.memberUrn }
    } catch (e) {
      logger.error(e, 'LinkedIn token refresh failed')
      return null
    }
  }

  logger.warn('LinkedIn access token expired and no valid refresh token')
  return null
}

async function refreshAccessToken(refreshToken: string): Promise<LinkedInTokenResponse> {
  if (!config.LINKEDIN_CLIENT_ID || !config.LINKEDIN_CLIENT_SECRET) {
    throw new Error('LinkedIn client credentials not configured')
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.LINKEDIN_CLIENT_ID,
      client_secret: config.LINKEDIN_CLIENT_SECRET,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`LinkedIn token refresh failed (${res.status}): ${body}`)
  }
  return res.json() as Promise<LinkedInTokenResponse>
}
