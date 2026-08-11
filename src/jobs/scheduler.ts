import { runDeliveryWorker } from './deliver.js'
import { refreshStaleActors } from './refresh-actors.js'
import { syncScrobbles } from './sync-scrobbles.js'
import { runScrobbleRace } from './scrobble-race.js'
import { checkRaceNowPlaying } from './scrobble-race-nowplaying.js'
import { syncBookMetadata } from './sync-book-metadata.js'
import { syncNeodbMetadata } from './sync-neodb-metadata.js'
import { syncReadingHistory } from './sync-reading-history.js'
import { syncGardenContent } from './sync-garden-content.js'
import { sampleEngagement } from './sample-engagement.js'
import { runPostBreakout } from './post-breakout.js'
import { runBreakoutFastLane } from './breakout-fast-lane.js'
import { runBreakoutDigest } from './breakout-digest.js'
import { pruneActivityLog } from './prune-activity-log.js'
import { publishStatusNote } from './publish-status-note.js'
import { linkTripPosts } from './link-trip-posts.js'
import { syncStations } from './sync-stations.js'
import { syncStationWeather } from './sync-station-weather.js'
import { resolveTripLines } from './resolve-trip-lines.js'
import { syncLinkedinPosts } from './sync-linkedin-posts.js'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

const SIX_HOURS_MS = 6 * 60 * 60_000

