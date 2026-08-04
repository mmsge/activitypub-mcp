/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import { raw } from 'hono/html'
import { platformInfo } from '../sources.js'
import { proxyPath } from '../image-proxy.js'
import type {
  Attachment, Entry, PostEntry, BookEntry, MarkEntry,
  ScrobbleDayEntry, TripEntry, GardenEntry, UndatedGardenNote,
} from '../entries.js'

/**
 * One rendered entry, dispatched on `kind`.
 *
 * These views do no filtering. Everything that reaches them is already
 * publishable, already sanitised, already free of hidden and deleted rows — a view
 * that had to remember a privacy rule would eventually forget one.
 *
 * The only thing the views must get right themselves is the content warning: if
 * Markus set one, the body renders collapsed. It uses <details>, so it works with
 * no JavaScript at all.
 */

const DATE_FMT = new Intl.DateTimeFormat('nn-NO', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Oslo',
})

function formatDate(at: Date): string {
  return DATE_FMT.format(at)
}

/**
 * Where an image is actually loaded from.
 *
 * Through this origin when the proxy is on, straight from the origin CDN when it is
 * off (`STREAM_IMAGE_CACHE_MB=0`) or when the host is not one we proxy. Falling
 * back to the original URL rather than dropping the image: a picture from a host
 * nobody anticipated is still a picture Markus posted.
 *
 * Every view goes through this. A view that used `a.url` directly would reintroduce
 * a hotlink that the CSP then blocks, and the only symptom would be a missing image.
 */
function imageSrc(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  return proxyPath(url) ?? url
}

const Meta: FC<{ entry: Entry; verb: string }> = ({ entry, verb }) => {
  const info = platformInfo(entry.source)
  return (
    <div class="meta">
      <span class="badge">{info.label}</span>
      <span>{verb}</span>
      <time datetime={entry.eventAt.toISOString()}>{formatDate(entry.eventAt)}</time>
      {entry.originUrl ? (
        <a class="out" href={entry.originUrl} rel="noopener nofollow" target="_blank">
          Les på {info.linkLabel} ↗
        </a>
      ) : null}
    </div>
  )
}

/** Media, served through this origin's image proxy where it can be — see imageSrc. */
const Media: FC<{ attachments: Attachment[] }> = ({ attachments }) => {
  if (attachments.length === 0) return null
  const shown = attachments.slice(0, 4)
  return (
    <div class={shown.length > 1 ? 'media two' : 'media'}>
      {shown.map((a) => {
        const isVideo = a.mediaType?.startsWith('video/')
        if (isVideo) {
          // Poster and a link out, never an inline player: an embedded remote
          // video is a heavier third-party load than an image, and proxying video
          // on two vCPUs is not viable.
          return (
            <a class="poster" href={a.url} rel="noopener nofollow" target="_blank">
              <img src={imageSrc(a.url)} alt={a.alt ?? ''} loading="lazy" referrerpolicy="no-referrer"
                width={a.width ?? undefined} height={a.height ?? undefined} />
            </a>
          )
        }
        return (
          <figure>
            <img src={imageSrc(a.url)} alt={a.alt ?? ''} loading="lazy" referrerpolicy="no-referrer"
              width={a.width ?? undefined} height={a.height ?? undefined} />
            {a.alt ? <figcaption>{a.alt}</figcaption> : null}
          </figure>
        )
      })}
    </div>
  )
}

/**
 * The body, collapsed behind its warning when one is set. Markus set that warning
 * deliberately; a public page that ignores it is worse than one that never had it.
 */
const Body: FC<{ html: string; warning: string | null; lang?: string | null }> = ({ html, warning, lang }) => {
  const inner = <div class="body" lang={lang ?? undefined}>{raw(html)}</div>
  if (!warning) return inner
  return (
    <details class="cw">
      <summary>{warning}</summary>
      {inner}
    </details>
  )
}

const Stars: FC<{ rating: number | null }> = ({ rating }) => {
  if (rating == null) return null
  const full = Math.round(rating)
  return (
    <span class="stars" title={`${rating} av 5`} aria-label={`${rating} av 5`}>
      {'★'.repeat(full)}{'☆'.repeat(Math.max(0, 5 - full))}
    </span>
  )
}

