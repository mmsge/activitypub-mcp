import { config, getActorUrl, getActorPublished, getOwnerIdentity } from '../config.js'
import { getPublicKeyPem } from '../crypto/keys.js'
import { getAssetUrl } from './profile-assets.js'
import { escapeHtml } from '../lib/html.js'

/** Human-readable profile page for this actor, Mastodon-style. Served as HTML by
 *  the router; the actor document advertises it as `url`. */
export function getProfilePageUrl(): string {
  return `https://${config.APP_DOMAIN}/@${config.APP_USERNAME}`
}

/** A Mastodon-rendered profile metadata row. */
function field(name: string, value: string) {
  return { type: 'PropertyValue', name, value }
}

/**
 * The bio, as HTML. Three claims, in the order a stranger needs them: whose this
 * is, what it does, and what it does not keep. Nynorsk, matching the owner's
 * other public writing.
 *
 * Mastodon renders `summary` HTML but strips most markup, so this sticks to
 * paragraphs and links.
 */
function buildSummary(): string {
  const owner = getOwnerIdentity()
  const ownerLink = owner
    ? `<a href="${escapeHtml(owner.url)}" rel="me">${escapeHtml(owner.handle)}</a>`
    : 'Markus'

  return [
    `<p>Personleg ActivityPub-bot. ${ownerLink} eig og driftar han.</p>`,
    '<p>Han følgjer eit fast og ope sett med kontoar — i praksis dei Markus eig sjølv' +
      ' — og arkiverer dei offentlege innlegga derfrå, slik at arkivet kan spørjast' +
      ' gjennom MCP.</p>',
    // "arkiverer", not "lagrar": the archive genuinely holds nothing from actors we do
    // not follow, but inbound requests do pass through a short-lived debug log. The
    // profile page discloses that in full; the bio must not claim more than is true.
    '<p>Han arkiverer ingenting om deg. Følgjeførespurnader vert avviste automatisk, så' +
      ' han kan korkje følgja deg eller lesa tidslinja di. Kven han følgjer, ligg ope.</p>',
  ].join('')
}

/** Profile metadata rows. Capped at four, because that is all Mastodon shows. */
function buildAttachments(actorUrl: string) {
  const owner = getOwnerIdentity()
  const fields = []

  if (owner) {
    fields.push(
      field(
        'Eigar',
        `<a href="${escapeHtml(owner.url)}" rel="me">${escapeHtml(owner.handle)}</a>`,
      ),
    )
  }

  // Spelling out the debug-log window rather than a bare "Ingenting": the retention
  // job keeps this honest, and the number tracks the configured window so the claim
  // cannot drift away from what is actually enforced.
  const days = config.ACTIVITY_LOG_RETENTION_DAYS
  fields.push(
    field(
      'Lagrar om deg',
      days > 0 ? `Ingenting — berre ein teknisk logg i ${days} dagar` : 'Berre ein teknisk logg',
    ),
    field('Hentar', 'Offentlege innlegg frå kontoane han følgjer'),
    field(
      'Følgjer',
      `<a href="${actorUrl}/following">Open liste</a>`,
    ),
  )

  return fields
}

export function buildActorDocument() {
  const actorUrl = getActorUrl()
  const owner = getOwnerIdentity()
  const published = getActorPublished()

  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1',
      {
        // Namespaces for the profile-metadata rows and Mastodon's discoverability
        // flag. Mirrors the context Mastodon itself publishes.
        schema: 'http://schema.org#',
        PropertyValue: 'schema:PropertyValue',
        value: 'schema:value',
        toot: 'http://joinmastodon.org/ns#',
        discoverable: 'toot:discoverable',
      },
    ],
    id: actorUrl,
    // Service, not Person: this is a bot, and the type is what makes clients show
    // the "bot" badge instead of presenting it as a human account.
    type: 'Service',
    preferredUsername: config.APP_USERNAME,
    name: config.APP_DISPLAY_NAME,
    summary: buildSummary(),
    url: getProfilePageUrl(),
    ...(published ? { published } : {}),
    // Every Follow is auto-rejected (see handlers/follow.ts). There is no AS2 term
    // for "never followable", so we advertise the closest thing — the padlock — and
    // spell the actual behaviour out in the bio and on the profile page.
    manuallyApprovesFollowers: true,
    discoverable: true,
    ...(owner ? { attributedTo: owner.url } : {}),
    attachment: buildAttachments(actorUrl),
    icon: {
      type: 'Image',
      mediaType: 'image/png',
      url: getAssetUrl('avatar'),
    },
    image: {
      type: 'Image',
      mediaType: 'image/png',
      url: getAssetUrl('header'),
    },
    inbox: `${actorUrl}/inbox`,
    outbox: `${actorUrl}/outbox`,
    followers: `${actorUrl}/followers`,
    following: `${actorUrl}/following`,
    endpoints: {
      sharedInbox: `https://${config.APP_DOMAIN}/inbox`,
    },
    publicKey: {
      id: `${actorUrl}#main-key`,
      owner: actorUrl,
      publicKeyPem: getPublicKeyPem(),
    },
  }
}
