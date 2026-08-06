/** @jsxImportSource hono/jsx */
import type { FC, PropsWithChildren } from 'hono/jsx'
import { html, raw } from 'hono/html'
import { config } from '../../config.js'
import { streamOrigin } from '../host.js'
import { platformInfo, AP_PLATFORMS, LOCAL_PLATFORMS, type Platform } from '../sources.js'
import { parseSources } from '../sources.js'

/**
 * The shell for meg.msge.no.
 *
 * Self-contained, exactly as src/activitypub/page-chrome.ts is: no external
 * stylesheet, font or script. On the bot's pages that was about not leaking a
 * reader to a third party, and it holds here too — images now come through this
 * origin's proxy rather than from seven CDNs (see image-proxy.ts). The colophon
 * states whichever is actually true, rather than asserting the flattering one:
 * with `STREAM_IMAGE_CACHE_MB=0` the page is back to hotlinking and says so.
 *
 * Its own look, deliberately unlike the bot's deep green: this is Markus' front
 * door, not infrastructure. Warm paper, terracotta accent, rounded cards.
 */

export interface LayoutProps {
  title: string
  description: string
  canonical: string
  /** Rendered into <head> — OG tags, JSON-LD. */
  headExtra?: string
  /** Shown above the stream on the front page only. */
  showIntro?: boolean
  activePlatform?: Platform | null
}

const SITE_NAME = 'Meg'

export const Layout: FC<PropsWithChildren<LayoutProps>> = (props) => {
  const origin = streamOrigin()
  return (
    <html lang="nn">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <meta name="description" content={props.description} />
        <link rel="canonical" href={props.canonical} />
        <link
          rel="alternate"
          type="application/atom+xml"
          title={`${SITE_NAME} — straumen`}
          href={`${origin}/feed.atom`}
        />
        <link rel="icon" href={`${origin}/ikon.png`} />
        {props.headExtra ? raw(props.headExtra) : null}
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <main>
          {props.showIntro ? <Intro /> : <CompactHeader />}
          <FilterBar active={props.activePlatform ?? null} />
          {props.children}
          <Colophon />
        </main>
      </body>
    </html>
  )
}

const Intro: FC = () => (
  <header class="intro">
    <img class="avatar" src={`${streamOrigin()}/ikon.png`} alt="" width="88" height="88" />
    <h1>{SITE_NAME}</h1>
    <p class="lead">
      Eg heiter Markus. Dette er alt eg legg ut, samla på éin stad — det eg skriv,
      les, ser og høyrer på, i den rekkjefølgja det faktisk skjedde.
    </p>
    <FollowLinks />
  </header>
)

const CompactHeader: FC = () => (
  <header class="compact">
    <a class="home" href="/">
      <img src={`${streamOrigin()}/ikon.png`} alt="" width="36" height="36" />
      <span>{SITE_NAME}</span>
    </a>
  </header>
)

/**
 * Where to follow Markus properly. The point of a page like this is that people
 * can leave it for the real accounts — meg.msge.no is not itself followable.
 */
const FollowLinks: FC = () => {
  let sources: Array<{ handle: string; platform: Platform }> = []
  try {
    sources = parseSources(config.STREAM_SOURCES)
  } catch {
    sources = []
  }
  if (sources.length === 0) return null
  return (
    <p class="follow">
      Følg meg der eg faktisk er:{' '}
      {sources.map((s, i) => {
        const [, user, domain] = /^@([^@]+)@(.+)$/.exec(s.handle) ?? []
        const url = user && domain ? `https://${domain}/@${user}` : '#'
        return (
          <>
            {i > 0 ? <span class="sep"> · </span> : null}
            <a href={url} rel="me noopener" title={s.handle}>
              {platformInfo(s.platform).label}
            </a>
          </>
        )
      })}
    </p>
  )
}

const FilterBar: FC<{ active: Platform | null }> = ({ active }) => (
  <nav class="filters" aria-label="Kjelder">
    <a class={active === null ? 'chip on' : 'chip'} href="/">Alt</a>
    {[...AP_PLATFORMS, ...LOCAL_PLATFORMS].map((p) => (
      <a class={active === p ? 'chip on' : 'chip'} href={`/kjelde/${p}`}>
        {platformInfo(p).label}
      </a>
    ))}
    {/* Not a source, so never `on` — the journeys are a grouping of the trips
        rather than another place things come from. */}
    <a class="chip" href="/reise">Reiser</a>
  </nav>
)

