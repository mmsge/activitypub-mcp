/** @jsxImportSource hono/jsx */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../config.js', () => ({
  config: {
    STREAM_DOMAIN: 'meg.msge.no', APP_DOMAIN: 'bot.skvip.lol', APP_USERNAME: 'bot',
    STREAM_SOURCES: '',
    // The views mint proxy paths for every image now — see image-proxy.ts.
    SESSION_SECRET: 'x'.repeat(32), STREAM_IMAGE_CACHE_MB: 250,
  },
}))

const { EntryView, StreamList } = await import('./entry.js')
const at = (s: string) => new Date(s)

const render = (node: unknown) => String(node)

const post = {
  refId: 'post:1', eventAt: at('2026-08-03T10:00:00Z'), archivedAt: at('2026-08-03T10:01:00Z'),
  source: 'mastodon' as const, originUrl: 'https://skvip.lol/@markus/1', kind: 'post' as const,
  html: '<p>Hei alle saman</p>', contentWarning: null, sensitive: false, language: 'nn',
  attachments: [], hashtags: ['togselfie'], emojis: [], embedUrl: null, thread: [], trip: null,
}

const book = {
  refId: 'book:2', eventAt: at('2026-07-20T00:00:00Z'), archivedAt: at('2026-07-21T00:00:00Z'),
  source: 'bookwyrm' as const, originUrl: 'https://bookwyrm.social/user/mvrkws/review/9',
  kind: 'book_review' as const, title: 'Ein stad å vera', author: 'Ei Forfattar',
  coverUrl: 'https://bookwyrm.social/cover.jpg', rating: 4, reviewTitle: 'Verdt tida',
  html: '<p>God bok.</p>', quote: null, pages: 312, pubYear: 2019, series: null,
  bookUrl: 'https://bookwyrm.social/book/1', contentWarning: null,
  subtitle: null, progress: null, progressMode: null, finishedAt: null,
}

const mark = {
  refId: 'mark:3', eventAt: at('2016-04-02T00:00:00Z'), archivedAt: at('2026-08-01T00:00:00Z'),
  source: 'neodb' as const, originUrl: 'https://minreol.dk/m/3', kind: 'screen' as const,
  title: 'Ein gammal film', coverUrl: null, category: 'movie', year: 2016,
  comment: 'Sett på kino.', rating: 5, director: 'Ein Regissør', genre: ['drama'], itemUrl: null,
}

describe('every entry shows where it came from and links back there', () => {
  for (const [name, entry] of [['post', post], ['book', book], ['mark', mark]] as const) {
    it(`${name} carries a source badge and an outbound link`, () => {
      const html = render(<EntryView entry={entry as never} />)
      expect(html, name).toContain('class="badge"')
      expect(html, name).toContain(entry.originUrl!)
      expect(html, name).toContain('Les på')
    })

    it(`${name} gets an anchor id, so it can be deep-linked`, () => {
      expect(render(<EntryView entry={entry as never} />)).toContain(`id="e-${entry.refId}"`)
    })
  }
})

describe('content warnings', () => {
  it('collapses the body behind the warning, with no JavaScript', () => {
    const cw = { ...post, sensitive: true, contentWarning: 'Politikk', html: '<p>HEMMELEG</p>' }
    const html = render(<EntryView entry={cw as never} />)
    expect(html).toContain('<details class="cw">')
    expect(html).toContain('<summary>Politikk</summary>')
    expect(html).not.toContain('<script')
  })

  it('withholds media on a warned post, not just the text', () => {
    // A photo is as much "the content" as the words are.
    const cw = {
      ...post, sensitive: true, contentWarning: 'Politikk',
      attachments: [{ url: 'https://cdn.example/x.jpg', mediaType: 'image/jpeg', alt: null, width: null, height: null, blurhash: null }],
    }
    expect(render(<EntryView entry={cw as never} />)).not.toContain('cdn.example')
  })

  it('still warns when the post is flagged but carries no warning text', () => {
    const cw = { ...post, sensitive: true, contentWarning: null }
    expect(render(<EntryView entry={cw as never} />)).toContain('Innhaldsvarsel')
  })

  it('leaves an unflagged post open', () => {
    expect(render(<EntryView entry={post as never} />)).not.toContain('<details class="cw">')
  })
})

