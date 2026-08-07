FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS devdeps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:22-alpine
WORKDIR /app

# Copy all dependencies (including devDeps for tsx)
COPY --from=devdeps /app/node_modules ./node_modules
COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY drizzle ./drizzle

# The build's git identity, written on the checkout by scripts/generate-build-info.sh
# at `make deploy` (the image has no .git) and served at /version.
#
# THREE THINGS ABOUT THIS LINE, all of which have bitten someone (naustet-server ADR 0022):
#   - It is the LAST COPY. `built_at` changes every deploy, so an earlier one would
#     bust the layer cache for `npm ci` on every single build.
#   - The `jso[n]` glob makes it a no-op when the file is absent, so a bare
#     `docker build` still works — a plain `COPY build-info.json` would fail instead.
#   - It is in the FINAL stage, not the `devdeps` builder. A COPY into a builder stage
#     never reaches the image that actually runs.
COPY build-info.jso[n] ./

EXPOSE 3000

ENTRYPOINT ["/bin/sh", "-c", "node --import tsx/esm src/db/migrate.ts && node --import tsx/esm src/index.ts"]