const Tags: FC<{ tags: string[] }> = ({ tags }) => {
  if (tags.length === 0) return null
  return (
    <p class="tags">
      {tags.slice(0, 6).map((t) => <a href={`/emne/${encodeURIComponent(t.toLowerCase())}`}>#{t}</a>)}
    </p>
  )
}

const Post: FC<{ entry: PostEntry }> = ({ entry }) => (
  <article class="entry" id={`e-${entry.refId}`}>
    <Meta entry={entry} verb={entry.kind === 'video' ? 'la ut ein video' : entry.kind === 'photo' ? 'la ut eit bilete' : 'skreiv'} />
    <Body html={entry.html} warning={entry.sensitive ? entry.contentWarning ?? 'Innhaldsvarsel' : null} lang={entry.language} />
    {entry.sensitive ? null : <Media attachments={entry.attachments} />}
    {entry.thread.map((part) => (
      <div class="thread">
        <div class="body">{raw(part.html)}</div>
        <Media attachments={part.attachments} />
      </div>
    ))}
    <Tags tags={entry.hashtags} />
  </article>
)

const BOOK_VERB: Record<BookEntry['kind'], string> = {
  book_started: 'byrja å lesa',
  book_finished: 'las ut',
  book_review: 'melde',
  book_quote: 'siterte frå',
}

const Book: FC<{ entry: BookEntry }> = ({ entry }) => (
  <article class="entry" id={`e-${entry.refId}`}>
    <Meta entry={entry} verb={BOOK_VERB[entry.kind]} />
    <div class="card">
      {entry.coverUrl ? (
        <img class="cover" src={imageSrc(entry.coverUrl)} alt="" loading="lazy" referrerpolicy="no-referrer" />
      ) : null}
      <div class="about">
        <h3>{entry.title ?? 'Ukjend bok'}</h3>
        {entry.author ? <p class="by">{entry.author}</p> : null}
        <p class="facts">
          <Stars rating={entry.rating} />
          {[
            entry.pubYear ? String(entry.pubYear) : null,
            entry.pages ? `${entry.pages} sider` : null,
            entry.series,
          ].filter(Boolean).map((f, i) => <>{i > 0 || entry.rating != null ? ' · ' : ''}{f}</>)}
        </p>
      </div>
    </div>
    {entry.quote ? <p class="quote">{entry.quote}</p> : null}
    {entry.reviewTitle ? <h4 class="note">{entry.reviewTitle}</h4> : null}
    {entry.html ? (
      <Body html={entry.html} warning={entry.contentWarning} />
    ) : null}
  </article>
)

const MARK_VERB: Record<MarkEntry['kind'], string> = {
  screen: 'såg',
  listen: 'høyrde på',
  play: 'spelte',
  read_neodb: 'las',
  mark: 'merka',
}

const Mark: FC<{ entry: MarkEntry }> = ({ entry }) => (
  <article class="entry" id={`e-${entry.refId}`}>
    <Meta entry={entry} verb={MARK_VERB[entry.kind]} />
    <div class="card">
      {entry.coverUrl ? (
        <img class="cover" src={imageSrc(entry.coverUrl)} alt="" loading="lazy" referrerpolicy="no-referrer" />
      ) : null}
      <div class="about">
        <h3>{entry.title ?? 'Ukjend'}</h3>
        <p class="facts">
          <Stars rating={entry.rating} />
          {[
            entry.year ? String(entry.year) : null,
            entry.director,
            entry.genre.join(', ') || null,
          ].filter(Boolean).map((f, i) => <>{i > 0 || entry.rating != null ? ' · ' : ''}{f}</>)}
        </p>
      </div>
    </div>
    {/* Markus' own note, verbatim — it records things the catalogue cannot know. */}
    {entry.comment ? <p class="note">{entry.comment}</p> : null}
  </article>
)

const ScrobbleDay: FC<{ entry: ScrobbleDayEntry }> = ({ entry }) => (
  <article class="entry" id={`e-${entry.refId}`}>
    <Meta entry={entry} verb={`høyrde på ${entry.playCount} spor`} />
    <div class="artists">
      {entry.topArtists.map((a) => <span>{a.artist} · {a.plays}</span>)}
    </div>
    <details class="tracks">
      <summary>Sjå alle {entry.tracks.length} spora</summary>
      <ol>
        {entry.tracks.map((t) => (
          <li>{t.artist} — {t.track}{t.album ? <> <span style="opacity:.6">({t.album})</span></> : null}</li>
        ))}
      </ol>
    </details>
  </article>
)

const Trip: FC<{ entry: TripEntry }> = ({ entry }) => (
  <article class="entry" id={`e-${entry.refId}`}>
    <Meta entry={entry} verb="reiste" />
    <div class="about">
      <h3>{entry.fromStation} → {entry.toStation}</h3>
      <p class="facts">
        {[
          entry.journey,
          entry.operator,
          entry.distanceKm ? `${entry.distanceKm} km` : null,
          entry.night ? 'nattog' : null,
        ].filter(Boolean).map((f, i) => <>{i > 0 ? ' · ' : ''}{f}</>)}
      </p>
    </div>
  </article>
)

const Garden: FC<{ entry: GardenEntry }> = ({ entry }) => (
  <article class="entry" id={`e-${entry.refId}`}>
    <Meta entry={entry} verb="skreiv i hagen" />
    <div class="about">
      <h3>
        <a href={entry.originUrl ?? '#'} rel="noopener" target="_blank">{entry.title}</a>
      </h3>
      {entry.excerpt ? <p>{entry.excerpt}</p> : null}
      {/* The note carries no date of its own; this one comes from the reading. Say
          so, rather than let a worked-out date read as something the note claims. */}
      {entry.dateSource === 'bookwyrm' ? (
        <p class="derived">Notatet har ingen eigen dato — denne er henta frå lesinga av boka.</p>
      ) : null}
    </div>
    <Tags tags={entry.tags} />
  </article>
)

/**
 * The notes with no date anywhere, listed rather than placed.
 *
 * Shown only at the foot of /kjelde/hage. They cannot be in the stream — the
 * keyset needs every entry dated — but leaving them off the site entirely would
 * hide a third of the garden, so they get their names and their links.
 */
export const UndatedGarden: FC<{ notes: UndatedGardenNote[] }> = ({ notes }) => {
  if (notes.length === 0) return null
  return (
    <section class="undated">
      <h2>Utan dato</h2>
      <p>
        {notes.length} notat har ingen dato — korkje sin eigen, eller ein å hente frå
        lesinga. Dei har difor ingen plass i straumen, men dei står her.
      </p>
      <ul>
        {notes.map((n) => (
          <li>
            <a href={n.url} rel="noopener" target="_blank">{n.title}</a>
          </li>
        ))}
      </ul>
    </section>
  )
}

export const EntryView: FC<{ entry: Entry }> = ({ entry }) => {
  switch (entry.kind) {
    case 'post':
    case 'photo':
    case 'video':
      return <Post entry={entry} />
    case 'book_started':
    case 'book_finished':
    case 'book_review':
    case 'book_quote':
      return <Book entry={entry} />
    case 'screen':
    case 'listen':
    case 'play':
    case 'read_neodb':
    case 'mark':
      return <Mark entry={entry} />
    case 'scrobble_day':
      return <ScrobbleDay entry={entry} />
    case 'trip':
      return <Trip entry={entry} />
    case 'garden':
      return <Garden entry={entry} />
  }
}

export const StreamList: FC<{ entries: Entry[]; nextHref: string | null }> = ({ entries, nextHref }) => {
  if (entries.length === 0) {
    return <p class="empty">Ingenting her enno.</p>
  }
  return (
    <>
      {entries.map((e) => <EntryView entry={e} />)}
      {nextHref ? (
        <p class="more"><a href={nextHref} rel="next">Vis meir</a></p>
      ) : null}
    </>
  )
}
