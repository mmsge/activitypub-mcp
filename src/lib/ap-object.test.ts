import { describe, it, expect } from 'vitest'
import { objectApId, resolveRef, isBareReference } from './ap-object.js'

describe('objectApId', () => {
  it('reads `id`, falling back to the JSON-LD `@id`', () => {
    expect(objectApId({ id: 'https://a/1' })).toBe('https://a/1')
    expect(objectApId({ '@id': 'https://a/2' })).toBe('https://a/2')
  })

  it('is null for anything without a usable id', () => {
    expect(objectApId({ type: 'Note' })).toBeNull()
    expect(objectApId({ id: '  ' })).toBeNull()
    expect(objectApId('https://a/1')).toBeNull()
    expect(objectApId(null)).toBeNull()
  })
})

describe('resolveRef', () => {
  it('resolves a link-valued property whether it is a URI, an object or a list', () => {
    expect(resolveRef('https://minreol.dk/@markus@minreol.dk/')).toBe('https://minreol.dk/@markus@minreol.dk/')
    expect(resolveRef({ id: 'https://minreol.dk/@markus@minreol.dk/', type: 'Person' }))
      .toBe('https://minreol.dk/@markus@minreol.dk/')
    expect(resolveRef([{ type: 'Person' }, 'https://skvip.lol/users/markus']))
      .toBe('https://skvip.lol/users/markus')
  })

  it('reads a Link’s href, so a `url` sent as an object still stores as a URL', () => {
    expect(resolveRef({ type: 'Link', href: 'https://minreol.dk/@markus/posts/1/', mediaType: 'text/html' }))
      .toBe('https://minreol.dk/@markus/posts/1/')
  })

  it('is null when there is nothing to resolve', () => {
    expect(resolveRef(undefined)).toBeNull()
    expect(resolveRef('')).toBeNull()
    expect(resolveRef([])).toBeNull()
    expect(resolveRef({ type: 'Person' })).toBeNull()
  })
})

describe('isBareReference', () => {
  it('is true for a pointer with nothing worth storing', () => {
    expect(isBareReference({ id: 'https://minreol.dk/posts/1/', type: 'Note' })).toBe(true)
    expect(isBareReference(null)).toBe(true)
  })

  it('is false as soon as the object carries text, structure or a timestamp', () => {
    expect(isBareReference({ id: 'x', content: '<p>hi</p>' })).toBe(false)
    expect(isBareReference({ id: 'x', contentMap: { en: '<p>hi</p>' } })).toBe(false)
    expect(isBareReference({ id: 'x', published: '2016-04-27T12:00:00Z' })).toBe(false)
    // A mark with no prose is still a real object: its tag and Status carry everything.
    expect(isBareReference({ id: 'x', tag: { type: 'Movie', href: 'https://minreol.dk/movie/a' } })).toBe(false)
    expect(isBareReference({ id: 'x', relatedWith: { type: 'Status', withRegardTo: 'y' } })).toBe(false)
  })
})
