import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { classifyVisibility, isPublishable, publicOnlyCondition } from './visibility.js'

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'
const FOLLOWERS = 'https://skvip.lol/users/markus/followers'

describe('classifyVisibility — the four levels, per platform', () => {
  // Every platform we follow uses the same ActivityStreams convention; these cases
  // are the shapes actually seen from each one.
  const cases: Array<[string, unknown, string]> = [
    ['Mastodon public', { to: [PUBLIC], cc: [FOLLOWERS] }, 'public'],
    ['Mastodon unlisted', { to: [FOLLOWERS], cc: [PUBLIC] }, 'unlisted'],
    ['Mastodon followers-only', { to: [FOLLOWERS], cc: [] }, 'private'],
    ['Mastodon direct', { to: ['https://example.social/users/someone'], cc: [] }, 'private'],
    ['Pixelfed public', { to: [PUBLIC], cc: ['https://pixelfed.babb.no/users/markus/followers'] }, 'public'],
    ['Loops public', { to: [PUBLIC], cc: [] }, 'public'],
    ['NeoDB mark public', { to: [PUBLIC], cc: ['https://minreol.dk/users/markus/followers'] }, 'public'],
    ['BookWyrm generatednote public', { to: [PUBLIC], cc: ['https://bookwyrm.social/user/mvrkws/followers'] }, 'public'],
    ['BookWyrm unlisted', { to: ['https://bookwyrm.social/user/mvrkws/followers'], cc: [PUBLIC] }, 'unlisted'],
    ['BookWyrm followers review', { to: ['https://bookwyrm.social/user/mvrkws/followers'] }, 'private'],
  ]

  for (const [name, raw, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(classifyVisibility(raw)).toBe(expected)
    })
  }
})

describe('classifyVisibility — lexical variants of the Public marker', () => {
  // Which form arrives depends on how the sender compacted its JSON-LD; all three
  // are legal and all three mean the same thing.
  it('accepts the full activitystreams URI', () => {
    expect(classifyVisibility({ to: [PUBLIC] })).toBe('public')
  })

  it('accepts the compacted "as:Public"', () => {
    expect(classifyVisibility({ to: ['as:Public'] })).toBe('public')
  })

  it('accepts the bare "Public"', () => {
    expect(classifyVisibility({ to: ['Public'] })).toBe('public')
  })

  it('accepts a bare string rather than an array', () => {
    expect(classifyVisibility({ to: PUBLIC })).toBe('public')
    expect(classifyVisibility({ cc: PUBLIC, to: [FOLLOWERS] })).toBe('unlisted')
  })

  it('does not match a lookalike that merely contains the marker', () => {
    expect(classifyVisibility({ to: ['https://evil.example/#Public'] })).toBe('private')
    expect(classifyVisibility({ to: [`${PUBLIC}/nope`] })).toBe('private')
  })
})

describe('classifyVisibility — absent addressing is unknown, not public', () => {
  it('returns unknown when neither to nor cc is present', () => {
    expect(classifyVisibility({ type: 'Note', content: 'hei' })).toBe('unknown')
  })

  it('returns unknown for a null or non-object raw', () => {
    expect(classifyVisibility(null)).toBe('unknown')
    expect(classifyVisibility(undefined)).toBe('unknown')
    expect(classifyVisibility('a string')).toBe('unknown')
    expect(classifyVisibility(42)).toBe('unknown')
    expect(classifyVisibility([{ to: [PUBLIC] }])).toBe('unknown')
  })

  it('treats a present-but-empty addressing field as private, not unknown', () => {
    // The sender told us who it was for; the answer just wasn't "everyone".
    expect(classifyVisibility({ to: [] })).toBe('private')
    expect(classifyVisibility({ cc: [] })).toBe('private')
    expect(classifyVisibility({ to: null })).toBe('private')
  })
})

describe('classifyVisibility — fails closed', () => {
  // The property that matters more than any single case above: no input that is not
  // an unambiguous public address may ever classify as publishable. If a future
  // refactor loosens the rule, this is what catches it.
  const adversarial: unknown[] = [
    null,
    undefined,
    0,
    1,
    '',
    'Public',
    PUBLIC,
    [],
    [PUBLIC],
    {},
    { to: null },
    { to: undefined },
    { to: 42 },
    { to: {} },
    { to: [null] },
    { to: [undefined] },
    { to: [42] },
    { to: [{ id: PUBLIC }] },
    { to: [['nested', PUBLIC]] },
    { to: { id: PUBLIC } },
    { to: 'public' },
    { to: 'PUBLIC' },
    { to: 'as:public' },
    { to: ['as:public'] },
    { to: ['#Public'] },
    { to: ['public'] },
    { to: [' Public'] },
    { to: ['Public '] },
    { to: [FOLLOWERS] },
    { cc: [PUBLIC] },
    { to: [FOLLOWERS], cc: [PUBLIC] },
    { To: [PUBLIC] },
    { audience: [PUBLIC] },
    { bto: [PUBLIC] },
    { bcc: [PUBLIC] },
    { raw: { to: [PUBLIC] } },
    Object.create({ to: [PUBLIC] }),
  ]

  for (const [i, input] of adversarial.entries()) {
    it(`case ${i} is not publishable: ${JSON.stringify(input) ?? String(input)}`, () => {
      expect(isPublishable(classifyVisibility(input))).toBe(false)
    })
  }

  it('only "public" is publishable', () => {
    expect(isPublishable('public')).toBe(true)
    expect(isPublishable('unlisted')).toBe(false)
    expect(isPublishable('private')).toBe(false)
    expect(isPublishable('unknown')).toBe(false)
  })
})

describe('publicOnlyCondition', () => {
  // Render the fragment without a connection, the way media-query.test.ts asserts
  // on query shape.
  const render = (frag: ReturnType<typeof publicOnlyCondition>) =>
    new PgDialect().sqlToQuery(frag).sql

  it('restricts to public by default', () => {
    const rendered = render(publicOnlyCondition())
    expect(rendered).toContain("'public'")
    expect(rendered).not.toContain("'unlisted'")
  })

  it('admits unlisted only when explicitly asked', () => {
    const rendered = render(publicOnlyCondition(true))
    expect(rendered).toContain("'public'")
    expect(rendered).toContain("'unlisted'")
  })

  it('names the visibility column, so it cannot silently target something else', () => {
    expect(render(publicOnlyCondition())).toContain('"visibility"')
  })
})
