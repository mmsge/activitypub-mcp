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
