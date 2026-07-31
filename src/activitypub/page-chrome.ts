import { config } from '../config.js'
import { getAssetUrl } from './profile-assets.js'
import { escapeHtml } from '../lib/html.js'

/**
 * The shared shell for the bot's human-readable pages — the profile at /@<username>
 * and the permalink of each note it publishes.
 *
 * Self-contained by design: no external stylesheet, font or script, so the pages
 * render identically regardless of the viewer's network policy, and nothing about a
 * visitor leaks to a third party just for reading what the bot is.
 */
export function renderPage(opts: {
  title: string
  description: string
  /** Where this page canonically lives. */
  canonical: string
  /** The ActivityPub representation of the same resource. */
  alternate: string
  /** Everything inside <body>. */
  body: string
}): string {
  return `<!doctype html>
<html lang="nn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<meta name="description" content="${escapeHtml(opts.description)}">
<link rel="icon" type="image/png" href="${escapeHtml(getAssetUrl('avatar'))}">
<!-- How a fediverse server gets from this page back to the ActivityPub object.
     Searching the page URL on Mastodon fetches it and, finding HTML, looks for
     exactly this link to discover the ActivityPub representation. Without it the
     URL resolves to nothing and the account is unfindable by link. -->
<link rel="alternate" type="application/activity+json" href="${escapeHtml(opts.alternate)}">
<link rel="canonical" href="${escapeHtml(opts.canonical)}">
<style>
${styles()}
</style>
</head>
<body>
${opts.body}
</body>
</html>
`
}

/** The banner strip and overlapping avatar both pages open with. */
export function renderIdentityHeader(): string {
  const handle = `@${config.APP_USERNAME}@${config.APP_DOMAIN}`
  return `<div class="banner"></div>
<main>
  <header class="id">
    <img src="${escapeHtml(getAssetUrl('avatar'))}" alt="" width="104" height="104">
    <div class="who">
      <h1>${escapeHtml(config.APP_DISPLAY_NAME)}<span class="badge">bot</span></h1>
      <div class="handle">${escapeHtml(handle)}</div>
    </div>
  </header>`
}

function styles(): string {
  return `  :root {
    --green: #143521; --green-deep: #0f2a1a; --panel: #1c4a2d;
    --line: #2f5a3e; --lime: #9fe822; --cream: #f1ede2;
    --sub: #bcd2bb; --foot: #6f8c74;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--green); color: var(--cream);
    font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  /* Full width, anchored to the bottom, so the artwork's lime rule always lands
     exactly on the banner's bottom edge instead of being cropped to a stripe that
     floats through the middle. Heights are chosen so the scaled 3:1 image is never
     shorter than the banner (no gap) down to a 300px viewport. */
  .banner {
    height: 160px; background: var(--green) center bottom / 100% auto no-repeat
      url("${escapeHtml(getAssetUrl('header'))}");
  }
  main { max-width: 720px; margin: 0 auto; padding: 0 24px 72px; }
  /* Avatar overlaps the banner; the name sits fully below it, so the artwork's lime
     rule never runs through the title at any viewport width. */
  header.id { margin-top: -52px; }
  header.id img {
    width: 104px; height: 104px; border-radius: 20px; display: block;
    border: 4px solid var(--green); background: var(--green);
  }
  .who { margin-top: 16px; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 4px; letter-spacing: -0.01em; }
  .handle { color: var(--sub); font-size: 0.95rem; }
  .badge {
    display: inline-block; margin-left: 8px; padding: 2px 8px; border-radius: 999px;
    background: var(--lime); color: #10301d; font-size: 0.7rem; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase; vertical-align: 2px;
  }
  .lead { font-size: 1.1rem; color: var(--cream); margin: 28px 0 0; }
  h2 {
    font-size: 0.78rem; letter-spacing: 0.12em; text-transform: uppercase;
    color: #d6ecca; margin: 40px 0 0; padding-bottom: 8px;
  }
  h2::after {
    content: ""; display: block; width: 38px; height: 3px;
    background: var(--lime); border-radius: 2px; margin-top: 8px;
  }
  ul { list-style: none; padding: 0; margin: 18px 0 0; }
  li {
    position: relative; padding: 0 0 0 26px; margin-bottom: 14px; color: var(--sub);
  }
  li::before {
    content: ""; position: absolute; left: 4px; top: 0.62em;
    width: 8px; height: 8px; border-radius: 2px; background: var(--lime);
  }
  li strong { color: var(--cream); font-weight: 600; }
  .facts {
    margin: 18px 0 0; border: 1px solid var(--line); border-radius: 14px;
    background: var(--panel); overflow: hidden;
  }
  .facts div {
    display: flex; flex-wrap: wrap; gap: 4px 16px; justify-content: space-between;
    padding: 12px 18px; border-top: 1px solid var(--line);
  }
  .facts div:first-child { border-top: 0; }
  .facts dt, .facts dd { margin: 0; }
  .facts dt { color: var(--sub); font-size: 0.9rem; }
  .facts dd { font-variant-numeric: tabular-nums; }
  /* A published note, on the profile's list and on its own permalink page. */
  .note {
    margin: 18px 0 0; padding: 18px; border: 1px solid var(--line);
    border-radius: 14px; background: var(--panel);
  }
  .note p { margin: 0 0 12px; }
  .note p:last-child { margin-bottom: 0; }
  .note .meta {
    display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline;
    margin-bottom: 12px; color: var(--foot); font-size: 0.85rem;
  }
  .note .meta a { color: var(--sub); }
  .pin {
    color: var(--lime); font-weight: 600; letter-spacing: 0.04em;
    text-transform: uppercase; font-size: 0.7rem;
  }
  a { color: var(--lime); text-decoration-thickness: 1px; text-underline-offset: 2px; }
  a:hover { color: var(--cream); }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em;
    background: var(--green-deep); border: 1px solid var(--line);
    border-radius: 6px; padding: 1px 6px;
  }
  footer {
    margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--line);
    color: var(--foot); font-size: 0.9rem;
  }
  @media (max-width: 520px) {
    .banner { height: 100px; }
    h1 { font-size: 1.3rem; }
  }`
}
