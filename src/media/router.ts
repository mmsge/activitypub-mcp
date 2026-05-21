import { Hono } from 'hono'
import { readFile } from 'node:fs/promises'
import { mediaFilePath } from './storage.js'

const app = new Hono()

app.get('/:id', async (c) => {
  const id = c.req.param('id')
  const resolved = await mediaFilePath(id)
  if (!resolved) return c.notFound()

  let buf: Buffer
  try {
    buf = await readFile(resolved.path)
  } catch {
    return c.notFound()
  }

  return c.body(buf as unknown as ArrayBuffer, 200, {
    'Content-Type': resolved.mimeType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Length': String(buf.byteLength),
  })
})

export { app as mediaRouter }
