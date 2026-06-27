import { getBookwyrmActors } from '../config.js'
import { handleCreate } from '../activitypub/handlers/create.js'
import { resolveActorByHandle } from '../lib/fetch-actor.js'
import { logger } from '../lib/logger.js'

type AnyObject = Record<string, unknown>

const AP_HEADERS = {
  Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
}
const MAX_PAGES = 200 // safety bound on a full outbox walk
const PAGE_DELAY_MS = 200

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Ingest one BookWyrm actor's full outbox through the normal Create handler so its
 * started/finished/review/rating posts land in `objects` (+ `bookwyrm_objects`)
 * exactly as live federation would. This closes finish-date gaps for activity that
 * predates when we started following the actor. Idempotent via the objects unique
 * constraint, so re-runs only add genuinely new posts.
 */
async function backfillOutbox(actorApId: string): Promise<{ pages: number; ingested: number }> {
  const outboxUrl = `${actorApId.replace(/\/$/, '')}/outbox`
  let url: string | undefined = outboxUrl
  let pages = 0
  let ingested = 0
  let resolvedFirst = false

  while (url && pages < MAX_PAGES) {
    let res: Response
    try {
      res = await fetch(url, { headers: AP_HEADERS })
    } catch (e) {
      logger.warn({ url, error: e }, 'Failed to fetch outbox page')
      break
    }
    if (!res.ok) {
      logger.warn({ url, status: res.status }, 'Outbox page returned non-OK status')
      break
    }
    const data = (await res.json()) as AnyObject

    const items = (data.orderedItems ?? data.items) as unknown[] | undefined
    if (Array.isArray(items)) {
      pages++
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const act = item as AnyObject
        // BookWyrm outbox entries are bare Note objects (not Create-wrapped). Wrap
        // each in a synthetic Create so the ingest handler's (actor, object) contract
        // holds. Already-wrapped Creates pass through; anything else (boosts etc.) is
        // skipped so we don't ingest other people's content as our own.
        let activity: AnyObject | null = null
        if (act.type === 'Create') activity = act
        else if (act.type === 'Note' || act.type === 'Article') {
          activity = { type: 'Create', actor: actorApId, object: act }
        } else continue
        if (!activity.actor) activity.actor = actorApId
        try {
          await handleCreate(activity)
          ingested++
        } catch (e) {
          logger.warn({ error: e }, 'Failed to ingest outbox item')
        }
      }
    }

    // Root OrderedCollection has no inline items — follow `first`; pages chain via `next`.
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

  return { pages, ingested }
}

/**
 * Walk the outbox of every configured BookWyrm actor (BOOKWYRM_ACTORS). No-op when
 * none are configured.
 */
export async function syncReadingHistory(): Promise<void> {
  const handles = getBookwyrmActors()
  if (handles.length === 0) {
    logger.info('BOOKWYRM_ACTORS not set, skipping reading-history backfill')
    return
  }

  for (const handle of handles) {
    const actor = handle.startsWith('http')
      ? { apId: handle }
      : await resolveActorByHandle(handle)
    if (!actor) {
      logger.warn({ handle }, 'Could not resolve BookWyrm actor for reading-history backfill')
      continue
    }
    logger.info({ actor: actor.apId }, 'Starting reading-history backfill')
    const { pages, ingested } = await backfillOutbox(actor.apId)
    logger.info({ actor: actor.apId, pages, ingested }, 'Reading-history backfill complete')
  }
}
