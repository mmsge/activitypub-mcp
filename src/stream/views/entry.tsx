/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import { raw } from 'hono/html'
import { platformInfo } from '../sources.js'
import { proxyPath } from '../image-proxy.js'
import { renderEmojis } from '../emoji.js'
import { escapeHtml } from '../../lib/html.js'
import type { Emoji } from '../emoji.js'
import type {
  Attachment, Entry, PostEntry, BookEntry, MarkEntry, GigEntry,
  ScrobbleDayEntry, TripEntry, GardenEntry, UndatedGardenNote, PostTrip,
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

/**
 * Sanitised HTML with its `:vy:` shortcodes drawn as pictures.
 *
 * The one place this origin turns a federated post's text into extra markup, so
 * it goes through `imageSrc` like every other image on the page and through
 * `renderEmojis`, which will only substitute a shortcode the post declared. See
 * emoji.ts.
 */
function withEmojis(html: string, emojis: Emoji[]): string {
  return renderEmojis(html, emojis, imageSrc)
}

const Meta: FC<{ entry: Entry; verb: string; verbClass?: string }> = ({ entry, verb, verbClass }) => {
  const info = platformInfo(entry.source)
  return (
    <div class="meta">
      <span class="badge">{info.label}</span>
      {/* hono/jsx drops an attribute whose value is undefined, so every entry type
          that does not name a class renders exactly the span it always did. */}
      <span class={verbClass}>{verb}</span>
      <time datetime={entry.eventAt.toISOString()}>{formatDate(entry.eventAt)}</time>
      {entry.originUrl ? (
        <a class="out" href={entry.originUrl} rel="noopener nofollow" target="_blank">
          Les på {info.linkLabel} ↗
        </a>
      ) : null}
    </div>
  )
}

/** `0:16`, `7:04`, `1:02:03` — as long as it needs to be and no longer. */
function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/**
 * One video: its poster if the origin sent one, a text chip if it did not.
 *
 * Never an `<img>` pointed at the video file. That is what this used to do — the
 * comment said "poster" while the code passed the attachment URL — and since almost
 * every attachment here is an .mp4 or a .webm, every Rullen card drew a row of
 * broken-image icons. A browser handed a video in an `<img>` has nothing to fall back
 * on, so the honest thing when there is no poster is to say so in text.
 */
const VideoAttachment: FC<{ a: Attachment }> = ({ a }) => {
  const label = a.durationSeconds ? `Sjå video · ${formatDuration(a.durationSeconds)}` : 'Sjå video'
  return (
    <a class={a.posterUrl ? 'poster' : 'poster chip'} href={a.url} rel="noopener nofollow" target="_blank">
      {a.posterUrl ? (
        <img src={imageSrc(a.posterUrl)} alt={a.alt ?? ''} loading="lazy" referrerpolicy="no-referrer"
          width={a.width ?? undefined} height={a.height ?? undefined} />
      ) : (
        <span>{label}</span>
      )}
      {a.posterUrl && a.durationSeconds ? (
        <span class="dur">{formatDuration(a.durationSeconds)}</span>
      ) : null}
    </a>
  )
}

/** Media, served through this origin's image proxy where it can be — see imageSrc. */
const Media: FC<{ attachments: Attachment[] }> = ({ attachments }) => {
  if (attachments.length === 0) return null
  const shown = attachments.slice(0, 4)
  return (
    <div class={shown.length > 1 ? 'media two' : 'media'}>
      {shown.map((a) => {
        if (a.mediaType?.startsWith('video/')) return <VideoAttachment a={a} />
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
 * A post with an embeddable player: its poster, and the player itself on request.
 *
 * The iframe lives inside a closed `<details>` and carries `loading="lazy"`, so
 * nothing is fetched from the origin until the reader opens it. That is the whole
 * point of the arrangement. This page fetches no fonts, no scripts and — since ADR
 * 0021 — no images from anyone else; an embed that loaded on sight would quietly
 * undo that for every reader who never pressed play. Opening it is a choice, and the
 * summary says what the choice costs.
 *
 * No JavaScript, because the page has none and one embed is not worth starting.
 */
const Embed: FC<{ entry: PostEntry }> = ({ entry }) => {
  const clips = entry.attachments.length
  const seconds = entry.attachments.reduce((n, a) => n + (a.durationSeconds ?? 0), 0)
  const poster = entry.attachments.find((a) => a.posterUrl)?.posterUrl
  const facts = [
    clips > 0 ? `${clips} ${clips === 1 ? 'snutt' : 'snuttar'}` : null,
    seconds > 0 ? formatDuration(seconds) : null,
  ].filter(Boolean).join(' · ')

  return (
    <details class="embed">
      <summary>
        {poster ? (
          <img src={imageSrc(poster)} alt="" loading="lazy" referrerpolicy="no-referrer" />
        ) : null}
        <span class="play">{facts ? `Spel av · ${facts}` : 'Spel av'}</span>
      </summary>
      <iframe src={`${entry.embedUrl}?autoplay=0`} loading="lazy" title={`Spelar frå ${platformInfo(entry.source).label}`}
        allow="fullscreen" referrerpolicy="no-referrer" />
    </details>
  )
}

/**
 * The body, collapsed behind its warning when one is set. Markus set that warning
 * deliberately; a public page that ignores it is worse than one that never had it.
 */
const Body: FC<{ html: string; warning: string | null; lang?: string | null; emojis?: Emoji[] }> = (
  { html, warning, lang, emojis },
) => {
  const inner = <div class="body" lang={lang ?? undefined}>{raw(html)}</div>
  if (!warning) return inner
  // A warning is plain text out of `objects.summary`, so it is escaped here before
  // any emoji are drawn into it — JSX escapes what it interpolates, `raw` does not.
  // Callers with no emoji (every book card) keep the plain interpolation they had.
  const label = emojis?.length
    ? raw(withEmojis(escapeHtml(warning), emojis))
    : warning
  return (
    <details class="cw">
      <summary>{label}</summary>
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

/** How a post relates to the train it was written on, in Markus' own language. */
const ABOARD_LABEL: Record<PostTrip['relation'], string> = {
  boarding: 'På perrongen før',
  aboard: 'Om bord',
  alighting: 'Nett komen fram',
}

/**
 * The train a post was written on.
 *
 * Never presented as part of what the post said — the post carries no station or
 * operator; this was worked out from when it was published (ADR 0023). Hence its
 * own line, its own class, and a label that says what the relation was.
 *
 * `brief` keeps the relation and drops the leg, for the journey page's chapters:
 * there the heading already names the train, so the full line would repeat it under
 * every post — but whether he was on the platform or already moving is still
 * something only the post can say.
 */
const Aboard: FC<{ trip: PostTrip | null; brief?: boolean }> = ({ trip, brief }) => {
  if (!trip) return null
  if (brief) {
    return (
      <p class="aboard">
        <span class="aboard-label">{ABOARD_LABEL[trip.relation]}</span>
      </p>
    )
  }
  const facts = [
    trip.operator,
    trip.distanceKm ? `${trip.distanceKm} km` : null,
    trip.night ? 'nattog' : null,
  ].filter(Boolean)
  return (
    <p class="aboard">
      <span class="aboard-label">{ABOARD_LABEL[trip.relation]}</span>
      {' '}
      <span class="aboard-leg">{trip.fromStation} → {trip.toStation}</span>
      {facts.length > 0 ? <span class="aboard-facts"> · {facts.join(' · ')}</span> : null}
      {trip.journey && trip.journeySlug
        ? <> · <a href={`/reise/${trip.journeySlug}`}>{trip.journey}</a></>
        : null}
    </p>
  )
}

const Post: FC<{ entry: PostEntry; briefTrip?: boolean }> = ({ entry, briefTrip }) => (
  <article class="entry" id={`e-${entry.refId}`}>
    <Meta entry={entry} verb={entry.kind === 'video' ? 'la ut ein video' : entry.kind === 'photo' ? 'la ut eit bilete' : 'skreiv'} />
    <Body html={withEmojis(entry.html, entry.emojis)}
      warning={entry.sensitive ? entry.contentWarning ?? 'Innhaldsvarsel' : null}
      lang={entry.language} emojis={entry.emojis} />
    {entry.sensitive ? null : entry.embedUrl
      ? <Embed entry={entry} />
      : <Media attachments={entry.attachments} />}
    {entry.thread.map((part) => (
      <div class="thread">
        <div class="body">{raw(withEmojis(part.html, part.emojis))}</div>
        {/* Gated like the root. Without this a content-warned post kept its warning
            over the body and showed the thread's media underneath it regardless. */}
        {entry.sensitive ? null : <Media attachments={part.attachments} />}
      </div>
    ))}
    <Aboard trip={entry.trip} brief={briefTrip} />
    <Tags tags={entry.hashtags} />
  </article>
)

/** What the event was, in Markus' own words. Not translated, not reworded. */
const BOOK_VERB: Record<BookEntry['kind'], string> = {
  book_started: 'byrja å lesa',
  book_finished: 'lesen ut',
  book_comment: 'kommentar',
  book_review: 'melding',
  book_quote: 'sitat',
}

/** The chip's shape per kind. Never `chip` — that class is the source tab strip. */
const BOOK_CHIP: Record<BookEntry['kind'], string> = {
  book_started: 'bookchip start',
  book_finished: 'bookchip finish',
  book_comment: 'bookchip said',
  book_review: 'bookchip review',
  book_quote: 'bookchip quote',
}

/**
 * A reading event, in five shapes.
 *
 * The chip names the event, but a card has to be recognisable with the chip's words
 * masked — so the shapes differ in what leads, how large the cover is and how much
 * of the catalogue is shown, not only in colour:
 *
 *   byrja å lesa /   the milestones: full cover, the whole facts line. Unchanged
 *   lesen ut         from what the stream has always drawn, except that a shelf
 *                    flip made with a sentence now has that sentence under it.
 *   kommentar        what he wrote leads; the book shrinks to a thumbnail and a
 *                    title, because the book is the context and not the news.
 *   sitat            the passage is the card, framed, in the page's own serif.
 *   melding          the widest: his heading, the review, then a mark saying the
 *                    book was finished — which is the only place that gets said.
 */
const Book: FC<{ entry: BookEntry }> = ({ entry }) => {
  const slim = entry.kind === 'book_comment' || entry.kind === 'book_quote'
  const heading = [entry.title ?? 'Ukjend bok', entry.subtitle].filter(Boolean).join(' — ')
  const facts = [
    entry.pubYear ? String(entry.pubYear) : null,
    entry.pages ? `${entry.pages} sider` : null,
    entry.series,
  ].filter(Boolean)
  const position = entry.progress == null
    ? null
    : entry.progressMode === 'PCT' ? `${entry.progress} %` : `side ${entry.progress}`

  return (
    <article class={`entry ${entry.kind}`} id={`e-${entry.refId}`}>
      <Meta entry={entry} verb={BOOK_VERB[entry.kind]} verbClass={BOOK_CHIP[entry.kind]} />

      {/* A remark is about the book, so it comes before it. */}
      {entry.kind === 'book_comment' && entry.html ? (
        <div class="said"><Body html={entry.html} warning={entry.contentWarning} /></div>
      ) : null}

      {entry.quote ? (
        <figure class="quote-frame"><blockquote>{entry.quote}</blockquote></figure>
      ) : null}

      <div class={slim ? 'card slim' : 'card'}>
        {entry.coverUrl ? (
          <img class="cover" src={imageSrc(entry.coverUrl)} alt="" loading="lazy" referrerpolicy="no-referrer" />
        ) : null}
        <div class="about">
          <h3>{heading}</h3>
          {!slim && entry.author ? <p class="by">{entry.author}</p> : null}
          {!slim ? (
            <p class="facts">
              <Stars rating={entry.rating} />
              {facts.map((f, i) => <>{i > 0 || entry.rating != null ? ' · ' : ''}{f}</>)}
            </p>
          ) : null}
          {slim && position ? <p class="facts">{position}</p> : null}
        </div>
      </div>

      {entry.reviewTitle ? <h3 class="review-title">{entry.reviewTitle}</h3> : null}

      {entry.kind !== 'book_comment' && entry.html ? (
        <Body html={entry.html} warning={entry.contentWarning} />
      ) : null}

      {/* A review, or a quotation or remark posted off the "read" shelf, is a finish
          BookWyrm never announced with a note of its own — so this card is the only
          one that can say it happened. Not on a finish card: the chip there already
          carries the same date, and printing it twice reads as two finishes. */}
      {entry.kind !== 'book_finished' && entry.finishedAt ? (
        <p class="finished-mark">Lesen ut {formatDate(entry.finishedAt)}</p>
      ) : null}
    </article>
  )
}

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

/**
 * The verb the card leads with.
 *
 * 'attended' is the overwhelming majority and reads as the plain past tense. A gig only
 * planned says so, because a timeline that renders "var på" for a concert that has not
 * happened is simply wrong. A gig whose state nothing on the wire recorded gets the
 * neutral verb rather than a guess.
 */
function gigVerb(status: string | null): string {
  if (status === 'attended') return 'var på'
  if (status === 'going') return 'skal på'
  return 'var på ein konsert'
}

const Gig: FC<{ entry: GigEntry }> = ({ entry }) => {
  const who = entry.artists.length > 0 ? entry.artists.join(', ') : entry.title
  const where = [entry.venue, entry.city].filter(Boolean).join(', ')
  return (
    <article class="entry" id={`e-${entry.refId}`}>
      <Meta entry={entry} verb={gigVerb(entry.status)} />
      <div class="about">
        <h3>
          {entry.concertUrl ? (
            <a href={entry.concertUrl} rel="noreferrer noopener">{who ?? 'Ein konsert'}</a>
          ) : (who ?? 'Ein konsert')}
        </h3>
        <p class="facts">
          {[
            where || null,
            entry.festivalName,
            entry.tourName,
          ].filter(Boolean).map((f, i) => <>{i > 0 ? ' · ' : ''}{f}</>)}
        </p>
      </div>
      {/* The write-up, verbatim. */}
      {entry.review ? <p class="note">{entry.review}</p> : null}
      {entry.photos.length > 0 ? (
        <div class="photos">
          {entry.photos.map((p) => (
            <img src={imageSrc(p.url)} alt={p.altText ?? ''} loading="lazy" referrerpolicy="no-referrer" />
          ))}
        </div>
      ) : null}
      {/* A setlist is a list to go and read; the card shows the opening and links on. */}
      {entry.setlistPreview.length > 0 ? (
        <p class="facts">
          {entry.setlistPreview.join(' · ')}
          {entry.songCount && entry.songCount > entry.setlistPreview.length
            ? <> · <span style="opacity:.6">og {entry.songCount - entry.setlistPreview.length} til</span></>
            : null}
        </p>
      ) : null}
    </article>
  )
}

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
          // Not measured on the platform — a reanalysis of that day at that place.
          // Omitted entirely when unknown, rather than shown as a blank.
          entry.weather,
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

/**
 * One entry, whatever kind it is.
 *
 * `briefTrip` is the journey page's: see Aboard. Every other view leaves it off and
 * gets the full travel line.
 */
export const EntryView: FC<{ entry: Entry; briefTrip?: boolean }> = ({ entry, briefTrip }) => {
  switch (entry.kind) {
    case 'post':
    case 'photo':
    case 'video':
      return <Post entry={entry} briefTrip={briefTrip} />
    case 'book_started':
    case 'book_finished':
    case 'book_comment':
    case 'book_review':
    case 'book_quote':
      return <Book entry={entry} />
    case 'screen':
    case 'listen':
    case 'play':
    case 'read_neodb':
    case 'mark':
      return <Mark entry={entry} />
    case 'gig':
      return <Gig entry={entry} />
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
