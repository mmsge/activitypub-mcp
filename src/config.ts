import { z } from 'zod'

const schema = z.object({
  APP_DOMAIN: z.string().min(1),
  APP_USERNAME: z.string().min(1).default('bot'),
  APP_DISPLAY_NAME: z.string().default('ActivityPub MCP Bot'),
  DATABASE_URL: z.string().url(),
  FOLLOW_ACTORS: z.string().default(''),
  // Your primary fediverse handle (@user@domain or actor URL). When set, the
  // hashtag-analytics tools default their scope to this actor's posts when no
  // actor_handle is passed, so "what hashtags I use" answers about you out of the
  // box. Unset → those tools aggregate across all stored posts.
  OWNER_ACTOR: z.string().default(''),
  // Date this actor first went live, published as the actor's `published` field so
  // clients can show a truthful "joined" date instead of the date the *remote*
  // instance happened to first see us. Override if the deployment is older.
  ACTOR_PUBLISHED: z.string().default('2026-05-02'),
  // How long inbound/outbound request-log rows are kept, in days. The inbox logs
  // every request before deciding whether to act on it, so this log holds traffic
  // from actors we do not follow; the actor profile promises we keep nothing about
  // them, so it is pruned on a schedule. 0 disables pruning (keeps forever).
  ACTIVITY_LOG_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  // How often the bot publishes a status note about its own archive, in hours. It has
  // no followers to deliver to, so these notes exist to give the account something
  // real to show: they sit in the outbox, on the profile page, and — for the pinned
  // intro — in the `featured` collection Mastodon reads on every profile refresh.
  // An unchanged status never reposts regardless of this interval. 0 disables them,
  // leaving only the pinned intro.
  STATUS_NOTE_INTERVAL_HOURS: z.coerce.number().int().min(0).default(168),
  ADMIN_PASSWORD_HASH: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  REST_API_KEY: z.string().default(''),
  LASTFM_API_KEY: z.string().default(''),
  LASTFM_USERNAME: z.string().default(''),
  // How often to poll Last.fm for new scrobbles, in seconds. Each incremental
  // sync is a single lightweight API call, so this can run frequently; the floor
  // of 15s keeps us well within Last.fm's rate limits.
  LASTFM_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(15).default(60),
  // ntfy push target. The broker lives in the hetzner-server Compose project, so we
  // reach it over its public URL rather than the internal `proxy` network. Auth is
  // HTTP basic as the single shared `markus` user (hetzner-server ADR 0011); an empty
  // NTFY_PASSWORD leaves every push a logged no-op, so the feature is inert until the
  // password is present in /srv/bot/.env.
  NTFY_URL: z.string().default('https://n.msge.no'),
  NTFY_TOPIC: z.string().default('scrobble-race'),
  NTFY_USER: z.string().default('markus'),
  NTFY_PASSWORD: z.string().default(''),
  // Second topic, for the post-breakout alerts below. Its own topic rather than
  // sharing `scrobble-race` so either feature can be muted on the phone without
  // silencing the other — they say completely different things, and only one of them
  // ever ends. publishNtfy() takes an explicit target, so nothing has to mutate
  // NTFY_TOPIC to reach it.
  NTFY_TOPIC_BREAKOUT: z.string().default('tut-treff'),
  // Head-to-head scrobble race: watch the challenger close on the leader and push an
  // ntfy alert as the gap shrinks. Exact artist names as Last.fm scrobbles them
  // ("Taylor Swift", "Maisie Peters"). Either one empty disables both race jobs.
  RACE_LEADER_ARTIST: z.string().default(''),
  RACE_CHALLENGER_ARTIST: z.string().default(''),
  // Gap values that each fire a one-off milestone alert. Above the countdown band
  // below, this ladder is the only thing that speaks.
  RACE_MILESTONES: z.string().default('300,250,200,150,100,75,50,25,20,15,10'),
  // The endgame countdown band: at or below this gap, every challenger play that moves
  // the number gets its own alert instead of the ladder's one-off milestones. Was
  // previously derived from the smallest milestone, which made it impossible to widen
  // the countdown without also inventing a milestone. 0 disables the countdown.
  //
  // The three decisive alerts — gap 1 ("one more levels it"), gap 0 ("the next track
  // takes it") and the overtake — are deliberately NOT governed by this and fire at
  // any value including 0. They are the finish, not the countdown; decision record
  // 0016 exists to guarantee they work off scrobbles alone. See record 0022.
  RACE_COUNTDOWN_GAP: z.coerce.number().int().min(0).default(10),
  // Gap at or below which the live now-playing watcher arms itself, naming the track
  // playing right now as the one about to tie or win. 0 (the default) disables it.
  //
  // It is off by default because it only works if your scrobbler sends Last.fm the
  // `track.updateNowPlaying` call — a SEPARATE submission from the scrobble itself,
  // which many players skip entirely. Verify before enabling it: play something and
  // check that get_now_playing returns nowPlaying:true. If it doesn't, this job
  // polls Last.fm forever for a signal that never arrives; the armed alerts at gap
  // 1 and 0 cover the same ground off scrobbles alone. See decision record 0016.
  //
  // Named RACE_ENDGAME_GAP until record 0022; "endgame" now means the countdown band
  // above, which is what the get_scrobble_race endgame_* fields report.
  RACE_NOWPLAYING_GAP: z.coerce.number().int().min(0).default(0),
  RACE_NOWPLAYING_INTERVAL_SECONDS: z.coerce.number().int().min(20).default(30),
  // BookWyrm actors (comma-separated @user@domain or actor URLs) whose outbox the
  // reading-history backfill walks for finished/started/review/rating posts. These
  // are typically also in FOLLOW_ACTORS; listed separately so we only crawl the
  // full outbox of actors we know are book-shaped (not e.g. a Mastodon account).
  BOOKWYRM_ACTORS: z.string().default(''),
  // Optional Google Books API key for the by-ISBN page-count fallback (used only
  // when BookWyrm's Edition has no page count). OpenLibrary needs no key; Google
  // Books works keyless but is more rate-limited, so a key is recommended.
  GOOGLE_BOOKS_API_KEY: z.string().default(''),
  // One-time switch: when true, the book-metadata sync ignores the 30-day staleness
  // filter and re-enriches every referenced book on its next run, so newly-added
  // metadata fields backfill immediately after a deploy. Unset it once that pass has
  // run to restore normal staleness-based refresh.
  BOOKMETA_BACKFILL: z.coerce.boolean().default(false),
  // Staleness window (days) for cached NeoDB catalog metadata: a record is refetched
  // by the periodic sync only when older than this, previously errored, or forced.
  NEODB_STALE_DAYS: z.coerce.number().int().min(1).default(30),
  // One-time switch mirroring BOOKMETA_BACKFILL: when true, the NeoDB sync ignores the
  // staleness window and re-enriches every referenced catalog item on its next run, so
  // newly-added fields/categories backfill immediately after a deploy. Unset once run.
  NEODB_BACKFILL: z.coerce.boolean().default(false),
  // LinkedIn DMA access token, for the Member Snapshot API. Blank disables the
  // poller entirely; the .xlsx import path keeps working without it.
  //
  // Minted BY HAND — there is no refresh flow here. LinkedIn's Member Data
  // Portability (Member) product is a DMA compliance obligation, so only members
  // in the EEA and Switzerland can consent and generate a token at all. See the
  // LinkedIn section of the README for how to mint one; treat its expiry as
  // unknown and possibly short, which is why the sync records its health in
  // `source_sync_state` rather than logging a 401 and moving on.
  LINKEDIN_DMA_TOKEN: z.string().default(''),
  // How often to re-crawl the snapshot, in hours. The snapshot is historical and
  // complete on every call rather than a feed of changes, so there is nothing to
  // miss between runs and weekly (168h) is plenty. The floor of 1 is a courtesy
  // to LinkedIn, not a rate limit we have been given.
  LINKEDIN_SYNC_INTERVAL_HOURS: z.coerce.number().int().min(1).default(168),
  // Hostname (or URL) of your own Mastodon instance, e.g. "skvip.lol". Bare
  // numeric status ids in get_engagement resolve against it, and the optional
  // MASTODON_ACCESS_TOKEN is ONLY ever sent to this host — never to remote origins.
  OWNER_INSTANCE: z.string().default(''),
  // Optional Mastodon API token for OWNER_INSTANCE. Only needed if the instance
  // sets DISALLOW_UNAUTHENTICATED_API_ACCESS; public statuses read fine without it.
  MASTODON_ACCESS_TOKEN: z.string().default(''),
  ENGAGEMENT_MAX_BATCH: z.coerce.number().int().min(1).max(200).default(50),
  ENGAGEMENT_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(10_000),
  // Cadence of the background sampler that snapshots engagement for the owner's
  // recent posts. Snapshots are skipped when counts are unchanged, so an hourly
  // default stays cheap once posts go quiet.
  ENGAGEMENT_SAMPLE_INTERVAL_MINUTES: z.coerce.number().int().min(5).default(60),
  // How many of the owner's most recent posts the sampler tracks. 0 disables it.
  ENGAGEMENT_SAMPLE_RECENT_POSTS: z.coerce.number().int().min(0).max(50).default(20),
  // ── Breakout alerts: "this post is doing better than your usual" (record 0036) ──
  // Master switch, off by default. The code can therefore be deployed and inspected
  // at /admin/breakouts days before anything is allowed to push — the same
  // deploy-then-arm property STREAM_DOMAIN gives the public stream.
  BREAKOUT_ENABLED: z.string().default('')
    .transform(v => ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())),
  // A post's score is favourites*w1 + reblogs*w2 + replies*w3. A boost weighs most
  // because it puts the post in front of an audience that was not already there; a
  // reply costs real effort; a favourite is one tap.
  //
  // These are part of the persisted state (`weights_key`): changing one re-scores the
  // whole archive at once, which without a guard would look like fifty posts breaking
  // out in the same minute. A changed weight re-seeds silently instead.
  BREAKOUT_WEIGHT_FAVOURITES: z.coerce.number().min(0).default(1),
  BREAKOUT_WEIGHT_REBLOGS: z.coerce.number().min(0).default(3),
  BREAKOUT_WEIGHT_REPLIES: z.coerce.number().min(0).default(2),
  // The rolling window the p90/p99 bar is computed over. Long enough to survive a
  // quiet fortnight, short enough that the bar follows his reach as it changes. The
  // personal-best rung is deliberately NOT windowed — a record is a record.
  BREAKOUT_BASELINE_DAYS: z.coerce.number().int().min(7).default(90),
  // How far back the hourly pass still considers a post a candidate. A post can take
  // off days after it was written (one boost by a big account), so this is much
  // longer than the fast lane's window.
  BREAKOUT_CANDIDATE_DAYS: z.coerce.number().int().min(1).default(30),
  // Two independent guards against a quiet baseline, and both are needed.
  //
  // BREAKOUT_MIN_POSTS: below this many scored posts in the window the actor is not
  // armed at all — a p99 over eight posts is "best of eight" wearing a statistician's
  // hat. BREAKOUT_MIN_SCORE: an absolute floor every rung must clear regardless of
  // the percentile, because "did particularly well" also has a floor below which a
  // push is just noise. A p90 of 2 is arithmetic, not a compliment.
  BREAKOUT_MIN_POSTS: z.coerce.number().int().min(1).default(20),
  BREAKOUT_MIN_SCORE: z.coerce.number().int().min(0).default(10),
  // Object types that count as a post worth judging. This is SAMPLED_TYPES minus
  // GeneratedNote: BookWyrm's auto-generated "Markus finished reading X" boilerplate
  // gets almost no engagement, and leaving it in drags that actor's percentiles
  // toward zero — the quiet-baseline hazard, arriving through the back door.
  BREAKOUT_OBJECT_TYPES: z.string()
    .default('Note,Question,Article,Page,Image,Video,Comment,Review'),
  // Replies are excluded from both the baseline and the candidates by default, the
  // same default get_actor_engagement_trends takes: a reply's reach is not comparable
  // to an original's, and a stream of low-engagement replies would drag every
  // percentile down until ordinary posts started looking exceptional.
  BREAKOUT_INCLUDE_REPLIES: z.string().default('')
    .transform(v => ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())),
  // Which accounts to watch, as @user@domain or actor URLs. Blank means every
  // accepted follow — which for this server is exactly Markus' own accounts. An
  // escape hatch for excluding one account without unfollowing it.
  BREAKOUT_ACTORS: z.string().default(''),
  // The fast lane: a short-interval pass over posts published in the last
  // BREAKOUT_FAST_LANE_HOURS, so a post taking off is caught while it is still
  // happening rather than up to an hour later. This is the ONLY part of the feature
  // that spends remote API calls — the hourly pass reads what the sampler just wrote.
  // 0 disables the fast lane and leaves the hourly pass running.
  //
  // If it ever needs trimming, cut MAX_POSTS rather than lengthening the interval:
  // the value of the fast lane is entirely in the first hours of a post's life.
  BREAKOUT_FAST_LANE_MINUTES: z.coerce.number().int().min(0).default(10),
  BREAKOUT_FAST_LANE_HOURS: z.coerce.number().int().min(1).default(24),
  BREAKOUT_FAST_LANE_MAX_POSTS: z.coerce.number().int().min(1).max(50).default(10),
  // Hour of day (Europe/Oslo) for the daily digest of everything that crossed a rung.
  // -1 disables it. A day with nothing to report sends no push at all — a nightly
  // "ingenting skjedde" would train him to mute the topic, which would cost him the
  // alerts that matter.
  BREAKOUT_DIGEST_HOUR: z.coerce.number().int().min(-1).max(23).default(21),
  // ── The public stream at meg.msge.no ────────────────────────────────────────
  // The app serves two sites on one port: bot.skvip.lol (the ActivityPub actor,
  // admin and MCP) and this one, a public, unauthenticated page republishing
  // Markus' own public posts. Requests are routed on the Host header.
  //
  // Unset disables the stream entirely — no route answers, nothing is published.
  // That is the off-switch: it takes the site down without touching Caddy, and it
  // lets the code deploy and be verified before anything becomes visible.
  STREAM_DOMAIN: z.string().default(''),
  // Which accounts may appear, as `@user@domain|platform` entries separated by
  // commas. Platform is one of mastodon, bookwyrm, pixelfed, loops, neodb, rullen,
  // samklang.
  //
  // An allowlist, not a convenience: `objects` also holds posts by *other people*,
  // because the Announce handler files a boosted post under its original author.
  // Nothing may be published that is not from an account named here.
  STREAM_SOURCES: z.string().default(''),
  // Whether unlisted posts join public ones on the page. Off by default: unlisted
  // means the author kept it off public timelines, and an indexed page is the
  // opposite of that. Flip only deliberately.
  //
  // NOT z.coerce.boolean() — that is Boolean(string), so the literal "false" would
  // come out true and quietly publish unlisted posts. Only an explicit yes enables
  // it; anything else, including nonsense, stays off.
  STREAM_INCLUDE_UNLISTED: z
    .string()
    .default('')
    .transform((v) => ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())),
  // How far back the daily music digests go, in months. Markus has ~51k scrobbles
  // since 2016 — as daily digests that is more entries than every post he has ever
  // written, and it would make the deep archive a listening log. Older listening
  // lives on its own page instead. 0 keeps every day.
  STREAM_SCROBBLE_CUTOFF_MONTHS: z.coerce.number().int().min(0).default(12),
  // How long a rendered page may be served from cache. The box is small and the
  // page is public, so every request must not run the lane merge.
  STREAM_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(180),
  // Disk budget for proxied images, in MB. Deliberately small: the box is a CAX11
  // and a full disk is an outage for every service on it, while a cache miss is
  // one upstream fetch. Eviction is by last access, so the front page and recent
  // months stay warm and a crawl of the 2016 archive does not displace them.
  // 0 disables the proxy — images are then hotlinked from the origin CDNs.
  STREAM_IMAGE_CACHE_MB: z.coerce.number().int().min(0).default(250),
  // Where those bytes live. A named volume in docker-compose, so a rebuild does
  // not throw the cache away and refetch everything from seven CDNs at once.
  STREAM_IMAGE_CACHE_DIR: z.string().default('/data/images'),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const config = parsed.data

