import { getDb } from '../db/client.js'
import { gardenNotes } from '../db/schema.js'
import { fetchGardenNoteRefs, noteAccessUrl, type GardenNoteRef } from '../lib/fetch-garden.js'
import { logger } from '../lib/logger.js'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

const FETCH_DELAY_MS = 200
const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000 // conditional re-check of already-fetched notes
const MAX_PER_RUN = 500 // bound one pass (the garden is ~380 notes today)
const ABORT_AFTER_FAILURES = 25 // zero successes + this many failures → origin is down, stop early
const FETCH_TIMEOUT_MS = 15_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface GardenNoteRow {
  sourcePath: string
  path: string
  title: string
  noteDate: string | null
  noteTags: string[] | null
  hasContent: boolean
  lastCheckedAt: Date | null
  deletedAt: Date | null
}

/** Frontmatter tag lists compare by value; order is not meaningful. */
function sameTags(a: string[] | null, b: string[]): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b)
}

export interface SyncPlan {
  toUpsertMeta: GardenNoteRef[] // new rows, resurrections, path/title changes
  toSoftDelete: string[] // sourcePaths in the DB (not yet deleted) but absent from refs
  toFetch: GardenNoteRef[] // missing-content rows first, then stale rows; capped at MAX_PER_RUN
}

/**
 * Decide what one sync pass should do. Pure so the retry/deletion policy is
 * unit-testable: notes without content are (re)fetched every run, fetched notes
 * are conditionally re-checked after RECHECK_AFTER_MS, and only notes that
 * disappeared from the cache doc are soft-deleted. Callers must not invoke this
 * with an empty `refs` — that means the cache doc was unavailable, not that the
 * garden is empty.
 */
export function planGardenSync(refs: GardenNoteRef[], rows: GardenNoteRow[], now: Date): SyncPlan {
  const rowByPath = new Map(rows.map((r) => [r.sourcePath, r]))
  const refPaths = new Set(refs.map((r) => r.sourcePath))

  const toUpsertMeta = refs.filter((ref) => {
    const row = rowByPath.get(ref.sourcePath)
    if (!row) return true
    return (
      row.deletedAt != null ||
      row.path !== ref.path ||
      row.title !== ref.title ||
      // Also on a date/tag change, so an edited note re-dates itself — and so the
      // first run after this column landed backfills every existing row.
      row.noteDate !== ref.date ||
      !sameTags(row.noteTags, ref.tags)
    )
  })
  const toSoftDelete = rows
    .filter((r) => r.deletedAt == null && !refPaths.has(r.sourcePath))
    .map((r) => r.sourcePath)

  const missing: GardenNoteRef[] = []
  const stale: GardenNoteRef[] = []
  for (const ref of refs) {
    const row = rowByPath.get(ref.sourcePath)
    if (!row || !row.hasContent) missing.push(ref)
    else if (!row.lastCheckedAt || now.getTime() - row.lastCheckedAt.getTime() > RECHECK_AFTER_MS)
      stale.push(ref)
  }
  return { toUpsertMeta, toSoftDelete, toFetch: [...missing, ...stale].slice(0, MAX_PER_RUN) }
}

/**
 * Persist the full markdown of every published Tankehav note. The Obsidian
 * Publish origin is flaky (long stretches of 500s on edge-cache misses), so
 * this is written to accumulate: only a 200 ever overwrites stored content,
 * failures just record fetch_error and are retried next cycle, and when the
 * cache doc itself is unavailable the pass is skipped without deleting a thing.
 */
