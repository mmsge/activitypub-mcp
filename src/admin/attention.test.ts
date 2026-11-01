import { describe, it, expect } from 'vitest'
import { attentionItems, actorHandle, type AttentionInput } from './attention.js'

const quiet: AttentionInput = {
  linkedinStatus: 'ok',
  linkedinLastSuccessAt: new Date('2026-10-28T08:00:00Z'),
  linkedinLastHttpStatus: 200,
  deliveryErrors24h: 0,
  failedEnrichment: 0,
  pendingFollowActors: [],
}

describe('attentionItems', () => {
  it('is empty when nothing is wrong, so Oversikt shows the all-clear', () => {
    expect(attentionItems(quiet)).toEqual([])
  })

  it('flags a refused LinkedIn token red, with when it last worked and the status', () => {
    const [li] = attentionItems({ ...quiet, linkedinStatus: 'unauthorized', linkedinLastHttpStatus: 401 })
    expect(li).toMatchObject({ id: 'linkedin', tone: 'red', href: '/admin/linkedin' })
    expect(li!.sub).toBe('Sist OK 28. okt. · HTTP 401')
  })

  it('does not raise stale or awaiting LinkedIn data, only a refused token', () => {
    expect(attentionItems({ ...quiet, linkedinStatus: 'stale' })).toEqual([])
    expect(attentionItems({ ...quiet, linkedinStatus: 'awaiting_data' })).toEqual([])
  })

  it('links delivery errors to the outbound logs', () => {
    const [d] = attentionItems({ ...quiet, deliveryErrors24h: 3 })
    expect(d).toMatchObject({ id: 'delivery', tone: 'red', title: '3 leveringsfeil', href: '/admin/logs?direction=outbound' })
  })

  it('names the first pending follow and counts the rest', () => {
    const [f] = attentionItems({
      ...quiet,
      pendingFollowActors: ['https://bookwyrm.social/user/reader', 'https://neodb.social/users/x'],
    })
    expect(f).toMatchObject({ id: 'follows', tone: 'yellow', title: '2 følgjer ventar', sub: '@reader@bookwyrm.social, +1' })
  })

  it('orders red before yellow', () => {
    const items = attentionItems({
      ...quiet,
      linkedinStatus: 'unauthorized',
      deliveryErrors24h: 1,
      failedEnrichment: 12,
      pendingFollowActors: ['https://a.example/users/b'],
    })
    expect(items.map((i) => i.tone)).toEqual(['red', 'red', 'yellow', 'yellow'])
    expect(items[2]!.title).toBe('12 feila berikingar')
  })
})

describe('actorHandle', () => {
  it('turns an actor URL into @user@host', () => {
    expect(actorHandle('https://skvip.lol/users/markus')).toBe('@markus@skvip.lol')
    expect(actorHandle('https://bookwyrm.social/user/mvrkws')).toBe('@mvrkws@bookwyrm.social')
  })

  it('leaves something that is not a URL alone', () => {
    expect(actorHandle('not a url')).toBe('not a url')
  })
})
