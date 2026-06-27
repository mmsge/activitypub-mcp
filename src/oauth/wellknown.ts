import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authServerMetadata, protectedResourceMetadata } from './metadata.js'

// Mounted at /.well-known. Serves the OAuth discovery documents MCP clients fetch
// to bootstrap the authorization flow. Some clients append the resource path
// (e.g. /.well-known/oauth-protected-resource/mcp), so we accept that suffix too.
const app = new Hono()

app.use('/*', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'] }))

app.get('/oauth-authorization-server', (c) => c.json(authServerMetadata()))
app.get('/oauth-authorization-server/*', (c) => c.json(authServerMetadata()))

app.get('/oauth-protected-resource', (c) => c.json(protectedResourceMetadata()))
app.get('/oauth-protected-resource/*', (c) => c.json(protectedResourceMetadata()))

export { app as oauthWellknownRouter }
