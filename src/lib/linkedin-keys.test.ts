// LinkedIn documents the snapshotData key names for exactly one domain, and the
// endpoint is pinned to version 202312 forever — so there is no version bump that
// would announce a rename. These tests pin the tolerance that stands in for the
// documentation we don't have, and the UTC assumption in pickDate, which is the
// one place a silent two-hour drift could move a post into the wrong weekday
// bucket and quietly corrupt the whole point of the stats tool.
import { describe, it, expect } from 'vitest'
import { normaliseKey, normaliseRecord, pick, pickBoolean, pickDate } from './linkedin-keys.js'

describe('normaliseKey', () => {
  it('collapses the spellings LinkedIn might use for one field', () => {
    const spellings = ['Shared URL', 'SharedUrl', 'shared_url', 'shared url', 'SHARED-URL']
    expect(new Set(spellings.map(normaliseKey)).size).toBe(1)
    expect(normaliseKey('Shared URL')).toBe('sharedurl')
  })
})

describe('normaliseRecord', () => {
  it('re-keys a snapshotData entry as it actually arrives, spaces and all', () => {
    const record = { 'First Name': 'Markus', 'Shared URL': 'https://example.com' }
    expect(normaliseRecord(record)).toEqual({
      firstname: 'Markus',
      sharedurl: 'https://example.com',
    })
  })
})

describe('pick', () => {
  const record = normaliseRecord({
    Date: '2026-05-21 08:04:13',
    ShareLink: 'https://www.linkedin.com/feed/update/urn:li:activity:7462903540748034050',
    'Share Commentary': 'Ein tekst',
    Visibility: 'PUBLIC',
    'Shared URL': '',
  })

  it('finds a field however the alias is written', () => {
    expect(pick(record, 'Share Commentary')).toBe('Ein tekst')
    expect(pick(record, 'shareCommentary')).toBe('Ein tekst')
    expect(pick(record, 'share_commentary')).toBe('Ein tekst')
  })

  it('falls through aliases in order until one has a value', () => {
    expect(pick(record, 'Post URL', 'ShareLink')).toBe(
      'https://www.linkedin.com/feed/update/urn:li:activity:7462903540748034050',
    )
  })

  it('treats an empty string as absent — LinkedIn blanks fields rather than omitting them', () => {
    expect(pick(record, 'Shared URL')).toBeNull()
  })

  it('returns null when nothing matches, rather than the literal alias', () => {
    expect(pick(record, 'Nothing At All')).toBeNull()
  })
})

describe('pickBoolean', () => {
  it('reads both spellings LinkedIn uses', () => {
    expect(pickBoolean(normaliseRecord({ ReshareFlag: 'Yes' }), 'ReshareFlag')).toBe(true)
    expect(pickBoolean(normaliseRecord({ ReshareFlag: 'true' }), 'ReshareFlag')).toBe(true)
    expect(pickBoolean(normaliseRecord({ ReshareFlag: 'No' }), 'ReshareFlag')).toBe(false)
  })

  it('defaults to false when unreadable — an unreadable flag is not evidence', () => {
    expect(pickBoolean(normaliseRecord({}), 'ReshareFlag')).toBe(false)
    expect(pickBoolean(normaliseRecord({ ReshareFlag: 'perhaps' }), 'ReshareFlag')).toBe(false)
  })
})

describe('pickDate', () => {
  it('reads the zoneless stamp as UTC, not as container-local time', () => {
    const d = pickDate(normaliseRecord({ Date: '2026-05-21 08:04:13' }), 'Date')
    expect(d?.toISOString()).toBe('2026-05-21T08:04:13.000Z')
  })

  it('reads the zoneless stamp identically whether spelled with a space or a T', () => {
    const a = pickDate(normaliseRecord({ Date: '2026-05-21 08:04:13' }), 'Date')
    const b = pickDate(normaliseRecord({ Date: '2026-05-21T08:04:13' }), 'Date')
    expect(a?.toISOString()).toBe(b?.toISOString())
  })

  it('honours an explicit offset when one is present', () => {
    const d = pickDate(normaliseRecord({ Date: '2026-05-21T08:04:13+02:00' }), 'Date')
    expect(d?.toISOString()).toBe('2026-05-21T06:04:13.000Z')
  })

  it('returns null for an unparseable or missing date', () => {
    expect(pickDate(normaliseRecord({ Date: 'whenever' }), 'Date')).toBeNull()
    expect(pickDate(normaliseRecord({}), 'Date')).toBeNull()
  })
})
