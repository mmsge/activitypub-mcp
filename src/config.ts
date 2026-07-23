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
  ADMIN_PASSWORD_HASH: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  REST_API_KEY: z.string().default(''),
  LASTFM_API_KEY: z.string().default(''),
  LASTFM_USERNAME: z.string().default(''),
  // How often to poll Last.fm for new scrobbles, in seconds. Each incremental
  // sync is a single lightweight API call, so this can run frequently; the floor
  // of 15s keeps us well within Last.fm's rate limits.
  LASTFM_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(15).default(60),
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

export function getBookwyrmActors(): string[] {
  return config.BOOKWYRM_ACTORS
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}
