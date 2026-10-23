import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { actors, objects } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { stripHtml } from '../lib/strip-html.js'
import { extractContent } from '../lib/object-content.js'
import { extractAttachments, extractLanguage, extractTags } from '../lib/object-fields.js'
import { resolveRef } from '../lib/ap-object.js'
import { dbReason } from './import-youtube-watches.js'
import {
  TWITTER_DOMAIN,
  buildActor,
  mediaDirFor,
  parseAccount,
  parseYtd,
  tweetToObject,
  type BuiltActor,
  type BuiltTweet,
  type TwitterAccount,
} from '../lib/parse-twitter-archive.js'

/**
 * Import Twitter archives as actors and posts.
 *
 * Each archive becomes one actor (`@<username>@twitter.com`) and one `objects` row per
 * tweet, stored the way an ingested Create would store them — same columns, derived by the
 * same helpers — so every tool that reads an actor's posts reads these without knowing the
 * difference. They differ in only one respect, and it is the point: an archive never
 * updates, so nothing here polls, follows or refreshes. See ADR 0067.
 *
 * Deliberately NOT routed through `ingestObject`. That path exists for objects arriving
 * from a live server and fans out to enrichment queues, mark/gig parsers and the msge.no
 * wake-up webhook, once per object; 37,000 tweets would fire all of it 37,000 times for
 * nothing. The columns are derived by the same helpers, which is what keeps the two from
 * drifting — the pipelines are what is left out.
 *
 * Idempotent, and an upsert rather than DO NOTHING: re-running after a parser improvement
 * re-derives every row from the same archive, which is the reason the whole tweet is kept
 * in `raw`. `deleted_at` is never touched, so a post hidden by hand stays hidden.
 */

type AnyObject = Record<string, unknown>

const DEFAULT_BATCH_SIZE = 500

// ---------------------------------------------------------------------------
// Reading an archive from disk
// ---------------------------------------------------------------------------

export { loadArchive, tweetFileNames, type LoadedArchive } from '../lib/load-twitter-archive.js'
import type { LoadedArchive } from '../lib/load-twitter-archive.js'

// ---------------------------------------------------------------------------
// Planning: archive → rows, without touching a database or a disk
// ---------------------------------------------------------------------------

export interface Problem {
  tweetId: string
  reason: string
}

export interface PlannedAccount {
  archive: LoadedArchive
  actor: BuiltActor
  tweets: BuiltTweet[]
  problems: Problem[]
  /** Distinct files to copy: tweet media, then profile images. */
  mediaFiles: string[]
  profileFiles: string[]
  stats: {
    tweets: number
    notes: number
    retweets: number
    replies: number
    withMedia: number
    mediaFiles: number
    mediaMissing: number
    entityMismatches: number
    first: string | null
    last: string | null
  }
}

