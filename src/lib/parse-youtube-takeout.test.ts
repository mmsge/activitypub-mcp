import { describe, it, expect } from 'vitest'
import {
  parseYoutubeWatchHistory,
  extractVideoId,
  extractChannelId,
  stripWatchedPrefix,
  watchDedupeKey,
  isShort,
  summariseProblems,
  SHORTS_MAX_SECONDS,
} from './parse-youtube-takeout.js'

// Entries here are synthetic. The shape is the archive's, the content is not: this is a
// public repository and the real watch history is private.

type Entry = Record<string, unknown>

/** A resolved watch entry, with only the interesting fields spelled out per test. */
function entry(over: Entry = {}): Entry {
  return {
    header: 'YouTube',
    title: 'Watched A Video About Rivers',
    titleUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    time: '2025-06-01T17:43:00',
    products: ['YouTube'],
    activityControls: ['YouTube watch history'],
    source: 'myactivity-console',
    account: 'acct-one',
    subtitles: [{ name: 'Some Channel', url: 'https://www.youtube.com/channel/UC0000000000000000000000' }],
    durationSeconds: 1033,
    ...over,
  }
}

/** An unresolved entry: bare URL as the title, no channel, no duration. */
function unresolvedEntry(over: Entry = {}): Entry {
  const url = (over.titleUrl as string) ?? 'https://www.youtube.com/watch?v=bbbbbbbbbbb'
  return {
    header: 'YouTube',
    title: `Watched ${url}`,
    titleUrl: url,
    time: '2025-06-02T09:00:00',
    products: ['YouTube'],
    activityControls: ['YouTube watch history'],
    source: 'myactivity-console',
    unresolved: true,
    account: 'acct-one',
    ...over,
  }
}

describe('extractVideoId', () => {
  it('reads the id from a watch?v= URL', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=hSBFqUUpj8I')).toBe('hSBFqUUpj8I')
  })

  it('reads the id from a /shorts/ URL', () => {
    // Shorts are a large share of the archive and are linked by path, not query.
    expect(extractVideoId('https://www.youtube.com/shorts/hSBFqUUpj8I')).toBe('hSBFqUUpj8I')
  })

  it('reads the id when v= is not the first query parameter', () => {
    expect(extractVideoId('https://www.youtube.com/watch?t=42&v=hSBFqUUpj8I&list=xyz')).toBe('hSBFqUUpj8I')
  })

  it('ignores a trailing fragment or extra parameter after the id', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=hSBFqUUpj8I#t=10')).toBe('hSBFqUUpj8I')
    expect(extractVideoId('https://www.youtube.com/shorts/hSBFqUUpj8I?feature=share')).toBe('hSBFqUUpj8I')
  })

  it('reads the id from a youtu.be short link', () => {
    expect(extractVideoId('https://youtu.be/hSBFqUUpj8I')).toBe('hSBFqUUpj8I')
    expect(extractVideoId('https://youtu.be/hSBFqUUpj8I?si=1JuGDKe3sVpMz6di')).toBe('hSBFqUUpj8I')
  })

  it('reads the id out of a search-results URL whose query is a youtu.be link', () => {
    // The archive really contains these: a watch entry whose titleUrl is a search page
    // wrapping a shortened link. Rejecting them leaves the import short of the source.
    expect(extractVideoId(
      'https://www.youtube.com/results?search_query=https://youtu.be/0hrCQv_26yc%3Fsi%3D1JuGDKe3sVpMz6di',
    )).toBe('0hrCQv_26yc')
  })

  it('prefers ?v= over an unrelated youtu.be elsewhere in the URL', () => {
    // Ordering matters: an ordinary watch URL must never be resolved by the loose branch.
    expect(extractVideoId('https://www.youtube.com/watch?v=hSBFqUUpj8I&r=https://youtu.be/aaaaaaaaaaa'))
      .toBe('hSBFqUUpj8I')
  })

  it('refuses an id of the wrong length rather than guessing', () => {
    // A wrong-length id would still key a row — just the wrong row. Better to surface it.
    expect(extractVideoId('https://www.youtube.com/watch?v=tooshort')).toBeNull()
    expect(extractVideoId('https://www.youtube.com/watch?v=waaaaaaaaaaytoolong')).toBeNull()
  })

  it('returns null for a URL with no video in it', () => {
    expect(extractVideoId('https://www.youtube.com/channel/UC0000000000000000000000')).toBeNull()
  })
})

