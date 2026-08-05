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
.media figure { margin: 0; }
.media figcaption { font-size: .78rem; color: var(--muted); margin-top: .3rem; }
.poster { position: relative; display: block; }
.poster::after {
  content: "▶"; position: absolute; inset: 0; display: grid; place-items: center;
  font-size: 2rem; color: #fff; text-shadow: 0 1px 6px rgba(0,0,0,.6);
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
.leg-when { color: var(--muted); font-variant-numeric: tabular-nums; }
.leg-route { font-weight: 600; }
.leg-fact { color: var(--muted); }
.journey .back { margin-top: 2.5rem; }

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
  .media.two { grid-template-columns: 1fr; }
}
`

export { html }
