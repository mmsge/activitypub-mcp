/** @jsxImportSource hono/jsx */
import type { FC, PropsWithChildren } from 'hono/jsx'
import { CATEGORIES } from '../categories.js'

// The admin shell from the mobile redesign (ADR 0073): a 56 px header, one scrolling
// content column, and a four-item bottom bar that becomes a left rail at 900 px.
//
// Everything is server-rendered. The only script is the one that opens the Meir sheet,
// and the sheet is a native <dialog>, so closing it (backdrop, Esc, a link) needs none.

export type NavItem = 'oversikt' | 'import' | 'loggar'

export interface LayoutProps {
  title?: string
  /** Which bottom-bar item is active. Category and detail pages count as Oversikt. */
  nav?: NavItem
  /** A back link shown before the title, e.g. `‹ Oversikt`. */
  back?: { href: string; label: string }
  /** The green "Live" pill on the right of the header (Loggar). */
  live?: boolean
}

const NAV: Array<[NavItem, string, string]> = [
  ['oversikt', 'Oversikt', '/admin'],
  ['import', 'Import', '/admin/import'],
  ['loggar', 'Loggar', '/admin/logs'],
]

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({
  title,
  nav = 'oversikt',
  back,
  live,
  children,
}) => {
  return (
    <html lang="nn">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
        <meta name="theme-color" content="#14121f" />
        <title>{title ? `${title} · AP Admin` : 'AP Admin'}</title>
        <FontLinks />
        <script src="https://unpkg.com/htmx.org@2.0.4" defer></script>
        <style dangerouslySetInnerHTML={{ __html: TOKENS + SHELL_CSS + CONTENT_CSS }} />
      </head>
      <body>
        <header class="topbar">
          {back && <a class="back" href={back.href}>‹ {back.label}</a>}
          <div class="title">{title ?? 'AP Admin'}</div>
          {live && <span class="live"><span class="live-dot" />Live</span>}
        </header>
        <main class="content">{children}</main>
        <nav class="bar" aria-label="Hovudmeny">
          {NAV.map(([id, label, href]) => (
            <a href={href} class={id === nav ? 'active' : ''} aria-current={id === nav ? 'page' : undefined}>
              <span>{label}</span>
            </a>
          ))}
          <button type="button" class="meir" onclick="document.getElementById('meir').showModal()">
            <span>Meir</span>
          </button>
          {/* On desktop the bar is a rail and Meir's contents sit under it directly. */}
          <div class="rail-more">
            <div class="label">Kategoriar</div>
            {CATEGORIES.map((c) => <a href={c.href}>{c.label}</a>)}
            <a href="/admin/logout" class="logout">Logg ut</a>
          </div>
        </nav>
        <dialog id="meir" class="sheet" aria-label="Meir" onclick="if(event.target===this)this.close()">
          <div class="sheet-body">
            <div class="grab" />
            <div class="sheet-grid">
              {CATEGORIES.map((c) => <a href={c.href}>{c.label}</a>)}
            </div>
            <a href="/admin/logout" class="sheet-logout">Logg ut</a>
          </div>
        </dialog>
      </body>
    </html>
  )
}

export const FontLinks: FC = () => (
  <>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
    <link
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
    />
  </>
)

/**
 * The ⓘ toggle. Explanatory text is hidden by default and opens inline, with no script:
 * a visually hidden checkbox, a <label> for it as the 44 px button, and a panel that
 * shows while it is checked. The three must be siblings in that order inside one
 * container (the button may sit deeper, inside a row): the panel is found with `~`.
 *
 * Not <details>: its summary and panel are one element, so the button cannot sit at
 * the end of a row while the panel opens under the whole row, which is the design.
 */
export const HelpInput: FC<{ id: string }> = ({ id }) => (
  <input type="checkbox" class="hx-toggle" id={id} />
)

export const HelpButton: FC<{ for: string; label?: string }> = ({ for: id, label = 'Forklaring' }) => (
  <label class="hx-btn" for={id} aria-label={label} title={label}>
    <span class="help-i">i</span>
  </label>
)

export const HelpPanel: FC<PropsWithChildren> = ({ children }) => (
  <div class="hx-panel">{children}</div>
)

