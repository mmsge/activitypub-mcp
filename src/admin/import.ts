import { eq } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { activities, actors } from '../db/schema.js'
import { processActivity } from '../activitypub/inbox.js'
import { fetchActor } from '../lib/fetch-actor.js'
import { logger } from '../lib/logger.js'

type AnyObject = Record<string, unknown>

export interface ImportResult {
  total: number
  imported: number
  skipped: number
  errors: string[]
}

const MAX_OUTBOX_PAGES = 200
const OUTBOX_PAGE_DELAY_MS = 300

export async function storeAndProcessImported(
  activity: AnyObject,
): Promise<{ skipped: boolean; error?: string }> {
  const apId = activity.id as string | undefined
  const type = activity.type as string | undefined

  if (!apId || !type) return { skipped: true }

  const db = getDb()
  const obj = activity.object as AnyObject | string | null
  const objectApId =
    typeof obj === 'string' ? obj : ((obj as AnyObject)?.id as string) ?? null
  const objectType =
    typeof obj === 'object' && obj
      ? ((obj as AnyObject).type as string) ?? null
      : null

  const result = await db
    .insert(activities)
    .values({
      apId,
      type,
      actorApId: activity.actor as string,
      objectApId,
      objectType,
      raw: activity,
    })
    .onConflictDoNothing()
    .returning({ apId: activities.apId })

  if (result.length === 0) return { skipped: true }

  try {
    await processActivity(activity)
    await db
      .update(activities)
      .set({ processed: true })
      .where(eq(activities.apId, apId))
    return { skipped: false }
  } catch (e) {
    const msg = String(e)
    await db
      .update(activities)
      .set({ processingError: msg })
      .where(eq(activities.apId, apId))
    return { skipped: false, error: `${apId}: ${msg}` }
  }
}

export async function processActivityBatch(
  items: unknown[],
  onProgress?: (n: number) => void,
): Promise<ImportResult> {
  const result: ImportResult = { total: items.length, imported: 0, skipped: 0, errors: [] }

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as AnyObject
    const outcome = await storeAndProcessImported(item)
    if (outcome.skipped) {
      result.skipped++
    } else if (outcome.error) {
      result.imported++
      if (result.errors.length < 50) result.errors.push(outcome.error)
    } else {
      result.imported++
    }
    if (onProgress && (i + 1) % 50 === 0) onProgress(i + 1)
  }

  return result
}

export function parseMastodonArchive(text: string): unknown[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('File is not valid JSON')
  }
  const obj = data as AnyObject
  if (obj.type !== 'OrderedCollection') {
    throw new Error(`Expected an OrderedCollection, got: ${obj.type ?? 'unknown'}`)
  }
  const items = obj.orderedItems
  if (!Array.isArray(items)) {
    throw new Error('OrderedCollection has no orderedItems array')
  }
  return items
}

export async function crawlOutbox(actorUrl: string): Promise<unknown[]> {
  const db = getDb()
  const actorRows = await db
    .select()
    .from(actors)
    .where(eq(actors.apId, actorUrl))
    .limit(1)

  let outboxUrl: string
  if (actorRows.length > 0 && (actorRows[0].raw as AnyObject)?.outbox) {
    outboxUrl = (actorRows[0].raw as AnyObject).outbox as string
  } else {
    outboxUrl = `${actorUrl}/outbox`
  }

  const AP_HEADERS = {
    Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
  }

  const allItems: unknown[] = []
  let pagesFetched = 0

  async function fetchPage(url: string): Promise<void> {
    if (pagesFetched >= MAX_OUTBOX_PAGES) {
      logger.warn({ url }, `Outbox crawl hit page limit (${MAX_OUTBOX_PAGES}), stopping`)
      return
    }
    const res = await fetch(url, { headers: AP_HEADERS })
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
    const data = (await res.json()) as AnyObject
    pagesFetched++

    const items = data.orderedItems as unknown[] | undefined
    if (Array.isArray(items)) {
      allItems.push(...items)
    }

    let nextUrl: string | undefined
    if (pagesFetched === 1 && !items) {
      // Root collection without inline items — follow first
      const first = data.first
      if (typeof first === 'string') nextUrl = first
      else if (first && typeof (first as AnyObject).id === 'string')
        nextUrl = (first as AnyObject).id as string
    } else {
      const next = data.next
      if (typeof next === 'string') nextUrl = next
    }

    if (nextUrl) {
      await new Promise((r) => setTimeout(r, OUTBOX_PAGE_DELAY_MS))
      await fetchPage(nextUrl)
    }
  }

  await fetchPage(outboxUrl)
  logger.info({ actorUrl, pages: pagesFetched, items: allItems.length }, 'Outbox crawl complete')
  return allItems
}

export async function ensureActor(actorUrl: string): Promise<void> {
  await fetchActor(actorUrl)
}
