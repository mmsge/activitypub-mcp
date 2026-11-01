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
  /** A flash message after a POST, passed back on the redirect as `?notice=`. */
  notice?: string
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
  notice,
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
        {notice && <div class="toast" role="status">{notice}</div>}
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

/* Category pages (kit.tsx). */
.cat { display: flex; flex-direction: column; gap: 14px; }
.cat .tabs { margin-bottom: 0; }
.search { display: flex; flex-direction: column; gap: 8px; }
.search-row { display: flex; align-items: center; gap: 8px; min-height: 44px; }
.search-row input { flex: 1; min-width: 0; height: 44px; }
.search-row .lead { flex: 1; font-size: 14px; color: var(--muted); }
.hx-wrap > .hx-panel { margin-top: 8px; }
.drawer { margin: 0; }
.drawer > summary { display: inline-flex; align-items: center; height: 36px; padding: 0 12px; border-radius: 18px;
  border: 1px solid var(--line-strong); color: var(--ink-2); font-size: 14px; font-weight: 500; list-style: none; }
.drawer > summary::-webkit-details-marker { display: none; }
.drawer[open] > summary { background: var(--accent-tint); border-color: #4a4290; color: var(--accent-ink); }
.drawer-body { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 10px;
  padding: 12px; border-radius: 14px; background: var(--surface); border: 1px solid var(--line); }
.drawer-actions { grid-column: 1 / -1; display: flex; gap: 8px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field > span { font-size: 13px; color: var(--muted); }
.field input, .field select { width: 100%; }
.field.check { flex-direction: row; align-items: center; gap: 8px; }
.stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.stat-s { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; }
.stat-s-n { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.stat-s-l { font-size: 13px; color: var(--muted); line-height: 1.35; }
.tone-red { color: var(--red); } .tone-yellow { color: var(--yellow); } .tone-green { color: var(--green); }
.tone-blue { color: var(--blue); } .tone-grey { color: var(--muted); }
.sec { display: flex; flex-direction: column; gap: 8px; }
.sec-head { display: flex; align-items: center; gap: 4px; min-height: 36px; }
.sec-title { flex: 1; font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.sec-head .hx-btn { height: 36px; }
.empty-box { padding: 20px 16px; border-radius: 14px; border: 1px dashed var(--line-strong); font-size: 14px; color: var(--muted); text-align: center; }
.r { border-bottom: 1px solid var(--divider); }
.panel > .r:last-of-type { border-bottom: none; }
.r-hidden { opacity: 0.55; }
.r-row { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 10px 6px 10px 14px; }
.r-x > summary { list-style: none; cursor: pointer; }
.r-x > summary::-webkit-details-marker { display: none; }
.r-x[open] > summary { background: rgba(139, 124, 255, 0.05); }
.r-raw { margin: 0 14px 12px; }
.row-cover { width: 36px; height: 54px; flex: none; border-radius: 4px; background: var(--panel); object-fit: cover; }
.r-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.r-title { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--ink); }
.r-title a { color: var(--ink); }
.r-sub { font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
.r-sub.mono { font-size: 12px; }
.r-badges { display: flex; gap: 6px; flex-wrap: wrap; }
.r-metric { font-family: var(--mono); font-size: 13px; color: var(--ink-2); padding-right: 8px; text-align: right; white-space: nowrap; }
.r-act { min-height: 36px; padding: 0 12px; margin-right: 6px; border-radius: 10px; background: var(--panel);
  border: 1px solid var(--line-strong); color: var(--accent-ink); font-size: 13px; font-weight: 600; white-space: nowrap; flex: none; }
.r-act:hover { color: var(--accent-ink); }
.r-dots { width: 44px; height: 44px; min-height: 44px; flex: none; padding: 0; background: none; border: none;
  color: var(--ink-2); font-size: 20px; font-weight: 700; border-radius: 10px; }
.r-dots:hover { color: var(--ink); background: var(--panel); }
.more { display: flex; justify-content: space-between; border-top: 1px solid var(--divider); }
.more a { display: flex; align-items: center; height: 48px; padding: 0 14px; font-size: 14px; font-weight: 600; }
.more .more-next { margin-left: auto; }
.is-row { display: flex; align-items: center; gap: 12px; min-height: 60px; padding: 8px 8px 8px 14px; border-bottom: 1px solid var(--divider); color: var(--ink); }
a.is-row:hover { text-decoration: none; background: rgba(139, 124, 255, 0.05); }
.is-row:last-child { border-bottom: none; }
.is-row .chev { color: var(--dim); font-size: 18px; padding-right: 6px; }
.btn-run { min-height: 40px; min-width: 76px; padding: 0 14px; border-radius: 10px; background: var(--panel);
  border: 1px solid var(--line-strong); color: var(--accent-ink); font-size: 14px; }
.btn-run:hover { color: var(--accent-ink); }
.btn-run:disabled { color: var(--muted); opacity: 1; }
.banner-error { padding: 12px 14px; border-radius: 14px; background: var(--red-bg); }
.banner-title { font-size: 15px; font-weight: 600; color: #ffdede; }
.banner-reason { font-size: 13px; color: #ffbcbc; font-family: var(--mono); overflow-wrap: anywhere; }
.badge-accent { background: var(--accent-tint); color: var(--accent-ink); }
.rm-head { padding: 0 12px 10px; }
.rm-title { font-size: 17px; font-weight: 600; }
.rm-form { margin: 0; }
.rm-item { display: flex; align-items: center; width: 100%; height: 52px; min-height: 52px; padding: 0 12px; border: none;
  border-radius: 12px; background: none; color: var(--ink); font-size: 15px; font-weight: 400; justify-content: flex-start; }
.rm-item:hover { background: var(--panel); color: var(--ink); text-decoration: none; filter: none; }
.rm-note { margin: 6px 12px 0; font-size: 13px; color: var(--muted); line-height: 1.5; }
.toast { position: fixed; left: 16px; right: 16px; bottom: calc(92px + env(safe-area-inset-bottom)); z-index: 30;
  max-width: 608px; margin: 0 auto; padding: 12px 14px; border-radius: 12px; background: var(--ink); color: var(--bg);
  font-size: 14px; font-weight: 500; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  animation: toast-out 0.3s ease-in 4s forwards; }
@keyframes toast-out { to { opacity: 0; visibility: hidden; } }
@media (min-width: 900px) { .toast { left: 236px; bottom: 24px; } }

/* Import (views/import.tsx). */
.last-run { font-size: 12px; color: var(--muted); white-space: nowrap; }
.last-run.tone-red { color: var(--red); }
.sec-title.tone-yellow { color: var(--yellow); }
.imp form.imp-form { display: flex; flex-direction: column; gap: 14px; }
.imp .field input { height: 48px; }
.steps { display: flex; gap: 6px; }
.step { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.step-bar { height: 3px; border-radius: 2px; background: var(--line); }
.step-l { font-size: 12px; font-weight: 600; color: var(--dim); }
.step.on .step-bar, .step.past .step-bar { background: var(--accent); }
.step.on .step-l { color: var(--accent-ink); }
.step.past .step-l { color: var(--ink-2); }
.picker { position: relative; display: flex; flex-direction: column; align-items: center; gap: 6px; width: 100%;
  padding: 28px 16px; border-radius: 14px; border: 1.5px dashed #4a4470; background: var(--input); cursor: pointer; text-align: center; }
.picker input[type=file] { position: absolute; inset: 0; opacity: 0; cursor: pointer; min-height: 0; padding: 0; }
.picker:focus-within { border-color: var(--accent); }
.picker.picked { border-style: solid; border-color: var(--line-strong); background: var(--surface); }
.picker-title { font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
.picker-sub { font-size: 13px; color: var(--muted); }
.btn-primary { height: 52px; border-radius: 14px; font-size: 16px; }
.btn-danger { height: 52px; width: 100%; border-radius: 14px; font-size: 16px; background: #5a2a3a; color: #ffdede; }
.btn-danger:hover { color: #ffdede; }
.done-banner { padding: 14px; border-radius: 14px; }
.done-title { font-size: 17px; font-weight: 600; }
.done-note { margin-top: 4px; font-size: 13px; overflow-wrap: anywhere; }
.tone-bg-green { background: var(--green-bg); color: #e6f8ee; } .tone-bg-green .done-note { color: var(--green); }
.tone-bg-yellow { background: var(--yellow-bg); color: #fbefcf; } .tone-bg-yellow .done-note { color: var(--yellow); }
.tone-bg-red { background: var(--red-bg); color: #ffdede; } .tone-bg-red .done-note { color: #ffbcbc; }
.done-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.done-actions .btn { flex: 1 1 160px; height: 48px; }
.sec-warn .panel { border-color: var(--yellow-bg); }
.hx-panel p + p { margin-top: 8px; }

/* Loggar (views/logs.tsx). */
.logs { gap: 14px; }
.logs .tabs { margin-bottom: 0; }
.log-list { display: flex; flex-direction: column; gap: 8px; }
.log-card { margin: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; }
.log-card > summary { list-style: none; display: flex; flex-direction: column; gap: 4px; padding: 10px 14px; cursor: pointer; color: var(--ink); font-size: 14px; }
.log-card > summary::-webkit-details-marker { display: none; }
.log-card[open] { border-color: var(--line-strong); }
.log-top { display: flex; align-items: center; gap: 8px; }
.log-method { font-size: 13px; font-weight: 500; }
.log-status { font-size: 13px; color: var(--ink-2); }
.log-status.tone-red { color: var(--red); }
.log-time { margin-left: auto; font-size: 12px; color: var(--muted); }
.log-url { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.log-actor { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.log-detail { display: flex; flex-direction: column; gap: 8px; padding: 0 14px 12px; }
.log-detail pre { margin: 0; max-height: 220px; }
.log-error { padding: 8px 12px; border-radius: 8px; background: var(--red-bg); color: #ffbcbc; font-size: 13px; overflow-wrap: anywhere; }
.actor-filter { display: inline-flex; align-self: flex-start; align-items: center; gap: 8px; height: 36px; padding: 0 6px 0 12px;
  border-radius: 18px; background: var(--accent-tint); color: var(--accent-ink); font-size: 13px; }
.actor-filter a { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 14px; }

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