export const TOKENS = `
:root {
  --bg: #14121f; --surface: #1e1b2e; --input: #191628; --panel: #2a2640; --code: #100e1a;
  --line: #2f2b45; --line-strong: #3d3858; --divider: #2a2640;
  --ink: #eeeaff; --ink-2: #d6d1ee; --muted: #a39fbd; --dim: #77729a;
  --accent: #8b7cff; --accent-ink: #b7adff; --on-accent: #120f22; --accent-tint: #2c2652;
  --red: #ff9a9a; --red-bg: #3d1f2c; --yellow: #f2cc6b; --yellow-bg: #3a3120;
  --green: #7fe0a8; --green-bg: #183a2e; --blue: #9cc8ff; --blue-bg: #1c2c4a;
  --grey: #cfcae6; --grey-bg: #2f2b45;
  --sans: 'IBM Plex Sans', system-ui, sans-serif;
  --mono: 'IBM Plex Mono', ui-monospace, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { -webkit-text-size-adjust: 100%; }
body { font-family: var(--sans); font-size: 15px; line-height: 1.4; background: var(--bg); color: var(--ink); }
a { color: var(--accent-ink); text-decoration: none; }
a:hover { color: #d2cbff; text-decoration: underline; }
button, input, select, textarea { font-family: inherit; }
.mono, code, pre { font-family: var(--mono); }
.num, .tabular { font-variant-numeric: tabular-nums; }
`

const SHELL_CSS = `
.topbar { position: sticky; top: 0; z-index: 20; height: 56px; display: flex; align-items: center; gap: 4px;
  padding: 0 8px 0 16px; background: var(--bg); border-bottom: 1px solid var(--divider); }
.topbar .back { height: 44px; display: flex; align-items: center; margin-left: -8px; padding: 0 8px;
  font-size: 15px; font-weight: 500; white-space: nowrap; }
.topbar .title { flex: 1; min-width: 0; font-size: 19px; font-weight: 600; letter-spacing: -0.01em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.topbar .live { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; margin-right: 6px;
  border-radius: 14px; background: var(--green-bg); color: var(--green); font-size: 12px; font-weight: 600; }
.topbar .live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); }

.content { padding: 16px 16px 104px; }

.bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; height: calc(76px + env(safe-area-inset-bottom));
  padding-bottom: calc(12px + env(safe-area-inset-bottom)); display: grid; grid-template-columns: repeat(4, 1fr);
  background: var(--input); border-top: 1px solid var(--line); }
.bar > a, .bar > button { position: relative; display: flex; align-items: center; justify-content: center;
  background: none; border: none; cursor: pointer; color: var(--muted); font-size: 13px; font-weight: 600; }
.bar > a:hover, .bar > button:hover { text-decoration: none; color: var(--ink-2); filter: none; }
.bar > a.active { color: var(--accent-ink); }
.bar > a.active::before { content: ''; position: absolute; top: 0; left: 28%; right: 28%; height: 3px;
  border-radius: 0 0 3px 3px; background: var(--accent); }
.bar > button { height: 100%; min-height: 0; padding: 0; border-radius: 0; }
.bar .rail-more { display: none; }

.sheet { position: fixed; inset: auto 0 0 0; width: 100%; max-width: 100%; max-height: 78vh; margin: 0;
  border: none; border-top: 1px solid var(--line-strong); border-radius: 22px 22px 0 0;
  background: var(--surface); color: var(--ink); padding: 0; }
.sheet::backdrop { background: rgba(8, 6, 16, 0.65); }
.sheet-body { padding: 8px 8px calc(24px + env(safe-area-inset-bottom)); }
.sheet .grab { width: 40px; height: 4px; border-radius: 2px; background: #4a4470; margin: 2px auto 10px; }
.sheet-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.sheet-grid a { height: 56px; display: flex; align-items: center; padding: 0 14px; border-radius: 12px;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink); font-size: 15px; font-weight: 500; }
.sheet-grid a:hover { text-decoration: none; border-color: var(--line-strong); }
.sheet-logout { display: flex; align-items: center; justify-content: center; width: 100%; height: 52px; margin-top: 10px;
  border-radius: 12px; background: #2e1a26; color: var(--red); font-size: 15px; font-weight: 600; }
.sheet-logout:hover { text-decoration: none; color: var(--red); }

@media (min-width: 900px) {
  body { padding-left: 220px; }
  .topbar, .content { max-width: 640px; margin: 0 auto; }
  .topbar { border-bottom: none; }
  .content { padding-bottom: 48px; }
  .bar { top: 0; right: auto; bottom: 0; width: 220px; height: auto; padding: 16px 12px;
    display: flex; flex-direction: column; gap: 2px; border-top: none; border-right: 1px solid var(--line); overflow-y: auto; }
  .bar > a { justify-content: flex-start; height: 44px; padding: 0 12px; border-radius: 10px; font-size: 15px; }
  .bar > a.active { background: var(--accent-tint); }
  .bar > a.active::before { top: 10px; bottom: 10px; left: 0; right: auto; width: 3px; height: auto; border-radius: 0 3px 3px 0; }
  .bar > button.meir { display: none; }
  .bar .rail-more { display: flex; flex-direction: column; gap: 2px; margin-top: 18px; }
  .bar .rail-more .label { padding: 0 12px 6px; font-size: 13px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--muted); }
  .bar .rail-more a { display: flex; align-items: center; height: 40px; padding: 0 12px; border-radius: 10px;
    color: var(--ink-2); font-size: 15px; }
  .bar .rail-more a:hover { background: var(--panel); text-decoration: none; }
  .bar .rail-more a.logout { margin-top: 12px; color: var(--red); }
}
`