describe('media', () => {
  const withImage = {
    ...post,
    attachments: [{
      url: 'https://cdn.example/x.jpg', mediaType: 'image/jpeg',
      alt: 'Ein katt på eit tog', width: 800, height: 600, blurhash: null,
    }],
  }

  it('keeps the author\'s own alt text', () => {
    const html = render(<EntryView entry={withImage as never} />)
    expect(html).toContain('alt="Ein katt på eit tog"')
    expect(html).toContain('<figcaption>Ein katt på eit tog</figcaption>')
  })

  it('lazy-loads, sizes, and sends no referrer to the origin CDN', () => {
    const html = render(<EntryView entry={withImage as never} />)
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('referrerpolicy="no-referrer"')
    expect(html).toContain('width="800"')
  })

  const clip = (extra: Record<string, unknown> = {}) => ({
    url: 'https://rullen.no/api/media/clips/u/v.mp4', mediaType: 'video/mp4',
    alt: null, width: null, height: null, blurhash: null,
    posterUrl: null, durationSeconds: null, ...extra,
  })

  it('renders video as a poster linking out, never as an inline player', () => {
    const video = {
      ...post, kind: 'video' as const,
      attachments: [clip({ posterUrl: 'https://rullen.no/api/media/thumbnails/u/9f.jpg' })],
    }
    const html = render(<EntryView entry={video as never} />)
    expect(html).not.toContain('<video')
    expect(html).toContain('class="poster"')
    // Through this origin, like every other image on the page.
    expect(html).toMatch(/<img src="\/bilete\//)
  })

  it('never points an <img> at the video file itself', () => {
    // The bug this replaces: the video branch passed the attachment URL as the
    // <img src>, so every Rullen card drew a row of broken-image icons. A browser
    // handed an .mp4 in an <img> has nothing to fall back on.
    const video = { ...post, kind: 'video' as const, attachments: [clip({ durationSeconds: 16 })] }
    const html = render(<EntryView entry={video as never} />)
    expect(html).not.toMatch(/<img[^>]+\.mp4/)
    expect(html).not.toMatch(/<img[^>]+\.webm/)
    // It says what it holds instead, and still links out.
    expect(html).toContain('Sjå video · 0:16')
    expect(html).toContain('https://rullen.no/api/media/clips/u/v.mp4')
  })

  it('shows the clip length over the poster when it has both', () => {
    const video = {
      ...post, kind: 'video' as const,
      attachments: [clip({ posterUrl: 'https://rullen.no/api/media/thumbnails/u/9f.jpg', durationSeconds: 64 })],
    }
    expect(render(<EntryView entry={video as never} />)).toContain('<span class="dur">1:04</span>')
  })
})

/**
 * The origin's own player, behind a click. Nothing may reach the origin until the
 * reader asks for it — this page fetches nothing third-party otherwise, and an embed
 * that loaded on sight would undo that for every reader who never pressed play.
 */
describe('embedded players', () => {
  const story = {
    ...post, kind: 'video' as const, source: 'rullen' as const,
    originUrl: 'https://rullen.no/@markus/london-2026',
    embedUrl: 'https://rullen.no/embed/stories/markus/london-2026',
    attachments: [
      { url: 'https://rullen.no/api/media/clips/u/1.mp4', mediaType: 'video/mp4', alt: null, width: null, height: null, blurhash: null, posterUrl: 'https://rullen.no/api/media/thumbnails/u/9f.jpg', durationSeconds: 16 },
      { url: 'https://rullen.no/api/media/clips/u/2.mp4', mediaType: 'video/mp4', alt: null, width: null, height: null, blurhash: null, posterUrl: null, durationSeconds: 44 },
    ],
  }

  it('keeps the iframe inside a closed details, and lazy', () => {
    const html = render(<EntryView entry={story as never} />)
    expect(html).toContain('<details class="embed">')
    expect(html).not.toContain('<details class="embed" open')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('src="https://rullen.no/embed/stories/markus/london-2026?autoplay=0"')
  })

  it('needs no JavaScript to open', () => {
    const html = render(<EntryView entry={story as never} />)
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/\son[a-z]+=/)
  })

  it('says how much there is before the reader commits to loading it', () => {
    expect(render(<EntryView entry={story as never} />)).toContain('Spel av · 2 snuttar · 1:00')
  })

  it('says "snutt" for one', () => {
    const one = { ...story, attachments: story.attachments.slice(0, 1) }
    expect(render(<EntryView entry={one as never} />)).toContain('1 snutt ·')
  })

  it('shows the poster through this origin, not hotlinked', () => {
    const html = render(<EntryView entry={story as never} />)
    expect(html).not.toContain('src="https://rullen.no/api/media/thumbnails/u/9f.jpg"')
    const src = html.match(/<summary><img src="([^"]+)"/)![1]
    expect(Buffer.from(src.split('/')[3], 'base64url').toString('utf8'))
      .toBe('https://rullen.no/api/media/thumbnails/u/9f.jpg')
  })

  it('withholds the whole player on a warned post', () => {
    const cw = { ...story, sensitive: true, contentWarning: 'Politikk' }
    const html = render(<EntryView entry={cw as never} />)
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('rullen.no/embed')
  })
})

