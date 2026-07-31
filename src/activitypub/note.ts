import type { InferSelectModel } from 'drizzle-orm'
import { config, getActorUrl } from '../config.js'
import { escapeHtml } from '../lib/html.js'
import type { localNotes } from '../db/schema.js'
import { AS_CONTEXT, PUBLIC_COLLECTION } from './vocab.js'
import { renderPage, renderIdentityHeader } from './page-chrome.js'
import { getProfilePageUrl } from './actor.js'

export type LocalNote = InferSelectModel<typeof localNotes>

/** Permalink of a note, in both senses: its ActivityPub `id` and its web address.
 *  Keeping them the same URL means a client that only has one can always reach the
 *  other through content negotiation. */
export function getNoteUrl(id: string): string {
  return `https://${config.APP_DOMAIN}/notes/${id}`
}

/**
 * The note as an ActivityStreams object.
 *
 * `@context` is only emitted when the note is served on its own; embedded in a
 * `Create` or in a collection the wrapper already carries it, and repeating it there
 * is noise a strict JSON-LD processor has to work around.
 */
export function buildNoteObject(note: LocalNote, opts: { context?: boolean } = {}) {
  const actorUrl = getActorUrl()
  const url = getNoteUrl(note.id)
  const published = note.publishedAt.toISOString()
  const updated = note.updatedAt.toISOString()

  return {
    ...(opts.context ? { '@context': AS_CONTEXT } : {}),
    id: url,
    type: 'Note',
    attributedTo: actorUrl,
    url,
    published,
    // Only when it actually differs — an `updated` equal to `published` makes clients
    // show an "edited" badge on a note nobody has ever edited.
    ...(updated !== published ? { updated } : {}),
    to: [PUBLIC_COLLECTION],
    cc: [`${actorUrl}/followers`],
    content: note.content,
    // Mastodon reads contentMap for the language badge and for per-language filtering.
    contentMap: { nn: note.content },
    sensitive: false,
    attachment: [],
    tag: [],
  }
}

/** The `Create` that wraps a note in the outbox. */
export function buildCreateActivity(note: LocalNote, opts: { context?: boolean } = {}) {
  const actorUrl = getActorUrl()
  return {
    ...(opts.context ? { '@context': AS_CONTEXT } : {}),
    // Distinct from the note's own id: implementations that key activities and objects
    // in one table will silently drop one of the two when the ids collide.
    id: `${getNoteUrl(note.id)}#create`,
    type: 'Create',
    actor: actorUrl,
    published: note.publishedAt.toISOString(),
    to: [PUBLIC_COLLECTION],
    cc: [`${actorUrl}/followers`],
    object: buildNoteObject(note),
  }
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('nn-NO', { day: 'numeric', month: 'long', year: 'numeric' })
}

/** One note as it appears on the profile list and on its own page. The body is HTML
 *  this service composed itself (see jobs/publish-status-note.ts), not user input. */
export function renderNoteCard(note: LocalNote): string {
  const url = getNoteUrl(note.id)
  const stamp = note.publishedAt.toISOString()
  const edited = note.updatedAt.getTime() > note.publishedAt.getTime()

  return `<article class="note">
    <div class="meta">
      ${note.pinned ? '<span class="pin">Festa</span>' : ''}
      <a href="${escapeHtml(url)}"><time datetime="${escapeHtml(stamp)}">${escapeHtml(formatDate(note.publishedAt))}</time></a>
      ${edited ? `<span>Endra ${escapeHtml(formatDate(note.updatedAt))}</span>` : ''}
    </div>
    ${note.content}
  </article>`
}

/** The permalink page for a single note, for anyone who follows the link in a browser. */
export function renderNotePage(note: LocalNote): string {
  const url = getNoteUrl(note.id)
  const summary = note.contentText.length > 160
    ? `${note.contentText.slice(0, 157)}…`
    : note.contentText

  return renderPage({
    title: `${config.APP_DISPLAY_NAME} — ${formatDate(note.publishedAt)}`,
    description: summary,
    canonical: url,
    alternate: url,
    body: `${renderIdentityHeader()}

  <h2>Innlegg</h2>
  ${renderNoteCard(note)}

  <footer>
    Dette er eitt av innlegga boten har publisert.
    <a href="${escapeHtml(getProfilePageUrl())}">Sjå heile profilen</a>.
  </footer>
</main>`,
  })
}
