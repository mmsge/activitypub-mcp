-- A NeoDB 404 on a row that already has its data is a stamp, not an error (ADR 0077).
-- minreol.dk began answering 404 for every item after the move to neodb.social, and as a
-- `fetch_error` each such row was re-fetched on every sync pass and listed as a failed
-- enrichment, while its stored record was fine.
ALTER TABLE "catalog_metadata" ADD COLUMN "source_gone_at" timestamp with time zone;
