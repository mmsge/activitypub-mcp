import { config } from '../config.js'
import { logger } from './logger.js'

// Shared headers for requests against a BookWyrm instance. The User-Agent
// matches BookWyrm's `is_bookwyrm_request` regex (`\(BookWyrm/x.y.z;`), which
// makes an instance serve its native serialization (Review/Comment/Quotation
// types instead of downgraded Article/Note). NOT load-bearing: bookwyrm.social's
// edge cache doesn't vary on User-Agent so pure JSON comes back anyway, and all
// parsing here works from the pure serialization (readingStatus/rating/quote
// survive it) — but a self-hosted instance without that cache will serve the
// full flavor, and the UA identifies this crawler politely either way.
export const BOOKWYRM_AP_HEADERS = {
  Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
  'User-Agent': `activitypub-mcp/1.0 (BookWyrm/0.7.5; +https://${config.APP_DOMAIN})`,
}

// Author AP objects are immutable for our purposes; cache resolved names for the
// process lifetime so a shelf or enrichment pass with many books by the same
// author costs one fetch. Shared by the shelf fetcher and the Edition enricher.
const authorNameCache = new Map<string, string | null>()

export async function resolveBookwyrmAuthorName(url: string): Promise<string | null> {
  const cached = authorNameCache.get(url)
  if (cached !== undefined) return cached
  let name: string | null = null
  try {
    const res = await fetch(url, { headers: BOOKWYRM_AP_HEADERS })
    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>
      name = typeof data.name === 'string' ? data.name : null
    }
  } catch (e) {
    logger.warn({ url, error: e }, 'Failed to resolve BookWyrm author')
  }
  authorNameCache.set(url, name)
  return name
}