describe('threads', () => {
  it('folds later parts into the same entry rather than repeating the header', () => {
    const threaded = {
      ...post,
      thread: [
        { html: '<p>del to</p>', attachments: [], originUrl: null, emojis: [] },
        { html: '<p>del tre</p>', attachments: [], originUrl: null, emojis: [] },
      ],
    }
    const html = render(<EntryView entry={threaded as never} />)
    expect(html.match(/class="badge"/g)?.length).toBe(1)
    expect(html).toContain('del to')
    expect(html).toContain('del tre')
    expect(html.match(/class="thread"/g)?.length).toBe(2)
  })
})

describe('rich cards', () => {
  it('shows a book\'s cover, author, rating and facts', () => {
    const html = render(<EntryView entry={book as never} />)
    expect(html).toContain('Ein stad å vera')
    expect(html).toContain('Ei Forfattar')
    // The cover is served through this origin, not hotlinked from BookWyrm.
    expect(html).not.toContain('src="https://bookwyrm.social/cover.jpg"')
    const src = html.match(/<img class="cover" src="([^"]+)"/)![1]
    expect(src).toMatch(/^\/bilete\//)
    expect(Buffer.from(src.split('/')[3], 'base64url').toString('utf8'))
      .toBe('https://bookwyrm.social/cover.jpg')
    expect(html).toContain('★★★★☆')
    expect(html).toContain('312 sider')
    expect(html).toContain('Verdt tida')
  })

  it('names the volume when the catalogue keeps it apart from the title', () => {
    // BookWyrm files Heartstopper vol. 6 as title "Heartstopper" + subtitle
    // "Volume 6". Showing the title alone makes six books look like one.
    const vol = { ...book, title: 'Heartstopper', subtitle: 'Volume 6' }
    expect(render(<EntryView entry={vol as never} />)).toContain('Heartstopper — Volume 6')
  })

  it('shows a mark with the note Markus wrote, verbatim', () => {
    const html = render(<EntryView entry={mark as never} />)
    expect(html).toContain('Ein gammal film')
    expect(html).toContain('Sett på kino.')
    expect(html).toContain('Ein Regissør')
  })

  it('dates a backdated mark at the event, not at the post', () => {
    expect(render(<EntryView entry={mark as never} />)).toContain('2016-04-02')
  })
})

