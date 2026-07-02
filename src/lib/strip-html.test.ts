import { describe, it, expect } from 'vitest'
import { stripHtml } from './strip-html.js'

describe('stripHtml', () => {
  it('strips tags and converts <br> and </p> to newlines', () => {
    expect(stripHtml('<p>Hei<br>der</p><p>Ny avsnitt</p>')).toBe('Hei\nder\nNy avsnitt')
  })

  it('decodes the basic entities', () => {
    expect(stripHtml('&amp; &lt; &gt; &quot; &#39; a&nbsp;b')).toBe(`& < > " ' a b`)
  })

  it('decodes Norwegian named entities', () => {
    expect(stripHtml('bl&aring;b&aelig;rsyltet&oslash;y p&aring; &Oslash;ya')).toBe(
      'blåbærsyltetøy på Øya'
    )
  })

  it('decodes decimal and hex numeric entities', () => {
    expect(stripHtml('bl&#229;b&#230;rsyltet&#248;y &#x2019;quote&#x2019;')).toBe(
      'blåbærsyltetøy ’quote’'
    )
    // HTML allows a capital X in hex references.
    expect(stripHtml('caf&#XE9;')).toBe('café')
  })

  it('decodes typography entities', () => {
    expect(stripHtml('a&mdash;b &hellip; &laquo;sitat&raquo;')).toBe('a—b … «sitat»')
  })

  it('never double-decodes escaped entities', () => {
    // &amp;lt; is the literal text "&lt;", not "<".
    expect(stripHtml('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;')
  })

  it('leaves unknown and invalid entities as literal text', () => {
    expect(stripHtml('&unknownentity; &#xFFFFFFFF; &#0;')).toBe(
      '&unknownentity; &#xFFFFFFFF; &#0;'
    )
  })

  it('collapses runs of blank lines and trims', () => {
    expect(stripHtml('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb')
  })
})
