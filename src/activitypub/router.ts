import { Hono } from 'hono'
import { config, getActorUrl } from '../config.js'
import { buildActorDocument } from './actor.js'
import { renderProfilePage } from './profile-page.js'
import { profileAssetsRouter } from './profile-assets.js'
import { inboxRouter } from './inbox.js'
import { outboxRouter } from './outbox.js'
import { getDb } from '../db/client.js'
import { follows } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { AP_HEADERS, isActivityPubRequest } from '../lib/content-type.js'

const app = new Hono()

/** True when the client explicitly asked for HTML.
 *
 *  Defaults to the actor JSON: plenty of fediverse implementations send a vague
 *  `Accept: * /*` (or none at all) and expect the actor document, so HTML is only
 *  served when text/html is actually requested — i.e. by browsers. */
function prefersHtml(accept: string | undefined): boolean {
  return !!accept && accept.includes('text/html')
}

// Actor profile. Content-negotiated: fediverse servers get the actor document,
// browsers get the human-readable page explaining what this bot is.
app.get('/actor', (c) => {
  if (prefersHtml(c.req.header('accept'))) {
    return c.html(renderProfilePage())
  }
  return c.json(buildActorDocument(), 200, AP_HEADERS)
})

// Mastodon alias
app.get(`/users/${config.APP_USERNAME}`, (c) => {
  return c.json(buildActorDocument(), 200, AP_HEADERS)
})

// Mastodon-style human-readable profile URL — what the actor document advertises
// as `url`, and what someone is likely to type after seeing the handle.
//
// Defaults to HTML, being the human-facing URL, but answers the actor document to a
// caller that explicitly asks for ActivityPub and not HTML. Mastodon's URL search
// fetches this with `Accept: application/activity+json` and gives up if it cannot
// reach the actor from here, so serving HTML unconditionally made the account
// unfindable by link. The page also carries a `rel="alternate"` link for clients
// that only parse the HTML.
app.get(`/@${config.APP_USERNAME}`, (c) => {
  const accept = c.req.header('accept')
  if (accept && isActivityPubRequest(accept) && !prefersHtml(accept)) {
    return c.json(buildActorDocument(), 200, AP_HEADERS)
  }
  return c.html(renderProfilePage())
})

// Avatar and header images referenced by the actor document.
app.route('/assets', profileAssetsRouter)

// Inbox
app.route('/actor/inbox', inboxRouter)
app.route(`/users/${config.APP_USERNAME}/inbox`, inboxRouter)
app.route('/inbox', inboxRouter)  // shared inbox

// Outbox
app.route('/actor/outbox', outboxRouter)

// Followers collection (empty — we don't accept followers)
app.get('/actor/followers', (c) => {
  const actorUrl = getActorUrl()
  return c.json({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${actorUrl}/followers`,
    type: 'OrderedCollection',
    totalItems: 0,
    orderedItems: [],
  }, 200, AP_HEADERS)
})

// Following collection (public list of who we follow)
app.get('/actor/following', async (c) => {
  const db = getDb()
  const accepted = await db.select().from(follows).where(eq(follows.status, 'accepted'))
  const actorUrl = getActorUrl()
  return c.json({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${actorUrl}/following`,
    type: 'OrderedCollection',
    totalItems: accepted.length,
    orderedItems: accepted.map(f => f.actorApId),
  }, 200, AP_HEADERS)
})

export { app as activityPubRouter }
