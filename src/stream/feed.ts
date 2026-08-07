import { config } from '../config.js'
import { streamOrigin } from './host.js'
import { platformInfo } from './sources.js'
import { renderEmojis } from './emoji.js'
import type { Entry } from './entries.js'

/**
 * The stream as Atom.
 *
 * Atom rather than RSS for three reasons, but mainly the third:
 *
 *  1. Every entry needs a globally unique <id>, and a scrobble digest has no URL
 *     of its own — Atom lets it carry a synthetic tag: URI instead.
 *  2. <link rel="alternate"> is per-entry, so each one can point at its origin
 *     post rather than at a page here that does not exist.
 *  3. Atom separates <published> from <updated>, and the stream needs both.
 *
 * That third point solves a problem the site's own ordering creates. Entries are
 * ordered by when they *happened*, so a film marked today but watched in 2016
 * belongs in 2016 — correct on the page, useless in a feed, because every reader
 * sorts by <updated> and the entry would arrive already buried nine years deep.
 *
 * So: <published> is the event date, matching the website, and <updated> is when
 * the entry entered the archive. Feed entries are ordered by <updated>. Both are
 * true, and a subscriber sees a backdated mark the day it is added.
 */

const MAX_ENTRIES = 50

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * A stable, globally unique id per entry.
 *
 * tag: URIs (RFC 4151) rather than the origin URL: a scrobble digest has no URL,
 * and an entry's id must never change once a reader has seen it — using the origin
 * URL would break that the day a platform changes its permalink format.
 */
export function entryId(entry: Entry): string {
  const domain = config.STREAM_DOMAIN || 'meg.msge.no'
  const year = entry.eventAt.getUTCFullYear()
  return `tag:${domain},${year}:${entry.refId}`
}

/** A short plain-text title for an entry that has no title of its own. */
export function entryTitle(entry: Entry): string {
  const label = platformInfo(entry.source).label
  switch (entry.kind) {
    case 'book_started': return `Byrja å lesa ${entry.title ?? 'ei bok'}`
    case 'book_finished': return `Las ut ${entry.title ?? 'ei bok'}`
    case 'book_comment': return `Om ${entry.title ?? 'ei bok'}`
    case 'book_review': return `Melding: ${entry.title ?? 'ei bok'}`
    case 'book_quote': return `Sitat frå ${entry.title ?? 'ei bok'}`
    case 'screen': return `Såg ${entry.title ?? 'noko'}`
    case 'listen': return `Høyrde på ${entry.title ?? 'noko'}`
    case 'play': return `Spelte ${entry.title ?? 'noko'}`
    case 'read_neodb': return `Las ${entry.title ?? 'noko'}`
    case 'mark': return entry.title ?? 'Merka noko'
    case 'scrobble_day': return `${entry.playCount} spor den ${entry.day}`
    case 'trip': return `${entry.fromStation} → ${entry.toStation}`
    case 'garden': return entry.title
    default: {
      // A content warning applies to the title too. Deriving the title from the
      // post text would put the withheld body straight back into the feed, in the
      // one field every reader displays.
      if (entry.sensitive) return entry.contentWarning ?? `Innhaldsvarsel · ${label}`
      const text = entry.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
      if (!text) return `Innlegg på ${label}`
      return text.length > 90 ? `${text.slice(0, 87)}…` : text
    }
  }
}

/** The HTML body of an entry, for <content type="html">. */
function entryContent(entry: Entry): string {
  switch (entry.kind) {
    case 'post': case 'photo': case 'video':
      // A content warning is a request not to show the body unbidden. A feed has
      // no way to collapse anything, so the warning is all a subscriber gets.
      // Custom emoji are drawn with their origin URLs, not this site's proxy paths:
      // a subscriber's feed reader resolves a relative `/bilete/…` against its own
      // page and loads nothing. `toEmojis` has already restricted these to hosts we
      // are willing to point at.
      return entry.sensitive
        ? `<p><em>${esc(entry.contentWarning ?? 'Innhaldsvarsel')}</em></p>`
        : renderEmojis(entry.html, entry.emojis, (url) => url)
    // Every reading event, not just reviews and quotations: a start or a finish
    // made with a sentence attached carries that sentence now, and a subscriber
    // who got the title but not the words would be getting the worse half.
    case 'book_started': case 'book_finished': case 'book_comment':
    case 'book_review': case 'book_quote':
      return [
        entry.quote ? `<blockquote>${esc(entry.quote)}</blockquote>` : '',
        entry.html ?? '',
      ].join('')
    case 'garden':
      return entry.excerpt ? `<p>${esc(entry.excerpt)}</p>` : ''
    case 'screen': case 'listen': case 'play': case 'read_neodb': case 'mark':
      return entry.comment ? `<p>${esc(entry.comment)}</p>` : ''
    case 'scrobble_day':
      return `<p>${esc(entry.topArtists.map((a) => `${a.artist} (${a.plays})`).join(', '))}</p>`
    default:
      return ''
  }
}

export interface FeedOptions {
  title: string
  /** The page this feed mirrors. */
  alternate: string
  /** The feed's own URL. */
  self: string
}

export function renderAtom(entries: Entry[], opts: FeedOptions): string {
  // Ordered by when things entered the archive, NOT by when they happened — see
  // the note at the top. The website orders the other way, on purpose.
  const ordered = [...entries]
    .sort((a, b) => b.archivedAt.getTime() - a.archivedAt.getTime())
    .slice(0, MAX_ENTRIES)

  const updated = (ordered[0]?.archivedAt ?? new Date(0)).toISOString()
  const origin = streamOrigin()

  const items = ordered.map((e) => {
    const content = entryContent(e)
    return `  <entry>
    <title>${esc(entryTitle(e))}</title>
    <id>${esc(entryId(e))}</id>
    <published>${e.eventAt.toISOString()}</published>
    <updated>${e.archivedAt.toISOString()}</updated>
    <category term="${esc(e.source)}" label="${esc(platformInfo(e.source).label)}"/>
${e.originUrl ? `    <link rel="alternate" type="text/html" href="${esc(e.originUrl)}"/>\n` : ''}${
      content ? `    <content type="html">${esc(content)}</content>\n` : ''
    }  </entry>`
  }).join('\n')

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="nn">
  <title>${esc(opts.title)}</title>
  <id>${esc(origin)}/</id>
  <updated>${updated}</updated>
  <link rel="alternate" type="text/html" href="${esc(opts.alternate)}"/>
  <link rel="self" type="application/atom+xml" href="${esc(opts.self)}"/>
  <author><name>Markus</name><uri>${esc(origin)}</uri></author>
  <generator uri="https://${esc(config.APP_DOMAIN)}">activitypub-mcp</generator>
${items}
</feed>
`
}
