import { createMiddleware } from 'hono/factory'
import { timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { verifyAccessToken } from '../oauth/store.js'
import { resourceMetadataUrl } from '../oauth/metadata.js'

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

/**
 * Build the WWW-Authenticate header that points clients at our protected-resource
 * metadata. This is what makes browser/mobile MCP clients (claude.ai) discover
 * the OAuth flow when they hit /mcp without a token.
 */
function wwwAuthenticate(error: string, description: string): string {
  return `Bearer error="${error}", error_description="${description}", resource_metadata="${resourceMetadataUrl()}"`
}

/**
 * Gate /mcp. Accepts EITHER a valid OAuth access token (used by browser/mobile
 * clients like claude.ai) OR the static REST_API_KEY (used by the Claude Code CLI
 * with `--header`). On failure, returns 401 with a WWW-Authenticate header that
 * triggers OAuth discovery. OAuth is always available, so /mcp is never public.
 */
export const requireMcpAuth = createMiddleware(async (c, next) => {
  if (c.req.method === 'OPTIONS') return next()

  const authHeader = c.req.header('authorization')
  const bearer = authHeader ? /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim() : undefined

  // 1. OAuth access token.
  if (bearer) {
    const verified = await verifyAccessToken(bearer)
    if (verified) {
      c.set('oauthClientId', verified.clientId)
      return next()
    }
  }

  // 2. Static shared secret (Bearer or X-API-Key), if configured.
  if (config.REST_API_KEY) {
    const provided = bearer ?? c.req.header('x-api-key')?.trim()
    if (provided && safeEqual(provided, config.REST_API_KEY)) return next()
  }

  return c.json(
    { error: 'invalid_token', error_description: 'Authentication required' },
    401,
    { 'WWW-Authenticate': wwwAuthenticate('invalid_token', 'Authentication required') },
  )
})
