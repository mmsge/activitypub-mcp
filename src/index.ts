import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { config } from './config.js'
import { logger } from './lib/logger.js'
import { ensureKeys } from './crypto/keys.js'
import { activityPubRouter } from './activitypub/router.js'
import { webfingerRouter } from './activitypub/webfinger.js'
import { nodeinfoRouter } from './activitypub/nodeinfo.js'
import { hostMetaRouter } from './activitypub/host-meta.js'
import { adminRouter } from './admin/router.js'
import { mcpRouter } from './mcp/router.js'
import { oauthRouter } from './oauth/router.js'
import { oauthWellknownRouter } from './oauth/wellknown.js'
import { restRouter } from './rest/router.js'
import { startScheduler } from './jobs/scheduler.js'
import { syncFollows } from './jobs/sync-follows.js'
import { syncScrobbles } from './jobs/sync-scrobbles.js'
import { runScrobbleRace } from './jobs/scrobble-race.js'
import { syncBookMetadata } from './jobs/sync-book-metadata.js'
import { syncNeodbMetadata } from './jobs/sync-neodb-metadata.js'
import { syncGigMetadata } from './jobs/sync-gig-metadata.js'
import { backfillGigs } from './jobs/backfill-gigs.js'
import { classifyYoutubeShorts } from './jobs/classify-youtube-shorts.js'
import { syncReadingHistory } from './jobs/sync-reading-history.js'
import { syncBookwyrmShelves } from './jobs/sync-bookwyrm-shelves.js'
import { syncGardenContent } from './jobs/sync-garden-content.js'
import { syncLinkedinPosts } from './jobs/sync-linkedin-posts.js'
import { backfillContentText } from './jobs/backfill-content-text.js'
import { backfillTags } from './jobs/backfill-tags.js'
import { backfillMarkTitles } from './jobs/backfill-mark-titles.js'
import { backfillNeodbMarks } from './jobs/backfill-neodb-marks.js'
import { repairNeodbIngest } from './jobs/repair-neodb-ingest.js'
import { runDeliveryWorker } from './jobs/deliver.js'
import { pruneActivityLog } from './jobs/prune-activity-log.js'
import { publishStatusNote } from './jobs/publish-status-note.js'
import { runPostBreakout } from './jobs/post-breakout.js'
import { getDb } from './db/client.js'
import { streamApp } from './stream/router.js'
import { isStreamHost, streamEnabled } from './stream/host.js'

const app = new Hono()

