import { Hono } from 'hono'
import { getActorUrl } from '../config.js'
import { AP_HEADERS } from '../lib/content-type.js'
import { AS_CONTEXT } from './vocab.js'
import { buildCreateActivity } from './note.js'
import { countNotes, listNotes } from './notes-store.js'

/**
 * The actor's outbox: the notes this bot wrote, and nothing else.
 *
 * It used to serve the `activities` table — which is the *inbox* archive — so every
 * public fetch republished the followed accounts' activities as if this actor had
 * authored them. Reading `local_notes` is the whole fix: the archive is private and
 * stays that way, and the outbox only ever says what the bot itself said.
 */

const PAGE_SIZE = 20

const app = new Hono()

app.get('/', async (c) => {
  const outboxUrl = `${getActorUrl()}/outbox`
  const total = await countNotes()
  const rawPage = c.req.query('page')

  // Without ?page this URL is the collection itself, not a page of it. Mastodon and the
  // fediverse crawlers read totalItems here and only follow `first` if they want the
  // contents; answering with a bare OrderedCollectionPage left them with no item count.
  if (rawPage === undefined) {
    const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE))
    return c.json({
      '@context': AS_CONTEXT,
      id: outboxUrl,
      type: 'OrderedCollection',
      totalItems: total,
      first: `${outboxUrl}?page=1`,
      last: `${outboxUrl}?page=${lastPage}`,
    }, 200, AP_HEADERS)
  }

  const page = Math.max(1, Math.floor(Number(rawPage)) || 1)
  const notes = await listNotes(PAGE_SIZE, (page - 1) * PAGE_SIZE)

  return c.json({
    '@context': AS_CONTEXT,
    id: `${outboxUrl}?page=${page}`,
    type: 'OrderedCollectionPage',
    partOf: outboxUrl,
    totalItems: total,
    orderedItems: notes.map(n => buildCreateActivity(n)),
    ...(page * PAGE_SIZE < total ? { next: `${outboxUrl}?page=${page + 1}` } : {}),
    ...(page > 1 ? { prev: `${outboxUrl}?page=${page - 1}` } : {}),
  }, 200, AP_HEADERS)
})

export { app as outboxRouter }