export function planArchives(archives: LoadedArchive[], baseUrl: string): PlannedAccount[] {
  // Both accounts are Markus', and one replies to the other. Knowing every account id up
  // front is what lets that reply point at a tweet that is actually in the database.
  const knownAccounts = new Map(archives.map((a) => [a.account.accountId, a.account.username]))

  const seenHandles = new Set<string>()
  return archives.map((archive) => {
    const handle = archive.account.username.toLowerCase()
    if (seenHandles.has(handle)) throw new Error(`two archives are for the same account: ${archive.account.username}`)
    seenHandles.add(handle)

    const { account } = archive
    const actor = buildActor(account, baseUrl, archive.profileMedia)

    const built: BuiltTweet[] = []
    const problems: Problem[] = []
    for (const tweet of archive.tweets) {
      try {
        built.push(tweetToObject(tweet, { account, baseUrl, knownAccounts, hasMedia: (f) => archive.tweetMedia.has(f) }))
      } catch (e) {
        problems.push({ tweetId: String(tweet.id_str ?? '?'), reason: e instanceof Error ? e.message : String(e) })
      }
    }

    const mediaFiles = [...new Set(built.flatMap((t) => t.mediaFiles))]
    const profileFiles = [actor.profileFiles.avatar, actor.profileFiles.header].filter((f): f is string => !!f)
    const dates = built.map((t) => t.object.published as string).sort()

    return {
      archive,
      actor,
      tweets: built,
      problems,
      mediaFiles,
      profileFiles,
      stats: {
        tweets: built.length,
        notes: built.filter((t) => t.type === 'Note').length,
        retweets: built.filter((t) => t.type === 'Announce').length,
        replies: built.filter((t) => 'inReplyTo' in t.object).length,
        withMedia: built.filter((t) => t.mediaFiles.length + t.missingMedia.length > 0).length,
        mediaFiles: mediaFiles.length,
        mediaMissing: built.reduce((n, t) => n + t.missingMedia.length, 0),
        entityMismatches: built.reduce((n, t) => n + t.mismatches.length, 0),
        first: dates[0] ?? null,
        last: dates[dates.length - 1] ?? null,
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Writing: files, then rows
// ---------------------------------------------------------------------------

export interface MediaCopyResult {
  copied: number
  alreadyThere: number
  missing: string[]
}

/**
 * Copy files into `<mediaRoot>/twitter/<account>/`. Skips a file already there with the
 * same size, so a second run copies nothing. Files go first and rows second: a row that
 * points at a file which never arrived is worse than a file nobody points at.
 */
export function copyMedia(
  fromDir: string,
  toDir: string,
  files: string[],
): MediaCopyResult {
  mkdirSync(toDir, { recursive: true })
  const out: MediaCopyResult = { copied: 0, alreadyThere: 0, missing: [] }
  for (const f of files) {
    const from = join(fromDir, f)
    const to = join(toDir, f)
    if (!existsSync(from)) {
      out.missing.push(f)
      continue
    }
    if (existsSync(to) && statSync(to).size === statSync(from).size) {
      out.alreadyThere++
      continue
    }
    copyFileSync(from, to)
    out.copied++
  }
  return out
}

/** The columns of an `objects` row, derived exactly as `ingestObject` derives them. */
export function objectRow(actorApId: string, built: BuiltTweet) {
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

export interface ImportOptions {
  /** Where files go. Required unless `copyFiles` is false. */
  mediaRoot?: string
  copyFiles?: boolean
  dryRun?: boolean
  batchSize?: number
}

export interface AccountReport {
  username: string
  handle: string
  actorWritten: boolean
  inserted: number
  updated: number
  /** Rows the database refused, each isolated to the single row. Never silently dropped. */
  failed: Array<{ tweetId: string; reason: string }>
  media: MediaCopyResult | null
}

async function upsertActor(actor: BuiltActor): Promise<void> {
  const db = getDb()
  const now = new Date()
  await db.insert(actors).values({
    apId: actor.apId,
    handle: actor.handle,
    username: actor.username,
    domain: TWITTER_DOMAIN,
    // There is no server software behind an archive. 'twitter' is the origin, which is the
    // only thing the column has ever meant, and it keeps the NodeInfo backfill from
    // trying to find one.
    software: 'twitter',
    displayName: actor.displayName,
    summary: actor.summaryHtml || null,
    iconUrl: actor.iconUrl,
    // Neither exists. The columns are NOT NULL; an empty string is the honest value.
    publicKeyPem: '',
    inboxUrl: '',
    sharedInboxUrl: null,
    followersUrl: null,
    followingUrl: null,
    raw: actor.raw,
    fetchedAt: now,
  }).onConflictDoUpdate({
    target: actors.apId,
    set: {
      handle: actor.handle,
      username: actor.username,
      software: 'twitter',
      displayName: actor.displayName,
      summary: actor.summaryHtml || null,
      iconUrl: actor.iconUrl,
      raw: actor.raw,
      fetchedAt: now,
      updatedAt: now,
    },
  })
}

const EXCLUDED = (col: string) => sql.raw(`excluded."${col}"`)

async function upsertBatch(batch: ReturnType<typeof objectRow>[]): Promise<{ inserted: number; updated: number }> {
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

export async function importPlanned(plan: PlannedAccount, opts: ImportOptions = {}): Promise<AccountReport> {
  const { actor } = plan
  const report: AccountReport = {
    username: actor.username,
    handle: actor.handle,
    actorWritten: false,
    inserted: 0,
    updated: 0,
    failed: [],
    media: null,
  }
  if (opts.dryRun) return report

  if (opts.copyFiles !== false) {
    if (!opts.mediaRoot) throw new Error('mediaRoot is required to copy files (or pass copyFiles: false)')
    const toDir = join(opts.mediaRoot, 'twitter', mediaDirFor(actor.username))
    const a = copyMedia(join(plan.archive.dir, 'data', 'tweet_media'), toDir, plan.mediaFiles)
    const p = copyMedia(join(plan.archive.dir, 'data', 'profile_media'), toDir, plan.profileFiles)
    report.media = {
      copied: a.copied + p.copied,
      alreadyThere: a.alreadyThere + p.alreadyThere,
      missing: [...a.missing, ...p.missing],
    }
  }

  await upsertActor(actor)
  report.actorWritten = true

  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE)
  const rows = plan.tweets.map((t) => ({ id: t.apId.split('/').pop() ?? t.apId, row: objectRow(actor.apId, t) }))

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
        { account: actor.username, batchStart: i, reason: dbReason(batchError) },
        'Twitter archive batch rejected; retrying row by row to isolate it',
      )
      for (const c of chunk) {
        try {
          const r = await upsertBatch([c.row])
          report.inserted += r.inserted
          report.updated += r.updated
        } catch (rowError) {
          report.failed.push({ tweetId: c.id, reason: dbReason(rowError) })
        }
      }
    }
  }

  logger.info(
    { account: actor.username, inserted: report.inserted, updated: report.updated, failed: report.failed.length },
    'Twitter archive import complete',
  )
  return report
}
