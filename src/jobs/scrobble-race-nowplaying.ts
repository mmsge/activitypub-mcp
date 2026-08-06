import { config, getScrobbleRacers } from '../config.js'
import { fetchNowPlaying } from '../lib/fetch-lastfm.js'
import { logger } from '../lib/logger.js'
import { publishNtfy } from '../lib/ntfy.js'
import { decideNowPlayingAlert } from '../lib/scrobble-race.js'
import { loadRaceState, saveRaceState } from '../lib/race-store.js'
import { type Notifier } from './scrobble-race.js'

/**
 * The predictive endgame alert — the point of the whole feature: while the gap is
 * within RACE_NOWPLAYING_GAP, watch what is playing right now and say, out loud, that
 * THIS song is the one that ties or wins it. An alert that arrives after the scrobble
 * lands is a result; this one arrives while the song is still going.
 *
 * Until the endgame it costs one indexed row read per tick and zero Last.fm calls,
 * which is what lets it poll on a 30-second timer for a race months away.
 *
 * Last.fm scrobbles at roughly half a track's duration, so the prediction window is
 * about the first half of the song — a couple of polls on a three-minute track. If it
 * is missed, the main watcher's overtake alert still lands on the next sync.
 */
export async function checkRaceNowPlaying(
  notify: Notifier = publishNtfy,
  fetchNP = fetchNowPlaying,
): Promise<void> {
  const racers = getScrobbleRacers()
  if (!racers) return
  if (config.RACE_NOWPLAYING_GAP <= 0) return
  if (!config.NTFY_PASSWORD) return
  if (!config.LASTFM_API_KEY || !config.LASTFM_USERNAME) return

  const state = await loadRaceState(racers.leader, racers.challenger)
  if (!state) return // not yet seeded by the main watcher
  if (state.overtakenAt) return

  const gap = state.leaderPlays - state.challengerPlays
  if (gap < 0 || gap > config.RACE_NOWPLAYING_GAP) return

  // Deliberately NOT getNowPlaying(): its 20-second cache is a module-level singleton
  // shared with the public get_now_playing tool, so this could read a value warmed by
  // an unrelated request. In the one window of the race where seconds matter, hidden
  // staleness is the wrong trade.
  const result = await fetchNP(config.LASTFM_API_KEY, config.LASTFM_USERNAME)
  // A failed read is not "nothing is playing" — passing it on as null would let an
  // outage look like silence in the one window where this feature has to be right.
  if (!result.ok) {
    logger.warn({ gap, reason: result.reason }, 'Skipping race now-playing check: Last.fm unavailable')
    return
  }
  const playing = result.track

  const alert = decideNowPlayingAlert(
    playing,
    gap,
    racers.challenger,
    racers.leader,
    { key: state.lastNowPlayingKey, at: state.lastNowPlayingAt },
  )
  if (!alert) return

  const delivered = await notify(alert.message)
  if (!delivered) return // leave the key unset so the next poll retries

  await saveRaceState(racers.leader, racers.challenger, {
    lastNowPlayingKey: alert.key,
    lastNowPlayingAt: new Date(),
  })
  logger.info({ gap, track: playing?.track }, 'Scrobble race now-playing alert sent')
}
