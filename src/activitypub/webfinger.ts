import { Hono } from 'hono'
import { config, getActorUrl } from '../config.js'

const app = new Hono()

app.get('/webfinger', (c) => {
  const resource = c.req.query('resource')
  if (!resource) return c.json({ error: 'Missing resource parameter' }, 400)

  const expected = `acct:${config.APP_USERNAME}@${config.APP_DOMAIN}`
  if (resource !== expected) {
    return c.json({ error: 'Unknown resource' }, 404)
  }

  const actorUrl = getActorUrl()
  return c.json({
    subject: resource,
    aliases: [actorUrl],
    links: [
      {
        rel: 'self',
        type: 'application/activity+json',
        href: actorUrl,
      },
      {
        rel: 'http://webfinger.net/rel/profile-page',
        type: 'text/html',
        href: actorUrl,
      },
    ],
  }, 200, {
    'Content-Type': 'application/jrd+json; charset=utf-8',
  })
})

export { app as webfingerRouter }