export function startScheduler(): void {
  // Delivery queue — every 30 seconds
  setInterval(async () => {
    try { await runDeliveryWorker() } catch (e) { logger.error(e, 'Delivery worker error') }
  }, 30_000)

  // Actor refresh — every hour
  setInterval(async () => {
    try { await refreshStaleActors() } catch (e) { logger.error(e, 'Actor refresh error') }
  }, 60 * 60_000)

  // Last.fm scrobble sync — interval configurable via LASTFM_SYNC_INTERVAL_SECONDS
  // (default 60s). The race watcher is chained to the sync rather than given its own
  // timer: it reacts to rows the sync just wrote, so an independent interval would
  // only add a window in which it reads stale counts.
  const scrobbleIntervalMs = config.LASTFM_SYNC_INTERVAL_SECONDS * 1_000
  setInterval(async () => {
    try {
      await syncScrobbles()
      await runScrobbleRace()
    } catch (e) { logger.error(e, 'Scrobble sync error') }
  }, scrobbleIntervalMs)

  // Live now-playing watch for the endgame of the scrobble race. Outside the endgame
  // this is one indexed row read and no API call, so a short interval is cheap.
  if (config.RACE_NOWPLAYING_GAP > 0) {
    setInterval(async () => {
      try { await checkRaceNowPlaying() } catch (e) { logger.error(e, 'Scrobble race now-playing error') }
    }, config.RACE_NOWPLAYING_INTERVAL_SECONDS * 1_000)
  }

  // Reading-history outbox backfill + book metadata enrichment — every 6 hours.
  // History first so newly-ingested books are present when metadata enrichment
  // collects the URLs to fetch.
  setInterval(async () => {
    try {
      await syncReadingHistory()
      await syncBookMetadata()
    } catch (e) { logger.error(e, 'Reading sync error') }
  }, SIX_HOURS_MS)

  // NeoDB film/TV catalog metadata enrichment — every 6 hours, its own interval
  // and independent of the BookWyrm reading chain.
  setInterval(async () => {
    try { await syncNeodbMetadata() } catch (e) { logger.error(e, 'NeoDB metadata sync error') }
  }, SIX_HOURS_MS)

  // Garden note-body crawl — every 6 hours, its own interval so a slow or
  // failing Obsidian origin never couples with the reading chain.
  setInterval(async () => {
    try { await syncGardenContent() } catch (e) { logger.error(e, 'Garden content sync error') }
  }, SIX_HOURS_MS)

  // Engagement sampling for the owner's recent posts — skip_unchanged writes
  // keep this cheap, so an hourly default builds smooth trends without bloat.
  //
  // The breakout ladder and its digest are chained to the sampler rather than given
  // their own timers, for the same reason the scrobble race is chained to the scrobble
  // sync: they react to the rows the sampler just wrote, so an independent interval
  // would only add a window in which they read stale counts. Both are DB-only — the
  // fast lane below is the sole part of the feature that talks to remote instances.
  setInterval(async () => {
    try { await sampleEngagement() } catch (e) { logger.error(e, 'Engagement sampling error') }
    try { await runPostBreakout() } catch (e) { logger.error(e, 'Breakout check error') }
    try { await runBreakoutDigest() } catch (e) { logger.error(e, 'Breakout digest error') }
  }, config.ENGAGEMENT_SAMPLE_INTERVAL_MINUTES * 60_000)

  // The breakout fast lane — re-reads engagement for posts published in the last
  // BREAKOUT_FAST_LANE_HOURS so a post taking off is caught while it is still
  // happening. Gated at registration AND inside the job: a disabled deployment pays
  // nothing for the timer, and toggling the env off takes effect without a restart.
  if (config.BREAKOUT_FAST_LANE_MINUTES > 0) {
    setInterval(async () => {
      try { await runBreakoutFastLane() } catch (e) { logger.error(e, 'Breakout fast lane error') }
    }, config.BREAKOUT_FAST_LANE_MINUTES * 60_000)
  }

  // Request-log retention — every 6 hours. Cheap (one indexed DELETE) and keeps the
  // "we store nothing about actors we don't follow" claim on the profile honest.
  setInterval(async () => {
    try { await pruneActivityLog() } catch (e) { logger.error(e, 'Activity-log prune error') }
  }, SIX_HOURS_MS)

  // The bot's own notes. Checked hourly rather than on the publishing interval itself,
  // because the job decides for itself whether anything is due — the interval is the
  // floor between status notes, not the tick rate — and the pinned intro should pick up
  // a config change without waiting out a whole week.
  setInterval(async () => {
    try { await publishStatusNote() } catch (e) { logger.error(e, 'Status-note publish error') }
  }, 60 * 60_000)

  // Bind posts to the trips they were posted on — hourly. Both sides move: a post
  // arrives from Mastodon, or a re-imported CSV corrects an arrival time and
  // re-classifies the posts around it. The job is diff-based, so a tick with
  // nothing to do writes nothing (ADR 0023).
  setInterval(async () => {
    try { await linkTripPosts() } catch (e) { logger.error(e, 'Trip/post linking error') }
  }, 60 * 60_000)

  // Station geocoding, then the weather at them — every 6 hours, chained so the
  // weather pass runs against coordinates the geocode pass just wrote. Both take a
  // bounded bite per run: Nominatim allows one request a second, and the whole
  // backfill is 115 stations with no deadline (ADR 0028).
  setInterval(async () => {
    try {
      await syncStations()
      await syncStationWeather()
    } catch (e) { logger.error(e, 'Station/weather sync error') }
  }, SIX_HOURS_MS)

  // Attribute trips to the named lines they ran on — hourly, alongside the trip/post
  // join for the same reason: a re-imported CSV can change a leg's stations or
  // distance. No external call and no bounded bite here, so a tick either finds
  // stale trips and recomputes them outright or writes nothing (ADR 0035).
  setInterval(async () => {
    try { await resolveTripLines() } catch (e) { logger.error(e, 'Line resolution error') }
  }, 60 * 60_000)

  // LinkedIn posts from the DMA snapshot — weekly by default. The snapshot is
  // historical and complete on every call rather than a feed of changes, so a long
  // interval misses nothing; there is no cursor to fall behind. Gated on the token
  // so an unconfigured deploy does not tick a job that only logs its own absence.
  //
  // index.ts also runs this once at startup: setInterval's first fire is a full
  // interval away, which at 168 hours means a fresh deploy would ingest nothing
  // for a week.
  if (config.LINKEDIN_DMA_TOKEN) {
    setInterval(async () => {
      try { await syncLinkedinPosts() } catch (e) { logger.error(e, 'LinkedIn sync error') }
    }, config.LINKEDIN_SYNC_INTERVAL_HOURS * 60 * 60_000)
  }

  logger.info({ scrobbleIntervalSeconds: config.LASTFM_SYNC_INTERVAL_SECONDS }, 'Scheduler started')
}