describe('extractChannelId', () => {
  it('reads the UC id from a /channel/ URL', () => {
    expect(extractChannelId('https://www.youtube.com/channel/UCxLIJccyaRQDeyu6RzUsPuw')).toBe('UCxLIJccyaRQDeyu6RzUsPuw')
  })

  it('returns null for an @handle URL, which carries no id', () => {
    // A real absence, not a failure — the display name is still captured.
    expect(extractChannelId('https://www.youtube.com/@somehandle')).toBeNull()
  })

  it('returns null for a malformed UC id', () => {
    expect(extractChannelId('https://www.youtube.com/channel/UCtooshort')).toBeNull()
  })
})

describe('stripWatchedPrefix', () => {
  it('strips the prefix', () => {
    expect(stripWatchedPrefix('Watched So Much Has Happened')).toBe('So Much Has Happened')
  })

  it('leaves a title that does not carry it alone', () => {
    expect(stripWatchedPrefix('So Much Has Happened')).toBe('So Much Has Happened')
  })

  it('strips only the first occurrence, so a title starting with "Watched" survives', () => {
    expect(stripWatchedPrefix('Watched Watched: A Documentary')).toBe('Watched: A Documentary')
  })
})

describe('isShort', () => {
  it('classifies by the 180-second heuristic', () => {
    expect(isShort(55)).toBe(true)
    expect(isShort(SHORTS_MAX_SECONDS - 1)).toBe(true)
    expect(isShort(SHORTS_MAX_SECONDS)).toBe(false)
    expect(isShort(1033)).toBe(false)
  })

  it('never calls an unknown duration a Short', () => {
    // ~11% of the archive has no duration. Bucketing those as Shorts would inflate every
    // Shorts figure by the size of the unresolved set.
    expect(isShort(null)).toBe(false)
  })
})

