import { Hono } from 'hono'
import type { Context } from 'hono'
import { config, getActorUrl } from '../config.js'
import { buildActorDocument } from './actor.js'
import { renderProfilePage } from './profile-page.js'
import { profileAssetsRouter } from './profile-assets.js'
import { inboxRouter } from './inbox.js'
import { outboxRouter } from './outbox.js'
import { buildNoteObject, renderNotePage } from './note.js'
import { getNote, listNotesForProfile, listPinnedNotes } from './notes-store.js'
import { AS_CONTEXT } from './vocab.js'
import { getDb } from '../db/client.js'
import { follows } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { logger } from '../lib/logger.js'
import {
  AP_HEADERS,
  AP_HEADERS_NEGOTIATED,
  HTML_HEADERS_NEGOTIATED,
  isActivityPubRequest,
} from '../lib/content-type.js'

const app = new Hono()

/** True when the client explicitly asked for HTML.
 *
 *  Defaults to the actor JSON: plenty of fediverse implementations send a vague
 *  `Accept: * /*` (or none at all) and expect the actor document, so HTML is only
 *  served when text/html is actually requested — i.e. by browsers. */
function prefersHtml(accept: string | undefined): boolean {
  return !!accept && accept.includes('text/html')
}

/** The notes shown on the profile page. A database hiccup must not take the page down
 *  with it — the rest of the page is the part people came for. */
async function profileNotes() {
  try {
    return await listNotesForProfile(10)
  } catch (e) {
    logger.error(e, 'Could not load notes for the profile page')
    return []
  }
}

// Actor profile. Content-negotiated: fediverse servers get the actor document,
// browsers get the human-readable page explaining what this bot is.
app.get('/actor', async (c) => {
  if (prefersHtml(c.req.header('accept'))) {
    return c.html(renderProfilePage(await profileNotes()), 200, HTML_HEADERS_NEGOTIATED)
  }
  return c.json(buildActorDocument(), 200, AP_HEADERS_NEGOTIATED)
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
app.get(`/@${config.APP_USERNAME}`, async (c) => {
  const accept = c.req.header('accept')
  if (accept && isActivityPubRequest(accept) && !prefersHtml(accept)) {
    return c.json(buildActorDocument(), 200, AP_HEADERS_NEGOTIATED)
  }
  return c.html(renderProfilePage(await profileNotes()), 200, HTML_HEADERS_NEGOTIATED)
})

// Avatar and header images referenced by the actor document.
app.route('/assets', profileAssetsRouter)

// A single note. This URL is both the note's ActivityPub `id` and its web address, so
// unlike /@<username> it defaults to JSON: a server dereferencing the id may well send
// nothing more specific than `Accept: * /*`, and handing it HTML would fail ingestion.
// Browsers always ask for text/html and still get the page.
app.get('/notes/:id', async (c) => {
  const note = await getNote(c.req.param('id'))
  if (!note) return c.notFound()

  if (prefersHtml(c.req.header('accept'))) {
    return c.html(renderNotePage(note), 200, HTML_HEADERS_NEGOTIATED)
  }
  return c.json(buildNoteObject(note, { context: true }), 200, AP_HEADERS_NEGOTIATED)
})

// Inbox
app.route('/actor/inbox', inboxRouter)
app.route(`/users/${config.APP_USERNAME}/inbox`, inboxRouter)
app.route('/inbox', inboxRouter)

// Followers collection (empty — we don't accept followers)
function followers(c: Context) {
  const actorUrl = getActorUrl()
  return c.json({
    '@context': AS_CONTEXT,
    id: `${actorUrl}/followers`,
    type: 'OrderedCollection',
    totalItems: 0,
    orderedItems: [],
  }, 200, AP_HEADERS)
}

// Following collection (public list of who we follow)
async function following(c: Context) {
  const db = getDb()
  const accepted = await db.select().from(follows).where(eq(follows.status, 'accepted'))
  const actorUrl = getActorUrl()
  return c.json({
    '@context': AS_CONTEXT,
    id: `${actorUrl}/following`,
    type: 'OrderedCollection',
    totalItems: accepted.length,
    orderedItems: accepted.map(f => f.actorApId),
  }, 200, AP_HEADERS)
}

// Pinned posts. Mastodon fetches this on every account discovery and refresh and shows
// what it finds at the top of the profile — the one way a note of ours reaches someone
// else's timeline, given we have no followers to deliver to.
async function featured(c: Context) {
  const actorUrl = getActorUrl()
  const pinned = await listPinnedNotes()
  return c.json({
    '@context': AS_CONTEXT,
    id: `${actorUrl}/featured`,
    type: 'OrderedCollection',
    totalItems: pinned.length,
    // Embedded rather than listed as bare URIs: both are legal, and embedding saves a
    // fetch per pinned note every time a remote server refreshes the profile.
    orderedItems: pinned.map(n => buildNoteObject(n)),
  }, 200, AP_HEADERS)
}

// Every collection answers under both the canonical /actor path and the Mastodon-style
// /users/<name> alias. Only the inbox had an alias before, so anything that composed
// collection URLs from the /users form — rather than reading them off the actor
// document — walked into a 404 and concluded the account had nothing.
for (const base of ['/actor', `/users/${config.APP_USERNAME}`]) {
  app.get(`${base}/followers`, followers)
  app.get(`${base}/following`, following)
  app.get(`${base}/featured`, featured)
  app.route(`${base}/outbox`, outboxRouter)
}

export { app as activityPubRouter }
