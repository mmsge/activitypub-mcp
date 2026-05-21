import { createHash } from 'node:crypto'
import { mkdir, writeFile, access } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { config } from '../config.js'
import { getDb } from '../db/client.js'
import { media } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { logger } from '../lib/logger.js'

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'application/pdf': '.pdf',
}

function extForMime(mimeType: string): string {
  return MIME_TO_EXT[mimeType] ?? '.bin'
}

export interface SavedMedia {
  id: string
  publicUrl: string
  mimeType: string
  bytes: number
}

/**
 * Download a remote URL and persist it locally.
 * Idempotent: if the content hash already exists, returns the existing record.
 */
export async function downloadAndSaveMedia(
  sourceUrl: string,
  overrideMime?: string,
): Promise<SavedMedia | null> {
  let buf: Buffer
  let mimeType: string
  try {
    const res = await fetch(sourceUrl)
    if (!res.ok) {
      logger.warn({ sourceUrl, status: res.status }, 'Failed to download media')
      return null
    }
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    mimeType = overrideMime ?? contentType.split(';')[0].trim()
    buf = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    logger.warn({ sourceUrl, error: e }, 'Error downloading media')
    return null
  }

  return saveMediaBuffer(buf, mimeType, sourceUrl)
}

/**
 * Save an in-memory buffer as a media file.
 * Idempotent by content hash.
 */
export async function saveMediaBuffer(
  buf: Buffer,
  mimeType: string,
  sourceUrl?: string,
): Promise<SavedMedia> {
  const hash = createHash('sha256').update(buf).digest('hex')
  const db = getDb()

  // Check if already stored
  const existing = await db.select().from(media).where(eq(media.hash, hash)).limit(1)
  if (existing.length > 0) {
    const row = existing[0]
    return {
      id: row.id,
      publicUrl: mediaPublicUrl(row.id, mimeType),
      mimeType: row.mimeType,
      bytes: row.bytes,
    }
  }

  // Persist to disk
  const dir = config.MEDIA_DIR
  await mkdir(dir, { recursive: true })
  const filename = hash + extForMime(mimeType)
  const filepath = join(dir, filename)

  try {
    await access(filepath)
    // File already exists on disk (DB row was perhaps rolled back)
  } catch {
    await writeFile(filepath, buf)
  }

  // Insert DB record
  const [row] = await db.insert(media).values({
    hash,
    mimeType,
    bytes: buf.byteLength,
    sourceUrl: sourceUrl ?? null,
  }).returning()

  logger.debug({ id: row.id, hash, mimeType, bytes: buf.byteLength }, 'Media saved')

  return {
    id: row.id,
    publicUrl: mediaPublicUrl(row.id, mimeType),
    mimeType,
    bytes: buf.byteLength,
  }
}

/** Construct the public URL for a media record by ID. */
export function mediaPublicUrl(id: string, _mimeType?: string): string {
  return `/media/${id}`
}

/** Resolve the disk path for a media ID + mime type. */
export async function mediaFilePath(id: string): Promise<{ path: string; mimeType: string } | null> {
  const db = getDb()
  const rows = await db.select().from(media).where(eq(media.id, id)).limit(1)
  if (rows.length === 0) return null
  const row = rows[0]
  const filename = row.hash + extForMime(row.mimeType)
  return { path: join(config.MEDIA_DIR, filename), mimeType: row.mimeType }
}
