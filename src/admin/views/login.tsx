/** @jsxImportSource hono/jsx */

export function LoginPage({ error }: { error?: string }) {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Admin Login</title>
        <style dangerouslySetInnerHTML={{ __html: `
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
          .box { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 40px; width: 360px; }
          h1 { font-size: 22px; margin-bottom: 8px; color: #fff; }
          p { color: #888; margin-bottom: 28px; font-size: 14px; }
          label { display: block; color: #aaa; font-size: 12px; margin-bottom: 6px; }
          input { width: 100%; background: #222; border: 1px solid #444; color: #e0e0e0; padding: 10px 14px; border-radius: 6px; font-size: 14px; margin-bottom: 16px; }
          input:focus { outline: none; border-color: #7c6ef7; }
          button { width: 100%; background: #7c6ef7; color: #fff; border: none; padding: 11px; border-radius: 6px; cursor: pointer; font-size: 15px; font-weight: 600; }
          button:hover { background: #6b5ce7; }
          .error { color: #f87171; background: #3a1a1a; padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; }
        ` }} />
      </head>
      <body>
        <div class="box">
          <h1>AP Admin</h1>
          <p>Sign in to manage your ActivityPub server</p>
          {error && <div class="error">{error}</div>}
          <form method="post" action="/admin/login">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" autofocus required />
            <button type="submit">Sign in</button>
          </form>
        </div>
      </body>
    </html>
  )
}