// Well-known endpoints
app.route('/.well-known', webfingerRouter)
app.route('/.well-known', hostMetaRouter)
app.route('/.well-known', oauthWellknownRouter)
// NodeInfo answers under /.well-known — where every crawler and instance-info lookup
// probes — and keeps the bare /nodeinfo path it has always had, which the profile page
// and the published OpenAPI spec both link to.
app.route('/.well-known', nodeinfoRouter)
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

  // Ingest Last.fm scrobbles (backfill on first run, incremental after), then settle
  // the scrobble race against what just landed — so a restart seeds or catches up
  // before the port binds, rather than a minute later.
  try {
    await syncScrobbles()
    await runScrobbleRace()
  } catch (e) {
    logger.error(e, 'Scrobble sync failed on startup')
  }

  // Backfill BookWyrm reading history + shelf membership + enrich book metadata
  // (no-ops unless BOOKWYRM_ACTORS / referenced books are present). Run in the
  // background so a slow first crawl doesn't block startup.
  //
  // The shelf pull runs on startup and not only on the 6-hourly timer for the same
  // reason the LinkedIn sync does: setInterval's first fire is six hours away, and
  // until bookwyrm_shelf_marks has rows /api/v1/books?shelf= refuses to answer.
  // A deploy would otherwise leave every shelf-filtered caller broken for a quarter
  // of a day.
  void (async () => {
    try {
      await syncReadingHistory()
      await syncBookwyrmShelves()
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

  // Enrich the gig catalogue in the background (no-op until an attendance has been
  // ingested). Runs after the backfill below has had a chance to create the rows.
  void (async () => {
    try {
      await syncGigMetadata()
    } catch (e) {
      logger.error(e, 'Gig metadata sync failed on startup')
    }
  })()

  // Classify the watched YouTube videos as Shorts in the background. setInterval's first
  // fire is a full interval away, so without this a fresh deploy would leave a newly
  // imported watch history unclassified for six hours. Stage 0 is offline and takes a few
  // seconds over the whole archive; the network stages are bounded and stay within their
  // own switches, so this is safe to run unconditionally.
  void (async () => {
    try {
      await classifyYoutubeShorts()
    } catch (e) {
      logger.error(e, 'YouTube Shorts classification failed on startup')
    }
  })()

  // One-time build of the gig store out of attendance Notes already stored as ordinary
  // posts — they have been arriving since the follow was accepted and were never read.
  // Local-first; only reaches the origin for a concert it has no record of. No-ops once
  // the marker is set.
  void (async () => {
    try {
      await backfillGigs()
    } catch (e) {
      logger.error(e, 'Gig backfill failed on startup')
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

  // Pull the LinkedIn snapshot in the background. Runs on startup as well as on
  // its weekly tick because setInterval's first fire is a full interval away — at
  // 168 hours a fresh deploy would otherwise ingest nothing for a week, and a
  // token that was already dead would not be reported until then either.
  void (async () => {
    try {
      await syncLinkedinPosts()
    } catch (e) {
      logger.error(e, 'LinkedIn sync failed on startup')
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

  // Seed the breakout ladder on boot rather than an hour later. The first run after
  // the feature is switched on announces NOTHING — it records where every post already
  // is, so a year of history is never replayed into his phone — and doing that at
  // startup means the very next post is judged against a ladder that is already primed.
  // See decision record 0036.
  void (async () => {
    try {
      await runPostBreakout()
    } catch (e) {
      logger.error(e, 'Breakout seeding failed on startup')
    }
  })()

  // Make sure the pinned intro note exists (and matches the current config) before the
  // first remote server asks for the featured collection. Cheap, and idempotent.
  void (async () => {
    try {
      await publishStatusNote()
    } catch (e) {
      logger.error(e, 'Status-note publish failed on startup')
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

  // Two sites, one port, chosen on the Host header.
  //
  // Deliberately a dispatcher rather than middleware on `app`: with two separate
  // Hono apps the ActivityPub actor, the admin UI and the MCP endpoint are not
  // merely shadowed on the public host, they are not mounted there — so a router
  // added to `app` later cannot leak onto meg.msge.no by accident.
  //
  // Anything that is not the stream host falls through to the bot app, including a
  // request with no Host at all. That default is load-bearing: the container
  // healthcheck calls http://127.0.0.1:3000/healthz, and flipping it would have the
  // probe answered by the wrong app.
  const dispatch = (request: Request, env?: unknown, ctx?: unknown) =>
    isStreamHost(request.headers.get('host'))
      ? streamApp.fetch(request, env as never, ctx as never)
      : app.fetch(request, env as never, ctx as never)

  serve({
    fetch: dispatch,
    port: config.PORT,
  }, (info) => {
    logger.info({ port: info.port }, `Server started on port ${info.port}`)
    logger.info(`Actor: https://${config.APP_DOMAIN}/actor`)
    logger.info(`Admin: http://localhost:${info.port}/admin`)
    logger.info(`MCP:   https://${config.APP_DOMAIN}/mcp`)
    logger.info(`REST:  https://${config.APP_DOMAIN}/api/v1`)
    logger.info(
      streamEnabled()
        ? `Straum: https://${config.STREAM_DOMAIN}`
        : 'Straum: disabled (STREAM_DOMAIN unset)',
    )
  })
}

main().catch(err => {
  logger.error(err, 'Fatal startup error')
  process.exit(1)
})
