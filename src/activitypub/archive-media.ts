import { Hono } from 'hono'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { config } from '../config.js'

/**
 * Serve the photos and videos of an imported archive — `GET /archive/media/twitter/:account/:file`.
 *
 * The attachments of an imported tweet point here, so the archive is self-contained: the
 * original `pbs.twimg.com` / `video.twimg.com` addresses are dead or going to be, and a
 * post whose picture is a broken link is not "kept". Files live under
 * `ARCHIVE_MEDIA_DIR/twitter/<account>/` (a volume that is never swept) and are written
 * there by the import, never by a request.
 *
 * Narrow by construction rather than by trust: names are matched against a strict
 * whitelist pattern *before* they touch the filesystem, the extension must be a known
 * media type, and the resolved path must still sit under the root. A request is a lookup in
 * one directory and cannot be anything else. See ADR 0067.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/

const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n` → an inclusive range inside `size`, or null. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null
  const m = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    // Suffix form: the last n bytes.
    const n = Number(m[2])
    if (n === 0) return null
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start > end || start >= size) return null
  return { start, end }
}

export function createArchiveMediaRouter(root: () => string): Hono {
  const app = new Hono()

  app.get('/archive/media/twitter/:account/:file', async (c) => {
    const { account, file } = c.req.param()
    if (!NAME.test(account) || !NAME.test(file)) return c.notFound()
    const contentType = TYPES[extname(file).toLowerCase()]
    if (!contentType) return c.notFound()

    const base = resolve(root(), 'twitter', account)
    const path = resolve(base, file)
    if (!path.startsWith(base + sep)) return c.notFound()

    let size: number
    try {
      const st = await stat(path)
      if (!st.isFile()) return c.notFound()
      size = st.size
    } catch {
      return c.notFound()
    }

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      // A file's name embeds the tweet and media it belongs to; its bytes never change.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    }

    const rangeHeader = c.req.header('range')
    const range = parseRange(rangeHeader, size)
    if (rangeHeader && !range) {
      return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${size}` })
    }

    const { start, end } = range ?? { start: 0, end: size - 1 }
    if (size === 0) return c.body(null, 200, { ...headers, 'Content-Length': '0' })
    const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>
    return c.body(body, range ? 206 : 200, {
      ...headers,
      'Content-Length': String(end - start + 1),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    })
  })

  return app
}

export const archiveMediaRouter = createArchiveMediaRouter(() => config.ARCHIVE_MEDIA_DIR)
