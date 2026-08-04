import { describe, it, expect } from 'vitest'
import { sanitizeHtml } from './sanitize-html.js'

describe('sanitizeHtml — keeps what fediverse posts are made of', () => {
  it('keeps paragraphs, breaks and inline emphasis', () => {
    expect(sanitizeHtml('<p>Hei <strong>der</strong><br>og <em>hei</em></p>'))
      .toBe('<p>Hei <strong>der</strong><br>og <em>hei</em></p>')
  })

  it('keeps lists, quotes and code', () => {
    expect(sanitizeHtml('<ul><li>ein</li><li>to</li></ul>')).toBe('<ul><li>ein</li><li>to</li></ul>')
    expect(sanitizeHtml('<blockquote><p>sitat</p></blockquote>'))
      .toBe('<blockquote><p>sitat</p></blockquote>')
    expect(sanitizeHtml('<pre><code>npm test</code></pre>')).toBe('<pre><code>npm test</code></pre>')
  })

  it('keeps an https link and marks it as republished content', () => {
    const out = sanitizeHtml('<a href="https://example.com/a">lenke</a>')
    expect(out).toContain('href="https://example.com/a"')
    expect(out).toContain('rel="nofollow noopener noreferrer ugc"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('lenke</a>')
  })

  it('preserves Norwegian text and existing entities', () => {
    expect(sanitizeHtml('<p>Ø, æ og å &amp; meir</p>')).toBe('<p>Ø, æ og å &amp; meir</p>')
  })

  it('is idempotent', () => {
    const once = sanitizeHtml('<p>Hei <a href="https://a.example">x</a></p>')
    expect(sanitizeHtml(once)).toBe(once)
  })

  it('handles empty input', () => {
    expect(sanitizeHtml('')).toBe('')
    expect(sanitizeHtml(null)).toBe('')
    expect(sanitizeHtml(undefined)).toBe('')
  })
})

describe('sanitizeHtml — drops everything else', () => {
  it('removes a script and its contents', () => {
    const out = sanitizeHtml('<p>før</p><script>alert(1)</script><p>etter</p>')
    expect(out).not.toContain('alert')
    expect(out).not.toContain('script')
    expect(out).toContain('før')
    expect(out).toContain('etter')
  })

  it('removes style, iframe, object, embed and svg with their contents', () => {
    for (const tag of ['style', 'iframe', 'object', 'embed', 'svg', 'noscript', 'template']) {
      const out = sanitizeHtml(`<p>a</p><${tag}>PAYLOAD</${tag}><p>b</p>`)
      expect(out, tag).not.toContain('PAYLOAD')
      expect(out, tag).not.toContain(`<${tag}`)
    }
  })

  it('removes an unterminated script rather than leaving the rest raw', () => {
    expect(sanitizeHtml('<p>a</p><script>alert(1)')).not.toContain('alert')
  })

  it('drops every attribute, including event handlers and styles', () => {
    const out = sanitizeHtml('<p onclick="alert(1)" style="position:fixed" class="x" id="y">t</p>')
    expect(out).toBe('<p>t</p>')
  })

  it('drops event handlers on a link while keeping the href', () => {
    const out = sanitizeHtml('<a href="https://a.example" onmouseover="alert(1)">t</a>')
    expect(out).not.toContain('onmouseover')
    expect(out).toContain('https://a.example')
  })

  it('refuses javascript: and data: hrefs, keeping the text', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      '  javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ]) {
      const out = sanitizeHtml(`<a href="${href}">klikk</a>`)
      expect(out, href).not.toContain('href')
      expect(out, href).toContain('klikk')
    }
  })

  it('refuses a relative href, which would resolve against our own domain', () => {
    expect(sanitizeHtml('<a href="/admin">x</a>')).not.toContain('href')
    expect(sanitizeHtml('<a href="//evil.example">x</a>')).not.toContain('href')
  })

  it('drops an unknown tag but keeps its text', () => {
    expect(sanitizeHtml('<marquee>tekst</marquee>')).toBe('tekst')
    expect(sanitizeHtml('<custom-element>tekst</custom-element>')).toBe('tekst')
  })

  it('escapes a stray < so it cannot start a tag downstream', () => {
    expect(sanitizeHtml('a < b')).toBe('a &lt; b')
    expect(sanitizeHtml('<p>1 < 2</p>')).toContain('1 &lt; 2')
  })

  it('removes comments, which can hide markup from a naive parser', () => {
    expect(sanitizeHtml('<p>a</p><!-- <script>alert(1)</script> --><p>b</p>')).not.toContain('alert')
  })

  it('does not let a stray </a> break out of the document', () => {
    const out = sanitizeHtml('tekst</a></p></div>')
    expect(out).toBe('tekst')
  })

  it('closes a link the input left open', () => {
    const out = sanitizeHtml('<a href="https://a.example">open')
    expect(out.endsWith('</a>')).toBe(true)
  })

  it('survives a malformed tag at the end of the input', () => {
    expect(() => sanitizeHtml('<p>a</p><a href="https://a.example"')).not.toThrow()
    expect(sanitizeHtml('<p>a</p><a href="https://a.example"')).toContain('a')
  })

  it('never emits an unescaped angle bracket outside an allowed tag', () => {
    const nasty = [
      '<img src=x onerror=alert(1)>',
      '<svg/onload=alert(1)>',
      '<a href="https://a.example"><script>alert(1)</script></a>',
      '"><script>alert(1)</script>',
      '<p><p onclick=alert(1)>',
      '<INPUT TYPE="IMAGE" SRC="javascript:alert(1);">',
    ]
    for (const input of nasty) {
      const out = sanitizeHtml(input)
      expect(out, input).not.toMatch(/<(?!\/?(?:p|br|a|span|em|strong|b|i|u|del|s|ul|ol|li|blockquote|code|pre|h[1-4])\b)/)
      expect(out, input).not.toContain('alert(1)')
    }
  })
})
