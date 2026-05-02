import { config, getActorUrl } from '../config.js'
import { getPublicKeyPem } from '../crypto/keys.js'

export function buildActorDocument() {
  const actorUrl = getActorUrl()
  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1',
    ],
    id: actorUrl,
    type: 'Person',
    preferredUsername: config.APP_USERNAME,
    name: config.APP_DISPLAY_NAME,
    summary: 'Personal ActivityPub bot. Follows and archives public posts.',
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