const Colophon: FC = () => (
  <footer>
    <p>
      Alt her er henta frå mine eigne kontoar, og berre innlegg som alt var
      offentlege der dei vart lagde ut. Ingen svar til andre, ingen framhevingar,
      ingenting om andre folk.
    </p>
    <p class="fine">
      {config.STREAM_IMAGE_CACHE_MB > 0 ? (
        <>
          Sida hentar ikkje skrifter, skript eller bilete frå andre. Bilete og
          omslag går gjennom denne tenaren, så nettlesaren din treng ikkje kontakta
          tenestene dei kom frå.
        </>
      ) : (
        <>
          Sida hentar ikkje skrifter eller skript frå andre. Bilete og omslag ligg
          framleis hjå tenestene dei kom frå, så nettlesaren din hentar dei derifrå.
        </>
      )}
      {' '}
      {/* The one exception, and it must be stated. The claim above is what ADR 0021
          was written to make true; an embedded player is a third-party load, so the
          colophon has to say that opening one is what triggers it. */}
      Opnar du ein videospelar i eit innlegg, hentar nettlesaren din han frå
      tenesta han ligg på — men ikkje før du trykkjer.
      {' '}
      <a href={`${streamOrigin()}/feed.atom`}>Atom-straum</a>
      {' · '}
      <a href={`https://${config.APP_DOMAIN}/@${config.APP_USERNAME}`}>Om roboten bak</a>
    </p>
  </footer>
)