describe('the list', () => {
  it('offers "vis meir" when there is another page', () => {
    const html = render(<StreamList entries={[post as never]} nextHref="/?etter=abc" />)
    expect(html).toContain('Vis meir')
    expect(html).toContain('rel="next"')
  })

  it('omits it at the end', () => {
    expect(render(<StreamList entries={[post as never]} nextHref={null} />)).not.toContain('Vis meir')
  })

  it('says so when there is nothing', () => {
    expect(render(<StreamList entries={[]} nextHref={null} />)).toContain('Ingenting her enno')
  })
})

describe('what must never appear', () => {
  // The sanitiser handles post bodies. These assert the *view* does not undo that
  // by interpolating a database value somewhere it is not escaped — a title, a
  // hashtag, an attribute. The payload may appear as escaped text; what must never
  // appear is a real tag or a real attribute.
  it('escapes a hostile hashtag and language attribute on a post', () => {
    const nasty = {
      ...post,
      hashtags: ['<script>alert(1)</script>'],
      language: '" onload="alert(1)',
    }
    const html = render(<EntryView entry={nasty as never} />)
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script')
    // The attribute must stay one attribute: the quotes in the value are escaped,
    // so it cannot close early and start an event handler.
    expect(html).toContain('lang="&quot; onload=&quot;alert(1)"')
  })

  it('escapes a hostile mark title and comment', () => {
    const nasty = { ...mark, title: '<img src=x onerror=alert(1)>', comment: '</p><script>alert(1)</script>' }
    const html = render(<EntryView entry={nasty as never} />)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
    expect(html).toContain('&lt;/p&gt;')
  })

  it('escapes a hostile book title and review heading', () => {
    const nasty = { ...book, title: '</h3><script>alert(1)</script>', reviewTitle: '"><b>x' }
    const html = render(<EntryView entry={nasty as never} />)
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;/h3&gt;')
  })

  it('escapes a hostile origin URL rather than breaking out of the href', () => {
    const nasty = { ...post, originUrl: 'https://x.example/"><script>alert(1)</script>' }
    const html = render(<EntryView entry={nasty as never} />)
    expect(html).not.toContain('<script')
  })
})

describe('the train a post was written on', () => {
  const aboard = {
    ...post,
    trip: {
      relation: 'aboard' as const,
      fromStation: 'Göteborgs central', toStation: 'Oslo S',
      journey: 'NDC Copenhagen 2026', journeySlug: 'ndc-copenhagen-2026',
      operator: 'Vygruppen AS', distanceKm: 346, night: false,
    },
  }

  it('renders the leg, the operator and the distance', () => {
    const html = render(<EntryView entry={aboard} />)
    expect(html).toContain('Göteborgs central → Oslo S')
    expect(html).toContain('Vygruppen AS')
    expect(html).toContain('346 km')
  })

  it('says which end of the trip the post came from', () => {
    expect(render(<EntryView entry={aboard} />)).toContain('Om bord')
    expect(render(<EntryView entry={{ ...aboard, trip: { ...aboard.trip, relation: 'boarding' as const } }} />))
      .toContain('På perrongen før')
    expect(render(<EntryView entry={{ ...aboard, trip: { ...aboard.trip, relation: 'alighting' as const } }} />))
      .toContain('Nett komen fram')
  })

  it('links the journey to its page', () => {
    expect(render(<EntryView entry={aboard} />)).toContain('href="/reise/ndc-copenhagen-2026"')
  })

  it('renders nothing at all for a post that was not on a train', () => {
    // Which is almost every post: 415 of ~5,000 carry a link.
    expect(render(<EntryView entry={post} />)).not.toContain('aboard')
  })

  it('omits the journey link when the trip has no journey name', () => {
    const noJourney = { ...aboard, trip: { ...aboard.trip, journey: null, journeySlug: null } }
    const html = render(<EntryView entry={noJourney} />)
    expect(html).toContain('Göteborgs central → Oslo S')
    expect(html).not.toContain('/reise/')
  })

  it('drops the leg but keeps the relation under briefTrip', () => {
    // The journey page's chapters: the heading has already named the train, so
    // repeating it under every post is noise — but "om bord" or "på perrongen"
    // is something only the post can say.
    const html = render(<EntryView entry={aboard} briefTrip />)
    expect(html).toContain('Om bord')
    expect(html).not.toContain('Göteborgs central → Oslo S')
    expect(html).not.toContain('346 km')
    expect(html).not.toContain('/reise/ndc-copenhagen-2026')
  })

  it('still hides the images of a sensitive post that was on a train', () => {
    // The trip line is metadata, not body — but it must not become a way for a
    // content-warned post to render its attachments anyway.
    const sensitive = {
      ...aboard, sensitive: true, contentWarning: 'Ikkje for alle',
      attachments: [{ url: 'https://cdn/x.jpg', mediaType: 'image/jpeg', alt: null, width: null, height: null, blurhash: null, posterUrl: null, durationSeconds: null }],
    }
    const html = render(<EntryView entry={sensitive} />)
    expect(html).toContain('Ikkje for alle')
    expect(html).not.toContain('cdn/x.jpg')
  })
})

