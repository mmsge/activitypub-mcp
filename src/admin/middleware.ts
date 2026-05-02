import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import { validateSession } from './auth.js'

export const requireAuth = createMiddleware(async (c, next) => {
  const token = getCookie(c, 'session')
  if (!token || !(await validateSession(token))) {
    return c.redirect('/admin/login')
  }
  await next()
})
