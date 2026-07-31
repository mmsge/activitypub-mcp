export const AP_CONTENT_TYPES = [
  'application/activity+json',
  'application/ld+json',
]

export function isActivityPubRequest(accept: string): boolean {
  return AP_CONTENT_TYPES.some(ct => accept.includes(ct))
}

export const AP_HEADERS = {
  'Content-Type': 'application/activity+json; charset=utf-8',
}

/** For the routes that answer either the ActivityPub document or the HTML page
 *  depending on `Accept`. Without `Vary` a shared cache between us and the caller is
 *  free to hand a fediverse server the page a browser asked for, and vice versa. */
export const AP_HEADERS_NEGOTIATED = {
  ...AP_HEADERS,
  Vary: 'Accept',
}

export const HTML_HEADERS_NEGOTIATED = {
  Vary: 'Accept',
}
