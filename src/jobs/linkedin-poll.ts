/**
 * LinkedIn poll job — fetches post snapshots for connected members and upserts them.
 * Runs on a schedule (every 6h) or can be triggered manually from the admin UI.
 */
import { getDb } from '../db/client.js'
import { objects, actors, linkedinAuth } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { getValidAccessToken } from '../linkedin/oauth.js'
import { fetchPostSnapshots, fetchMemberProfile } from '../linkedin/client.js'
import { parseLinkedInPost } from '../linkedin/parser.js'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'

export interface LinkedInPollResult {
  memberUrn: string
  total: number
  imported: number
  skipped: number
  errors: string[]
}

export async function runLinkedInPoll(): Promise<LinkedInPollResult[]> {
  const auth = await getValidAccessToken()
  if (!auth) {
    logger.debug('LinkedIn poll skipped — no connected account or token expired')
    return []
  }

  const result = await pollMember(auth.token, auth.memberUrn)
  return [result]
}

async function pollMember(
  accessToken: string,
  memberUrn: string,
): Promise<LinkedInPollResult> {
  logger.info({ memberUrn }, 'LinkedIn poll starting')
  const result: LinkedInPollResult = {
    memberUrn,
    total: 0,
    imported: 0,
    skipped: 0,
    errors: [],
  }

  const db = getDb()

  // Upsert the actor row
  const profile = await fetchMemberProfile(accessToken, memberUrn)
  await upsertLinkedInActor(memberUrn, profile.displayName, profile.profilePicture)

  // Fetch all snapshots
  let snapshots
  try {
    snapshots = await fetchPostSnapshots(accessToken)
  } catch (e) {
    const msg = String(e)
    logger.error({ memberUrn, error: msg }, 'LinkedIn snapshot fetch failed')
    result.errors.push(msg)
    return result
  }

  result.total = snapshots.length

  for (const snapshot of snapshots) {
    try {
      const parsed = await parseLinkedInPost(snapshot, memberUrn, config.APP_DOMAIN)
      if (!parsed) {
        result.skipped++
        continue
      }

      const inserted = await db.insert(objects).values({
        apId: parsed.apId,
        source: 'linkedin',
        sourceExternalId: parsed.sourceExternalId,
        type: parsed.type,
        actorApId: parsed.actorApId,
        content: parsed.content,
        contentText: parsed.contentText,
        url: parsed.url,
        publishedAt: parsed.publishedAt,
        attachments: parsed.attachments,
        tags: [],
        sensitive: false,
        raw: parsed.raw as Record<string, unknown>,
      }).onConflictDoNothing({ target: objects.apId }).returning({ id: objects.id })

      if (inserted.length === 0) {
        result.skipped++
      } else {
        result.imported++
      }
    } catch (e) {
      const msg = String(e)
      if (result.errors.length < 50) result.errors.push(msg)
      logger.warn({ error: msg, snapshot }, 'Failed to import LinkedIn post')
    }
  }

  // Update lastPolledAt
  await db.update(linkedinAuth)
    .set({ lastPolledAt: new Date(), updatedAt: new Date() })
    .where(eq(linkedinAuth.memberUrn, memberUrn))

  logger.info({
    memberUrn,
    total: result.total,
    imported: result.imported,
    skipped: result.skipped,
    errors: result.errors.length,
  }, 'LinkedIn poll complete')

  return result
}

async function upsertLinkedInActor(
  memberUrn: string,
  displayName: string | undefined,
  iconUrl: string | undefined,
): Promise<void> {
  const db = getDb()
  const now = new Date()
  await db.insert(actors).values({
    apId: memberUrn,
    source: 'linkedin',
    displayName: displayName ?? null,
    iconUrl: iconUrl ?? null,
    profileUrl: `https://www.linkedin.com/in/me`,
    raw: { memberUrn, displayName, iconUrl },
    fetchedAt: now,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: actors.apId,
    set: {
      displayName: displayName ?? null,
      iconUrl: iconUrl ?? null,
      updatedAt: now,
      fetchedAt: now,
      raw: { memberUrn, displayName, iconUrl },
    },
  })
}
