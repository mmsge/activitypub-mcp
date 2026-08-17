# Decision records

Append-only architecture/decision records (ADRs) for activitypub-mcp. Each
records a non-obvious decision or a hard-to-re-derive incident so it doesn't
have to be reverse-engineered from the code (or repeated). Records are immutable
once accepted; to change one, add a new record and mark the old one
`Superseded by NNNN`.

These are pooled into the cross-service view at `adr.msge.no` (see
`mmsge/hetzner-server`), so an optional `**Topics:**` line surfaces them there.

| # | Title |
|---|-------|
| [0001](0001-refresh-structured-fields-on-edit.md) | Refresh structured fields (tags/attachments) when a post is edited |
| [0002](0002-derive-reading-dates-from-public-ap.md) | Derive reading dates from public ActivityPub statuses, not authenticated BookWyrm access |
| [0003](0003-book-metadata-enrichment-on-ingest.md) | Enrich book metadata on ingest (plus periodic backfill), and let every reading tool read the cache |
| [0004](0004-deliver-directed-activities-to-personal-inbox.md) | Deliver directed activities (Follow/Undo) to the personal inbox, with explicit `to` |
| [0005](0005-enrich-neodb-film-tv-metadata.md) | Enrich NeoDB film/TV catalog metadata on ingest (IMDb/TMDB/details), mirroring the book pipeline |
| [0006](0006-enrich-all-neodb-categories.md) | Enrich every NeoDB category (music/game/podcast/performance/book) with retry + BookWyrm book dedup |
| [0007](0007-retain-mark-title-aliases.md) | Retain the mark's tag name as an accumulating catalogue alias (`mark_titles`), searched alongside `title` |
| [0008](0008-ingest-neodb-marks-into-a-per-actor-store.md) | Ingest NeoDB marks into a dedicated per-actor store (`neodb_marks`), keyed on (item, actor), joined to the catalogue cache |
| [0009](0009-actor-profile-and-log-retention.md) | Publish an informative actor profile, and prune the request log so its privacy claim stays true |
| [0010](0010-profile-page-must-resolve-to-the-actor.md) | The profile page URL must resolve back to the actor (`rel="alternate"` + content negotiation) |
| [0011](0011-one-ingest-path-for-create-announce-update.md) | One ingest path for Create/Announce/Update, plus a repair job for marks the old paths dropped |
| [0012](0012-surface-the-mark-shelf-date.md) | Store the mark's shelf date (`watched_at`) as its own column, and let `get_watched` filter and sort on it |
| [0013](0013-hide-media-rows-instead-of-deleting.md) | Hide catalogue rows with `hidden_at` instead of deleting them, and default every public tool to excluding them |
| [0014](0014-make-the-account-visible-over-activitypub.md) | Make the account visible: complete the discovery surface, and publish notes the actor actually wrote (the outbox was serving the inbox archive) |
| [0015](0015-scrobble-race-notifications.md) | Notify a head-to-head scrobble race: exact artist matching, a one-way milestone ladder, and state that only advances on a delivered push |
| [0016](0016-arm-the-race-one-play-early.md) | Arm the decisive race alerts one play early (scrobblers don't report now-playing), and never treat a dead heat as the finish |
| [0017](0017-derive-post-visibility-from-addressing.md) | Derive post visibility from ActivityPub addressing, in a generated column that fails closed |
| [0018](0018-publish-the-archive-as-a-public-stream.md) | Publish the archive as a public stream on a second host, ordered by when things happened |
| [0019](0019-one-timezone-for-the-whole-stream.md) | One timezone for the whole stream: a bucket is computed in the timezone its label is rendered in |
| [0020](0020-recover-garden-dates-from-reading-events.md) | Recover garden note dates from reading events, and list what stays undated |
| [0021](0021-serve-images-through-a-signed-proxy.md) | Serve the stream's images through a signed proxy, and never resize them |
| [0022](0022-configurable-endgame-countdown-band.md) | Make the endgame countdown band explicit (`RACE_COUNTDOWN_GAP`), let `endgame_*` report it, and latch the arming |
| [0023](0023-bind-posts-to-the-trips-they-were-posted-on.md) | Bind posts to the trips they were posted on, in a derived link table |
| [0024](0024-give-the-trip-post-join-a-surface.md) | Give the trip↔post join a surface: travel context on posts, and journey pages |
| [0025](0025-render-remote-video-as-a-poster-and-an-on-demand-embed.md) | Render remote video as a poster, and load the origin's player only on request |
| [0026](0026-rest-serves-public-posts-only.md) | The REST API serves public posts only; MCP still sees the whole archive |
| [0027](0027-read-a-journey-forwards-in-chapters.md) | Read a journey forwards: one chapter per leg, oldest post first |
| [0028](0028-weather-at-the-stations-he-travelled-through.md) | The weather at the stations he travelled through: geocode once, ERA5 per travel day |
| [0029](0029-a-shelf-flip-with-words-arrives-as-a-comment.md) | A shelf flip with words attached arrives as a Comment, not a GeneratedNote — classify reading events on what they say, and give each kind its own card |
| [0030](0030-the-scrobble-count-is-a-mirror-not-a-judgement.md) | The scrobble count is a mirror of Last.fm, not a judgement: audit the short plays, change nothing |
| [0031](0031-a-trip-is-visible-when-it-has-departed.md) | A trip is visible when it has departed, not when the export says Completed — the import's status is write-once |
| [0032](0032-draw-the-custom-emoji-that-were-already-in-the-database.md) | Draw the custom emoji that were already in the database — they federate in the `tag` array — and drop the ones we cannot serve back to text |
| [0033](0033-linkedin-as-a-source-two-halves-joined-on-the-post-id.md) | LinkedIn as a source: two halves joined on the post id, metrics kept append-only because the export's impressions are a window, not a total |
| [0034](0034-a-successful-empty-crawl-is-not-a-healthy-one.md) | A successful empty crawl is not a healthy one — LinkedIn spells "not collated yet" and "end of data" the same way, so store when data last arrived |
| [0035](0035-a-curated-kilometre-post-beats-a-geometry.md) | A curated kilometre post beats a geometry — attribute trips to named lines by hand-curated kilometrering rather than PostGIS over station coordinates that are already demonstrably wrong |
| [0036](0036-a-good-post-is-good-relative-to-your-own-baseline.md) | A good post is good relative to your own baseline — a percentile ladder over his own history, a hard floor, and a high-water mark an un-favourite cannot lower |
| [0037](0037-ingest-gigs-from-samklang.md) | Ingest Gigowl attendances into a per-actor store joined to a per-concert catalogue — the gig date is the night, not the day it was logged, and the prose is a bridge that always loses to a stated fact |
| [0038](0038-follow-gigowl-at-its-new-address.md) | Follow Gigowl at gigowl.social and rebase the archive onto its new identifiers — a 301 does not rescue a key, so the same gig from two addresses must still be one row |
| [0039](0039-a-clean-run-that-explains-nothing-is-not-observability.md) | A clean run that explains nothing is not observability — store the response on every attempt, and settle an empty LinkedIn crawl by asking a control domain instead of assuming patience |
| [0040](0040-the-wait-was-over-and-the-state-still-said-wait.md) | The wait was over and the state still said wait — a control domain cannot test a claim about collation, so ask a peer activity domain and call a lone missing domain stuck rather than late |
| [0041](0041-ask-the-archive-what-it-holds-not-whether-a-name-answers.md) | Ask the archive what it holds, not whether a name answers — walk the unfiltered snapshot query, tally what comes back per domain, and treat a domain reachable that way as a workaround |
| [0042](0042-a-diagnostic-nobody-can-read-is-not-a-diagnostic.md) | A diagnostic nobody can read is not a diagnostic — the summary is the output, and a walk that produced 42 domains without MEMBER_SHARE_INFO proves absence rather than "not probed" |
| [0043](0043-two-endpoints-the-snapshot-work-never-called.md) | Two endpoints the snapshot work never called — ask `memberAuthorizations` about the consent itself, and re-open the Changelog API now that the snapshot provably has nothing to give |
| [0044](0044-the-consent-is-fine-and-two-more-claims-were-not-earned.md) | The consent is registered and the diagnosis holds — and two more unearned claims retired: a verdict citing controls it never probed, and a changelog surveyed from ten events |
| [0045](0045-a-book-he-put-down-is-not-a-book-he-is-reading.md) | A book he put down is not a book he is reading: BookWyrm has a fourth shelf, and the archive cannot see it — store live membership, and let a stop close a cycle without finishing it |
| [0046](0046-serve-the-marks-status-and-subtract-rather-than-select.md) | Serve the mark's status, and subtract rather than select — `dropped` had been written and never read back, and an incomplete store means a negative filter, not a positive one |
| [0047](0047-the-wall-clock-is-the-authority-and-the-hours-are-an-upper-bound.md) | The wall clock is the authority, and every hours figure is an upper bound — YouTube watch history stores the bare local time it was given and derives the instant from it, keys on all three parts of (account, video, minute), and refuses to return one number for a duration the data never recorded |
| [0048](0048-a-trip-is-when-it-left-and-between-where.md) | A trip is when it left and between where — train code was half the identity and is not stable, so one journey was stored twice; the import now updates a matched trip in place and a migration collapses the 77 pairs |
| [0049](0049-a-short-is-an-era-not-a-length.md) | A Short is an era, not a length — the archive carries no Shorts flag, and a flat 180-second rule mislabels ~10% of what it catches; classify per video against the era rules, cheapest signal first, and record how each row was decided so a guess can be told from a verified answer |
