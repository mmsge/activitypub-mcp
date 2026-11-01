/** @jsxImportSource hono/jsx */
import { describe, it, expect } from 'vitest'
import { DashboardPage, categoryKeys, type DashboardData } from './dashboard.js'
import { LoginPage } from './login.js'

const data = (over: Partial<DashboardData> = {}): DashboardData => ({
  linkedinStatus: 'ok',
  linkedinLastSuccessAt: null,
  linkedinLastHttpStatus: null,
  deliveryErrors24h: 0,
  failedEnrichment: 0,
  pendingFollowActors: [],
  activitiesLast24h: 142,
  activitiesLast7d: 1038,
  recentActivities: [],
  totalObjects: 48219,
  media: { books: 312, films: 640, tv: 118 },
  scrobbles: 98140,
  trips: 186,
  linkedinPosts: 52,
  ...over,
})

describe('DashboardPage (Oversikt)', () => {
  it('shows the all-clear card when nothing needs attention', () => {
    const html = String(DashboardPage({ data: data() }))
    expect(html).toContain('Ingenting treng merksemd')
    expect(html).not.toContain('class="count-pill"')
  })

  it('renders a card per problem with a count and a deep link', () => {
    const html = String(DashboardPage({ data: data({ deliveryErrors24h: 3 }) }))
    expect(html).toContain('<span class="count-pill">1</span>')
    expect(html).toContain('href="/admin/logs?f=ut"')
    // The explanation is folded away behind the ⓘ by default.
    expect(html).toContain('<input type="checkbox" class="hx-toggle" id="help-delivery"/>')
    expect(html).toContain('<label class="hx-btn" for="help-delivery"')
  })

  it('has a tile for every category, linking where the category opens today', () => {
    const html = String(DashboardPage({ data: data() }))
    for (const label of ['Lesing', 'Sjåing', 'Musikk', 'Reiser', 'Fediverse', 'LinkedIn', 'System']) {
      expect(html).toContain(`<span class="tile-name">${label}</span>`)
    }
  })

  it('marks Oversikt active in the bottom bar', () => {
    const html = String(DashboardPage({ data: data() }))
    expect(html).toContain('<a href="/admin" class="active" aria-current="page">')
  })
})

describe('categoryKeys', () => {
  it('formats numbers the Norwegian way', () => {
    const keys = categoryKeys(data())
    expect(keys.fediverse).toBe('48 219 innlegg')
    expect(keys.sjaaing).toBe('758 titlar')
  })
})

describe('LoginPage', () => {
  it('posts to the same endpoint and shows the error in nynorsk', () => {
    const html = String(LoginPage({ error: 'Feil passord.' }))
    expect(html).toContain('action="/admin/login"')
    expect(html).toContain('Feil passord.')
    expect(html).toContain('Logg inn')
  })
})
