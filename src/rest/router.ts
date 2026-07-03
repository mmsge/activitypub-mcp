import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { logger } from '../lib/logger.js'
import { InvalidCursorError } from '../mcp/tools/pagination.js'
import { requireApiKey } from './auth.js'
import { coerceQuery } from './coerce.js'
import { endpoints, type RestEndpoint } from './table.js'

const app = new Hono()

// Permissive read-only CORS. QUERY and the JSON Content-Type must be listed
// explicitly — the middleware defaults omit both, which breaks cross-origin
// QUERY/JSON preflight. Harmless for same-origin and server-to-server clients.
app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'QUERY', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}))

// API key gate (after CORS so preflight is never blocked).
app.use('/*', requireApiKey)

// Shared tail for GET / QUERY / POST: validate with the MCP tool's own schema,
// run the same handler, and map its result to an HTTP status without altering
// the body — so REST returns byte-identical data to the MCP tool.
async function run(endpoint: RestEndpoint, input: unknown, c: Context) {
  const parsed = endpoint.schema.safeParse(input)
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400)
  }
  try {
    const result = await endpoint.handler(parsed.data)
    // Handlers signal "not found" by returning { error: string } instead of
    // throwing (e.g. an unresolvable actor handle) → surface as 404.
    const isErr = !!result && typeof result === 'object' && !Array.isArray(result)
      && typeof (result as { error?: unknown }).error === 'string'
    return c.json(result as any, isErr ? 404 : 200)
  } catch (e) {
    // A bad cursor token is a caller error — surface the reason so clients can
    // recover (re-fetch page 1) instead of seeing an opaque 500.
    if (e instanceof InvalidCursorError) {
      return c.json({ error: e.message }, 400)
    }
    logger.error(e, `REST ${endpoint.path} failed`)
    return c.json({ error: 'Internal error' }, 500)
  }
}

for (const endpoint of endpoints) {
  // GET: params arrive as query strings and need string→type coercion.
  app.get(endpoint.path, (c) => run(endpoint, coerceQuery(c.req.queries(), endpoint), c))

  // QUERY (RFC 10008) and POST: the body is the raw MCP tool input — no coercion.
  // An empty/absent body validates as {} so all-optional endpoints still work.
  app.on(['QUERY', 'POST'], endpoint.path, async (c) => {
    let body: unknown = {}
    try { body = await c.req.json() } catch { body = {} }
    return run(endpoint, body, c)
  })
}

// Discovery document — lets a collector introspect the API. Generated from the
// same table the routes are, so it never drifts.
app.get('/', (c) => {
  return c.json({
    service: 'activitypub-mcp REST API',
    version: 'v1',
    methods: {
      GET: 'params as query string (?actor_handle=@a@b&limit=5); arrays repeated or comma-separated',
      QUERY: 'RFC 10008; JSON body identical to the MCP tool input',
      POST: 'JSON body identical to the MCP tool input (compatibility alias for QUERY)',
    },
    auth: 'Authorization: Bearer <key> or X-API-Key: <key>',
    endpoints: endpoints.map((e) => ({
      path: `/api/v1${e.path}`,
      mcp_tool: e.name,
      description: e.description,
      params: Object.keys(e.schema.shape),
    })),
  })
})

export { app as restRouter }
