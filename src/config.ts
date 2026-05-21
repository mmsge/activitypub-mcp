import { z } from 'zod'

const schema = z.object({
  APP_DOMAIN: z.string().min(1),
  APP_USERNAME: z.string().min(1).default('bot'),
  APP_DISPLAY_NAME: z.string().default('ActivityPub MCP Bot'),
  DATABASE_URL: z.string().url(),
  FOLLOW_ACTORS: z.string().default(''),
  ADMIN_PASSWORD_HASH: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  // LinkedIn OAuth — all optional; feature is dormant when unset
  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),
  LINKEDIN_REDIRECT_URI: z.string().optional(),
  MEDIA_DIR: z.string().default('/data/media'),
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

export function getLinkedInRedirectUri(): string {
  return config.LINKEDIN_REDIRECT_URI
    ?? `https://${config.APP_DOMAIN}/admin/linkedin/callback`
}

export function isLinkedInConfigured(): boolean {
  return Boolean(config.LINKEDIN_CLIENT_ID && config.LINKEDIN_CLIENT_SECRET)
}
