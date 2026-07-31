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
