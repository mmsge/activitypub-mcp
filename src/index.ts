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
import { oauthRouter } from './oauth/router.js'
import { oauthWellknownRouter } from './oauth/wellknown.js'
import { restRouter } from './rest/router.js'
import { startScheduler } from './jobs/scheduler.js'
import { syncFollows } from './jobs/sync-follows.js'
import { syncScrobbles } from './jobs/sync-scrobbles.js'
import { syncBookMetadata } from './jobs/sync-book-metadata.js'
import { syncNeodbMetadata } from './jobs/sync-neodb-metadata.js'
import { syncReadingHistory } from './jobs/sync-reading-history.js'
import { syncGardenContent } from './jobs/sync-garden-content.js'
import { backfillContentText } from './jobs/backfill-content-text.js'
import { backfillTags } from './jobs/backfill-tags.js'
import { backfillMarkTitles } from './jobs/backfill-mark-titles.js'
import { backfillNeodbMarks } from './jobs/backfill-neodb-marks.js'
import { repairNeodbIngest } from './jobs/repair-neodb-ingest.js'
import { runDeliveryWorker } from './jobs/deliver.js'
import { pruneActivityLog } from './jobs/prune-activity-log.js'
import { getDb } from './db/client.js'

const app = new Hono()

// Well-known endpoints
app.route('/.well-known', webfingerRouter)
app.route('/.well-known', oauthWellknownRouter)
app.route('', nodeinfoRouter)

// ActivityPub
app.route('', activityPubRouter)

// MCP + its OAuth authorization server
app.route('', mcpRouter)
app.route('/oauth', oauthRouter)

// REST API (same data as MCP, for non-MCP collectors)
app.route('/api/v1', restRouter)

// Admin UI
app.route('/admin', adminRouter)

// Health check
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))
app.get('/healthz', (c) => c.text('ok'))

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

  // Backfill BookWyrm reading history + enrich book metadata (no-ops unless
  // BOOKWYRM_ACTORS / referenced books are present). Run in the background so a
  // slow first crawl doesn't block startup.
  void (async () => {
    try {
      await syncReadingHistory()
      await syncBookMetadata()
    } catch (e) {
      logger.error(e, 'Reading sync failed on startup')
    }
  })()

  // Clear request-log rows past the retention window. Runs on startup too, not just
  // on the 6-hourly timer, so a deploy that shortens the window takes effect at once
  // and the pre-existing backlog is cleared rather than waiting six hours.
  void (async () => {
    try {
      await pruneActivityLog()
    } catch (e) {
      logger.error(e, 'Activity-log prune failed on startup')
    }
  })()

  // Enrich NeoDB catalog metadata (all categories) in the background (no-op unless a
  // mark referencing a NeoDB catalog item has been ingested; re-enriches everything
  // when NEODB_BACKFILL is set).
  void (async () => {
    try {
      await syncNeodbMetadata()
    } catch (e) {
      logger.error(e, 'NeoDB metadata sync failed on startup')
    }
  })()

  // Crawl the markus.plus garden note bodies in the background (the first pass
  // over ~380 notes takes a couple of minutes at the polite fetch rate).
  void (async () => {
    try {
      await syncGardenContent()
    } catch (e) {
      logger.error(e, 'Garden content sync failed on startup')
    }
  })()

  // One-time re-derivation of stored post text after text-pipeline fixes
  // (entity decoding, contentMap fallback). No-ops once the marker is set.
  void (async () => {
    try {
      await backfillContentText()
    } catch (e) {
      logger.error(e, 'Content-text backfill failed on startup')
    }
  })()

  // One-time re-derivation of stored `tags`/`attachments` from raw jsonb, to
  // repair rows whose structured hashtags went stale before the edit handler
  // refreshed them (e.g. selfies tagged #TogSelfie after the fact). No-ops once
  // the marker is set.
  void (async () => {
    try {
      await backfillTags()
    } catch (e) {
      logger.error(e, 'Tags backfill failed on startup')
    }
  })()

  // One-time seed of catalog_metadata.mark_titles (the mark-supplied aliases) for rows
  // that predate the column, recomputed from stored marks. No-ops once the marker is set.
  void (async () => {
    try {
      await backfillMarkTitles()
    } catch (e) {
      logger.error(e, 'Mark-titles backfill failed on startup')
    }
  })()

  // One-time backfill of the NeoDB mark store (neodb_marks): reprocess stored marks and
  // top up from each mark-actor's outbox, so marks that federated before this ingestion
  // path existed show up in get_watched. Background + marker-guarded; no-op once run.
  void (async () => {
    try {
      await backfillNeodbMarks()
    } catch (e) {
      logger.error(e, 'NeoDB marks backfill failed on startup')
    }
    // Then repair marks stored by a lossier ingest path (a boost that wrote no text and
    // no catalogue row, an edit that wrote nothing at all): re-derive the post text from
    // raw, rebuild neodb_marks, and enrich every tagged catalogue item. Runs after the
    // backfill so the two don't fetch the same items concurrently; local-first,
    // idempotent, and a no-op once its marker is set.
    try {
      await repairNeodbIngest()
    } catch (e) {
      logger.error(e, 'NeoDB ingest repair failed on startup')
    }
  })()

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
