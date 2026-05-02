import { Hono } from 'hono'
import { config } from '../config.js'

const app = new Hono()

app.get('/nodeinfo', (c) => {
  return c.json({
    links: [
      {
        rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
        href: `https://${config.APP_DOMAIN}/nodeinfo/2.0`,
      },
    ],
  })
})

app.get('/nodeinfo/2.0', (c) => {
  return c.json({
    version: '2.0',
    software: { name: 'activitypub-mcp', version: '1.0.0' },
    protocols: ['activitypub'],
    usage: { users: { total: 1 }, localPosts: 0 },
    openRegistrations: false,
  })
})

export { app as nodeinfoRouter }
