import { config } from '../config.js'

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
