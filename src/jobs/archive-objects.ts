import { sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { objects } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { stripHtml } from '../lib/strip-html.js'
import { extractContent } from '../lib/object-content.js'
import { extractAttachments, extractLanguage, extractTags } from '../lib/object-fields.js'
import { resolveRef } from '../lib/ap-object.js'
import { dbReason } from './import-youtube-watches.js'

/**
 * Writing an imported archive's posts as `objects` rows: shared by the Twitter (ADR 0067)
 * and TikTok (ADR 0078) importers, which store their posts exactly the way an ingested
 * Create would be stored, without going through `ingestObject` and its pipelines.
 *
 * Idempotent, and an upsert rather than DO NOTHING: re-running after a parser improvement
 * re-derives every row from the same archive. `deleted_at` is never touched, so a post
 * hidden by hand stays hidden.
 */

type AnyObject = Record<string, unknown>

/** What a parser hands over: the row's type and ap_id, and the AS2 object it was built as. */
export interface ArchivePost {
  type: string
  apId: string
  object: AnyObject
}

/** The columns of an `objects` row, derived exactly as `ingestObject` derives them. */
export function objectRow(actorApId: string, built: ArchivePost) {
  const obj = built.object
  const content = extractContent(obj) ?? ''
  return {
    apId: built.apId,
    type: built.type,
    actorApId,
    content,
    contentText: content ? stripHtml(content) : '',
    summary: null as string | null,
    url: resolveRef(obj.url),
    inReplyTo: resolveRef(obj.inReplyTo),
    publishedAt: new Date(obj.published as string),
    updatedAtAp: null as Date | null,
    attachments: extractAttachments(obj),
    tags: extractTags(obj),
    sensitive: Boolean(obj.sensitive),
    language: extractLanguage(obj),
    raw: obj,
  }
}

export type ObjectRow = ReturnType<typeof objectRow>

const EXCLUDED = (col: string) => sql.raw(`excluded."${col}"`)

export async function upsertBatch(batch: ObjectRow[]): Promise<{ inserted: number; updated: number }> {
  const db = getDb()
  const rows = await db.insert(objects).values(batch as never).onConflictDoUpdate({
    target: objects.apId,
    set: {
      type: EXCLUDED('type'),
      content: EXCLUDED('content'),
      contentText: EXCLUDED('content_text'),
      summary: EXCLUDED('summary'),
      url: EXCLUDED('url'),
      inReplyTo: EXCLUDED('in_reply_to'),
      publishedAt: EXCLUDED('published_at'),
      updatedAtAp: EXCLUDED('updated_at_ap'),
      attachments: EXCLUDED('attachments'),
      tags: EXCLUDED('tags'),
      sensitive: EXCLUDED('sensitive'),
      language: EXCLUDED('language'),
      raw: EXCLUDED('raw'),
      updatedAt: new Date(),
    },
  }).returning({ created: sql<boolean>`(xmax = 0)` })
  const inserted = rows.filter((r) => r.created).length
  return { inserted, updated: rows.length - inserted }
}

export interface UpsertReport {
  inserted: number
  updated: number
  /** Rows the database refused, each isolated to the single row. Never silently dropped. */
  failed: Array<{ id: string; reason: string }>
}

/**
 * Upsert rows in batches. A batch the database refuses is retried row by row, so one bad
 * row costs only itself and the refusal names it.
 */
export async function upsertObjectRows(
  rows: Array<{ id: string; row: ObjectRow }>,
  opts: { batchSize: number; label: string; context?: AnyObject },
): Promise<UpsertReport> {
  const report: UpsertReport = { inserted: 0, updated: 0, failed: [] }
  const batchSize = Math.max(1, opts.batchSize)
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize)
    try {
      const r = await upsertBatch(chunk.map((c) => c.row))
      report.inserted += r.inserted
      report.updated += r.updated
    } catch (batchError) {
      // One bad row must not cost the other 499, nor abort a 28,000-row import thousands in.
      // A chunk is one statement, so a failure rolled all of it back and nothing from it
      // landed — which is what makes retrying row by row safe, and isolates the offender.
      logger.warn(
        { ...opts.context, batchStart: i, reason: dbReason(batchError) },
        `${opts.label} batch rejected; retrying row by row to isolate it`,
      )
      for (const c of chunk) {
        try {
          const r = await upsertBatch([c.row])
          report.inserted += r.inserted
          report.updated += r.updated
        } catch (rowError) {
          report.failed.push({ id: c.id, reason: dbReason(rowError) })
        }
      }
    }
  }
  return report
}
