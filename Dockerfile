# Debian-slim (glibc), not Alpine (musl): onnxruntime-node — pulled in by
# @huggingface/transformers for local embeddings — only ships glibc prebuilt
# binaries.
FROM node:22-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-slim AS devdeps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:22-slim
WORKDIR /app

# Copy all dependencies (including devDeps for tsx)
COPY --from=devdeps /app/node_modules ./node_modules
COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY drizzle ./drizzle

# Writable cache for downloaded embedding model weights (backed by a volume).
RUN mkdir -p /app/.cache/embeddings

EXPOSE 3000

ENTRYPOINT ["/bin/sh", "-c", "node --import tsx/esm src/db/migrate.ts && node --import tsx/esm src/index.ts"]
