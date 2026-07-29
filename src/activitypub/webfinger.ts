import { Hono } from 'hono'
import { config, getActorUrl } from '../config.js'
import { getProfilePageUrl } from './actor.js'
import { getAssetUrl } from './profile-assets.js'

const app = new Hono()

app.get('/webfinger', (c) => {
  const resource = c.req.query('resource')
  if (!resource) return c.json({ error: 'Missing resource parameter' }, 400)

  const expected = `acct:${config.APP_USERNAME}@${config.APP_DOMAIN}`
  if (resource !== expected) {
    return c.json({ error: 'Unknown resource' }, 404)
  }

  const actorUrl = getActorUrl()
  const profilePageUrl = getProfilePageUrl()
  return c.json({
    subject: resource,
    aliases: [actorUrl, profilePageUrl],
    links: [
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
    ],
  }, 200, {
    'Content-Type': 'application/jrd+json; charset=utf-8',
  })
})

export { app as webfingerRouter }
