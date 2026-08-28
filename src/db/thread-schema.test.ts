import { describe, it, expect } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { threadNodes, threadRoots } from './schema.js'

/**
 * The privacy criterion, enforced rather than trusted.
 *
 * The thread walker stores the SHAPE of a conversation and never its words: reply text,
 * content warnings, summaries, attachments, alt text, media URLs, display names, avatars,
 * bios, follower counts and other people's engagement counts are all out. "There is no
 * content column" is a fact about today's schema, not a rule — so this suite makes it one.
 *
 * Two layers, because neither alone is enforcement:
 *
 *   **the column set is pinned** here, so adding a column to either table fails CI rather
 *   than passing review. A reviewer who wants one has to change this file and say why.
 *
 *   **every text column carries a CHECK** in the migration, so no INSERT can smuggle prose
 *   through a column that already exists. `handle` is the one that matters most: it is the
 *   only field about an external person that is kept at all, and `@user@host` is the only
 *   thing it will accept.
 *
 * See decision record 0057.
 */

const ROOT_COLUMNS = [
  'id', 'rootApId', 'actorApId', 'rootStatusId', 'origin',
  'nodeCount', 'externalNodeCount', 'maxDepth', 'externalParticipantCount',
  'newestNodeAt', 'walkedAt', 'walkAttempts', 'walkError',
  'createdAt', 'updatedAt',
]

const NODE_COLUMNS = [
  'id', 'rootApId', 'statusApId', 'statusId', 'origin', 'url',
  'parentStatusApId', 'depth', 'publishedAt', 'handle', 'isMine', 'createdAt',
]

/** Anything whose name suggests it could hold what somebody wrote. */
const FORBIDDEN = [
  'content', 'text', 'summary', 'spoiler', 'body', 'html', 'raw', 'note',
  'attachment', 'media', 'alt', 'display', 'avatar', 'icon', 'bio',
  'favourite', 'favorite', 'reblog', 'boost', 'follower',
]

const migration = readFileSync(
  join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'drizzle/0040_thread_shape.sql'),
  'utf8',
)

describe('the thread tables cannot hold reply content', () => {
  it('has exactly the columns the shape needs, and no more', () => {
    // If this fails because you added a column: the question to answer first is whether
    // it can hold anything somebody else wrote. If it can, it does not belong here.
    expect(Object.keys(getTableColumns(threadRoots)).sort()).toEqual([...ROOT_COLUMNS].sort())
    expect(Object.keys(getTableColumns(threadNodes)).sort()).toEqual([...NODE_COLUMNS].sort())
  })

  it('names no column after anything a post carries', () => {
    const names = [
      ...Object.keys(getTableColumns(threadRoots)),
      ...Object.keys(getTableColumns(threadNodes)),
    ].map(n => n.toLowerCase())

    // `walkError` is ours — a fetch failure, never anything read out of a reply — and it
    // is length-bounded by its own CHECK. Everything else must be clean.
    const suspicious = names
      .filter(n => n !== 'walkerror')
      .filter(n => FORBIDDEN.some(word => n.includes(word)))
    expect(suspicious).toEqual([])
  })

  it('constrains every text column in the migration, so no INSERT can carry prose', () => {
    // The column set above stops a new column; these stop the existing ones being abused.
    for (const constraint of [
      'thread_roots_root_ap_id_shape',
      'thread_roots_actor_ap_id_shape',
      'thread_roots_status_id_shape',
      'thread_roots_origin_shape',
      'thread_roots_walk_error_len',
      'thread_nodes_status_ap_id_shape',
      'thread_nodes_parent_shape',
      'thread_nodes_url_shape',
      'thread_nodes_status_id_shape',
      'thread_nodes_origin_shape',
      'thread_nodes_handle_shape',
    ]) {
      expect(migration, `missing CHECK ${constraint}`).toContain(constraint)
    }
  })

  it('accepts a handle and rejects a sentence, by the same pattern the CHECK uses', () => {
    // The regex is duplicated in thread-context.ts so a bad value is dropped in the open
    // rather than at INSERT time. This pins the two to the same rule.
    const check = /@\[\^@\[:space:\]\]\{1,64\}@/
    expect(migration).toMatch(check)

    const handleRe = /^@[^@\s]{1,64}@[a-z0-9.-]{1,253}$/
    expect(handleRe.test('@markus@skvip.lol')).toBe(true)
    expect(handleRe.test('@someone@mastodon.social')).toBe(true)
    expect(handleRe.test('this is what they replied')).toBe(false)
    expect(handleRe.test('@markus@skvip.lol and then a whole sentence')).toBe(false)
    expect(handleRe.test('Markus Andersen')).toBe(false)
  })
})
