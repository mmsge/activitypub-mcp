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