/**
 * The five reading cards.
 *
 * Fixtures are the real events from the live archive, because the point of the
 * change was that four of these five had never rendered at all.
 */
describe('reading cards', () => {
  const started = {
    ...book, refId: 'book:10', kind: 'book_started' as const,
    eventAt: at('2026-08-05T20:57:15Z'),
    originUrl: 'https://bookwyrm.social/user/mvrkws/comment/12215917',
    title: 'A Parade of Horribles', author: 'Matt Dinniman', pages: 624, pubYear: 2026,
    rating: null, reviewTitle: null, html: '<p>Siste bok for no!</p>',
  }
  const bareStart = { ...started, refId: 'book:11', html: null, finishedAt: null }
  const finished = {
    ...book, refId: 'book:12', kind: 'book_finished' as const,
    eventAt: at('2026-08-05T20:40:55Z'), title: 'This Inevitable Ruin',
    rating: null, reviewTitle: null, html: '<p>markus.plus/melding/bok/this-inevitable-ruin</p>',
  }
  const comment = {
    ...book, refId: 'book:13', kind: 'book_comment' as const,
    title: 'Heartstopper', subtitle: 'Volume 6', rating: null, reviewTitle: null,
    html: '<p>Pause frå Carl for å sjå slutten til Nick og Charlie.</p>',
    progress: 120, progressMode: 'PG',
  }
  const quote = {
    ...book, refId: 'book:14', kind: 'book_quote' as const, rating: null, reviewTitle: null,
    quote: 'Maybe he wanted to visit the British Library in London.',
    html: '<p>Tromsø bokhandel???</p>',
  }
  const review = { ...book, refId: 'book:15', finishedAt: at('2025-06-04T19:38:36Z') }

  const FIVE = [
    ['byrja å lesa', started], ['lesen ut', finished], ['kommentar', comment],
    ['sitat', quote], ['melding', review],
  ] as const

  it('labels each kind with the word Markus chose for it', () => {
    for (const [label, entry] of FIVE) {
      expect(render(<EntryView entry={entry as never} />), label).toContain(`>${label}<`)
    }
  })

  it('gives each kind a silhouette of its own', () => {
    // Criterion 8: tellable apart in a screenshot with the chip text masked. Both
    // the article's class and the chip's shape have to differ, or "masked" would
    // leave five identical cards.
    const cards = FIVE.map(([, e]) => render(<EntryView entry={e as never} />))
    const article = cards.map((h) => h.match(/<article class="([^"]+)"/)![1])
    const chip = cards.map((h) => h.match(/<span class="(bookchip[^"]*)"/)![1])
    expect(new Set(article).size).toBe(5)
    expect(new Set(chip).size).toBe(5)
  })

  it('tells a start from a finish with every word stripped out', () => {
    const strip = (h: string) => h.replace(/>[^<]*</g, '><')
    expect(strip(render(<EntryView entry={started as never} />)))
      .not.toBe(strip(render(<EntryView entry={finished as never} />)))
  })

  it('shows what he wrote when the start came in a comment', () => {
    // The bug, from the reader's side: this sentence existed and the page did not
    // show it, because the start had no generatednote to hang off.
    const html = render(<EntryView entry={started as never} />)
    expect(html).toContain('Siste bok for no!')
    expect(html).toContain('A Parade of Horribles')
    expect(html).toContain('Matt Dinniman')
    expect(html).toContain('624 sider')
  })

  it('says nothing extra for a shelf flip made without words', () => {
    // Criterion 3: the generatednote start must look exactly as it always has.
    const html = render(<EntryView entry={bareStart as never} />)
    expect(html).not.toContain('class="body"')
    expect(html).not.toContain('started reading')
    expect(html).toContain('byrja å lesa')
  })

  it('puts a remark above the book it is about', () => {
    const html = render(<EntryView entry={comment as never} />)
    expect(html.indexOf('Pause frå Carl')).toBeLessThan(html.indexOf('class="card slim"'))
    expect(html).toContain('side 120')
    // Chatter shows the title and nothing else of the catalogue.
    expect(html).not.toContain('312 sider')
  })

  it('frames a quotation as a quotation', () => {
    const html = render(<EntryView entry={quote as never} />)
    expect(html).toContain('<figure class="quote-frame">')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('British Library')
    // The remark he added alongside the passage is still his, and still shown.
    expect(html).toContain('Tromsø bokhandel???')
  })

  it('marks a review that also closed the book', () => {
    const html = render(<EntryView entry={review as never} />)
    expect(html).toContain('class="finished-mark"')
    expect(html).toContain('4. juni 2025')
    expect(html).toContain('<h3 class="review-title">Verdt tida</h3>')
  })

  it('never repeats the finish on a card whose chip already says it', () => {
    // hydrateBooks is what leaves finishedAt null here, so the fixture has to carry
    // one for this to be worth asserting — a card with no date cannot print one.
    const marked = { ...finished, finishedAt: at('2026-08-05T20:40:55Z') }
    expect(render(<EntryView entry={marked as never} />)).not.toContain('finished-mark')
  })

  it('escapes a hostile title on every one of the five', () => {
    for (const [label, entry] of FIVE) {
      const nasty = { ...entry, title: '</h3><script>alert(1)</script>', subtitle: null }
      expect(render(<EntryView entry={nasty as never} />), label).not.toContain('<script>')
    }
  })
})

