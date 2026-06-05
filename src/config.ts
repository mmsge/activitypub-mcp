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

  // Semantic search (pgvector + local transformers.js embedding model).
  // When disabled, search_actor_content falls back to keyword (ILIKE) matching
  // and no embedding model is ever loaded — a memory escape hatch.
  EMBEDDING_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // HuggingFace model id understood by @huggingface/transformers. The default
  // is a 384-dimension sentence-transformer (all-MiniLM-L6-v2).
  EMBEDDING_MODEL: z.string().default('Xenova/all-MiniLM-L6-v2'),
  // Must match the chosen model's output dimension AND the vector(N) column in
  // the migration. Changing this requires a new migration for a new column.
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(384),
  // onnxruntime weight quantization: q8 keeps memory low; fp32 is more accurate.
  EMBEDDING_DTYPE: z.string().default('q8'),
  // Where the model weights are cached on disk (mount a volume here so the
  // ~25 MB download only happens once, not on every container restart).
  EMBEDDING_CACHE_DIR: z.string().default('/app/.cache/embeddings'),
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