export function getActorUrl(): string {
  return `https://${config.APP_DOMAIN}/actor`
}

export function getFollowActors(): string[] {
  return config.FOLLOW_ACTORS
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

/** Normalise OWNER_INSTANCE ("skvip.lol" or "https://skvip.lol") to a lowercase
 *  hostname; '' when unset or unparseable. */
export function getOwnerInstanceHost(): string {
  const v = config.OWNER_INSTANCE.trim()
  if (!v) return ''
  try {
    return new URL(v.includes('://') ? v : `https://${v}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** The owner's fediverse identity, derived from OWNER_ACTOR, for the profile's
 *  "who runs this" attribution. Accepts either an @user@domain handle or an actor
 *  URL and yields both forms; null when OWNER_ACTOR is unset or unparseable.
 *
 *  The profile URL is a best-effort guess for actor-URL input (we use the URL as
 *  given) and the Mastodon-style /@user path for handle input. */
export function getOwnerIdentity(
  raw: string = config.OWNER_ACTOR,
): { handle: string; url: string } | null {
  const v = raw.trim()
  if (!v) return null

  if (v.includes('://')) {
    try {
      const url = new URL(v)
      const username = url.pathname.split('/').filter(Boolean).pop()
      if (!username) return null
      return { handle: `@${username.replace(/^@/, '')}@${url.hostname}`, url: v }
    } catch {
      return null
    }
  }

  const [username, domain] = v.replace(/^@/, '').split('@')
  if (!username || !domain) return null
  return { handle: `@${username}@${domain}`, url: `https://${domain}/@${username}` }
}

/** ACTOR_PUBLISHED as an ISO 8601 timestamp, or null when it isn't a valid date. */
export function getActorPublished(raw: string = config.ACTOR_PUBLISHED): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const d = new Date(trimmed)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** The configured race, or null when either racer is unset or they're the same artist
 *  — the off-switch, mirroring the LASTFM_API_KEY-empty precedent in syncScrobbles(). */
export function getScrobbleRacers(): { leader: string; challenger: string } | null {
  const leader = config.RACE_LEADER_ARTIST.trim()
  const challenger = config.RACE_CHALLENGER_ARTIST.trim()
  if (!leader || !challenger || leader === challenger) return null
  return { leader, challenger }
}

/** RACE_MILESTONES parsed into a descending list of positive gap values. Invalid or
 *  duplicate entries are dropped rather than failing boot — a typo in one milestone
 *  should not take the whole service down. */
export function getRaceMilestones(raw: string = config.RACE_MILESTONES): number[] {
  const values = raw
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n > 0)
  return [...new Set(values)].sort((a, b) => b - a)
}

export interface BreakoutWeights { favourites: number; reblogs: number; replies: number }

/** The three engagement weights. All-zero would score every post 0 and make every
 *  percentile 0, so it falls back to the defaults rather than arming a feature that
 *  would call everything a breakout. */
export function getBreakoutWeights(): BreakoutWeights {
  const w = {
    favourites: config.BREAKOUT_WEIGHT_FAVOURITES,
    reblogs: config.BREAKOUT_WEIGHT_REBLOGS,
    replies: config.BREAKOUT_WEIGHT_REPLIES,
  }
  if (w.favourites === 0 && w.reblogs === 0 && w.replies === 0) {
    return { favourites: 1, reblogs: 3, replies: 2 }
  }
  return w
}

/** Object types the breakout baseline and candidates are drawn from. Blank entries are
 *  dropped; an entirely empty list falls back to the default rather than failing boot
 *  or — worse — silently matching nothing, which would look exactly like "he has not
 *  posted lately". The getRaceMilestones() convention. */
export function getBreakoutObjectTypes(raw: string = config.BREAKOUT_OBJECT_TYPES): string[] {
  const types = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))]
  return types.length ? types : ['Note', 'Question', 'Article', 'Page', 'Image', 'Video', 'Comment', 'Review']
}

/** Accounts to watch. Empty means "every accepted follow" — resolved by the store,
 *  since this getter has no database. */
export function getBreakoutActors(): string[] {
  return config.BREAKOUT_ACTORS.split(',').map(s => s.trim()).filter(Boolean)
}

/** Whether the breakout jobs may run at all.
 *
 *  NTFY_PASSWORD is part of the condition, not a separate check, for the reason
 *  record 0015 gives: advancing a ladder past rungs nobody was ever told about is the
 *  silent no-op hetzner-server ADR 0011 exists to forbid. The jobs log the refusal
 *  loudly rather than idling quietly. */
export function breakoutEnabled(): boolean {
  return config.BREAKOUT_ENABLED && config.NTFY_PASSWORD !== ''
}

export function getBookwyrmActors(): string[] {
  return config.BOOKWYRM_ACTORS
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}