describe('custom emoji', () => {
  const VY = 'https://cdn.masto.host/skviplol/custom_emojis/images/000/024/644/original/x.png'
  const emojis = [{ shortcode: 'vy', url: VY }]

  it('draws a shortcode as a picture, served through this origin', () => {
    const entry = { ...post, html: '<p>Vy :vy: har nye vassflaskar!</p>', emojis }
    const html = render(<EntryView entry={entry as never} />)
    expect(html).toContain('class="emoji"')
    expect(html).toContain('alt=":vy:"')
    // Proxied like every other image on the page (ADR 0021), never hotlinked.
    expect(html).not.toContain(`src="${VY}"`)
    expect(html).toContain('src="/bilete/')
    expect(html).not.toContain(':vy: har')
  })

  it('draws them in a thread part too, from that part\'s own tag array', () => {
    const entry = {
      ...post,
      thread: [{ html: '<p>og :vy: her</p>', attachments: [], originUrl: null, emojis }],
    }
    expect(render(<EntryView entry={entry as never} />)).toContain('class="emoji"')
  })

  it('draws them in a content warning without letting it emit markup', () => {
    const entry = {
      ...post, sensitive: true, emojis,
      contentWarning: 'Vy :vy: <script>alert(1)</script>',
    }
    const html = render(<EntryView entry={entry as never} />)
    expect(html).toContain('class="emoji"')
    expect(html).not.toContain('<script>')
  })

  it('leaves the shortcode as text when the post declared no emoji', () => {
    const entry = { ...post, html: '<p>Vy :vy: her</p>', emojis: [] }
    expect(render(<EntryView entry={entry as never} />)).toContain(':vy:')
  })
})
