import { eq } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { follows } from '../db/schema.js'
import { getActorUrl, getFollowActors } from '../config.js'
import { fetchActor, resolveActorByHandle, type ActorRecord } from '../lib/fetch-actor.js'
import { isArchiveDomain } from '../lib/archive-actors.js'
import { sendFollow, sendUnfollow } from '../activitypub/follow.js'
import { logger } from '../lib/logger.js'

// Follow, retry and unfollow from the admin (ADR 0074). FOLLOW_ACTORS still works and
// still runs on boot; this is a second way into the same `follows` table, which is what
// the inbox gate reads, so a follow made here is exactly as real as one from the env.

export type FollowOutcome = { ok: true; message: string } | { ok: false; message: string }

/** `@user@host`, `user@host` and an actor URL are all accepted. */
export function parseFollowInput(raw: string): { kind: 'handle'; handle: string } | { kind: 'url'; url: string } | null {
  const s = raw.trim()
  if (!s) return null
  if (/^https:\/\/[^\s/]+\/\S*$/i.test(s)) return { kind: 'url', url: s }
  const m = s.match(/^@?([^@\s/]+)@([^@\s/]+\.[^@\s/]+)$/)
  return m ? { kind: 'handle', handle: `@${m[1]}@${m[2]!.toLowerCase()}` } : null
}

const normHandle = (h: string) => `@${h.trim().replace(/^@/, '')}`.toLowerCase()

/**
 * Whether a handle is listed in FOLLOW_ACTORS. Such a follow comes back on the next boot
 * after an unfollow, so the admin says so instead of pretending the unfollow sticks.
 */
export function isEnvFollow(handle: string | null | undefined, list: string[] = getFollowActors()): boolean {
  if (!handle) return false
  const h = normHandle(handle)
  return list.some((x) => normHandle(x) === h)
}

const label = (a: ActorRecord) => a.handle ?? a.apId

async function resolve(raw: string): Promise<ActorRecord | string> {
  const parsed = parseFollowInput(raw)
  if (!parsed) return `Forstod ikkje «${raw.trim()}». Skriv @brukar@tenar eller ein aktør-URL.`
  try {
    if (parsed.kind === 'handle') {
      return (await resolveActorByHandle(parsed.handle)) ?? `Fann ikkje ${parsed.handle} over WebFinger.`
    }
    return await fetchActor(parsed.url)
  } catch (e) {
    return `Klarte ikkje å hente aktøren: ${e instanceof Error ? e.message : String(e)}`
  }
}

/**
 * Archive actors (ADR 0067) have no server behind them, and the bot cannot follow itself.
 * Both are refused before anything is queued.
 */
function refusal(actor: ActorRecord): string | null {
  if (isArchiveDomain(actor.domain)) return `${label(actor)} er eit importert arkiv. Det er ingen tenar å følgje.`
  if (actor.apId === getActorUrl()) return 'Det er denne boten sjølv.'
  return null
}

const currentFollow = async (apId: string) =>
  (await getDb().select().from(follows).where(eq(follows.actorApId, apId)).limit(1))[0]

export async function followFromAdmin(raw: string): Promise<FollowOutcome> {
  const actor = await resolve(raw)
  if (typeof actor === 'string') return { ok: false, message: actor }
  const refused = refusal(actor)
  if (refused) return { ok: false, message: refused }

  const existing = await currentFollow(actor.apId)
  if (existing?.status === 'accepted') return { ok: true, message: `Følgjer alt ${label(actor)}.` }
  if (existing?.status === 'pending') {
    return { ok: true, message: `${label(actor)} ventar alt på svar. Bruk «Prøv igjen» om det står fast.` }
  }

  await sendFollow(actor.apId, actor.inboxUrl)
  logger.info({ actorApId: actor.apId }, 'Follow sent from admin')
  return { ok: true, message: `Følgjeførespurnad sendt til ${label(actor)}. Han står som ventande til tenaren svarar.` }
}

/** Re-send a Follow that is stuck on pending or was rejected. Never for an accepted one. */
export async function retryFollowFromAdmin(apId: string): Promise<FollowOutcome> {
  const existing = await currentFollow(apId)
  if (!existing) return { ok: false, message: 'Følginga finst ikkje lenger.' }
  if (existing.status === 'accepted') return { ok: true, message: 'Følginga er alt godkjend.' }
  let actor: ActorRecord
  try {
    actor = await fetchActor(apId)
  } catch (e) {
    return { ok: false, message: `Klarte ikkje å hente aktøren: ${e instanceof Error ? e.message : String(e)}` }
  }
  const refused = refusal(actor)
  if (refused) return { ok: false, message: refused }
  await sendFollow(actor.apId, actor.inboxUrl)
  logger.info({ actorApId: actor.apId, was: existing.status }, 'Follow re-sent from admin')
  return { ok: true, message: `Ny følgjeførespurnad sendt til ${label(actor)}.` }
}

/**
 * Send an Undo and drop the row. Once the row is gone the inbox ignores the account, so
 * nothing new from it is stored; what is already stored stays.
 */
export async function unfollowFromAdmin(apId: string): Promise<FollowOutcome> {
  const existing = await currentFollow(apId)
  if (!existing) return { ok: false, message: 'Følginga finst ikkje lenger.' }
  let actor: ActorRecord | null = null
  try {
    actor = await fetchActor(apId)
  } catch (e) {
    logger.warn({ actorApId: apId, error: e }, 'Unfollow: actor fetch failed, dropping the row without an Undo')
  }
  if (actor && !isArchiveDomain(actor.domain)) {
    await sendUnfollow(apId, actor.inboxUrl)
  } else {
    // No inbox to tell. The row still goes, since that is what stops ingest here.
    await getDb().delete(follows).where(eq(follows.actorApId, apId))
  }
  const name = actor ? label(actor) : apId
  const env = isEnvFollow(actor?.handle)
  return {
    ok: true,
    message: env
      ? `Slutta å følgje ${name}. Han står framleis i FOLLOW_ACTORS og blir følgd att neste gong tenaren startar. Fjern han der òg.`
      : `Slutta å følgje ${name}. Det som alt er lagra, blir verande.`,
  }
}
