import { config, getActorUrl, getOwnerIdentity, getActorPublished } from '../config.js'
import { getAssetUrl } from './profile-assets.js'
import { escapeHtml } from '../lib/html.js'

/**
 * The human-readable profile page, served to browsers at /actor and /@<username>.
 *
 * Fediverse clients only ever see the bio, which has room for three sentences. This
 * page is the long form: who runs the bot, what it archives, and — the part people
 * actually want to know when a stranger's bot shows up in their notifications —
 * exactly what it does not keep about them, with links to verify each claim.
 *
 * Nynorsk, matching the owner's other public writing. Self-contained: no external
 * stylesheet, font or script, so it renders the same regardless of network policy.
 */
export function renderProfilePage(): string {
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

  // Retention is configurable, and 0 means "keep forever" — so the sentence has to
  // change with it rather than promise a window that isn't enforced.
  const logSentence = retentionDays > 0
    ? `Innkomande førespurnader vert logga teknisk for feilsøking, og logg eldre enn
       ${retentionDays} dagar vert sletta automatisk.`
    : `Innkomande førespurnader vert logga teknisk for feilsøking.`

  return `<!doctype html>
<html lang="nn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(config.APP_DISPLAY_NAME)} — ${escapeHtml(handle)}</title>
<meta name="description" content="Personleg ActivityPub-bot. Arkiverer offentlege innlegg frå eit fast sett kontoar, og ingenting om andre.">
<link rel="icon" type="image/png" href="${escapeHtml(getAssetUrl('avatar'))}">
<style>
  :root {
    --green: #143521; --green-deep: #0f2a1a; --panel: #1c4a2d;
    --line: #2f5a3e; --lime: #9fe822; --cream: #f1ede2;
    --sub: #bcd2bb; --foot: #6f8c74;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--green); color: var(--cream);
    font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  /* Full width, anchored to the bottom, so the artwork's lime rule always lands
     exactly on the banner's bottom edge instead of being cropped to a stripe that
     floats through the middle. Heights are chosen so the scaled 3:1 image is never
     shorter than the banner (no gap) down to a 300px viewport. */
  .banner {
    height: 160px; background: var(--green) center bottom / 100% auto no-repeat
      url("${escapeHtml(getAssetUrl('header'))}");
  }
  main { max-width: 720px; margin: 0 auto; padding: 0 24px 72px; }
  /* Avatar overlaps the banner; the name sits fully below it, so the artwork's lime
     rule never runs through the title at any viewport width. */
  header.id { margin-top: -52px; }
  header.id img {
    width: 104px; height: 104px; border-radius: 20px; display: block;
    border: 4px solid var(--green); background: var(--green);
  }
  .who { margin-top: 16px; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 4px; letter-spacing: -0.01em; }
  .handle { color: var(--sub); font-size: 0.95rem; }
  .badge {
    display: inline-block; margin-left: 8px; padding: 2px 8px; border-radius: 999px;
    background: var(--lime); color: #10301d; font-size: 0.7rem; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase; vertical-align: 2px;
  }
  .lead { font-size: 1.1rem; color: var(--cream); margin: 28px 0 0; }
  h2 {
    font-size: 0.78rem; letter-spacing: 0.12em; text-transform: uppercase;
    color: #d6ecca; margin: 40px 0 0; padding-bottom: 8px;
  }
  h2::after {
    content: ""; display: block; width: 38px; height: 3px;
    background: var(--lime); border-radius: 2px; margin-top: 8px;
  }
  ul { list-style: none; padding: 0; margin: 18px 0 0; }
  li {
    position: relative; padding: 0 0 0 26px; margin-bottom: 14px; color: var(--sub);
  }
  li::before {
    content: ""; position: absolute; left: 4px; top: 0.62em;
    width: 8px; height: 8px; border-radius: 2px; background: var(--lime);
  }
  li strong { color: var(--cream); font-weight: 600; }
  .facts {
    margin: 18px 0 0; border: 1px solid var(--line); border-radius: 14px;
    background: var(--panel); overflow: hidden;
  }
  .facts div {
    display: flex; flex-wrap: wrap; gap: 4px 16px; justify-content: space-between;
    padding: 12px 18px; border-top: 1px solid var(--line);
  }
  .facts div:first-child { border-top: 0; }
  .facts dt, .facts dd { margin: 0; }
  .facts dt { color: var(--sub); font-size: 0.9rem; }
  .facts dd { font-variant-numeric: tabular-nums; }
  a { color: var(--lime); text-decoration-thickness: 1px; text-underline-offset: 2px; }
  a:hover { color: var(--cream); }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em;
    background: var(--green-deep); border: 1px solid var(--line);
    border-radius: 6px; padding: 1px 6px;
  }
  footer {
    margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--line);
    color: var(--foot); font-size: 0.9rem;
  }
  @media (max-width: 520px) {
    .banner { height: 100px; }
    h1 { font-size: 1.3rem; }
  }
</style>
</head>
<body>
<div class="banner"></div>
<main>
  <header class="id">
    <img src="${escapeHtml(getAssetUrl('avatar'))}" alt="" width="104" height="104">
    <div class="who">
      <h1>${escapeHtml(config.APP_DISPLAY_NAME)}<span class="badge">bot</span></h1>
      <div class="handle">${escapeHtml(handle)}</div>
    </div>
  </header>

  <p class="lead">
    Dette er ein personleg ActivityPub-bot. ${ownerLink} eig og driftar han.
    Han finst for at Markus skal kunna spørja sitt eige arkiv gjennom MCP — ikkje
    for å samla inn noko om andre.
  </p>

  <h2>Kva han gjer</h2>
  <ul>
    <li>Følgjer <strong>eit fast og ope sett med kontoar</strong> — i praksis dei
      Markus eig sjølv. Lista ligg ope på
      <a href="${actorUrl}/following">/actor/following</a>.</li>
    <li>Arkiverer dei <strong>offentlege</strong> innlegga frå desse kontoane, saman
      med lesing, musikk, film og reiser som kontoane sjølve publiserer.</li>
    <li>Gjer arkivet søkbart for Markus gjennom MCP og eit privat REST-API.</li>
    <li><strong>Postar ingenting.</strong> Utboksen er tom, og han svarar ikkje,
      likar ikkje og deler ikkje vidare.</li>
  </ul>

  <h2>Kva han ikkje gjer</h2>
  <ul>
    <li><strong>Han arkiverer ingenting om deg</strong> så lenge du ikkje er ein av
      kontoane han følgjer. Kjem det eit innlegg frå ein annan konto, vert det
      forkasta i innboksen — ikkje arkivert.</li>
    <li><strong>Han tek ikkje imot følgjarar.</strong> Alle følgjeførespurnader vert
      avviste automatisk, og difor kan han korkje følgja deg eller lesa tidslinja di.</li>
    <li><strong>Ingenting vert delt vidare.</strong> Arkivet er privat, det er ikkje
      publisert, og det vert korkje selt eller utlevert.</li>
    <li>${logSentence}</li>
    <li>Slettar du eit innlegg, vert <code>Delete</code> respektert: innlegget vert
      markert sletta og kjem ikkje ut av arkivet igjen.</li>
  </ul>

  <h2>Sjekk det sjølv</h2>
  <dl class="facts">
    <div><dt>Kontoar han følgjer</dt>
      <dd><a href="${actorUrl}/following">/actor/following</a></dd></div>
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
</main>
</body>
</html>
`
}
