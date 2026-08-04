import { config, getActorUrl, getOwnerIdentity, getActorPublished } from '../config.js'
import { getProfilePageUrl } from './actor.js'
import { escapeHtml } from '../lib/html.js'
import { renderPage, renderIdentityHeader } from './page-chrome.js'
import { renderNoteCard, type LocalNote } from './note.js'

/**
 * The human-readable profile page, served to browsers at /actor and /@<username>.
 *
 * Fediverse clients only ever see the bio, which has room for three sentences. This
 * page is the long form: who runs the bot, what it archives, and — the part people
 * actually want to know when a stranger's bot shows up in their notifications —
 * exactly what it does not keep about them, with links to verify each claim.
 *
 * Nynorsk, matching the owner's other public writing.
 *
 * `notes` is passed in rather than read here so the page stays a pure function: the
 * router does the query, and the tests render it without a database.
 */
export function renderProfilePage(notes: LocalNote[] = []): string {
  const actorUrl = getActorUrl()
  const owner = getOwnerIdentity()
  const published = getActorPublished()
  const handle = `@${config.APP_USERNAME}@${config.APP_DOMAIN}`
  const retentionDays = config.ACTIVITY_LOG_RETENTION_DAYS

  const ownerLink = owner
    ? `<a href="${escapeHtml(owner.url)}" rel="me">${escapeHtml(owner.handle)}</a>`
    : 'Markus'

  const joined = published
    ? new Date(published).toLocaleDateString('nn-NO', {
        day: 'numeric', month: 'long', year: 'numeric',
      })
    : null

  // The public stream, when there is one. The page's privacy claims are meant to be
  // checkable (ADR 0009), so this sentence must follow the configuration rather than
  // asserting something that may not be true: with STREAM_DOMAIN unset nothing is
  // published, and the wording says exactly that.
  const sharingSentence = config.STREAM_DOMAIN
    ? `<strong>Ingenting om andre vert delt vidare.</strong> Arkivet er ikkje ope, og
       det vert korkje selt eller utlevert. Markus publiserer eit utval av sine
       <em>eigne</em> innlegg på
       <a href="https://${escapeHtml(config.STREAM_DOMAIN)}">${escapeHtml(config.STREAM_DOMAIN)}</a>
       — berre innlegg som alt var offentlege der dei vart lagde ut, aldri svar til
       andre, aldri noko frå andre kontoar enn hans eigne.`
    : `<strong>Ingenting vert delt vidare.</strong> Arkivet er privat, det er ikkje
       publisert, og det vert korkje selt eller utlevert.`

  // Retention is configurable, and 0 means "keep forever" — so the sentence has to
  // change with it rather than promise a window that isn't enforced.
  const logSentence = retentionDays > 0
    ? `Innkomande førespurnader vert logga teknisk for feilsøking, og logg eldre enn
       ${retentionDays} dagar vert sletta automatisk.`
    : `Innkomande førespurnader vert logga teknisk for feilsøking.`

  // Dropped entirely when the bot has not published anything yet, rather than left as
  // an empty heading that reads like something broke.
  const notesSection = notes.length
    ? `
  <h2>Siste innlegg</h2>
  ${notes.map(renderNoteCard).join('\n  ')}
`
    : ''

  return renderPage({
    title: `${config.APP_DISPLAY_NAME} — ${handle}`,
    description: config.STREAM_DOMAIN
      ? `Personleg ActivityPub-bot. Arkiverer offentlege innlegg frå eit fast sett kontoar, og ingenting om andre. Markus sine eigne innlegg er samla på ${config.STREAM_DOMAIN}.`
      : 'Personleg ActivityPub-bot. Arkiverer offentlege innlegg frå eit fast sett kontoar, og ingenting om andre.',
    canonical: getProfilePageUrl(),
    alternate: actorUrl,
    body: `${renderIdentityHeader()}

  <p class="lead">
    Dette er ein personleg ActivityPub-bot. ${ownerLink} eig og driftar han.
    Han finst for at Markus skal kunna spørja sitt eige arkiv gjennom MCP — ikkje
    for å samla inn noko om andre.
  </p>
${notesSection}
  <h2>Kva han gjer</h2>
  <ul>
    <li>Følgjer <strong>eit fast og ope sett med kontoar</strong> — i praksis dei
      Markus eig sjølv. Lista ligg ope på
      <a href="${actorUrl}/following">/actor/following</a>.</li>
    <li>Arkiverer dei <strong>offentlege</strong> innlegga frå desse kontoane, saman
      med lesing, musikk, film og reiser som kontoane sjølve publiserer.</li>
    <li>Gjer arkivet søkbart for Markus gjennom MCP og eit privat REST-API.</li>
    <li><strong>Postar berre om seg sjølv.</strong> Utboksen inneheld korte
      statusmeldingar om kva han arkiverer, og ingenting anna. Han svarar ikkje,
      likar ikkje og deler ikkje vidare.</li>
  </ul>

  <h2>Kva han ikkje gjer</h2>
  <ul>
    <li><strong>Han arkiverer ingenting om deg</strong> så lenge du ikkje er ein av
      kontoane han følgjer. Kjem det eit innlegg frå ein annan konto, vert det
      forkasta i innboksen — ikkje arkivert.</li>
    <li><strong>Han tek ikkje imot følgjarar.</strong> Alle følgjeførespurnader vert
      avviste automatisk, og difor kan han korkje følgja deg eller lesa tidslinja di.</li>
    <li>${sharingSentence}</li>
    <li>${logSentence}</li>
    <li>Slettar du eit innlegg, vert <code>Delete</code> respektert: innlegget vert
      markert sletta og kjem ikkje ut av arkivet igjen.</li>
  </ul>

  <h2>Sjekk det sjølv</h2>
  <dl class="facts">
    <div><dt>Kontoar han følgjer</dt>
      <dd><a href="${actorUrl}/following">/actor/following</a></dd></div>
    <div><dt>Alt han har posta</dt>
      <dd><a href="${actorUrl}/outbox">/actor/outbox</a></dd></div>
    <div><dt>Aktørdokument (JSON)</dt>
      <dd><a href="${actorUrl}">/actor</a></dd></div>
    <div><dt>Programvare</dt>
      <dd><a href="https://${escapeHtml(config.APP_DOMAIN)}/nodeinfo/2.0">nodeinfo</a></dd></div>
    ${joined ? `<div><dt>I drift sidan</dt><dd>${escapeHtml(joined)}</dd></div>` : ''}
  </dl>

  <footer>
    Har du spørsmål, eller vil du ikkje at boten skal følgja kontoen din?
    Ta kontakt med ${ownerLink}.
  </footer>
</main>`,
  })
}