describe('parseYoutubeWatchHistory', () => {
  it('maps a resolved entry onto a row', () => {
    const { rows, problems } = parseYoutubeWatchHistory([entry()])
    expect(problems).toEqual([])
    expect(rows[0]).toMatchObject({
      account: 'acct-one',
      videoId: 'aaaaaaaaaaa',
      videoUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      watchedAtLocal: '2025-06-01T17:43:00',
      title: 'A Video About Rivers',
      channelName: 'Some Channel',
      channelId: 'UC0000000000000000000000',
      durationSeconds: 1033,
      unresolved: false,
      source: 'myactivity-console',
    })
  })

  it('keeps the wall clock as the source wrote it, with no offset applied', () => {
    // The whole two-column storage design rests on this string arriving unconverted.
    const { rows } = parseYoutubeWatchHistory([entry({ time: '2026-08-16T18:08:00' })])
    expect(rows[0]!.watchedAtLocal).toBe('2026-08-16T18:08:00')
  })

  it('keeps the raw entry verbatim', () => {
    const e = entry()
    const { rows } = parseYoutubeWatchHistory([e])
    expect(rows[0]!.raw).toBe(e)
  })

  it('gives an unresolved entry a null title and no channel', () => {
    const { rows, problems } = parseYoutubeWatchHistory([unresolvedEntry()])
    expect(problems).toEqual([])
    expect(rows[0]).toMatchObject({
      videoId: 'bbbbbbbbbbb',
      title: null,
      channelName: null,
      channelId: null,
      durationSeconds: null,
      unresolved: true,
    })
  })

  it('detects an unresolved entry from its shape even without the flag', () => {
    // A real Takeout export carries no `unresolved` key; the bare-URL title is the only
    // signal, and the row still has to land in the terminal state.
    const e = unresolvedEntry()
    delete e.unresolved
    const { rows } = parseYoutubeWatchHistory([e])
    expect(rows[0]!.unresolved).toBe(true)
    expect(rows[0]!.title).toBeNull()
  })

  it('keeps a resolved entry that simply has no channel', () => {
    // Missing subtitles is not the same fact as an unavailable video.
    const e = entry()
    delete e.subtitles
    const { rows } = parseYoutubeWatchHistory([e])
    expect(rows[0]).toMatchObject({ unresolved: false, channelName: null, channelId: null })
    expect(rows[0]!.title).toBe('A Video About Rivers')
  })

  it('keeps the channel name when the URL is an @handle with no id', () => {
    const { rows } = parseYoutubeWatchHistory([
      entry({ subtitles: [{ name: 'Handle Channel', url: 'https://www.youtube.com/@handlechannel' }] }),
    ])
    expect(rows[0]).toMatchObject({ channelName: 'Handle Channel', channelId: null })
  })

  it('records a missing duration as null rather than zero', () => {
    const e = entry()
    delete e.durationSeconds
    const { rows } = parseYoutubeWatchHistory([e])
    expect(rows[0]!.durationSeconds).toBeNull()
  })

  it('accepts a zero-second duration as a real value', () => {
    const { rows, problems } = parseYoutubeWatchHistory([entry({ durationSeconds: 0 })])
    expect(problems).toEqual([])
    expect(rows[0]!.durationSeconds).toBe(0)
  })

  it('falls back to the supplied account and source, but only when the entry has none', () => {
    const e = entry()
    delete e.account
    delete e.source
    const { rows } = parseYoutubeWatchHistory([e, entry()], {
      defaultAccount: 'fallback',
      defaultSource: 'takeout-2026-08',
    })
    expect(rows[0]).toMatchObject({ account: 'fallback', source: 'takeout-2026-08' })
    // The entry's own values win — a merged file's halves must stay distinguishable.
    expect(rows[1]).toMatchObject({ account: 'acct-one', source: 'myactivity-console' })
  })
})

describe('the dedupe key', () => {
  it('separates two accounts watching the same video in the same minute', () => {
    // Collapsing across accounts would lose a real, distinct watch event.
    const { rows } = parseYoutubeWatchHistory([
      entry({ account: 'acct-one' }),
      entry({ account: 'acct-two' }),
    ])
    expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(2)
  })

  it('separates 31 different videos watched in one minute by one account', () => {
    // Minute resolution plus rapid Shorts scrolling collide; these are distinct watches
    // of distinct videos, not duplicates.
    const ids = Array.from({ length: 31 }, (_, i) => `vid${String(i).padStart(8, '0')}`)
    const { rows, problems } = parseYoutubeWatchHistory(
      ids.map((id) => entry({ titleUrl: `https://www.youtube.com/watch?v=${id}`, time: '2025-07-04T22:15:00' })),
    )
    expect(problems).toEqual([])
    expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(31)
  })

  it('separates the same video rewatched at a different minute', () => {
    const { rows } = parseYoutubeWatchHistory([
      entry({ time: '2025-06-01T17:43:00' }),
      entry({ time: '2025-06-01T17:44:00' }),
    ])
    expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(2)
  })

  it('collapses only a genuine repeat of the whole triple', () => {
    const { rows } = parseYoutubeWatchHistory([entry(), entry()])
    expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(1)
  })

  it('is the account, video and wall clock joined', () => {
    const { rows } = parseYoutubeWatchHistory([entry()])
    expect(rows[0]!.dedupeKey).toBe(watchDedupeKey('acct-one', 'aaaaaaaaaaa', '2025-06-01T17:43:00'))
  })
})

