// Bind posts to the train trips they were posted on, across the whole archive.
// Idempotent and diff-based: it writes only what changed, so a second run reports
// zeroes. Nothing is federated and nothing outside `trip_posts` is touched.
// Also runs hourly from the scheduler and after a trip import — this forces it now.
//
//   npm run link-trip-posts
import { linkTripPosts } from '../src/jobs/link-trip-posts.js'
import { logger } from '../src/lib/logger.js'

try {
  const result = await linkTripPosts()
  logger.info({ ...result }, 'Trip/post linking complete')
  process.exit(0)
} catch (e) {
  logger.error(e, 'Trip/post linking failed')
  process.exit(1)
}
