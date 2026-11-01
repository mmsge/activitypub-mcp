/** @jsxImportSource hono/jsx */
import { Layout, HelpInput, HelpButton, HelpPanel } from './layout.js'
import { SourceBadge } from './ui.js'
import type { TokenStatus } from '../../lib/source-health.js'

// LinkedIn ingest health, moved off the old dashboard. A stand-in until the LinkedIn
// category page (Innlegg, Statistikk) lands; the content is the same evidence the
// dashboard showed, so a dying token stays visible without reading logs (ADR 0033/0034).

export interface LinkedinHealth {
  enabled: boolean
  status: TokenStatus
  lastSuccessAt: Date | null
  lastDataAt: Date | null
  lastError: string | null
  /** What the last attempt concluded and on what evidence. See ADR 0039. */
  lastNote: string | null
  lastHttpStatus: number | null
  posts: number
  metricRows: number
  latestExport: string | null
}

const nf = new Intl.NumberFormat('nn-NO')
const ts = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : 'aldri')

export function LinkedinPage({ data }: { data: LinkedinHealth }) {
  return (
    <Layout title="LinkedIn" back={{ href: '/admin', label: 'Oversikt' }}>
      <div class="stack">
        <section class="group">
          <HelpInput id="help-linkedin" />
          <div class="section-label">
            <span style="flex:1">Status</span>
            <HelpButton for="help-linkedin" />
          </div>
          <HelpPanel>
            Innlegga kjem frå DMA-API-et (LINKEDIN_DMA_TOKEN), tala frå XLSX-eksporten under Import.
            Eit avvist token stoppar nye innlegg, men det som alt er lagra er framleis gyldig.
          </HelpPanel>
          <div class="panel">
            <div class="row">
              <div class="row-main">
                <div class="row-title">DMA-synk</div>
                <div class="row-sub">Sist OK {ts(data.lastSuccessAt)} · data sist {ts(data.lastDataAt)}</div>
              </div>
              <SourceBadge
                status={data.status}
                lastError={data.lastError}
                lastSuccessAt={data.lastSuccessAt}
                lastDataAt={data.lastDataAt}
              />
            </div>
            {data.lastHttpStatus !== null && (
              <div class="row">
                <div class="row-main">
                  <div class="row-title">Siste svar</div>
                  <div class="row-sub">HTTP {data.lastHttpStatus}</div>
                </div>
              </div>
            )}
            {data.lastNote && <pre style="margin:10px 14px 12px">{data.lastNote}</pre>}
          </div>
          {data.status === 'unauthorized' && (
            <div class="error">
              Tokenet blir avvist. Lag eit nytt (sjå LinkedIn-delen av README), og køyr{' '}
              <code>npm run sync-linkedin</code>.
            </div>
          )}
          {data.status === 'stale' && (
            <div class="notice">Synken har ikkje fullført på ei stund, så innlegga står still.</div>
          )}
          {data.status === 'awaiting_data' && (
            <div class="notice">
              Synken fullfører, men LinkedIn har ikkje laga <code>MEMBER_SHARE_INFO</code> enno. Linja over
              seier kva siste køyring faktisk fann. Kom profilsonden tilbake med data, er det ingenting å
              fikse, og eit nytt token startar berre ventinga på nytt. Køyr{' '}
              <code>npm run probe-linkedin</code> for å sjå no.
            </div>
          )}
          {!data.enabled && <div class="notice">LINKEDIN_DMA_TOKEN er tom, så synken er av.</div>}
        </section>

        <section class="group">
          <div class="section-label">Data</div>
          <div class="tiles">
            <div class="stat">
              <div class="stat-n">{nf.format(data.posts)}</div>
              <div class="stat-l">innlegg (DMA)</div>
            </div>
            <div class="stat">
              <div class="stat-n">{nf.format(data.metricRows)}</div>
              <div class="stat-l">statistikkrader (XLSX)</div>
            </div>
          </div>
          <div class="panel">
            <a class="panel-more" href="/admin/import">
              Siste eksport: {data.latestExport ?? 'ingen'} · Importer ny →
            </a>
          </div>
        </section>
      </div>
    </Layout>
  )
}
