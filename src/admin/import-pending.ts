import { randomBytes } from 'node:crypto'

// Uploads waiting for "Importer" after their preview (ADR 0073). The form body is kept
// as it arrived, File included, so the confirm runs the very handler the preview ran on
// the very same bytes, and nobody uploads the file twice.
//
// In memory on purpose: a pending upload is worth ten minutes and one click, and a
// restart losing it costs a re-upload. Bounded by count and by age, oldest out first.

export const PENDING_TTL_MS = 10 * 60_000
export const PENDING_MAX = 4

export type FormBody = Record<string, string | File | (string | File)[]>

export interface Pending {
  kind: string
  body: FormBody
  createdAt: number
  /** Trips only: the ids the preview listed as missing, the most the confirm may remove. */
  pruneIds?: string[]
}

const store = new Map<string, Pending>()

function sweep(now: number): void {
  for (const [token, p] of store) {
    if (now - p.createdAt > PENDING_TTL_MS) store.delete(token)
  }
  while (store.size > PENDING_MAX) {
    const oldest = store.keys().next()
    if (oldest.done) break
    store.delete(oldest.value)
  }
}

export function stashUpload(kind: string, body: FormBody, now = Date.now()): string {
  const token = randomBytes(16).toString('hex')
  store.set(token, { kind, body, createdAt: now })
  sweep(now)
  return token
}

/** Attach what the preview found, so the confirm can be held to it. */
export function notePending(token: string, extra: Pick<Pending, 'pruneIds'>): void {
  const p = store.get(token)
  if (p) Object.assign(p, extra)
}

/**
 * Take an upload for its confirm. One use: the token is gone afterwards, so a resubmit
 * or a second tab cannot import the same file twice behind your back.
 */
export function takeUpload(token: string, kind: string, now = Date.now()): Pending | null {
  sweep(now)
  const p = store.get(token)
  if (!p || p.kind !== kind) return null
  store.delete(token)
  return p
}

/** Test seam. */
export function clearPending(): void {
  store.clear()
}
