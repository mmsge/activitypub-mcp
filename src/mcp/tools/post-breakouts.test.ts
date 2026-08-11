import { describe, it, expect } from 'vitest'
import { armedPosts } from './post-breakouts.js'
import {
  breakoutThresholds, breakoutWeightsKey,
  type BreakoutBaseline, type BreakoutPost, type BreakoutState,
} from '../../lib/post-breakout.js'

const KEY = breakoutWeightsKey({ favourites: 1, reblogs: 3, replies: 2 })
const ACTOR = 'https://skvip.lol/users/markus'
const OPTS = { minPosts: 20, minScore: 10 }

const baseline = (over: Partial<BreakoutBaseline> = {}): BreakoutBaseline => ({
  actorApId: ACTOR, actor: '@markus@skvip.lol',
  n: 200, windowDays: 90, median: 6, p90: 24, p99: 58,
  best: 88, bestApId: 'https://skvip.lol/x/old', secondBest: 74,
  ...over,
})

const post = (over: Partial<BreakoutPost> = {}): BreakoutPost => ({
  apId: 'https://skvip.lol/x/1', actorApId: ACTOR,
  url: 'https://skvip.lol/@markus/1',
  publishedAt: new Date('2026-08-10T09:00:00Z'),
  text: 'Toget står stille på Finse igjen.',
  visibility: 'public',
  favourites: 30, reblogs: 0, replies: 0,
  peak: 30, score: 30,
  ...over,
})

const state = (over: Partial<BreakoutState> = {}): BreakoutState => ({
  score: 5, peakScore: 5, rung: null, rungScore: null,
  p90At: null, p99At: null, bestAt: null, weightsKey: KEY,
  ...over,
})

const T = (b = baseline()) => breakoutThresholds(b, OPTS)

describe('armedPosts', () => {
  it('lists a post that clears a rung nothing has been announced for', () => {
    const p = post()
    const armed = armedPosts([p], new Map([[p.apId, state()]]), baseline(), OPTS, 20)

    expect(armed).toHaveLength(1)
    expect(armed[0].would_fire).toBe('p90')
    expect(armed[0].spent_rung).toBeNull()
  })

  it('leaves out a post that has already been announced that far', () => {
    const p = post()
    const spent = state({ rung: 'p90', peakScore: p.peak, p90At: new Date() })
    expect(armedPosts([p], new Map([[p.apId, spent]]), baseline(), OPTS, 20)).toEqual([])
  })

  it('still lists a post that has climbed past the rung it already spent', () => {
    const t = T()
    const p = post({ peak: t.p99, score: t.p99 })
    const spent = state({ rung: 'p90', peakScore: t.p90, p90At: new Date() })

    const armed = armedPosts([p], new Map([[p.apId, spent]]), baseline(), OPTS, 20)

    expect(armed[0].would_fire).toBe('p99')
    expect(armed[0].spent_rung).toBe('p90')
  })

  it('leaves out a post the notifier has never seen', () => {
    // An unseen post SEEDS silently rather than firing, so listing it as armed would
    // promise a push that is never coming.
    const p = post({ peak: 500, score: 500 })
    expect(armedPosts([p], new Map(), baseline(), OPTS, 20)).toEqual([])
  })

  it('leaves out a post that clears nothing', () => {
    const p = post({ favourites: 2, peak: 2, score: 2 })
    expect(armedPosts([p], new Map([[p.apId, state()]]), baseline(), OPTS, 20)).toEqual([])
  })

  it('is empty for an account whose baseline is not established', () => {
    const p = post()
    const armed = armedPosts([p], new Map([[p.apId, state()]]), baseline({ n: 8 }), OPTS, 20)
    expect(armed).toEqual([])
  })

  it('judges the record rung against the runner-up when the post holds the record', () => {
    // Otherwise the record holder would have to beat a number it set itself, and could
    // never be reported as armed to extend its own record.
    const p = post({ peak: 80, score: 80 })
    const b = baseline({ best: 88, bestApId: p.apId, secondBest: 74 })

    const armed = armedPosts([p], new Map([[p.apId, state()]]), b, OPTS, 20)

    expect(armed[0].would_fire).toBe('best') // 80 > secondBest 74, not measured against 88
  })

  it('reports the peak, not the withdrawn current score', () => {
    const p = post({ peak: 60, score: 12 })
    const armed = armedPosts([p], new Map([[p.apId, state()]]), baseline(), OPTS, 20)

    expect(armed[0].peak_score).toBe(60)
    expect(armed[0].score).toBe(12)
  })

  it('puts the biggest first and honours the limit', () => {
    const posts = [
      post({ apId: 'a', peak: 30, score: 30 }),
      post({ apId: 'b', peak: 70, score: 70 }),
      post({ apId: 'c', peak: 50, score: 50 }),
    ]
    const states = new Map(posts.map(p => [p.apId, state()]))

    const armed = armedPosts(posts, states, baseline(), OPTS, 2)

    expect(armed.map(a => a.status_ap_id)).toEqual(['b', 'c'])
  })
})
