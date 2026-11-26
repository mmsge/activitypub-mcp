import { getDb } from '../db/client.js'
import { actors } from '../db/schema.js'
import { logger } from '../lib/logger.js'
import { objectRow, upsertObjectRows } from './archive-objects.js'
import {
  buildTiktokActor,
  parseTiktokArchive,
  postToObject,
  type BuiltPost,
  type BuiltTiktokActor,
  type PostProblem,
} from '../lib/parse-tiktok-archive.js'

/**
 * Import a `tiktok-archive/1` file as `@<username>@tiktok.com` and one `objects` row per post.
 *
 * The posts are stored the way an ingested Create would store them, by the same helpers
 * the Twitter importer uses (src/jobs/archive-objects.ts), so every tool that reads an
 * actor's posts reads these without knowing the difference. What this does NOT do is the
 * point (ADR 0078):
 *
 * - It never goes through `ingestObject`: no enrichment queues, no msge.no webhook.
 * - It never dials tiktok.com: no WebFinger, no actor refresh, no NodeInfo probe.
 * - It stores no files. A post's page on TikTok is the only link it carries, and only when
 *   that page exists.
 *
 * Idempotent, an upsert on `ap_id`: a newer file, or a parser fix, is a re-run.
 * `deleted_at` is never touched, so a post hidden by hand stays hidden.
 */

const DEFAULT_BATCH_SIZE = 500

export interface TiktokPlan {
  actor: BuiltTiktokActor
  generatedAt: string | null
  posts: BuiltPost[]
  /** Posts in the file that were left out, by position, with the reason. */
  problems: PostProblem[]
  stats: {
    inFile: number
    posts: number
    videos: number
    photos: number
    /** Posts with a page on TikTok, and so a url. */
    onProfile: number
    /** Posts the export knows and the profile no longer shows: an ap_id and no url. */
    offProfile: number
    first: string | null
    last: string | null
  }
}

/**
 * The file → rows, without a database. Throws `TiktokArchiveError` when the file is not a
 * `tiktok-archive/1` at all; a post that does not check out is listed in `problems`.
 */
export function planTiktokArchive(input: unknown): TiktokPlan {
  const { archive, problems, positions } = parseTiktokArchive(input)
  const actor = buildTiktokActor(archive.account, archive.generatedAt)

  const posts: BuiltPost[] = []
  const seen = new Map<string, number>()
  archive.posts.forEach((post, i) => {
    const built = postToObject(post, archive.account)
    // Two posts in one ap_id would be one row, and the second would overwrite the first
    // without a word. For a post with no id that means two in the same second.
    const earlier = seen.get(built.apId)
    if (earlier != null) {
      problems.push({ index: positions[i]!, postedAt: post.postedAt, reason: `same ap_id as post ${earlier} (${built.apId})` })
      return
    }
    seen.set(built.apId, positions[i]!)
    posts.push(built)
  })
  problems.sort((a, b) => a.index - b.index)

  const dates = posts.map((p) => p.object.published as string).sort()
  return {
    actor,
    generatedAt: archive.generatedAt,
    posts,
    problems,
    stats: {
      // Every entry in the file is either a kept post or a problem.
      inFile: posts.length + problems.length,
      posts: posts.length,
      videos: posts.filter((p) => p.type === 'Video').length,
      photos: posts.filter((p) => p.type === 'Image').length,
      onProfile: posts.filter((p) => 'url' in p.object).length,
      offProfile: posts.filter((p) => !('url' in p.object)).length,
      first: dates[0] ?? null,
      last: dates[dates.length - 1] ?? null,
    },
  }
}

export interface TiktokImportReport {
  handle: string
  actorWritten: boolean
  inserted: number
  updated: number
  /** Rows the database refused, each isolated to the single row. Never silently dropped. */
  failed: Array<{ id: string; reason: string }>
}

async function upsertActor(actor: BuiltTiktokActor): Promise<void> {
  const now = new Date()
  await getDb().insert(actors).values({
    apId: actor.apId,
    handle: actor.handle,
    username: actor.username,
    domain: actor.domain,
    // No server software behind an archive. 'tiktok' is the origin, and a non-null value
    // keeps the NodeInfo backfill from looking for one.
    software: 'tiktok',
    displayName: actor.displayName,
    summary: null,
    iconUrl: null,
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
      software: 'tiktok',
      displayName: actor.displayName,
      raw: actor.raw,
      fetchedAt: now,
      updatedAt: now,
    },
  })
}

/** The id a refusal is reported by: TikTok's own, or the archive stamp for a post without one. */
function reportId(post: BuiltPost): string {
  const archived = post.apId.split('#')[1]
  return archived ?? post.apId.split('/').pop() ?? post.apId
}

export async function importTiktokArchive(
  plan: TiktokPlan,
  opts: { dryRun?: boolean; batchSize?: number } = {},
): Promise<TiktokImportReport> {
  const report: TiktokImportReport = { handle: plan.actor.handle, actorWritten: false, inserted: 0, updated: 0, failed: [] }
  if (opts.dryRun) return report

  await upsertActor(plan.actor)
  report.actorWritten = true

  const written = await upsertObjectRows(
    plan.posts.map((p) => ({ id: reportId(p), row: objectRow(plan.actor.apId, p) })),
    { batchSize: opts.batchSize ?? DEFAULT_BATCH_SIZE, label: 'TikTok archive', context: { account: plan.actor.username } },
  )
  report.inserted = written.inserted
  report.updated = written.updated
  report.failed = written.failed

  logger.info(
    { account: plan.actor.username, inserted: report.inserted, updated: report.updated, failed: report.failed.length },
    'TikTok archive import complete',
  )
  return report
}
