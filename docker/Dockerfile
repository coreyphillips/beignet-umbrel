# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:20-bookworm-slim

# ---- UI build: compile the React/Vite dashboard to static assets ----
FROM ${NODE_IMAGE} AS ui
# Harden npm against flaky networks (arm64 emulation on CI is prone to resets).
ENV NPM_CONFIG_FETCH_RETRIES=6 NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 NPM_CONFIG_FETCH_TIMEOUT=300000
WORKDIR /ui
COPY manager/ui/package.json manager/ui/package-lock.json ./
RUN npm install --no-audit --no-fund
COPY manager/ui/ ./
RUN npm run build
# Vite outputs to /public (outDir ../public)

# ---- server build: manager deps + the beignet daemon (compiles better-sqlite3) ----
FROM ${NODE_IMAGE} AS build
ARG BEIGNET_VERSION=latest
ENV NPM_CONFIG_FETCH_RETRIES=6 NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 NPM_CONFIG_FETCH_TIMEOUT=300000
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY manager/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
RUN npm install --omit=dev --no-audit --no-fund --prefix /opt/beignet "beignet@${BEIGNET_VERSION}"

# ---- runtime ----
FROM ${NODE_IMAGE}
# gosu drops privileges after the entrypoint fixes ownership of the data volume.
# Zombie reaping is handled by Docker's own init (compose `init: true`).
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates gosu && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# The manager runs this with node when it ends in .js (see beignetSpawn()).
ENV BEIGNET_BIN=/opt/beignet/node_modules/beignet/dist/cli/cli.js
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /opt/beignet /opt/beignet
COPY manager/package.json ./package.json
COPY manager/server ./server
COPY --from=ui /public ./public
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
