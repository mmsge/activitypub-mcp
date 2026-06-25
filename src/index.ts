import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { config } from './config.js'
import { logger } from './lib/logger.js'
import { ensureKeys } from './crypto/keys.js'
import { activityPubRouter } from './activitypub/router.js'
import { webfingerRouter } from './activitypub/webfinger.js'
import { nodeinfoRouter } from './activitypub/nodeinfo.js'
import { adminRouter } from './admin/router.js'
import { mcpRouter } from './mcp/router.js'
import { restRouter } from './rest/router.js'
import { startScheduler } from './jobs/scheduler.js'
import { syncFollows } from './jobs/sync-follows.js'
import { syncScrobbles } from './jobs/sync-scrobbles.js'
import { runDeliveryWorker } from './jobs/deliver.js'
import { getDb } from './db/client.js'

const app = new Hono()

// Well-known endpoints
app.route('/.well-known', webfingerRouter)
app.route('', nodeinfoRouter)

// ActivityPub
app.route('', activityPubRouter)

// MCP
app.route('', mcpRouter)

// REST API (same data as MCP, for non-MCP collectors)
app.route('/api/v1', restRouter)

// Admin UI
app.route('/admin', adminRouter)

// Health check
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

async function main() {
  // Verify DB connection
  const db = getDb()
  logger.info('Connected to database')

  // Generate or load RSA keys
  await ensureKeys()

  // Sync follows from env
  try {
    await syncFollows()
  } catch (e) {
    logger.error(e, 'Follow sync failed on startup')
  }

  // Ingest Last.fm scrobbles (backfill on first run, incremental after)
  try {
    await syncScrobbles()
  } catch (e) {
    logger.error(e, 'Scrobble sync failed on startup')
  }

  // Run delivery worker once immediately
  try {
    await runDeliveryWorker()
  } catch (e) {
    logger.error(e, 'Initial delivery run failed')
  }

  // Start background jobs
  startScheduler()

  serve({
    fetch: app.fetch,
    port: config.PORT,
  }, (info) => {
    logger.info({ port: info.port }, `Server started on port ${info.port}`)
    logger.info(`Actor: https://${config.APP_DOMAIN}/actor`)
    logger.info(`Admin: http://localhost:${info.port}/admin`)
    logger.info(`MCP:   https://${config.APP_DOMAIN}/mcp`)
    logger.info(`REST:  https://${config.APP_DOMAIN}/api/v1`)
  })
}

main().catch(err => {
  logger.error(err, 'Fatal startup error')
  process.exit(1)
})
