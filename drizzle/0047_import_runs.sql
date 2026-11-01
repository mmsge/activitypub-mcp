-- One row per import or maintenance run started from the admin, so the Import list can
-- say when each last ran and how it went. See ADR 0073 (phase 3).
--
-- Written after the run, never before: a row is an outcome, not an intent. `summary` is
-- the one-line nynorsk result the list shows; `error` is set only when `ok` is false.
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"summary" text,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "import_runs_kind_ran_at_idx" ON "import_runs" USING btree ("kind","ran_at" DESC);
