/** @jsxImportSource hono/jsx */
import { Layout } from './layout.js'

interface ObjectRow {
  id: string
  apId: string
  type: string
  actorApId: string
  contentText: string | null
  url: string | null
  publishedAt: Date | null
  attachments: unknown
  tags: unknown
  deletedAt: Date | null
  raw: unknown
}

interface ObjectsPageProps {
  objects: ObjectRow[]
  page: number
  hasMore: boolean
  filters: { actor?: string; type?: string; q?: string; source?: string }
}

export function ObjectsPage({ objects, page, hasMore, filters }: ObjectsPageProps) {
  const buildPaginationHref = (p: number) => {
    const params = new URLSearchParams()
    params.set('page', String(p))
    if (filters.actor) params.set('actor', filters.actor)
    if (filters.type) params.set('type', filters.type)
    if (filters.q) params.set('q', filters.q)
    if (filters.source) params.set('source', filters.source)
    return `/admin/objects?${params}`
  }

  return (
    <Layout title="Posts">
      <h1>Posts</h1>
      <form class="filters" method="get" action="/admin/objects">
        <input name="actor" placeholder="Actor URL / URN" value={filters.actor ?? ''} style="width:280px" />
        <input name="type" placeholder="Type (Note, LinkedInPost…)" value={filters.type ?? ''} style="width:160px" />
        <select name="source" style="min-width:130px">
          <option value="" selected={!filters.source}>All sources</option>
          <option value="activitypub" selected={filters.source === 'activitypub'}>ActivityPub</option>
          <option value="linkedin" selected={filters.source === 'linkedin'}>LinkedIn</option>
        </select>
        <input name="q" placeholder="Search text" value={filters.q ?? ''} style="width:200px" />
        <button type="submit">Filter</button>
        <a href="/admin/objects" class="btn" style="background:#333">Clear</a>
      </form>
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Actor</th>
            <th>Content</th>
            <th>Published</th>
            <th>Attachments</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {objects.map(o => (
            <tr key={o.id} style={o.deletedAt ? 'opacity:0.5' : ''}>
              <td>
                <span class="badge badge-blue">{o.type}</span>
                {(o as any).source === 'linkedin' && <span class="badge badge-yellow" style="margin-left:4px">LinkedIn</span>}
                {o.deletedAt && <span class="badge badge-red" style="margin-left:4px">Deleted</span>}
              </td>
              <td class="truncate mono">{o.actorApId}</td>
              <td class="truncate">{o.contentText?.slice(0, 120) ?? '—'}</td>
              <td class="mono">{o.publishedAt?.toISOString().slice(0, 10) ?? '—'}</td>
              <td>
                {(() => {
                  const att = o.attachments as Array<{ mediaType?: string }> | null
                  if (!att?.length) return '—'
                  const images = att.filter(a => a.mediaType?.startsWith('image/')).length
                  const videos = att.filter(a => a.mediaType?.startsWith('video/')).length
                  return [images && `${images} img`, videos && `${videos} vid`].filter(Boolean).join(', ')
                })()}
              </td>
              <td>
                <details>
                  <summary>JSON</summary>
                  <pre>{JSON.stringify(o.raw, null, 2)}</pre>
                </details>
              </td>
            </tr>
          ))}
          {objects.length === 0 && (
            <tr><td colspan={6} style="color:#666;text-align:center">No posts found</td></tr>
          )}
        </tbody>
      </table>
      <div style="display:flex;gap:12px;margin-top:16px">
        {page > 0 && <a href={buildPaginationHref(page - 1)} class="btn">← Previous</a>}
        {hasMore && <a href={buildPaginationHref(page + 1)} class="btn">Next →</a>}
      </div>
    </Layout>
  )
}
