import { Hono } from 'hono'
import { config, getActorUrl } from '../config.js'
import { getProfilePageUrl } from './actor.js'
import { getAssetUrl } from './profile-assets.js'

const app = new Hono()

/** The `acct:` form, which is what we always answer with regardless of what was asked. */
function canonicalSubject(): string {
  return `acct:${config.APP_USERNAME}@${config.APP_DOMAIN}`
}

/** Every spelling of this actor a caller might legitimately ask about.
 *
 *  The spec only obliges us to answer the `acct:` form, but implementations in the wild
 *  ask with the bare handle or with one of the actor's URLs, and a 404 to those reads as
 *  "no such account" rather than "wrong spelling". */
function knownResources(): string[] {
  return [
    canonicalSubject(),
    `${config.APP_USERNAME}@${config.APP_DOMAIN}`,
    getActorUrl(),
    getProfilePageUrl(),
    `https://${config.APP_DOMAIN}/users/${config.APP_USERNAME}`,
  ]
}

/** Schemes and domains are case-insensitive, and so is our single username. */
function normalise(resource: string): string {
  return resource.trim().toLowerCase().replace(/\/+$/, '')
}

function matchesLocalActor(resource: string): boolean {
  const asked = normalise(resource)
  return knownResources().some(r => normalise(r) === asked)
}

app.get('/webfinger', (c) => {
  const resource = c.req.query('resource')
  if (!resource) return c.json({ error: 'Missing resource parameter' }, 400)

  if (!matchesLocalActor(resource)) {
    return c.json({ error: 'Unknown resource' }, 404)
  }

  const actorUrl = getActorUrl()
  const profilePageUrl = getProfilePageUrl()
  const links = [
    {
      rel: 'self',
      type: 'application/activity+json',
      href: actorUrl,
    },
    {
      // The readable page, not the actor URL — /actor only returns HTML to clients
      // that ask for it, so pointing here is the unambiguous browser destination.
      rel: 'http://webfinger.net/rel/profile-page',
      type: 'text/html',
      href: profilePageUrl,
    },
    {
      rel: 'http://webfinger.net/rel/avatar',
      type: 'image/png',
      href: getAssetUrl('avatar'),
    },
  ]

  // Callers may narrow the response to the rels they care about, and may repeat the
  // parameter (RFC 7033 §4.3). An unmatched rel yields an empty link list, not a 404 —
  // the subject still exists.
  const wanted = c.req.queries('rel')
  const filtered = wanted?.length ? links.filter(l => wanted.includes(l.rel)) : links

  return c.json({
    // Always the canonical acct: form, whichever spelling arrived. Several
    // implementations re-finger the subject they get back, and echoing a URL there
    // would send them straight round again.
    subject: canonicalSubject(),
    aliases: [actorUrl, profilePageUrl],
    links: filtered,
  }, 200, {
    'Content-Type': 'application/jrd+json; charset=utf-8',
    // WebFinger is read straight from the browser by client-side fediverse apps, which
    // the spec anticipates by requiring CORS on this endpoint.
    'Access-Control-Allow-Origin': '*',
  })
})

export { app as webfingerRouter }
