import { describe, it, expect } from 'vitest'
import { serviceLabel } from './fetch-nodeinfo.js'

describe('serviceLabel', () => {
  it('maps known software to a prettified service name', () => {
    expect(serviceLabel('mastodon')).toBe('Mastodon')
    expect(serviceLabel('pixelfed')).toBe('Pixelfed')
    expect(serviceLabel('bookwyrm')).toBe('BookWyrm')
    expect(serviceLabel('loops')).toBe('Loops')
    expect(serviceLabel('gotosocial')).toBe('GoToSocial')
  })

  it('Title-cases unmapped software rather than dropping it', () => {
    expect(serviceLabel('funkwhale')).toBe('Funkwhale')
  })

  it('returns null for null/undefined/empty', () => {
    expect(serviceLabel(null)).toBeNull()
    expect(serviceLabel(undefined)).toBeNull()
    expect(serviceLabel('')).toBeNull()
  })
})
