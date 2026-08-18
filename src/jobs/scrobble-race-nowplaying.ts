import { config } from '../config.js'
import { fetchNowPlaying } from '../lib/fetch-lastfm.js'
import { logger } from '../lib/logger.js'
import { publishNtfy, type NtfyTarget } from '../lib/ntfy.js'
import { decideNowPlayingAlert } from '../lib/scrobble-race.js'
import { loadRaceStates, saveRaceState } from '../lib/race-store.js'
import { activeRaces } from '../lib/races-config.js'
import { type Notifier } from './scrobble-race.js'

/**
 * The predictive endgame alert — the point of the whole feature: while a race's gap is
 * within its `nowplaying_gap`, watch what is playing right now and say, out loud, that
 * THIS song is the one that ties or wins it. An alert that arrives after the scrobble
 * lands is a result; this one arrives while the song is still going.
 *
 * Until some race reaches its endgame this costs one indexed read per tick and zero
 * Last.fm calls, which is what lets it poll on a 30-second timer for a race months away.
 * Note the read is ONE query for every race and the Last.fm fetch is ONE call however
 * many races are armed — that is the property that keeps the interval affordable as
 * races are added, and it is easy to lose by moving the fetch inside the loop.
 *
 * Last.fm scrobbles at roughly half a track's duration, so the prediction window is
 * about the first half of the song — a couple of polls on a three-minute track. If it
 * is missed, the main watcher's overtake alert still lands on the next sync.
 */
export async function checkRaceNowPlaying(
  notify: Notifier = publishNtfy,
  fetchNP = fetchNowPlaying,
): Promise<void> {
  const races = activeRaces().filter(r => r.nowplayingGap > 0)
  if (!races.length) return
  if (!config.NTFY_PASSWORD) return
  if (!config.LASTFM_API_KEY || !config.LASTFM_USERNAME) return

  const states = await loadRaceStates(races.map(r => r.id))
  const armed = races.filter(race => {
    const state = states.get(race.id)
    if (!state) return false // not yet seeded by the main watcher
    if (state.overtakenAt) return false
    const gap = state.leaderPlays - state.challengerPlays
    return gap >= 0 && gap <= race.nowplayingGap
  })
  if (!armed.length) return

  // Deliberately NOT getNowPlaying(): its 20-second cache is a module-level singleton
  // shared with the public get_now_playing tool, so this could read a value warmed by
  // an unrelated request. In the one window of the race where seconds matter, hidden
  // staleness is the wrong trade.
  const result = await fetchNP(config.LASTFM_API_KEY, config.LASTFM_USERNAME)
  // A failed read is not "nothing is playing" — passing it on as null would let an
  // outage look like silence in the one window where this feature has to be right.
  if (!result.ok) {
    logger.warn(
      { races: armed.map(r => r.id), reason: result.reason },
      'Skipping race now-playing check: Last.fm unavailable',
    )
    return
  }
  const playing = result.track

  for (const race of armed) {
    const state = states.get(race.id)!
    const gap = state.leaderPlays - state.challengerPlays
    const alert = decideNowPlayingAlert(
      playing,
      gap,
      race.challenger,
      race.leader,
      { key: state.lastNowPlayingKey, at: state.lastNowPlayingAt },
    )
    if (!alert) continue

    const target: NtfyTarget = {
      url: config.NTFY_URL,
      topic: race.topic,
      user: config.NTFY_USER,
      password: config.NTFY_PASSWORD,
    }
    const delivered = await notify(alert.message, target)
    if (!delivered) continue // leave the key unset so the next poll retries

    await saveRaceState(race.id, {
      lastNowPlayingKey: alert.key,
      lastNowPlayingAt: new Date(),
    })
    logger.info({ race: race.id, gap, track: playing?.track }, 'Scrobble race now-playing alert sent')
  }
}
