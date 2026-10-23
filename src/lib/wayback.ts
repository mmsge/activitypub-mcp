import { candidatesFor, imageUrlFromPage, type Candidate, type LegacyImageLink } from './legacy-image-links.js'

/**
 * Recover a legacy photo from the Wayback Machine. See ADR 0068.
 *
 * Two endpoints, both public and keyless:
 *   - the CDX index, to find which captures of a URL exist, and
 *   - `web/<timestamp>id_/<url>`, which serves a capture's original bytes with no
 *     Wayback toolbar or rewriting.
 *
 * `fetch` and `sleep` are injected, so the whole lookup runs in tests without a network.
 * archive.org is a non-profit on donated bandwidth: every request goes through `polite`,
 * which waits between requests and backs off on 429 and 5xx rather than retrying hot.
 */

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}>

export interface WaybackClientOptions {
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  /** Wait at least this long between requests. */
  delayMs?: number
  /** How many times to retry one request on 429 or 5xx. */
  retries?: number
  userAgent?: string
}

export interface Capture {
  timestamp: string
  original: string
  mimetype: string
}

export type Recovered =
  | {
      status: 'found'
      bytes: Uint8Array
      contentType: string
      /** The capture the bytes came from, for the index and for checking by hand. */
      waybackUrl: string
      /** Which candidate URL found it. */
      via: string
    }
  | { status: 'missing'; tried: string[] }
  | { status: 'error'; tried: string[]; error: string }

const WAYBACK = 'https://web.archive.org'

export class WaybackClient {
  private readonly fetch: FetchLike
  private readonly sleep: (ms: number) => Promise<void>
  private readonly delayMs: number
  private readonly retries: number
  private readonly userAgent: string
  private last = 0

  constructor(opts: WaybackClientOptions = {}) {
    this.fetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike)
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.delayMs = opts.delayMs ?? 1500
    this.retries = opts.retries ?? 3
    this.userAgent = opts.userAgent ?? 'activitypub-mcp legacy image recovery (bot.skvip.lol)'
  }

  private async polite(url: string): ReturnType<FetchLike> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.delayMs - Date.now()
      if (wait > 0) await this.sleep(wait)
      this.last = Date.now()
      const res = await this.fetch(url, { headers: { 'User-Agent': this.userAgent } })
      const busy = res.status === 429 || res.status >= 500
      if (!busy || attempt >= this.retries) return res
      const retryAfter = Number(res.headers.get('retry-after'))
      await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.delayMs * 2 ** (attempt + 1))
    }
  }

  /** The successful captures of a URL (or of every URL under it), newest first. */
  async captures(url: string, match: Candidate['match'] = 'exact', limit = 5): Promise<Capture[]> {
    const q = new URLSearchParams({
      url,
      output: 'json',
      fl: 'timestamp,original,mimetype',
      filter: 'statuscode:200',
      limit: String(-limit),
    })
    if (match === 'prefix') q.set('matchType', 'prefix')
    const res = await this.polite(`${WAYBACK}/cdx/search/cdx?${q}`)
    if (!res.ok) throw new Error(`CDX ${res.status} for ${url}`)
    return parseCdx(await res.text()).reverse()
  }

  /** A capture's original bytes. */
  async raw(timestamp: string, original: string) {
    const url = `${WAYBACK}/web/${timestamp}id_/${original}`
    const res = await this.polite(url)
    return { res, url }
  }

  /**
   * Try each candidate for a link, best first, and return the first real image.
   *
   * "Real" is checked by the bytes, not the content type: Wayback sometimes serves an
   * HTML error page labelled as the capture's original type, and saving that as .jpg
   * would hide a miss in the output folder.
   */
  async recover(link: LegacyImageLink): Promise<Recovered> {
    const tried: string[] = []
    try {
      for (const cand of candidatesFor(link)) {
        tried.push(cand.url)
        const caps = await this.captures(cand.url, cand.match)
        if (cand.kind === 'image') {
          const hit = await this.firstImage(caps.filter((c) => !c.mimetype || c.mimetype.startsWith('image/')), cand.url)
          if (hit) return hit
          continue
        }
        for (const cap of caps.filter((c) => c.mimetype.includes('html')).slice(0, 2)) {
          const { res } = await this.raw(cap.timestamp, cap.original)
          if (!res.ok) continue
          const imageUrl = imageUrlFromPage(await res.text(), cap.original)
          if (!imageUrl) continue
          tried.push(imageUrl)
          const imageCaps = await this.captures(imageUrl, 'exact')
          // Nothing indexed for the image itself: ask for it at the page's moment and let
          // Wayback redirect to the nearest capture, which the index can miss.
          const fallback = imageCaps.length ? imageCaps : [{ timestamp: cap.timestamp, original: imageUrl, mimetype: '' }]
          const hit = await this.firstImage(fallback, cand.url)
          if (hit) return hit
        }
      }
      return { status: 'missing', tried }
    } catch (e) {
      return { status: 'error', tried, error: e instanceof Error ? e.message : String(e) }
    }
  }

  private async firstImage(caps: Capture[], via: string): Promise<Recovered | null> {
    for (const cap of caps.slice(0, 3)) {
      const { res, url } = await this.raw(cap.timestamp, cap.original)
      if (!res.ok) continue
      const bytes = new Uint8Array(await res.arrayBuffer())
      const sniffed = sniffImage(bytes)
      if (!sniffed) continue
      return { status: 'found', bytes, contentType: sniffed, waybackUrl: url, via }
    }
    return null
  }
}

/** CDX's JSON output is a header row followed by data rows. */
export function parseCdx(text: string): Capture[] {
  if (!text.trim()) return []
  const rows = JSON.parse(text) as string[][]
  if (!Array.isArray(rows) || rows.length < 2) return []
  const [header, ...data] = rows
  const at = (name: string) => header.indexOf(name)
  return data.map((r) => ({ timestamp: r[at('timestamp')], original: r[at('original')], mimetype: r[at('mimetype')] ?? '' }))
}

/** The image type from the file's first bytes, or null when it is not an image. */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length < 12) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  return null
}
