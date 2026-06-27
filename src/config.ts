import { z } from 'zod'

const schema = z.object({
  APP_DOMAIN: z.string().min(1),
  APP_USERNAME: z.string().min(1).default('bot'),
  APP_DISPLAY_NAME: z.string().default('ActivityPub MCP Bot'),
  DATABASE_URL: z.string().url(),
  FOLLOW_ACTORS: z.string().default(''),
  ADMIN_PASSWORD_HASH: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  REST_API_KEY: z.string().default(''),
  LASTFM_API_KEY: z.string().default(''),
  LASTFM_USERNAME: z.string().default(''),
  // How often to poll Last.fm for new scrobbles, in seconds. Each incremental
  // sync is a single lightweight API call, so this can run frequently; the floor
  // of 15s keeps us well within Last.fm's rate limits.
  LASTFM_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(15).default(60),
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
