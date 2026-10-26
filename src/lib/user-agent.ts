import { config } from '../config.js'

// The service's name as other servers see it (ADR 0070). Every outbound User-Agent
// starts with it, and the contact URL stays: it is how a remote admin traces our
// requests back to us (ADR 0058).
export const SOFTWARE_NAME = 'markivaren'
export const USER_AGENT = `${SOFTWARE_NAME}/1.0 (+https://${config.APP_DOMAIN})`
