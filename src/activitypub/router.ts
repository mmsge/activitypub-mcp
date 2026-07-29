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
import { AP_HEADERS } from '../lib/content-type.js'

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
app.get(`/@${config.APP_USERNAME}`, (c) => c.html(renderProfilePage()))

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
