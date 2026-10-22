# syntax=docker/dockerfile:1

# The Node release every stage builds on, pinned to the multi-arch index digest.
# tests.yml and build-image.yml read it from this line, so bump it here only.
# 24.22.1 carries the October 21, 2026 Node.js security fixes; Node 20 is end
# of life and gets none.
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:1681862882da07ee5476fee047bcf34138833f1df42633bb25bcb0f438d5bf3d

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
# A local engine tarball (vendor/beignet-local.tgz, gitignored) wins over the
# published version: `npm pack` in an engine checkout and copy the tarball in
# to build an image against unreleased engine work. Release builds never have
# one, so they install exactly BEIGNET_VERSION from npm.
COPY vendor/ /vendor/
# better-sqlite3 needs its install script (a prebuilt binary, or node-gyp with
# the toolchain above). The npm in node:24 runs dependency install scripts that
# no `allowScripts` entry covers but warns about them, and skips them once
# strict-allow-scripts is on, so approve it by name before installing.
RUN mkdir -p /opt/beignet && echo '{"private":true,"allowScripts":{"better-sqlite3":true}}' > /opt/beignet/package.json
RUN if [ -f /vendor/beignet-local.tgz ]; then       npm install --omit=dev --no-audit --no-fund --prefix /opt/beignet /vendor/beignet-local.tgz;     else       npm install --omit=dev --no-audit --no-fund --prefix /opt/beignet "beignet@${BEIGNET_VERSION}";     fi
# Fail the build, not the first wallet start, if the native module is missing.
RUN node -e "const D = require(require.resolve('better-sqlite3', { paths: ['/opt/beignet/node_modules/beignet'] })); new D(':memory:').prepare('select 1').get()"

# ---- runtime ----
FROM ${NODE_IMAGE}
# The app release this image is, from the git tag the build ran on. Nothing
# else in the container carries it (umbrel-app.yml is not copied in), and a
# backup archive records the version it came from.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
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