// Written as one string rather than assembled, so what ships is what you read.
const CSS = `
:root {
  --paper: #faf6ef; --ink: #231f1c; --muted: #6f665d; --line: #e6ddcd;
  --card: #fffdfa; --accent: #c2542a; --accent-soft: #f7e8e0; --shadow: rgba(60,40,20,.05);
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #191614; --ink: #f0e9df; --muted: #a89c8e; --line: #332d27;
    --card: #211d1a; --accent: #e8834f; --accent-soft: #33231b; --shadow: rgba(0,0,0,.3);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--paper); color: var(--ink);
  font: 17px/1.6 ui-serif, Georgia, "Iowan Old Style", "Palatino Linotype", serif;
  -webkit-text-size-adjust: 100%;
}
main { max-width: 44rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
a { color: var(--accent); text-underline-offset: 2px; text-decoration-thickness: 1px; }
a:hover { color: var(--ink); }

.intro { text-align: center; margin-bottom: 2.5rem; }
.avatar { border-radius: 50%; display: block; margin: 0 auto 1rem; }
.intro h1 {
  font-size: 2.1rem; margin: 0 0 .6rem; letter-spacing: -.02em; font-weight: 600;
}
.lead { font-size: 1.08rem; margin: 0 auto 1rem; max-width: 32rem; color: var(--ink); }
.follow { font-size: .93rem; color: var(--muted); margin: 0; }
.follow .sep { color: var(--line); }

.compact { margin-bottom: 1.75rem; }
.compact .home {
  display: inline-flex; align-items: center; gap: .55rem;
  font-weight: 600; text-decoration: none; color: var(--ink);
}
.compact .home img { border-radius: 50%; }

.filters {
  display: flex; flex-wrap: wrap; gap: .4rem; margin: 0 0 2rem;
  padding-bottom: 1.25rem; border-bottom: 1px solid var(--line);
}
.chip {
  font-family: ui-sans-serif, system-ui, sans-serif; font-size: .8rem;
  padding: .3rem .7rem; border: 1px solid var(--line); border-radius: 999px;
  text-decoration: none; color: var(--muted); background: var(--card);
}
.chip:hover { border-color: var(--accent); color: var(--accent); }
.chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }

.entry {
  background: var(--card); border: 1px solid var(--line); border-radius: 14px;
  padding: 1.15rem 1.25rem; margin-bottom: 1rem; box-shadow: 0 1px 2px var(--shadow);
}
.entry > :last-child { margin-bottom: 0; }
.meta {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: .5rem;
  font-family: ui-sans-serif, system-ui, sans-serif; font-size: .78rem;
  color: var(--muted); margin-bottom: .7rem;
}
.badge {
  padding: .12rem .5rem; border-radius: 999px; background: var(--accent-soft);
  color: var(--accent); font-weight: 600; letter-spacing: .02em;
}
.meta time { font-variant-numeric: tabular-nums; }
.meta .out { margin-left: auto; text-decoration: none; }

.body p { margin: 0 0 .75rem; }
.body p:last-child { margin-bottom: 0; }
.body blockquote {
  margin: .75rem 0; padding-left: .9rem; border-left: 3px solid var(--line);
  color: var(--muted); font-style: italic;
}
.body code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em;
  background: var(--accent-soft); border-radius: 5px; padding: .08em .35em;
}
.body pre { overflow-x: auto; background: var(--accent-soft); padding: .8rem; border-radius: 8px; }
.body pre code { background: none; padding: 0; }

.cw { margin: 0; }
.cw > summary {
  cursor: pointer; font-family: ui-sans-serif, system-ui, sans-serif; font-size: .87rem;
  color: var(--muted); padding: .5rem .75rem; background: var(--accent-soft);
  border-radius: 8px; list-style: none;
}
.cw > summary::-webkit-details-marker { display: none; }
.cw > summary::before { content: "⚠ "; }
.cw > summary::after { content: " — trykk for å visa"; opacity: .7; }
.cw[open] > summary::after { content: " — trykk for å gøyma"; }
.cw > div { margin-top: .8rem; }

.thread { margin-top: .8rem; padding-top: .8rem; border-top: 1px dashed var(--line); }
.thread + .thread { margin-top: .5rem; }

.media { display: grid; gap: .5rem; margin: .8rem 0 0; }
.media.two { grid-template-columns: 1fr 1fr; }
.media img, .media video { width: 100%; height: auto; border-radius: 10px; display: block; }
/* Same cap as the embed poster: a portrait video still would otherwise be a
   screenful on its own. Photos are left alone — they are the point of a photo post. */
.poster img { max-height: 24rem; object-fit: cover; }
.media figure { margin: 0; }
.media figcaption { font-size: .78rem; color: var(--muted); margin-top: .3rem; }
.poster { position: relative; display: block; }
.poster::after {
  content: "▶"; position: absolute; inset: 0; display: grid; place-items: center;
  font-size: 2rem; color: #fff; text-shadow: 0 1px 6px rgba(0,0,0,.6);
}
/* A video the origin sent no poster for. Says what it is in words rather than
   leaving a browser to render a video file as a broken image. */
.poster.chip {
  display: flex; align-items: center; gap: .4rem; padding: .5rem .8rem .5rem 2.2rem;
  background: var(--accent-soft); border-radius: 8px; text-decoration: none;
  font-family: ui-sans-serif, system-ui, sans-serif; font-size: .85rem;
}
.poster.chip::after {
  inset: auto auto auto .8rem; top: 50%; transform: translateY(-50%);
  font-size: 1rem; color: var(--accent); text-shadow: none;
}
.poster .dur {
  position: absolute; right: .4rem; bottom: .4rem; z-index: 1;
  font-family: ui-sans-serif, system-ui, sans-serif; font-size: .72rem;
  background: rgba(0,0,0,.65); color: #fff; border-radius: 5px; padding: .1rem .35rem;
}

/* The origin's own player, loaded only when the reader opens it — see Embed. */
.embed { margin: .8rem 0 0; }
.embed > summary {
  cursor: pointer; position: relative; display: block; list-style: none;
  border-radius: 10px; overflow: hidden; background: var(--accent-soft);
  /* Never collapse. The label is positioned over the poster, so a poster that
     fails to load would otherwise leave a zero-height summary — no play control at
     all, and no way to reach the video. A dead image must cost the picture, not
     the control. */
  min-height: 2.75rem;
}
.embed > summary::-webkit-details-marker { display: none; }
/* Rullen's clips are 720×1280 portrait, and a poster at that ratio across the full
   card width fills a whole screen with one entry. Cap it and crop. */
.embed > summary > img {
  width: 100%; height: auto; max-height: 24rem; object-fit: cover; display: block;
}
.embed > summary .play {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 1.6rem .7rem .5rem;
  font-family: ui-sans-serif, system-ui, sans-serif; font-size: .82rem; color: #fff;
  background: linear-gradient(to bottom, transparent, rgba(0,0,0,.72));
}
/* No poster came through: the summary is the label, so it needs its own padding
   and a colour that works against the page rather than against an image. */
.embed > summary:not(:has(img)) .play {
  position: static; padding: .55rem .8rem; color: var(--ink); background: none;
}
.embed > summary::before {
  content: "▶"; position: absolute; inset: 0; display: grid; place-items: center;
  font-size: 2rem; color: #fff; text-shadow: 0 1px 6px rgba(0,0,0,.6);
}
.embed > summary:not(:has(img))::before { content: none; }
/* Open: the poster gives way to the player rather than sitting on top of it, and
   the summary shrinks to the bar that closes it again. */
.embed[open] > summary { border-radius: 10px 10px 0 0; min-height: 0; }
.embed[open] > summary > img { display: none; }
.embed[open] > summary::before { content: none; }
.embed[open] > summary .play {
  position: static; padding: .5rem .8rem; color: var(--muted); background: none;
}
.embed[open] > summary .play::after { content: " — trykk for å lukka"; opacity: .8; }
.embed > iframe {
  width: 100%; aspect-ratio: 9 / 16; max-height: 34rem; border: 0; display: block;
  border-radius: 0 0 10px 10px; background: #000;
}

.card { display: flex; gap: 1rem; align-items: flex-start; }
.card .cover {
  flex: 0 0 82px; width: 82px; border-radius: 6px; display: block;
  box-shadow: 0 1px 4px var(--shadow); background: var(--accent-soft);
}
.card .about { flex: 1 1 auto; min-width: 0; }
.card h3 { margin: 0 0 .2rem; font-size: 1.05rem; font-weight: 600; line-height: 1.3; }
.card .by { color: var(--muted); font-size: .92rem; margin: 0 0 .35rem; }
.card .facts {
  font-family: ui-sans-serif, system-ui, sans-serif; font-size: .78rem;
  color: var(--muted); margin: 0;
}
.stars { color: var(--accent); letter-spacing: .08em; }
.note { margin: .7rem 0 0; font-style: italic; color: var(--ink); }
.quote {
  margin: .7rem 0 0; padding-left: .9rem; border-left: 3px solid var(--accent);
  font-style: italic;
}

/* ---- Reading cards -------------------------------------------------------
   Five kinds of BookWyrm event. The chip names each one, but a card has to be
   tellable apart with the chip's words masked — so the cover size, the order the
   body comes in and how much of the catalogue is shown carry the difference too,
   not the colour alone. */

/* The event's own chip, in the meta line. Deliberately not the .chip class: that
   one is the source tab strip at the top of the page, and sharing it would tie the
   two together forever. */
.bookchip { padding: .12rem .55rem; border-radius: 999px; font-weight: 600; }
.bookchip.start { background: var(--accent-soft); color: var(--accent); }
/* The only solid one. A finish is the event with an end to it, and it should read
   as heavier than the start it closes. --paper rather than #fff, so it stays
   legible when the page is dark. */
.bookchip.finish { background: var(--accent); color: var(--paper); }
.bookchip.review { background: var(--ink); color: var(--paper); }
.bookchip.quote { border: 1px solid var(--accent); color: var(--accent); }
.bookchip.said { border: 1px solid var(--line); color: var(--muted); }

/* Chatter: his words first, the book after them and small. */
.said { margin: 0 0 .85rem; }
.card.slim { gap: .7rem; align-items: center; }
.card.slim .cover { flex: 0 0 44px; width: 44px; border-radius: 4px; }
.card.slim h3 { font-size: .95rem; margin: 0; font-weight: 600; }

/* A quotation: the passage is the card. Serif, because the page is, and framed so
   it does not read as another paragraph of his own. */
.quote-frame {
  margin: 0 0 .85rem; padding: .9rem 1rem .9rem 1.1rem;
  background: var(--accent-soft); border-left: 3px solid var(--accent);
  border-radius: 0 10px 10px 0;
}
.quote-frame blockquote {
  margin: 0; font-size: 1.06rem; line-height: 1.55; font-style: italic; color: var(--ink);
}
.book_quote .card.slim { padding-top: .6rem; border-top: 1px solid var(--line); }

/* A review: the widest of them, and the only one with a heading he wrote. */
.entry.book_review { margin-left: -.75rem; margin-right: -.75rem; }
.book_review .card .cover { flex: 0 0 96px; width: 96px; }
.review-title { margin: .95rem 0 .35rem; font-size: 1.12rem; font-weight: 600; line-height: 1.3; }
.finished-mark {
  margin: .7rem 0 0; font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: .78rem; color: var(--muted);
}
.finished-mark::before { content: "\\2713 "; color: var(--accent); }

/* A finish closes something; give it an edge the start does not have. */
.entry.book_finished { box-shadow: inset 3px 0 0 var(--accent), 0 1px 2px var(--shadow); }

.tracks { margin: .7rem 0 0; }
.tracks > summary {
  cursor: pointer; font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: .82rem; color: var(--muted);
}
.tracks ol { margin: .6rem 0 0; padding-left: 1.4rem; font-size: .9rem; }
.tracks li { margin-bottom: .2rem; }
.artists { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .6rem; }
.artists span {
  font-family: ui-sans-serif, system-ui, sans-serif; font-size: .8rem;
  background: var(--accent-soft); border-radius: 999px; padding: .2rem .6rem;
}

.tags { margin: .7rem 0 0; font-size: .82rem; }
.tags a { margin-right: .5rem; text-decoration: none; }

.more { text-align: center; margin: 2rem 0 0; }
.more a {
  display: inline-block; padding: .6rem 1.5rem; border: 1px solid var(--accent);
  border-radius: 999px; text-decoration: none; font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: .9rem;
}
.more a:hover { background: var(--accent); color: #fff; }

.empty { text-align: center; color: var(--muted); padding: 3rem 0; }

/* A date we worked out rather than one the note claims — see the garden lane. */
.derived { font-size: .85rem; color: var(--muted); font-style: italic; margin-top: .4rem; }

/* The train a post was written on. Derived, not part of what the post said, so it
   reads as a quiet aside rather than as body text — see ADR 0023. */
.aboard {
  margin: .7rem 0 0; font-size: .82rem; color: var(--muted);
  font-family: ui-sans-serif, system-ui, sans-serif;
}
.aboard-label {
  background: var(--accent-soft); border-radius: 999px; padding: .15rem .55rem;
  color: var(--fg);
}
.aboard-leg { white-space: nowrap; }

/* The journey pages: /reise and /reise/<slug>. */
.journeys .lede, .journey .when { color: var(--muted); }
.journey-list { list-style: none; padding: 0; margin: 2rem 0 0; }
.journey-list > li {
  padding: 1rem 0; border-top: 1px solid var(--line);
}
.journey-list h2 { margin: 0 0 .2rem; font-size: 1.15rem; }
.journey-list h2 a { text-decoration: none; }
.journey .when { margin: .2rem 0; }
.journey .operators { color: var(--muted); font-size: .85rem; }
.legs { margin: 0 0 2rem; padding-left: 1.2rem; }
.legs li { margin: .35rem 0; font-size: .9rem; }
.legs a { text-decoration: none; }
.legs a:hover .leg-route { text-decoration: underline; }
.leg-when { color: var(--muted); font-variant-numeric: tabular-nums; }
.leg-route { font-weight: 600; }
.leg-fact { color: var(--muted); }
.journey .back { margin-top: 2.5rem; }

/* Each leg is a chapter, in departure order: the one page on the site that reads
   forwards, so scrolling it follows the journey from start to end. */
.chapter { margin: 2.5rem 0 0; scroll-margin-top: 1rem; }
.chapter-head {
  display: flex; align-items: baseline; gap: .6rem;
  margin: 0; padding-top: 1.2rem; border-top: 2px solid var(--line);
  font-size: 1.15rem;
}
.chapter-no {
  flex: none; color: var(--muted); font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: .8rem; font-variant-numeric: tabular-nums;
}
.chapter-when {
  margin: .25rem 0 1.2rem calc(.6rem + 1ch);
  font-size: .85rem; font-family: ui-sans-serif, system-ui, sans-serif;
}
.chapter-empty { color: var(--muted); font-size: .9rem; font-style: italic; margin: 0; }

/* The garden notes with no date anywhere: listed at the foot of /kjelde/hage. */
.undated {
  margin-top: 3.5rem; padding-top: 1.5rem; border-top: 1px solid var(--line);
}
.undated h2 { font-size: 1.1rem; margin: 0 0 .4rem; }
.undated > p { color: var(--muted); font-size: .9rem; margin: 0 0 1rem; }
.undated ul {
  list-style: none; padding: 0; margin: 0;
  columns: 2; column-gap: 2rem;
}
.undated li { break-inside: avoid; margin: 0 0 .35rem; font-size: .92rem; }
@media (max-width: 34rem) { .undated ul { columns: 1; } }

footer {
  margin-top: 3.5rem; padding-top: 1.5rem; border-top: 1px solid var(--line);
  font-family: ui-sans-serif, system-ui, sans-serif; font-size: .85rem; color: var(--muted);
}
footer p { margin: 0 0 .6rem; }
footer .fine { font-size: .8rem; opacity: .85; }

@media (max-width: 34rem) {
  body { font-size: 16px; }
  main { padding: 1.5rem 1rem 3rem; }
  .intro h1 { font-size: 1.7rem; }
  .card { gap: .8rem; }
  .card .cover { flex-basis: 64px; width: 64px; }
  .book_review .card .cover { flex-basis: 72px; width: 72px; }
  .card.slim .cover { flex-basis: 36px; width: 36px; }
  /* No room to be the widest card on a phone — the page is already edge to edge. */
  .entry.book_review { margin-left: 0; margin-right: 0; }
  .media.two { grid-template-columns: 1fr; }
}
`

export { html }
