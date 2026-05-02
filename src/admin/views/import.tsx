/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx'
import { Layout } from './layout.js'
import type { ImportResult } from '../import.js'

export const ImportPage: FC<{ error?: string }> = ({ error }) => (
  <Layout title="Import">
    <h1>Import Historical Activities</h1>

    {error && <div class="error">{error}</div>}

    <div class="section">
      <h2>Mastodon Archive</h2>
      <p style="color: #888; margin-bottom: 12px; line-height: 1.5;">
        Export your archive from <strong>Mastodon Settings → Export → Request your archive</strong>.
        Extract the <code>.tar.gz</code> and upload the <code>outbox.json</code> file.
      </p>
      <form method="post" action="/admin/import/archive" enctype="multipart/form-data">
        <div class="filters">
          <input type="file" name="archive" accept=".json" required />
          <button type="submit">Import Archive</button>
        </div>
      </form>
    </div>

    <div class="section">
      <h2>Crawl ActivityPub Outbox</h2>
      <p style="color: #888; margin-bottom: 12px; line-height: 1.5;">
        Enter an actor handle to fetch their full public post history. Works with Mastodon and BookWyrm.
        May take a minute for large accounts (up to 200 pages).
      </p>
      <form method="post" action="/admin/import/crawl">
        <div class="filters">
          <input
            type="text"
            name="handle"
            placeholder="@user@instance.social"
            style="width: 280px;"
            required
          />
          <button type="submit">Crawl Outbox</button>
        </div>
      </form>
    </div>
    <div class="section">
      <h2>Re-process Stored Bare Objects</h2>
      <p style="color: #888; margin-bottom: 12px; line-height: 1.5;">
        Re-runs processing on activities stored as bare Note/Review/etc. objects
        (e.g. from a BookWyrm outbox crawl) so they appear as queryable posts.
        Safe to run multiple times.
      </p>
      <form method="post" action="/admin/import/reprocess">
        <div class="filters">
          <button type="submit">Re-process Bare Objects</button>
        </div>
      </form>
    </div>
  </Layout>
)

export const ImportResultPage: FC<{
  result: ImportResult
  actor: string
}> = ({ result, actor }) => (
  <Layout title="Import Result">
    <h1>Import Complete</h1>
    {actor && <p style="color: #888; margin-bottom: 20px;">{actor}</p>}

    <div class="grid" style="margin-bottom: 24px;">
      <div class="card">
        <div class="num">{result.total}</div>
        <div class="label">Total activities</div>
      </div>
      <div class="card">
        <div class="num" style="color: #4ade80;">{result.imported}</div>
        <div class="label">Imported</div>
      </div>
      <div class="card">
        <div class="num" style="color: #888;">{result.skipped}</div>
        <div class="label">Skipped (already exist)</div>
      </div>
      <div class="card">
        <div class="num" style="color: #f87171;">{result.errors.length}</div>
        <div class="label">Errors</div>
      </div>
    </div>

    {result.errors.length > 0 && (
      <div class="section">
        <h2>Errors (first {Math.min(result.errors.length, 20)})</h2>
        <pre>{result.errors.slice(0, 20).join('\n')}</pre>
      </div>
    )}

    <div class="filters">
      <a href="/admin/import" class="btn">Import More</a>
      <a href="/admin/objects" class="btn" style="background: #333;">View Posts</a>
    </div>
  </Layout>
)
