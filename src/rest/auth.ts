import { createMiddleware } from 'hono/factory'
import { timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

/**
 * Gate every /api/v1 route behind a shared secret. The key is supplied either as
 * `Authorization: Bearer <key>` or `X-API-Key: <key>` and compared in constant
 * time. If no key is configured the API stays closed (503) rather than silently
 * public; OPTIONS is skipped so CORS preflight (which carries no auth) succeeds.
 */
export const requireApiKey = createMiddleware(async (c, next) => {
  if (c.req.method === 'OPTIONS') return next()

  if (!config.REST_API_KEY) {
    return c.json({ error: 'REST API disabled: REST_API_KEY not configured' }, 503)
  }

  const authHeader = c.req.header('authorization')
  const bearer = authHeader ? /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim() : undefined
  const provided = bearer ?? c.req.header('x-api-key')?.trim()

  if (!provided || !safeEqual(provided, config.REST_API_KEY)) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  await next()
})
