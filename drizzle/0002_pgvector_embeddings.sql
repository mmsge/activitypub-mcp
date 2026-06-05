CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN IF NOT EXISTS "embedding" vector(384);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "objects_embedding_idx" ON "objects" USING hnsw ("embedding" vector_cosine_ops);
