import { describe, it, expect } from 'vitest'
import { adminRouter } from './router.js'
import { kick } from './media-router.js'

// The Media routes are merged into the admin app *after* `app.use('/*', requireAuth)`.
// Get that ordering wrong and the whole media section — every row, every sync button —
// is served to anyone who asks, with no error anywhere to notice. Nothing else in the
// codebase would catch it, so it is pinned here.
describe('media routes are behind the session gate', () => {
  const cases = [
    ['GET', '/admin/media'],
    ['GET', '/admin/media?tab=watched'],
    ['POST', '/admin/media/sync'],
    ['POST', '/admin/media/reenrich'],
    ['POST', '/admin/media/retry-failed'],
  ] as const

  for (const [method, path] of cases) {
    it(`${method} ${path} redirects to the login page without a session cookie`, async () => {
      const res = await adminRouter.request(path.replace('/admin', ''), { method })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/admin/login')
    })
  }
})

// The sync buttons are detached, so nothing else stops a double-click, an F5 on the
// redirect, or a second admin tab from starting the same outbound-fetch job three times
// over. In production these jobs run for tens of seconds, which is exactly the window
// this guard covers — and exactly the window a live test can't reproduce, since the jobs
// bail out instantly without API credentials.
describe('sync in-flight guard', () => {
  it('refuses a second start while the first is still running, then frees the slot', async () => {
    let release!: () => void
    const blocked = new Promise<void>((r) => { release = r })

    expect(kick('test-job', () => blocked)).toBe('started')
    expect(kick('test-job', () => blocked)).toBe('already running')
    expect(kick('test-job', () => blocked)).toBe('already running')

    // A different job is unaffected — the guard is per-job, not global.
    expect(kick('other-job', async () => {})).toBe('started')

    release()
    await blocked
    await new Promise((r) => setTimeout(r, 0)) // let the .finally() settle
    expect(kick('test-job', async () => {})).toBe('started')
  })

  it('frees the slot even when the job throws', async () => {
    expect(kick('failing-job', async () => { throw new Error('boom') })).toBe('started')
    await new Promise((r) => setTimeout(r, 0))
    expect(kick('failing-job', async () => {})).toBe('started')
  })
})
