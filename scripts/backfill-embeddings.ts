// Backfill semantic-search embeddings for objects ingested before embeddings
// were enabled (or while the model was unavailable).
//
// Safe to run repeatedly: it only touches rows where embedding IS NULL, in
// batches, and skips rows with no text. Does NOT run at startup — invoke it
// manually after a deploy that enables embeddings:
//
//   docker compose exec app npm run db:backfill-embeddings
//
// Usage: npm run db:backfill-embeddings [batchSize]

import { and, isNull, isNotNull, ne, sql } from 'drizzle-orm'
import { getDb, closeDb } from '../src/db/client.js'
import { objects } from '../src/db/schema.js'
import { embedText, embeddingsEnabled } from '../src/lib/embeddings.js'

const BATCH_SIZE = Number(process.argv[2]) || 100

async function main() {
  if (!embeddingsEnabled()) {
    console.error('EMBEDDING_ENABLED is false — nothing to backfill. Enable it and retry.')
    process.exit(1)
  }

  const db = getDb()
  let total = 0
  let skipped = 0

  // Process in batches until no rows are left without an embedding.
  for (;;) {
    const rows = await db.select({
      apId: objects.apId,
      summary: objects.summary,
      contentText: objects.contentText,
    }).from(objects)
      .where(and(
        isNull(objects.embedding),
        isNull(objects.deletedAt),
        isNotNull(objects.contentText),
        ne(objects.contentText, ''),
      ))
      .limit(BATCH_SIZE)

    if (rows.length === 0) break

    let progressed = 0
    for (const row of rows) {
      const text = [row.summary, row.contentText].filter(Boolean).join('. ').trim()
      const vector = text ? await embedText(text) : null
      if (vector) {
        await db.update(objects).set({ embedding: vector })
          .where(sql`${objects.apId} = ${row.apId}`)
        total++
        progressed++
      } else if (!text) {
        // Guard rows with no usable text so the WHERE clause stops re-selecting
        // them (ne(contentText, '')), keeping the loop moving forward.
        await db.update(objects).set({ contentText: '' })
          .where(sql`${objects.apId} = ${row.apId}`)
        skipped++
        progressed++
      }
      // vector === null && text present → model unavailable; leave the row and
      // let the no-progress guard below stop the run.
    }

    console.log(`Embedded ${total} objects so far (skipped ${skipped})...`)

    // A selected batch that produced no updates means the model isn't returning
    // vectors — stop instead of looping forever.
    if (progressed === 0) {
      console.error('No progress in a full batch — is the embedding model available?')
      break
    }
  }

  console.log(`\nDone. Embedded ${total} objects (${skipped} had no usable text).`)
  await closeDb()
}

main().catch(async (err) => {
  console.error(err)
  await closeDb()
  process.exit(1)
})
