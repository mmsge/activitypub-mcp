import { Hono } from 'hono'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createMcpServer } from './server.js'
import { logger } from '../lib/logger.js'

const app = new Hono()

app.all('/mcp', async (c) => {
  try {
    const server = createMcpServer()
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    })
    await server.connect(transport)
    const response = await transport.handleRequest(c.req.raw)
    return response
  } catch (e) {
    logger.error(e, 'MCP error')
    return c.json({ error: 'MCP error' }, 500)
  }
})

export { app as mcpRouter }
