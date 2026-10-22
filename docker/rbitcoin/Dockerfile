# syntax=docker/dockerfile:1

# The rbitcoin node (https://github.com/reardencode/rbitcoin) for the
# beignet-rbitcoin Umbrel app: the upstream static musl release binary,
# verified, on a minimal Alpine with just enough to drop privileges.
#
# The rbitcoin release this image carries is pinned here and nowhere else:
# build-rbitcoin-image.yml and check-release.yml read these ARG lines. The
# checksum is the rbitcoin-node line of that release's SHA256SUMS.linux-musl,
# copied by hand when the version is bumped. The build also downloads that
# sums file and checks the binary against both, so a re-published asset or a
# typo here fails the build instead of shipping.
ARG RBITCOIN_VERSION=0.8.0
ARG RBITCOIN_NODE_SHA256=2a261a477e3f4f4322970297f09581f9f7a3891c574e83af45d6cb61e157c935
ARG ALPINE_IMAGE=alpine:3.22@sha256:d406446bc05b82480756ce8f1287964d28768c23955fa9480d2a74a2eae7a654

# ---- fetch: download and verify the operator binary ----
FROM ${ALPINE_IMAGE} AS fetch
ARG RBITCOIN_VERSION
ARG RBITCOIN_NODE_SHA256
ARG TARGETARCH
WORKDIR /fetch
RUN apk add --no-cache ca-certificates wget
RUN set -eu; \
    if [ "$TARGETARCH" != "amd64" ]; then \
      # Upstream publishes no Linux arm64 build. On a Raspberry Pi Umbrel this
      # stub takes the binary's place so the app installs, the status page
      # comes up, and it says why the node is not answering, instead of the
      # app hanging on a pull of an image that has no arm64 variant.
      printf '%s\n' '#!/bin/sh' \
        'while :; do' \
        '  echo "rbitcoin publishes no Linux arm64 build. This app needs an x86_64 Umbrel (Umbrel Home); a Raspberry Pi Umbrel cannot run it." >&2' \
        '  sleep 300' \
        'done' > rbitcoin-node; \
      chmod 755 rbitcoin-node; \
      exit 0; \
    fi; \
    BASE="https://github.com/reardencode/rbitcoin/releases/download/v${RBITCOIN_VERSION}"; \
    wget -q "$BASE/rbitcoin-node-x86_64-linux" -O rbitcoin-node; \
    wget -q "$BASE/SHA256SUMS.linux-musl" -O SHA256SUMS; \
    # The sums file names the binary without the arch suffix, so it is
    # checked under that name; then against the pin above.
    grep -E ' rbitcoin-node$' SHA256SUMS | sha256sum -c -; \
    echo "${RBITCOIN_NODE_SHA256}  rbitcoin-node" | sha256sum -c -; \
    chmod 755 rbitcoin-node

# ---- runtime ----
FROM ${ALPINE_IMAGE}
ARG RBITCOIN_VERSION
ARG APP_VERSION=dev
ENV RBITCOIN_VERSION=${RBITCOIN_VERSION} APP_VERSION=${APP_VERSION}
# su-exec drops to uid 1000 after the entrypoint has made the data directory
# writable, the same job gosu does in docker/entrypoint.sh for the manager.
# The binary is static musl, so nothing else is needed from the base.
RUN apk add --no-cache su-exec
COPY --from=fetch /fetch/rbitcoin-node /usr/local/bin/rbitcoin-node
COPY docker/rbitcoin/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh
EXPOSE 50001 9332
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
