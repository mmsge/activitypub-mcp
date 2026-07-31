import { createHash } from 'node:crypto'
import { desc, eq, isNull, sql } from 'drizzle-orm'
import { config, getActorUrl, getOwnerIdentity } from '../config.js'
import { getProfilePageUrl } from '../activitypub/actor.js'
import { getDb } from '../db/client.js'
import { follows, localNotes, objects } from '../db/schema.js'
import { escapeHtml } from '../lib/html.js'
import { logger } from '../lib/logger.js'

/**
 * The only thing this actor ever publishes.
 *
 * Two notes, both about the bot itself and never about anyone else: a pinned intro
 * explaining what it is, and a periodic status giving the size of the archive. Nothing
 * here reveals anything about a third party — the follow list is already public, and
 * the counts are aggregates over Markus' own accounts.
 *
 * There are no followers to deliver to (every Follow is rejected), so nothing is
 * queued for delivery. The notes reach people through the `featured` collection, which
 * Mastodon refetches on every profile refresh, through the outbox, and through the
 * profile page.
 */

export interface ArchiveStats {
  /** Accounts the bot follows — the same set its open following list shows. */
  followed: number
  /** Public posts archived from them. */
  archived: number
  /** Publication date of the oldest archived post, if there is one. */
  oldest: Date | null
}

export interface ComposedNote {
  content: string
  contentText: string
}

/** Fingerprint of a note's text. Comparing these is what stops an unchanged status
 *  from being posted again every interval, and what tells a reworded intro apart from
 *  one that only looks different. */
export function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** Wraps our own URLs in anchors. Applied after escaping, and only ever to text this
 *  module composed — nothing from a request reaches it. */
function linkify(escaped: string): string {
  return escaped.replace(/https:\/\/[^\s<]+[^\s<.,)]/g, url => `<a href="${url}">${url}</a>`)
}

function toNote(paragraphs: string[]): ComposedNote {
  return {
    content: paragraphs.map(p => `<p>${linkify(escapeHtml(p))}</p>`).join(''),
    contentText: paragraphs.join('\n\n'),
  }
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('nn-NO', { day: 'numeric', month: 'long', year: 'numeric' })
}

/** The pinned note. Says the same three things as the bio, but with room to link the
 *  proof, and — being pinned — it is what a stranger sees first on the profile. */
export function composeIntro(): ComposedNote {
  const owner = getOwnerIdentity()
  const actorUrl = getActorUrl()

  return toNote([
    // The handle alone would render as plain text — nothing links a bare @user@host
    // without a Mention tag, and tagging the owner would notify him every time the
    // intro is reworded. The URL links itself.
    owner
      ? `Dette er ein personleg ActivityPub-bot. Markus eig og driftar han: ${owner.url}`
      : 'Dette er ein personleg ActivityPub-bot. Markus eig og driftar han.',
    'Han følgjer eit fast og ope sett med kontoar — i praksis dei Markus eig sjølv — og' +
      ' arkiverer dei offentlege innlegga derfrå, slik at arkivet kan spørjast gjennom MCP.',
    'Han arkiverer ingenting om deg, og han tek ikkje imot følgjarar. Kven han følgjer,' +
      ` ligg ope: ${actorUrl}/following`,
    `Meir om kva han gjer og ikkje gjer: ${getProfilePageUrl()}`,
  ])
}

export function composeStatus(stats: ArchiveStats): ComposedNote {
  const actorUrl = getActorUrl()
  const count = (n: number) => n.toLocaleString('nn-NO')
  const accounts = stats.followed === 1 ? 'éin konto' : `${count(stats.followed)} kontoar`

  return toNote([
    'Statusmelding frå arkivet.',
    `Han følgjer ${accounts} og har arkivert ${count(stats.archived)} offentlege innlegg` +
      ` frå dei.${stats.oldest ? ` Det eldste er frå ${formatDate(stats.oldest)}.` : ''}`,
    'Ingenting av dette er om deg — han arkiverer berre kontoane i den opne lista:' +
      ` ${actorUrl}/following`,
  ])
}

/** Whether a new status note is due. Pure, so the two guards that matter — the interval
 *  and the "nothing changed" check — can be pinned by tests without a database. */
export function shouldPublishStatus(opts: {
  intervalHours: number
  latest: { digest: string; publishedAt: Date } | null
  digest: string
  now: Date
}): boolean {
  if (opts.intervalHours <= 0) return false
  if (!opts.latest) return true
  // Reposting an identical status every week would fill the outbox with noise and tell
  // a reader nothing they did not already know.
  if (opts.latest.digest === opts.digest) return false
  const elapsedHours = (opts.now.getTime() - opts.latest.publishedAt.getTime()) / 3_600_000
  return elapsedHours >= opts.intervalHours
}

async function collectStats(): Promise<ArchiveStats> {
  const db = getDb()

  const [followed] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(follows)
    .where(eq(follows.status, 'accepted'))

  const [archived] = await db
    .select({
      n: sql<number>`count(*)::int`,
      oldest: sql<string | null>`min(${objects.publishedAt})`,
    })
    .from(objects)
    .where(isNull(objects.deletedAt))

  const oldest = archived?.oldest ? new Date(archived.oldest) : null
  return {
    followed: followed?.n ?? 0,
    archived: archived?.n ?? 0,
    oldest: oldest && !Number.isNaN(oldest.getTime()) ? oldest : null,
  }
}

/** Creates the pinned intro, or edits it in place when its wording has changed (the
 *  retention window it quotes is configurable). Never a second intro row. */
async function ensureIntro(now: Date): Promise<void> {
  const db = getDb()
  const note = composeIntro()
  const digest = digestOf(note.contentText)

  const [existing] = await db.select()
    .from(localNotes)
    .where(eq(localNotes.kind, 'intro'))
    .limit(1)

  if (!existing) {
    await db.insert(localNotes).values({
      kind: 'intro',
      content: note.content,
      contentText: note.contentText,
      digest,
      pinned: true,
      publishedAt: now,
      updatedAt: now,
    })
    logger.info('Published the pinned intro note')
    return
  }

  if (existing.digest === digest) return

  await db.update(localNotes)
    .set({ content: note.content, contentText: note.contentText, digest, updatedAt: now })
    .where(eq(localNotes.id, existing.id))
  logger.info('Rewrote the pinned intro note')
}

export async function publishStatusNote(now = new Date()): Promise<void> {
  await ensureIntro(now)

  const intervalHours = config.STATUS_NOTE_INTERVAL_HOURS
  if (intervalHours <= 0) return

  const stats = await collectStats()
  // A status of all zeros — a fresh deployment, or one whose follows have not synced
  // yet — says less than no status at all. Wait until there is something to report.
  if (stats.followed === 0 && stats.archived === 0) return

  const db = getDb()
  const note = composeStatus(stats)
  const digest = digestOf(note.contentText)

  const [latest] = await db.select()
    .from(localNotes)
    .where(eq(localNotes.kind, 'status'))
    .orderBy(desc(localNotes.publishedAt))
    .limit(1)

  if (!shouldPublishStatus({ intervalHours, latest: latest ?? null, digest, now })) return

  await db.insert(localNotes).values({
    kind: 'status',
    content: note.content,
    contentText: note.contentText,
    digest,
    pinned: false,
    publishedAt: now,
    updatedAt: now,
  })
  logger.info('Published a status note')
}
