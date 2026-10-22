import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createArchiveMediaRouter, parseRange } from './archive-media.js'

let root: string
let app: ReturnType<typeof createArchiveMediaRouter>

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'archive-media-'))
  mkdirSync(join(root, 'twitter', 'mvrkws'), { recursive: true })
  writeFileSync(join(root, 'twitter', 'mvrkws', '100-Abc.jpg'), Buffer.from('0123456789'))
  writeFileSync(join(root, 'twitter', 'mvrkws', '100-Clip.mp4'), Buffer.from('abcdefghij'))
  writeFileSync(join(root, 'twitter', 'mvrkws', 'notes.txt'), 'not media')
  writeFileSync(join(root, 'secret.jpg'), 'outside the account directory')
  app = createArchiveMediaRouter(() => root)
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers })

describe('GET /archive/media/twitter/:account/:file', () => {
  it('serves an archived file with its type and a long cache lifetime', async () => {
    const res = await get('/archive/media/twitter/mvrkws/100-Abc.jpg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-length')).toBe('10')
    expect(await res.text()).toBe('0123456789')
  })

  it('answers a Range request with 206 and just those bytes, which is what video seeking needs', async () => {
    const res = await get('/archive/media/twitter/mvrkws/100-Clip.mp4', { range: 'bytes=2-4' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(await res.text()).toBe('cde')
  })

  it('refuses an unsatisfiable range with 416', async () => {
    const res = await get('/archive/media/twitter/mvrkws/100-Clip.mp4', { range: 'bytes=50-60' })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */10')
  })

  it('404s a missing file, an unknown account and a file type that is not media', async () => {
    expect((await get('/archive/media/twitter/mvrkws/999-Nope.jpg')).status).toBe(404)
    expect((await get('/archive/media/twitter/nobody/100-Abc.jpg')).status).toBe(404)
    expect((await get('/archive/media/twitter/mvrkws/notes.txt')).status).toBe(404)
  })

  it('cannot be walked out of the account directory', async () => {
    for (const evil of [
      '/archive/media/twitter/mvrkws/..%2Fsecret.jpg',
      '/archive/media/twitter/mvrkws/%2e%2e%2fsecret.jpg',
      '/archive/media/twitter/..%2F/secret.jpg',
      '/archive/media/twitter/mvrkws/..%5Csecret.jpg',
      '/archive/media/twitter/mvrkws/.hidden.jpg',
    ]) {
      const res = await get(evil)
      expect(res.status, evil).toBe(404)
    }
  })

  it('does not answer to anything but GET', async () => {
    const res = await app.request('/archive/media/twitter/mvrkws/100-Abc.jpg', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('parseRange', () => {
  it('reads closed, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=0-4', 10)).toEqual({ start: 0, end: 4 })
    expect(parseRange('bytes=5-', 10)).toEqual({ start: 5, end: 9 })
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
  })
  it('clamps an end past the file and rejects what cannot be satisfied', () => {
    expect(parseRange('bytes=5-999', 10)).toEqual({ start: 5, end: 9 })
    expect(parseRange('bytes=10-12', 10)).toBeNull()
    expect(parseRange('bytes=5-2', 10)).toBeNull()
    expect(parseRange('bytes=-0', 10)).toBeNull()
    expect(parseRange('items=0-1', 10)).toBeNull()
    expect(parseRange(undefined, 10)).toBeNull()
  })
})