/**
 * Building blocks for the redesigned screens, plus a restyle of the classes the older
 * pages still use (tables, .card, .badge…) so they sit in the new shell until their own
 * phase rebuilds them.
 */
const CONTENT_CSS = `
.stack { display: flex; flex-direction: column; gap: 24px; }
.group { display: flex; flex-direction: column; gap: 10px; }
.section-label { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.count-pill { min-width: 22px; height: 22px; padding: 0 6px; border-radius: 11px; display: inline-flex;
  align-items: center; justify-content: center; background: var(--red-bg); color: var(--red);
  font-size: 12px; font-weight: 700; letter-spacing: 0; }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
.dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.dot.red { background: var(--red); } .dot.yellow { background: var(--yellow); } .dot.green { background: var(--green); }

.problem { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 6px 6px 6px 14px; }
.problem-head { display: flex; align-items: center; gap: 12px; min-height: 44px; }
.problem-text { flex: 1; min-width: 0; }
.problem-title { font-size: 15px; font-weight: 600; }
.problem-sub { font-size: 13px; color: var(--muted); }
.problem .hx-panel { margin: 4px 8px 8px 0; }
.problem-act { padding: 2px 8px 8px 22px; }
.all-clear { display: flex; align-items: center; gap: 12px; padding: 14px; border-radius: 14px; background: var(--green-bg); }
.all-clear div { font-size: 15px; font-weight: 600; color: #e6f8ee; }

.btn-soft { display: inline-flex; align-items: center; height: 40px; padding: 0 14px; border-radius: 10px;
  background: var(--panel); border: 1px solid var(--line-strong); color: var(--accent-ink); font-size: 14px; font-weight: 600; cursor: pointer; }
.btn-soft:hover { text-decoration: none; border-color: #4a4470; }

.tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.tile { min-height: 76px; display: flex; flex-direction: column; justify-content: space-between; gap: 6px;
  padding: 12px 14px; border-radius: 14px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); }
a.tile:hover { text-decoration: none; border-color: var(--line-strong); color: var(--ink); }
.tile-name { font-size: 16px; font-weight: 600; }
.tile-key { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
.stat { padding: 12px 14px; border-radius: 14px; border: 1px solid var(--line); background: var(--surface); }
.stat-n { font-size: 30px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.stat-l { font-size: 13px; color: var(--muted); }

.row { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 10px 14px; border-bottom: 1px solid var(--divider); }
.row-main { flex: 1; min-width: 0; }
.row-title { font-size: 14px; font-weight: 500; }
.row-sub { font-family: var(--mono); font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.panel-more { display: flex; align-items: center; height: 48px; padding: 0 14px; font-size: 14px; font-weight: 600; }
.panel-empty { padding: 16px 14px; font-size: 14px; color: var(--muted); }

.hx-toggle { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.hx-btn { width: 44px; height: 44px; flex: none; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.help-i { width: 22px; height: 22px; border-radius: 50%; border: 1.5px solid var(--dim); color: var(--dim);
  font-size: 13px; font-weight: 700; font-style: italic; display: flex; align-items: center; justify-content: center; }
.hx-toggle:checked ~ * .help-i, .hx-toggle:checked + .hx-btn .help-i { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.hx-toggle:focus-visible ~ * .hx-btn { outline: 2px solid var(--accent); outline-offset: -4px; border-radius: 12px; }
.hx-panel { display: none; padding: 12px 14px; border-radius: 12px; background: var(--panel); font-size: 14px; line-height: 1.55; color: #e2ddf7; }
.hx-toggle:checked ~ .hx-panel { display: block; }

/* Older pages, restyled to the new tokens until they are rebuilt. */
h1 { font-size: 19px; font-weight: 600; margin-bottom: 16px; }
h2 { font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); margin-bottom: 10px; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 24px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; color: var(--ink); }
a.card:hover { text-decoration: none; border-color: var(--line-strong); }
.card .num { font-size: 22px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
.card .label { color: var(--muted); margin-top: 2px; font-size: 13px; }
table { display: block; overflow-x: auto; width: 100%; border-collapse: collapse; background: var(--surface);
  border: 1px solid var(--line); border-radius: 14px; }
th { text-align: left; padding: 10px 12px; color: var(--muted); font-size: 12px; font-weight: 600; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 10px 12px; border-bottom: 1px solid var(--divider); vertical-align: top; font-size: 14px; }
tr:last-child td { border-bottom: none; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 6px; font-size: 11px; font-weight: 600; }
.badge-green { background: var(--green-bg); color: var(--green); }
.badge-yellow { background: var(--yellow-bg); color: var(--yellow); }
.badge-red { background: var(--red-bg); color: var(--red); }
.badge-blue { background: var(--blue-bg); color: var(--blue); }
.badge-grey { background: var(--grey-bg); color: var(--grey); }
input, select, textarea { background: var(--input); border: 1px solid var(--line-strong); color: var(--ink);
  min-height: 44px; padding: 0 14px; border-radius: 12px; font-size: 15px; max-width: 100%; }
textarea { padding: 10px 14px; }
input[type=file] { padding: 10px; }
input[type=checkbox], input[type=radio] { min-height: 0; }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); }
button, .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; background: var(--accent);
  color: var(--on-accent); border: none; padding: 0 16px; border-radius: 12px; cursor: pointer; font-size: 15px; font-weight: 600; }
button:hover, .btn:hover { filter: brightness(1.08); text-decoration: none; color: var(--on-accent); }
button:disabled { opacity: 0.5; cursor: default; }
.btn-ghost { background: var(--panel); color: var(--accent-ink); border: 1px solid var(--line-strong); }
.btn-ghost:hover { color: var(--accent-ink); }
.filters { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.filters input { flex: 1 1 200px; width: auto !important; }
.truncate { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.section { margin-bottom: 28px; }
.error { color: #ffbcbc; background: var(--red-bg); padding: 12px 14px; border-radius: 12px; margin-bottom: 16px; }
.valid-yes { color: var(--green); }
.valid-no { color: var(--red); }
pre { background: var(--code); border: 1px solid var(--line); border-radius: 8px; padding: 10px; font-size: 11.5px; line-height: 1.5;
  color: var(--ink-2); overflow: auto; white-space: pre-wrap; word-break: break-all; max-height: 240px; }
details { margin-top: 4px; }
summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.tabs { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; margin: 0 -16px 16px; padding: 0 16px 2px; }
.tabs::-webkit-scrollbar { display: none; }
.tabs a { flex: none; height: 36px; display: flex; align-items: center; padding: 0 14px; border-radius: 18px; white-space: nowrap;
  border: 1px solid var(--line-strong); color: var(--ink-2); font-size: 14px; font-weight: 500; }
.tabs a:hover { text-decoration: none; border-color: #4a4470; }
.tabs a.active { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.cover { width: 36px; height: 54px; object-fit: cover; border-radius: 4px; background: var(--panel); display: block; }
.cover-empty { border: 1px solid var(--line); }
.cover-cell { width: 36px; padding-right: 0; }
.row-actions { display: flex; gap: 6px; }
.row-actions button { min-height: 36px; padding: 0 10px; font-size: 13px; border-radius: 10px; }
.notice { background: var(--blue-bg); color: var(--blue); padding: 12px 14px; border-radius: 12px; margin-bottom: 16px; }
.muted { color: var(--muted); font-size: 13px; }
p { line-height: 1.55; }
`
