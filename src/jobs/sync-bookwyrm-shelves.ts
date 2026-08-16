import { getDb } from '../db/client.js'
import { bookwyrmShelfMarks } from '../db/schema.js'
import { getBookwyrmActors } from '../config.js'
import { resolveActorByHandle } from '../lib/fetch-actor.js'
import { fetchBookwyrmShelfDetailed, SHELVES, type Shelf } from '../lib/fetch-bookwyrm-shelf.js'
import { logger } from '../lib/logger.js'
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm'

/**
 * Record which shelf each of a BookWyrm actor's books currently sits on.
 *
 * This job exists because the shelf cannot be derived from the post archive. A
 * stop federates as a GeneratedNote ("… stopped reading X"), but only a fraction
 * of them survive: when this was written the stopped-reading shelf held 10 books
 * and `objects` held 3 of the notes. Posts record the events that were witnessed;
 * the shelf records the current truth, and only the shelf is complete.
 *
 * Everything downstream that needs to tell "he finished this" from "he put this
 * down" reads the table this job fills — most consequentially /api/v1/books?shelf=,
 * which is how framfor learns to rank only what was actually finished.
 */

/** Per-shelf outcome, kept around so the log can say which shelf spoiled a pull. */
interface ShelfOutcome {
  shelf: Shelf
  count: number
  totalItems: number | null
  complete: boolean
}

export interface ShelfSyncResult {
  actorApId: string
  upserted: number
  removed: number
  /** False when the removal sweep was skipped because the pull couldn't be trusted. */
  verified: boolean
  shelves: ShelfOutcome[]
}

/**
 * Did we see the whole of every shelf?
 *
 * Every shelf must have fetched without a failed page AND returned exactly as many
 * items as its collection said it had. The equality is the point: framfor's
 * catalogue sync has to guess with an 80% floor because it has no oracle, but
 * BookWyrm publishes `totalItems` on the Shelf root, so the correct size is known.
 * Settling for a percentage where an exact number is available would be choosing
 * to be approximately right on purpose.
 *
 * A pull that fails this still upserts — adding and correcting rows is always safe.
 * It just may not remove any, because a truncated pull and an emptied shelf look
 * identical from here, and only one of them should erase history.
 */
export function isVerifiedComplete(outcomes: ShelfOutcome[]): boolean {
  return (
    outcomes.length === SHELVES.length &&
    outcomes.every((o) => o.complete && o.totalItems != null && o.count === o.totalItems)
  )
}

async function syncActorShelves(actorApId: string): Promise<ShelfSyncResult> {
  const db = getDb()
  const now = new Date()
  const outcomes: ShelfOutcome[] = []
  const seen = new Map<string, { shelf: Shelf; shelvedDate: Date | null }>()

  for (const shelf of SHELVES) {
    const { items, totalItems, complete } = await fetchBookwyrmShelfDetailed(actorApId, shelf)
    outcomes.push({ shelf, count: items.length, totalItems, complete })
    for (const item of items) {
      if (!item.bookUrl) continue
      const shelvedDate = item.shelvedDate ? new Date(item.shelvedDate) : null
      seen.set(item.bookUrl, {
        shelf,
        shelvedDate: shelvedDate && !isNaN(shelvedDate.getTime()) ? shelvedDate : null,
      })
    }
  }

  let upserted = 0
  for (const [bookUrl, { shelf, shelvedDate }] of seen) {
    await db
      .insert(bookwyrmShelfMarks)
      .values({ actorApId, bookUrl, shelf, shelvedDate, syncedAt: now, firstSeenAt: now })
      .onConflictDoUpdate({
        target: [bookwyrmShelfMarks.actorApId, bookwyrmShelfMarks.bookUrl],
        // `firstSeenAt` is deliberately absent: a shelf move keeps the date we
        // first saw the book, and re-stamping it would erase the only history
        // this table has (BookWyrm sends no shelvedDate). Same spirit as framfor
        // keeping `arena` and `excluded_at` out of its own ON CONFLICT set list.
        set: { shelf, shelvedDate, syncedAt: now, removedAt: null },
      })
    upserted++
  }

  const verified = isVerifiedComplete(outcomes)
  let removed = 0
  if (!verified) {
    logger.warn(
      { actorApId, shelves: outcomes },
      'shelf pull incomplete — skipped the removal sweep',
    )
  } else {
    // A shelf *move* needs no sweep — the unique key rewrote it in place above.
    // This only catches a book that left all four shelves at once.
    const urls = [...seen.keys()]
    const result = await db
      .update(bookwyrmShelfMarks)
      .set({ removedAt: now })
      .where(
        and(
          eq(bookwyrmShelfMarks.actorApId, actorApId),
          isNull(bookwyrmShelfMarks.removedAt),
          urls.length > 0 ? notInArray(bookwyrmShelfMarks.bookUrl, urls) : sql`true`,
        ),
      )
      .returning({ id: bookwyrmShelfMarks.id })
    removed = result.length
  }

  return { actorApId, upserted, removed, verified, shelves: outcomes }
}

export async function syncBookwyrmShelves(): Promise<ShelfSyncResult[]> {
  const actors = getBookwyrmActors()
  if (actors.length === 0) {
    logger.info('BOOKWYRM_ACTORS is empty — shelf sync is inert')
    return []
  }

  const results: ShelfSyncResult[] = []
  for (const handle of actors) {
    const actor = handle.startsWith('http')
      ? { apId: handle }
      : await resolveActorByHandle(handle)
    if (!actor) {
      logger.warn({ handle }, 'could not resolve BookWyrm actor for shelf sync')
      continue
    }
    try {
      const result = await syncActorShelves(actor.apId)
      results.push(result)
      logger.info(result, 'BookWyrm shelf sync')
    } catch (e) {
      logger.error({ handle, error: e }, 'BookWyrm shelf sync failed')
    }
  }
  return results
}
