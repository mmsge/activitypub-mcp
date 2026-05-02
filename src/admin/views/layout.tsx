/** @jsxImportSource hono/jsx */
import type { FC, PropsWithChildren } from 'hono/jsx'

export const Layout: FC<PropsWithChildren<{ title?: string }>> = ({ title, children }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title ? `${title} — AP Admin` : 'AP Admin'}</title>
        <script src="https://unpkg.com/htmx.org@2.0.4" defer></script>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <nav>
          <a href="/admin" class="brand">AP MCP</a>
          <div class="nav-links">
            <a href="/admin">Dashboard</a>
            <a href="/admin/activities">Activities</a>
            <a href="/admin/objects">Posts</a>
            <a href="/admin/follows">Follows</a>
            <a href="/admin/logs">Logs</a>
            <a href="/admin/logout" class="logout">Logout</a>
          </div>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  )
}

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, sans-serif; font-size: 14px; background: #0f0f0f; color: #e0e0e0; }
nav { background: #1a1a1a; border-bottom: 1px solid #333; padding: 0 20px; display: flex; align-items: center; gap: 24px; height: 48px; }
nav .brand { font-weight: 700; color: #7c6ef7; text-decoration: none; font-size: 16px; }
nav .nav-links { display: flex; gap: 16px; margin-left: auto; }
nav a { color: #aaa; text-decoration: none; }
nav a:hover { color: #fff; }
nav .logout { color: #f87171; }
main { padding: 24px; max-width: 1200px; margin: 0 auto; }
h1 { font-size: 22px; margin-bottom: 20px; color: #fff; }
h2 { font-size: 16px; margin-bottom: 12px; color: #ccc; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }
.card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 16px; }
.card .num { font-size: 32px; font-weight: 700; color: #7c6ef7; }
.card .label { color: #888; margin-top: 4px; font-size: 12px; }
table { width: 100%; border-collapse: collapse; background: #1a1a1a; border-radius: 8px; overflow: hidden; }
th { text-align: left; padding: 10px 14px; color: #888; font-size: 12px; border-bottom: 1px solid #333; }
td { padding: 10px 14px; border-bottom: 1px solid #222; vertical-align: top; }
tr:last-child td { border-bottom: none; }
tr:hover td { background: #222; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
.badge-green { background: #1a3a1a; color: #4ade80; }
.badge-yellow { background: #3a3a1a; color: #fbbf24; }
.badge-red { background: #3a1a1a; color: #f87171; }
.badge-blue { background: #1a1a3a; color: #60a5fa; }
input, select { background: #222; border: 1px solid #444; color: #e0e0e0; padding: 8px 12px; border-radius: 6px; font-size: 14px; }
input:focus, select:focus { outline: none; border-color: #7c6ef7; }
button, .btn { background: #7c6ef7; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; }
button:hover, .btn:hover { background: #6b5ce7; }
.filters { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.mono { font-family: monospace; font-size: 12px; }
.truncate { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.section { margin-bottom: 32px; }
a { color: #7c6ef7; text-decoration: none; }
a:hover { text-decoration: underline; }
.error { color: #f87171; background: #3a1a1a; padding: 12px; border-radius: 6px; margin-bottom: 16px; }
.valid-yes { color: #4ade80; }
.valid-no { color: #f87171; }
pre { background: #111; border: 1px solid #333; border-radius: 6px; padding: 12px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow-y: auto; }
details { margin-top: 4px; }
summary { cursor: pointer; color: #888; font-size: 12px; }
`
