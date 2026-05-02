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

EXPOSE 3000

ENTRYPOINT ["/bin/sh", "-c", "node --import tsx/esm src/db/migrate.ts && node --import tsx/esm src/index.ts"]