describe('problem reporting', () => {
  // Every entry must be accounted for: a row, or a named problem. Nothing in between.
  const cases: Array<[string, Entry | unknown, string]> = [
    ['a non-object entry', 'not an object', 'entry is not an object'],
    ['a YouTube Music row', entry({ header: 'YouTube Music' }), 'header is not "YouTube" (got YouTube Music)'],
    ['an entry with no title', (() => { const e = entry(); delete e.title; return e })(), 'no title'],
    ['a search row', entry({ title: 'Searched for trains' }), 'title is not a watch event'],
    ['an entry with no titleUrl', (() => { const e = entry(); delete e.titleUrl; return e })(), 'no titleUrl'],
    ['an unrecognised video URL', entry({ titleUrl: 'https://www.youtube.com/watch?v=nope' }), 'no video id in titleUrl'],
    ['an entry with no time', (() => { const e = entry(); delete e.time; return e })(), 'no time'],
    ['a time carrying an offset', entry({ time: '2025-06-01T17:43:00Z' }), 'time is not a bare local wall clock'],
    ['an entry with no account', (() => { const e = entry(); delete e.account; return e })(), 'no account, and no default supplied'],
    ['an entry with no source', (() => { const e = entry(); delete e.source; return e })(), 'no source, and no default supplied'],
    ['a non-integer duration', entry({ durationSeconds: 'lots' }), 'durationSeconds is not a non-negative integer'],
    ['a negative duration', entry({ durationSeconds: -5 }), 'durationSeconds is not a non-negative integer'],
  ]

  for (const [what, bad, reason] of cases) {
    it(`reports ${what} rather than dropping it`, () => {
      const { rows, problems, total } = parseYoutubeWatchHistory([bad])
      expect(rows).toEqual([])
      expect(problems).toHaveLength(1)
      expect(problems[0]!.reason).toBe(reason)
      expect(problems[0]!.index).toBe(0)
      expect(rows.length + problems.length).toBe(total)
    })
  }

  it('rejects a timezone-carrying time instead of silently dropping the offset', () => {
    // Dropping the offset would shift the row by an unknown amount — the exact failure
    // the local/instant split exists to prevent.
    const { problems } = parseYoutubeWatchHistory([
      entry({ time: '2025-06-01T17:43:00+02:00' }),
      entry({ time: '2025-06-01T17:43:00Z' }),
    ])
    expect(problems).toHaveLength(2)
  })

  it('accounts for every entry, good and bad, and keeps the source index', () => {
    const { rows, problems, total } = parseYoutubeWatchHistory([
      entry(),
      entry({ header: 'YouTube Music' }),
      unresolvedEntry(),
      entry({ titleUrl: 'https://www.youtube.com/watch?v=nope' }),
    ])
    expect(total).toBe(4)
    expect(rows).toHaveLength(2)
    expect(problems.map((p) => p.index)).toEqual([1, 3])
  })

  it('truncates a problem sample so one bad entry cannot flood the report', () => {
    const { problems } = parseYoutubeWatchHistory([entry({ title: `Searched for ${'x'.repeat(500)}` })])
    expect(problems[0]!.sample.length).toBeLessThanOrEqual(120)
  })
})

describe('summariseProblems', () => {
  it('counts by reason, largest first', () => {
    const { problems } = parseYoutubeWatchHistory([
      entry({ header: 'YouTube Music' }),
      entry({ header: 'YouTube Music' }),
      entry({ title: 'Searched for trains' }),
    ])
    expect(summariseProblems(problems)).toEqual([
      { reason: 'header is not "YouTube" (got YouTube Music)', count: 2 },
      { reason: 'title is not a watch event', count: 1 },
    ])
  })

  it('is empty for a clean parse', () => {
    expect(summariseProblems([])).toEqual([])
  })
})
