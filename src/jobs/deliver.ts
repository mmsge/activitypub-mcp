import { getDb } from '../db/client.js'
import { deliveryQueue, activityLog } from '../db/schema.js'
import { and, isNull, lte, eq } from 'drizzle-orm'
import { signRequest } from '../crypto/signatures.js'
import { logger } from '../lib/logger.js'

const MAX_ATTEMPTS = 5
const BACKOFF_MINUTES = [1, 5, 30, 120, 1440]

export async function runDeliveryWorker(): Promise<void> {
  const db = getDb()
  const now = new Date()

  const pending = await db.select().from(deliveryQueue)
    .where(and(
      isNull(deliveryQueue.deliveredAt),
      lte(deliveryQueue.nextAttemptAt, now),
    ))
    .limit(10)

  for (const item of pending) {
    const body = JSON.stringify(item.payload)
    const headers = await signRequest('POST', item.inboxUrl, body)

    let responseStatus: number | null = null
    let responseBody: string | null = null
    let error: string | null = null

    try {
      const res = await fetch(item.inboxUrl, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/activity+json',
          'Accept': 'application/activity+json',
        },
        body,
      })
      responseStatus = res.status
      responseBody = (await res.text()).slice(0, 2000)

      await db.insert(activityLog).values({
        direction: 'outbound',
        method: 'POST',
        url: item.inboxUrl,
        requestBody: body.slice(0, 10_000),
        responseStatus,
        responseBody,
      })

      if (res.ok || res.status === 202) {
        await db.update(deliveryQueue)
          .set({ deliveredAt: new Date() })
          .where(eq(deliveryQueue.id, item.id))
        logger.info({ inboxUrl: item.inboxUrl }, 'Activity delivered')
      } else {
        error = `HTTP ${res.status}: ${responseBody?.slice(0, 200)}`
        await scheduleRetry(item.id, item.attemptCount, error)
      }
    } catch (e) {
      error = String(e)
      logger.warn({ inboxUrl: item.inboxUrl, error }, 'Delivery failed')
      await db.insert(activityLog).values({
        direction: 'outbound',
        method: 'POST',
        url: item.inboxUrl,
        requestBody: body.slice(0, 10_000),
        error,
      })
      await scheduleRetry(item.id, item.attemptCount, error)
    }
  }
}

async function scheduleRetry(id: string, attemptCount: number, error: string): Promise<void> {
  const db = getDb()
  const next = attemptCount + 1
  if (next >= MAX_ATTEMPTS) {
    await db.update(deliveryQueue)
      .set({ attemptCount: next, lastError: error, nextAttemptAt: new Date(Date.now() + 999_999_999) })
      .where(eq(deliveryQueue.id, id))
    logger.error({ id }, 'Max delivery attempts reached, giving up')
    return
  }
  const delayMs = BACKOFF_MINUTES[attemptCount] * 60_000
  await db.update(deliveryQueue)
    .set({
      attemptCount: next,
      lastError: error,
      nextAttemptAt: new Date(Date.now() + delayMs),
    })
    .where(eq(deliveryQueue.id, id))
}
