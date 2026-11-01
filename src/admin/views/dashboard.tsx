/** @jsxImportSource hono/jsx */
import { Layout, HelpInput, HelpButton, HelpPanel } from './layout.js'
import { CATEGORIES, type CategoryId } from '../categories.js'
import { attentionItems, actorHandle, type AttentionInput } from '../attention.js'

// Oversikt: what needs attention, the seven categories with one number each, and recent
// activity. Everything else moved behind the categories (ADR 0073).

export interface DashboardData extends AttentionInput {
  activitiesLast24h: number
  activitiesLast7d: number
  recentActivities: Array<{
    type: string
    actorApId: string
    objectType: string | null
    receivedAt: Date
    processed: boolean
    processingError: string | null
  }>
  totalObjects: number
  media: { books: number; films: number; tv: number }
  scrobbles: number
  trips: number
  linkedinPosts: number
}

const nf = new Intl.NumberFormat('nn-NO')
const n = (v: number) => nf.format(v)

/** The one number a category tile shows. */
export function categoryKeys(d: DashboardData): Record<CategoryId, string> {
  return {
    lesing: `${n(d.media.books)} bøker`,
    sjaaing: `${n(d.media.films + d.media.tv)} titlar`,
    musikk: `${n(d.scrobbles)} scrobblar`,
    reiser: `${n(d.trips)} turar`,
    fediverse: `${n(d.totalObjects)} innlegg`,
    linkedin: `${n(d.linkedinPosts)} innlegg`,
    system: d.deliveryErrors24h > 0 ? `${n(d.deliveryErrors24h)} feil siste døgn` : 'Ingen feil siste døgn',
  }
}

function activityStatus(a: DashboardData['recentActivities'][number]) {
  if (a.processingError) return <span class="badge badge-red" title={a.processingError}>Feil</span>
  if (a.processed) return <span class="badge badge-green">OK</span>
  return <span class="badge badge-yellow">Ventar</span>
}

export function DashboardPage({ data }: { data: DashboardData }) {
  const problems = attentionItems(data)
  const keys = categoryKeys(data)
  return (
    <Layout title="Oversikt" nav="oversikt">
      <div class="stack">
        <section class="group">
          <div class="section-label">
            Treng merksemd
            {problems.length > 0 && <span class="count-pill">{problems.length}</span>}
          </div>
          {problems.length === 0 && (
            <div class="all-clear">
              <span class="dot green" />
              <div>Ingenting treng merksemd</div>
            </div>
          )}
          {problems.map((p) => (
            <div class="problem">
              <HelpInput id={`help-${p.id}`} />
              <div class="problem-head">
                <span class={`dot ${p.tone}`} />
                <div class="problem-text">
                  <div class="problem-title">{p.title}</div>
                  <div class="problem-sub">{p.sub}</div>
                </div>
                <HelpButton for={`help-${p.id}`} />
              </div>
              <HelpPanel>{p.help}</HelpPanel>
              <div class="problem-act">
                <a class="btn-soft" href={p.href}>{p.action} →</a>
              </div>
            </div>
          ))}
        </section>

        <section class="group">
          <div class="section-label">Kategoriar</div>
          <div class="tiles">
            {CATEGORIES.map((c) => (
              <a class="tile" href={c.href}>
                <span class="tile-name">{c.label}</span>
                <span class="tile-key">{keys[c.id]}</span>
              </a>
            ))}
          </div>
        </section>

        <section class="group">
          <div class="section-label">Aktivitet</div>
          <div class="tiles">
            <div class="stat">
              <div class="stat-n">{n(data.activitiesLast24h)}</div>
              <div class="stat-l">siste 24 t</div>
            </div>
            <div class="stat">
              <div class="stat-n">{n(data.activitiesLast7d)}</div>
              <div class="stat-l">siste 7 d</div>
            </div>
          </div>
          <div class="panel">
            {data.recentActivities.slice(0, 3).map((a) => (
              <div class="row">
                <div class="row-main">
                  <div class="row-title">{a.objectType ? `${a.type} · ${a.objectType}` : a.type}</div>
                  <div class="row-sub" title={a.actorApId}>{actorHandle(a.actorApId)}</div>
                </div>
                {activityStatus(a)}
              </div>
            ))}
            {data.recentActivities.length === 0 && <div class="panel-empty">Ingen aktivitetar enno.</div>}
            <a class="panel-more" href="/admin/activities">Alle aktivitetar →</a>
          </div>
        </section>
      </div>
    </Layout>
  )
}
