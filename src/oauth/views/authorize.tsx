/** @jsxImportSource hono/jsx */

export type AuthorizeParams = {
  client_id: string
  redirect_uri: string
  code_challenge: string
  code_challenge_method: string
  state?: string
  scope?: string
  resource?: string
}

// Consent + login page for the OAuth authorization step. The admin password is
// the single gate: entering it correctly approves the connection. All OAuth
// params ride along as hidden fields so the POST can mint the code.
export function AuthorizePage({
  clientName,
  params,
  error,
}: {
  clientName: string
  params: AuthorizeParams
  error?: string
}) {
  const hidden: Record<string, string | undefined> = {
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    code_challenge_method: params.code_challenge_method,
    state: params.state,
    scope: params.scope,
    resource: params.resource,
  }
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Authorize {clientName}</title>
        <style dangerouslySetInnerHTML={{ __html: `
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
          .box { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 40px; width: 100%; max-width: 380px; }
          h1 { font-size: 22px; margin-bottom: 8px; color: #fff; }
          p { color: #888; margin-bottom: 20px; font-size: 14px; line-height: 1.5; }
          p strong { color: #cbb; }
          .scope { background: #222; border: 1px solid #333; border-radius: 8px; padding: 12px 14px; margin-bottom: 24px; font-size: 13px; color: #aaa; }
          label { display: block; color: #aaa; font-size: 12px; margin-bottom: 6px; }
          input[type=password] { width: 100%; background: #222; border: 1px solid #444; color: #e0e0e0; padding: 10px 14px; border-radius: 6px; font-size: 14px; margin-bottom: 16px; }
          input:focus { outline: none; border-color: #7c6ef7; }
          button { width: 100%; background: #7c6ef7; color: #fff; border: none; padding: 11px; border-radius: 6px; cursor: pointer; font-size: 15px; font-weight: 600; }
          button:hover { background: #6b5ce7; }
          .error { color: #f87171; background: #3a1a1a; padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; }
        ` }} />
      </head>
      <body>
        <div class="box">
          <h1>Authorize access</h1>
          <p><strong>{clientName}</strong> wants to connect to your ActivityPub MCP server and read your archived data.</p>
          <div class="scope">It will be able to call the read-only MCP tools (posts, reading, scrobbles, train trips, and more).</div>
          {error && <div class="error">{error}</div>}
          <form method="post" action="/oauth/authorize">
            {Object.entries(hidden).map(([k, v]) =>
              v !== undefined ? <input type="hidden" name={k} value={v} /> : null,
            )}
            <label for="password">Admin password</label>
            <input type="password" id="password" name="password" autofocus required />
            <button type="submit">Allow</button>
          </form>
        </div>
      </body>
    </html>
  )
}
