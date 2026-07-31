import { Hono } from 'hono'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import { countNotes } from './notes-store.js'

const app = new Hono()

const SOFTWARE_NAME = 'activitypub-mcp'
const SOFTWARE_VERSION = '1.0.0'
const REPOSITORY = 'https://github.com/mmsge/activitypub-mcp'

/** One account, and it is this one. */
const USERS = { total: 1, activeMonth: 1, activeHalfyear: 1 }

/** Posts the bot has published. Crawlers hit NodeInfo unauthenticated and often, so a
 *  database blip answers 0 rather than a 500 — an undercount is better than looking
 *  like a dead host. */
async function localPosts(): Promise<number> {
  try {
    return await countNotes()
  } catch (e) {
    logger.error(e, 'Could not count local notes for NodeInfo')
    return 0
  }
}

function nodeinfoHeaders(version: string) {
  return {
    'Content-Type':
      `application/json; profile="http://nodeinfo.diaspora.software/ns/schema/${version}#"`,
    'Access-Control-Allow-Origin': '*',
  }
}

// The discovery document. This router is mounted at BOTH `/.well-known` and the root
// (see src/index.ts): every crawler and every "what software is that instance running?"
// lookup probes /.well-known/nodeinfo, and answering 404 there is why this host was
// invisible to the fediverse directories.
app.get('/nodeinfo', (c) => {
  return c.json({
    links: ['2.0', '2.1'].map(v => ({
      rel: `http://nodeinfo.diaspora.software/ns/schema/${v}`,
      href: `https://${config.APP_DOMAIN}/nodeinfo/${v}`,
    })),
  }, 200, { 'Access-Control-Allow-Origin': '*' })
})

/** Everything the two schema versions agree on. */
async function commonFields() {
  return {
    protocols: ['activitypub'],
    // Required by the schema even when empty: this host bridges no third-party
    // service in either direction.
    services: { inbound: [], outbound: [] },
    openRegistrations: false,
    usage: { users: USERS, localPosts: await localPosts() },
    metadata: {
      nodeName: config.APP_DISPLAY_NAME,
      nodeDescription:
        'Personleg ActivityPub-bot. Arkiverer offentlege innlegg frå eit fast sett' +
        ' kontoar og gjer arkivet søkbart gjennom MCP.',
    },
  }
}

app.get('/nodeinfo/2.0', async (c) => {
  return c.json({
    version: '2.0',
    software: { name: SOFTWARE_NAME, version: SOFTWARE_VERSION },
    ...await commonFields(),
  }, 200, nodeinfoHeaders('2.0'))
})

// 2.1 is 2.0 plus `software.repository`/`homepage`. Its own document rather than extra
// keys on 2.0, whose schema rejects them.
app.get('/nodeinfo/2.1', async (c) => {
  return c.json({
    version: '2.1',
    software: { name: SOFTWARE_NAME, version: SOFTWARE_VERSION, repository: REPOSITORY },
    ...await commonFields(),
  }, 200, nodeinfoHeaders('2.1'))
})

export { app as nodeinfoRouter }
