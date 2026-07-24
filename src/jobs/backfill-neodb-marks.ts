import { getDb } from '../db/client.js'
import { serverConfig } from '../db/schema.js'
import { eq, sql } from 'drizzle-orm'
import { handleCreate } from '../activitypub/handlers/create.js'
import { reprocessStoredMarks } from './sync-neodb-marks.js'
import { isNeodbMark } from '../lib/neodb-mark.js'
import { NEODB_MEDIA_TAG_TYPES } from './sync-neodb-metadata.js'
import { logger } from '../lib/logger.js'

type AnyObject = Record<string, unknown>

// Bump if the backfill logic changes and existing installs need to re-run it.
const MARKER_KEY = 'neodb_marks_backfill_v1'
const AP_HEADERS = { Accept: 'application/activity+json' }
const MAX_PAGES = 200
const PAGE_DELAY_MS = 200

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Every actor that has authored a NeoDB mark we've stored: authors of objects whose raw
 * carries `relatedWith`, plus authors of objects tagged with a NeoDB media type. The two
 * TV seasons that already work carry `relatedWith`, so their author (the minreol account)
 * is discovered here — and its outbox holds every mark, including the older film marks
 * whose stored raw predates the extension. Data-driven, so no instance is hard-coded.
 */
async function discoverMarkActors(): Promise<string[]> {
  const db = getDb()
  const mediaTypes = NEODB_MEDIA_TAG_TYPES.map((t) => `'${t}'`).join(', ')
  const rows = await db.execute<{ actor: string }>(sql`
    SELECT DISTINCT actor FROM (
      SELECT actor_ap_id AS actor FROM objects WHERE raw ? 'relatedWith'
      UNION
      SELECT raw->>'attributedTo' AS actor FROM objects WHERE raw ? 'relatedWith'
      UNION
      SELECT o.actor_ap_id AS actor
      FROM objects o, jsonb_array_elements(o.tags) AS tag
      WHERE jsonb_typeof(o.tags) = 'array'
        AND tag->>'type' IN (${sql.raw(mediaTypes)})
    ) s
    WHERE actor IS NOT NULL AND actor <> ''
  `)
  return [...rows].map((r) => r.actor)
}

/**
 * Walk one actor's outbox and re-ingest every mark `Note` through the normal Create handler
 * (so it lands in `objects`, upserts neodb_marks, and enriches the catalogue exactly as live
 * federation would). Only marks are ingested; unrelated posts are skipped. Idempotent via the
 * objects/marks unique constraints and the `updated`-guarded upsert.
 */
async function backfillActorOutbox(actorApId: string): Promise<{ pages: number; marks: number }> {
  const base = actorApId.replace(/\/$/, '')
  let url: string | undefined = `${base}/outbox`
  let pages = 0
  let marks = 0
  let resolvedFirst = false

  while (url && pages < MAX_PAGES) {
    let res: Response
    try {
      res = await fetch(url, { headers: AP_HEADERS })
    } catch (e) {
      logger.warn({ url, error: String(e) }, 'Failed to fetch mark outbox page')
      break
    }
    if (!res.ok) {
      logger.warn({ url, status: res.status }, 'Mark outbox page returned non-OK')
      break
    }
    const data = (await res.json()) as AnyObject
    const items = (data.orderedItems ?? data.items) as unknown[] | undefined

    if (Array.isArray(items)) {
      pages++
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const entry = item as AnyObject
        // An outbox entry may be a bare Note or a Create/Announce wrapping one.
        const note = (entry.type === 'Create' || entry.type === 'Announce') && entry.object && typeof entry.object === 'object'
          ? (entry.object as AnyObject)
          : entry
        if (!isNeodbMark(note)) continue
        const actor = (typeof note.attributedTo === 'string' ? note.attributedTo : null) ?? actorApId
        try {
          await handleCreate({ type: 'Create', actor, object: note })
          marks++
        } catch (e) {
          logger.warn({ id: note.id, error: e }, 'Failed to ingest mark from outbox')
        }
      }
    }

    // Root OrderedCollection has no inline items — follow `first`, then chain `next`.
    let nextUrl: string | undefined
    if (!Array.isArray(items) && !resolvedFirst) {
      const first = data.first
      nextUrl = typeof first === 'string' ? first : (first as AnyObject | undefined)?.id as string | undefined
      resolvedFirst = true
    } else {
      const next = data.next
      nextUrl = typeof next === 'string' ? next : undefined
    }
    if (nextUrl && nextUrl !== url) {
      url = nextUrl
      await sleep(PAGE_DELAY_MS)
    } else {
      url = undefined
    }
  }

  return { pages, marks }
}

/**
 * One-off backfill of the NeoDB mark store (criterion 7). Two passes:
 *   1. Reprocess already-stored objects locally (no network).
 *   2. Top up from each discovered mark-actor's live outbox, which carries the full history
 *      (status verb + timestamps) even for marks whose stored raw predates the extension.
 * Guarded by a server_config marker so the auto-run on startup happens once; pass
 * `{ force: true }` (the standalone script) to re-run regardless.
 */
export async function backfillNeodbMarks(opts: { force?: boolean } = {}): Promise<void> {
  const db = getDb()
  if (!opts.force) {
    const [marker] = await db.select().from(serverConfig).where(eq(serverConfig.key, MARKER_KEY))
    if (marker) return
  }

  const reprocessed = await reprocessStoredMarks()

  const actors = await discoverMarkActors()
  let pages = 0
  let outboxMarks = 0
  for (const actor of actors) {
    logger.info({ actor }, 'Backfilling NeoDB marks from outbox')
    const r = await backfillActorOutbox(actor)
    pages += r.pages
    outboxMarks += r.marks
  }

  await db
    .insert(serverConfig)
    .values({ key: MARKER_KEY, value: new Date().toISOString() })
    .onConflictDoUpdate({ target: serverConfig.key, set: { value: new Date().toISOString() } })

  logger.info({ reprocessed, actors: actors.length, pages, outboxMarks }, 'NeoDB marks backfill complete')
}
