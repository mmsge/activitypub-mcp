import { desc, eq, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { localNotes } from '../db/schema.js'
import type { LocalNote } from './note.js'

/** Reads over the bot's own notes, shared by the outbox, the featured collection, the
 *  profile page and NodeInfo so they can never disagree about what has been published. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Newest first — the order the outbox and the profile list both want. */
export async function listNotes(limit: number, offset = 0): Promise<LocalNote[]> {
  const db = getDb()
  return db.select()
    .from(localNotes)
    .orderBy(desc(localNotes.publishedAt))
    .limit(limit)
    .offset(offset)
}

export async function countNotes(): Promise<number> {
  const db = getDb()
  const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(localNotes)
  return row?.total ?? 0
}

/** The pinned notes, for the `featured` collection Mastodon fetches on every refresh. */
export async function listPinnedNotes(): Promise<LocalNote[]> {
  const db = getDb()
  return db.select()
    .from(localNotes)
    .where(eq(localNotes.pinned, true))
    .orderBy(desc(localNotes.publishedAt))
}

/** A single note by id, or null. The id comes straight off the URL path, so a value
 *  that is not a UUID is rejected here rather than handed to Postgres as a cast error. */
export async function getNote(id: string): Promise<LocalNote | null> {
  if (!UUID.test(id)) return null
  const db = getDb()
  const [row] = await db.select()
    .from(localNotes)
    .where(eq(localNotes.id, id))
    .limit(1)
  return row ?? null
}

/** Pinned notes first, then the rest newest-first — how the profile page lists them. */
export async function listNotesForProfile(limit: number): Promise<LocalNote[]> {
  const db = getDb()
  return db.select()
    .from(localNotes)
    .orderBy(desc(localNotes.pinned), desc(localNotes.publishedAt))
    .limit(limit)
}
