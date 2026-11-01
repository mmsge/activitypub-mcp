/** @jsxImportSource hono/jsx */
import { FontLinks, TOKENS } from './layout.js'

// Full-screen login from the mobile redesign: no header and no bar. Same POST.
export function LoginPage({ error }: { error?: string }) {
  return (
    <html lang="nn">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#14121f" />
        <title>Logg inn · AP Admin</title>
        <FontLinks />
        <style dangerouslySetInnerHTML={{ __html: TOKENS + LOGIN_CSS }} />
      </head>
      <body>
        <form class="login" method="post" action="/admin/login">
          <h1>AP Admin</h1>
          {error && <div class="login-error" role="alert">{error}</div>}
          <label>
            <span>Passord</span>
            <input type="password" name="password" autocomplete="current-password" autofocus required />
          </label>
          <button type="submit">Logg inn</button>
        </form>
      </body>
    </html>
  )
}

const LOGIN_CSS = `
body { min-height: 100vh; min-height: 100dvh; display: flex; }
.login { flex: 1; max-width: 420px; margin: 0 auto; display: flex; flex-direction: column; justify-content: center; gap: 20px; padding: 24px; }
.login h1 { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; }
.login-error { padding: 12px 14px; border-radius: 12px; background: var(--red-bg); color: #ffbcbc; font-size: 14px; }
.login label { display: flex; flex-direction: column; gap: 6px; }
.login label span { font-size: 13px; color: var(--muted); }
.login input { height: 52px; width: 100%; padding: 0 14px; border-radius: 12px; border: 1px solid var(--line-strong);
  background: var(--input); color: var(--ink); font-size: 16px; }
.login input:focus { outline: none; border-color: var(--accent); }
.login button { height: 52px; border: none; border-radius: 14px; background: var(--accent); color: var(--on-accent);
  font-size: 16px; font-weight: 600; cursor: pointer; }
.login button:hover { filter: brightness(1.08); }
`
