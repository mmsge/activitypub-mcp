import { Hono } from 'hono'
import { config } from '../config.js'
import { escapeHtml } from '../lib/html.js'

const app = new Hono()

/**
 * The discovery hop that predates WebFinger.
 *
 * Friendica, GNU Social and a handful of WebFinger clients fetch host-meta first to
 * learn where a domain's WebFinger endpoint lives, and give up on the account when it
 * 404s — even though our /.well-known/webfinger sits exactly where they would have
 * guessed. Two representations because both are asked for in practice.
 */

/** `{uri}` is a placeholder the *caller* substitutes, so it must survive un-encoded. */
function lrddTemplate(): string {
  return `https://${config.APP_DOMAIN}/.well-known/webfinger?resource={uri}`
}

const CORS = { 'Access-Control-Allow-Origin': '*' }

app.get('/host-meta', (c) => {
  return c.body(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">\n' +
    `  <Link rel="lrdd" type="application/jrd+json" template="${escapeHtml(lrddTemplate())}"/>\n` +
    '</XRD>\n',
    200,
    { 'Content-Type': 'application/xrd+xml; charset=utf-8', ...CORS },
  )
})

app.get('/host-meta.json', (c) => {
  return c.json({
    links: [{ rel: 'lrdd', type: 'application/jrd+json', template: lrddTemplate() }],
  }, 200, { 'Content-Type': 'application/jrd+json; charset=utf-8', ...CORS })
})

export { app as hostMetaRouter }