export async function syncGardenContent(): Promise<void> {
  const refs = await fetchGardenNoteRefs()
  if (refs.length === 0) {
    logger.warn('Obsidian cache doc unavailable; skipping garden content sync (nothing deleted)')
    return
  }

  const db = getDb()
  const rows: GardenNoteRow[] = (
    await db
      .select({
        sourcePath: gardenNotes.sourcePath,
        path: gardenNotes.path,
        title: gardenNotes.title,
        noteDate: gardenNotes.noteDate,
        noteTags: sql<string[] | null>`${gardenNotes.noteTags}`,
        hasContent: sql<boolean>`${gardenNotes.content} is not null`,
        lastCheckedAt: gardenNotes.lastCheckedAt,
        deletedAt: gardenNotes.deletedAt,
      })
      .from(gardenNotes)
  )
  const plan = planGardenSync(refs, rows, new Date())

  for (const ref of plan.toUpsertMeta) {
    await db
      .insert(gardenNotes)
      .values({
        sourcePath: ref.sourcePath,
        path: ref.path,
        title: ref.title,
        noteDate: ref.date,
        noteTags: ref.tags,
      })
      .onConflictDoUpdate({
        target: gardenNotes.sourcePath,
        set: {
          path: ref.path,
          title: ref.title,
          noteDate: ref.date,
          noteTags: ref.tags,
          deletedAt: null,
          updatedAt: new Date(),
        },
      })
  }
  if (plan.toSoftDelete.length > 0) {
    await db
      .update(gardenNotes)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(inArray(gardenNotes.sourcePath, plan.toSoftDelete))
  }

  let fetched = 0
  let unchanged = 0
  let failed = 0
  for (const [i, ref] of plan.toFetch.entries()) {
    if (i > 0) await sleep(FETCH_DELAY_MS)
    // Origin down: nothing succeeded and everything failed — stop hammering,
    // the remaining notes retry next cycle.
    if (fetched + unchanged === 0 && failed >= ABORT_AFTER_FAILURES) {
      logger.warn({ failed }, 'Obsidian origin appears down; aborting garden content pass early')
      break
    }
    try {
      const [row] = await db
        .select({ etag: gardenNotes.etag, lastModified: gardenNotes.lastModified })
        .from(gardenNotes)
        .where(eq(gardenNotes.sourcePath, ref.sourcePath))
      const headers: Record<string, string> = {}
      if (row?.etag) headers['If-None-Match'] = row.etag
      if (row?.lastModified) headers['If-Modified-Since'] = row.lastModified

      const res = await fetch(noteAccessUrl(ref.sourcePath), {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.status === 304) {
        unchanged++
        await db
          .update(gardenNotes)
          .set({ lastCheckedAt: new Date(), fetchError: null, failCount: 0, updatedAt: new Date() })
          .where(eq(gardenNotes.sourcePath, ref.sourcePath))
      } else if (res.ok) {
        const body = await res.text()
        fetched++
        await db
          .update(gardenNotes)
          .set({
            content: body,
            etag: res.headers.get('etag'),
            lastModified: res.headers.get('last-modified'),
            fetchedAt: new Date(),
            lastCheckedAt: new Date(),
            fetchError: null,
            failCount: 0,
            updatedAt: new Date(),
          })
          .where(eq(gardenNotes.sourcePath, ref.sourcePath))
      } else {
        // Note: a 404 does NOT soft-delete — cache-doc membership is the
        // authority on which notes exist. Stored content/etag stay untouched.
        failed++
        await recordFailure(ref.sourcePath, `HTTP ${res.status}`)
      }
    } catch (e) {
      failed++
      await recordFailure(ref.sourcePath, e instanceof Error ? e.message : String(e))
    }
  }

  const [{ stillMissing }] = await db
    .select({ stillMissing: sql<number>`count(*)::int` })
    .from(gardenNotes)
    .where(and(isNull(gardenNotes.content), isNull(gardenNotes.deletedAt)))
  logger.info(
    {
      refs: refs.length,
      upserted: plan.toUpsertMeta.length,
      soft_deleted: plan.toSoftDelete.length,
      attempted: plan.toFetch.length,
      fetched,
      unchanged,
      failed,
      still_missing: stillMissing,
    },
    'Garden content sync complete'
  )
}

async function recordFailure(sourcePath: string, message: string): Promise<void> {
  const db = getDb()
  await db
    .update(gardenNotes)
    .set({
      fetchError: message,
      failCount: sql`${gardenNotes.failCount} + 1`,
      lastCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(gardenNotes.sourcePath, sourcePath))
}
