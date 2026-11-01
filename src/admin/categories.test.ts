import { describe, it, expect } from 'vitest'
import { CATEGORIES, redirectFor, resolveTab, categoryHref } from './categories.js'

const go = (url: string) => {
  const u = new URL(url, 'https://bot.example')
  return redirectFor(u.pathname, u.searchParams)
}

describe('redirectFor', () => {
  it('sends each old media tab to its category tab', () => {
    expect(go('/admin/media')).toBe('/admin/k/lesing?tab=boker')
    expect(go('/admin/media?tab=watched')).toBe('/admin/k/sjaaing?tab=film')
    expect(go('/admin/media?tab=gigs')).toBe('/admin/k/musikk?tab=konsertar')
    expect(go('/admin/media?tab=theatre')).toBe('/admin/k/sjaaing?tab=teater')
  })

  it('keeps the filters of a bookmarked view', () => {
    expect(go('/admin/media?tab=watched&category=movie&page=2'))
      .toBe('/admin/k/sjaaing?tab=film&category=movie&page=2')
    expect(go('/admin/objects?q=tog&actor=https%3A%2F%2Fskvip.lol%2Fusers%2Fmarkus'))
      .toBe('/admin/k/fediverse?q=tog&actor=https%3A%2F%2Fskvip.lol%2Fusers%2Fmarkus&tab=innlegg')
  })

  it('carves games, albums and podcasts out of Other media, and keeps the rest whole', () => {
    expect(go('/admin/media?tab=other&category=game')).toBe('/admin/k/sjaaing?tab=spel')
    expect(go('/admin/media?tab=other&category=music')).toBe('/admin/k/musikk?tab=album')
    expect(go('/admin/media?tab=other&category=podcast&health=failed')).toBe('/admin/k/musikk?tab=podkastar&health=failed')
    expect(go('/admin/media?tab=other&category=book')).toBe('/admin/k/sjaaing?tab=katalog&category=book')
  })

  it('moves every old page', () => {
    for (const [from, to] of [
      ['/admin/activities', '/admin/k/fediverse?tab=aktivitetar'],
      ['/admin/follows', '/admin/k/fediverse?tab=folgjer'],
      ['/admin/threads', '/admin/k/fediverse?tab=traadar'],
      ['/admin/breakouts', '/admin/k/fediverse?tab=breakouts'],
      ['/admin/visibility', '/admin/k/fediverse?tab=synlegheit'],
      ['/admin/stations', '/admin/k/reiser?tab=stasjonar'],
      ['/admin/linkedin', '/admin/k/linkedin?tab=status'],
      ['/admin/tools', '/admin/k/system?tab=verktoy'],
    ]) expect(go(from!)).toBe(to)
  })

  it('leaves anything else alone', () => {
    expect(go('/admin/logs')).toBeNull()
    expect(go('/admin/import')).toBeNull()
  })
})

describe('resolveTab', () => {
  it('falls back to the first tab', () => {
    expect(resolveTab('musikk', 'nope')?.tab.id).toBe('scrobblar')
    expect(resolveTab('musikk', undefined)?.tab.id).toBe('scrobblar')
  })

  it('knows no category it was not given', () => {
    expect(resolveTab('nope', 'x')).toBeNull()
  })
})

describe('the registry', () => {
  it('has seven categories with unique tab ids each', () => {
    expect(CATEGORIES).toHaveLength(7)
    for (const c of CATEGORIES) expect(new Set(c.tabs.map((t) => t.id)).size).toBe(c.tabs.length)
  })

  it('builds hrefs with the tab first', () => {
    expect(categoryHref('reiser', 'stasjonar', { notice: 'ok' })).toBe('/admin/k/reiser?tab=stasjonar&notice=ok')
  })
})

import { IMPORT_KINDS } from './import-kinds.js'

describe('imports listed under a category', () => {
  it('each name an import page that exists, in the same category', () => {
    for (const c of CATEGORIES) {
      for (const i of c.imports) {
        expect(IMPORT_KINDS.find((k) => k.id === i.anchor)?.category).toBe(c.id)
      }
    }
  })

  it('cover every import', () => {
    const listed = new Set(CATEGORIES.flatMap((c) => c.imports.map((i) => i.anchor)))
    for (const k of IMPORT_KINDS) expect(listed.has(k.id)).toBe(true)
  })
})
