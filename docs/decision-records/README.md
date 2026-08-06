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
| [0029](0029-the-scrobble-count-is-a-mirror-not-a-judgement.md) | The scrobble count is a mirror of Last.fm, not a judgement: audit the short plays, change nothing |
