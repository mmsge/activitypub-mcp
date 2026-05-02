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
