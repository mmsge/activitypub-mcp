import { z } from 'zod'
import { getDb } from '../../db/client.js'
import { objects } from '../../db/schema.js'
import { and, eq, isNull, isNotNull, desc, like, or, inArray, sql } from 'drizzle-orm'
import { resolveActorByHandle } from '../../lib/fetch-actor.js'
import { embedText, toVectorLiteral } from '../../lib/embeddings.js'

export const searchActorContentSchema = z.object({
  query: z.string().min(1).describe('Search terms — matched by meaning (semantic) when embeddings are available, otherwise by keyword'),
  actor_handle: z.string().optional().describe('Scope to a specific actor; omit to search all followed actors'),
  limit: z.number().int().min(1).max(50).default(20),
  object_types: z.array(z.string()).optional(),
  mode: z.enum(['auto', 'semantic', 'keyword']).default('auto')
    .describe('auto: semantic with keyword fallback (default); semantic: vector-only; keyword: ILIKE-only'),
})

type SearchInput = z.infer<typeof searchActorContentSchema>

export async function searchActorContent(input: SearchInput) {
  // Resolve actor scope once; shared by both search strategies.
  let actorApId: string | undefined
  if (input.actor_handle) {
    const actor = input.actor_handle.startsWith('http')
      ? { apId: input.actor_handle }
      : await resolveActorByHandle(input.actor_handle)
    if (!actor) return { error: `Could not resolve actor: ${input.actor_handle}` }
    actorApId = actor.apId
  }

  // Semantic search first (unless explicitly keyword-only).
  if (input.mode !== 'keyword') {
    const queryVector = await embedText(input.query)
    if (queryVector) {
      const results = await semanticSearch(input, actorApId, queryVector)
      // In forced-semantic mode return whatever we got. In auto mode, fall
      // through to keyword when semantic finds nothing (e.g. corpus not yet
      // backfilled).
      if (input.mode === 'semantic' || results.length > 0) {
        return { mode: 'semantic', count: results.length, results }
      }
    } else if (input.mode === 'semantic') {
      return { mode: 'semantic', count: 0, results: [], note: 'Embeddings unavailable (model disabled or failed to load).' }
    }
  }

  const results = await keywordSearch(input, actorApId)
  return { mode: 'keyword', count: results.length, results }
}

async function semanticSearch(input: SearchInput, actorApId: string | undefined, queryVector: number[]) {
  const db = getDb()
  const literal = toVectorLiteral(queryVector)
  const distance = sql<number>`${objects.embedding} <=> ${literal}::vector`

  const conditions = [isNull(objects.deletedAt), isNotNull(objects.embedding)]
  if (actorApId) conditions.push(eq(objects.actorApId, actorApId))
  if (input.object_types?.length) {
    conditions.push(inArray(objects.type, input.object_types))
  }

  const rows = await db.select({
    apId: objects.apId,
    type: objects.type,
    actorApId: objects.actorApId,
    content: objects.contentText,
    summary: objects.summary,
    url: objects.url,
    publishedAt: objects.publishedAt,
    distance,
  }).from(objects)
    .where(and(...conditions))
    .orderBy(distance)
    .limit(input.limit)

  // Cosine distance ∈ [0,2]; report a 0..1 similarity (1 = identical).
  return rows.map(({ distance, ...r }) => ({ ...r, similarity: 1 - distance }))
}

async function keywordSearch(input: SearchInput, actorApId: string | undefined) {
  const db = getDb()
  const conditions = [isNull(objects.deletedAt)]
  if (actorApId) conditions.push(eq(objects.actorApId, actorApId))

  // Simple ILIKE search — works without tsvector for portability
  const term = `%${input.query.toLowerCase()}%`
  conditions.push(
    or(
      like(objects.contentText, term),
      like(objects.summary, term),
    )!
  )

  const rows = await db.select({
    apId: objects.apId,
    type: objects.type,
    actorApId: objects.actorApId,
    content: objects.contentText,
    summary: objects.summary,
    url: objects.url,
    publishedAt: objects.publishedAt,
  }).from(objects)
    .where(and(...conditions))
    .orderBy(desc(objects.publishedAt))
    .limit(input.limit)

  return input.object_types?.length
    ? rows.filter(r => input.object_types!.includes(r.type))
    : rows
}
