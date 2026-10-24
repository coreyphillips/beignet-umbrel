# syntax=docker/dockerfile:1
# check=skip=FromPlatformFlagConstDisallowed

# The rbitcoin node (https://github.com/reardencode/rbitcoin) for the
# beignet-rbitcoin Umbrel app: rbitcoin-node built from a pinned upstream
# commit as a static musl binary, on a minimal Alpine with just enough to
# drop privileges.
#
# The rbitcoin source this image carries is pinned here and nowhere else:
# build-rbitcoin-image.yml and check-release.yml read these ARG lines.
# RBITCOIN_VERSION is the workspace version in that commit's Cargo.toml (what
# the binary reports), and the build refuses a commit that says otherwise.
# The last upstream release, 0.8.0, predates the Electrum JSON-RPC batch
# support Beignet's client needs (rbitcoin PR 1155, for issue 1152), so the
# app builds master until a release carries it.
#
# The build uses the flags upstream's release build sets (nix/rbitcoin.nix:
# release profile, no debuginfo, stripped symbols, crt-static, the build
# directory remapped) with the toolchain rust-toolchain.toml pins, which
# RUST_IMAGE must carry, and a fixed SOURCE_DATE_EPOCH, so the binary is
# reproducible: RBITCOIN_NODE_SHA256 is its checksum, and a build that does
# not reproduce it fails instead of shipping.
ARG RBITCOIN_VERSION=0.8.99
ARG RBITCOIN_COMMIT=8e62e4ce4d60c30abc851cb0893e4b80149ac9e4
ARG RBITCOIN_NODE_SHA256=eb08aecb703b0e526a879a92cb3914f902325dbbcdb0c35c3c58f62dbcc88426
ARG RUST_IMAGE=rust:1.95.0-alpine3.22@sha256:064dfc925d68d1a63f4fd2871bd7dc6e6ea56692989a487185855d62885d90aa
ARG ALPINE_IMAGE=alpine:3.22@sha256:d406446bc05b82480756ce8f1287964d28768c23955fa9480d2a74a2eae7a654

# ---- build: compile rbitcoin-node for x86_64 ----
# Always an amd64 stage, whatever platform is being assembled: only the amd64
# image carries the node (see node-arm64 below), so the arm64 build never
# reaches this stage, and on an amd64 runner the compile is native. The
# constant platform is deliberate, which is why the check directive at the
# top skips the linter's rule against it.
FROM --platform=linux/amd64 ${RUST_IMAGE} AS build
ARG RBITCOIN_VERSION
ARG RBITCOIN_COMMIT
# git to fetch the commit. The gcc, musl-dev and binutils that build the two
# C dependencies (secp256k1-sys and libmimalloc-sys) come with RUST_IMAGE,
# so its digest pins them along with rustc.
RUN apk add --no-cache git
WORKDIR /build
# The commit must be on upstream master, its Cargo.toml must say
# RBITCOIN_VERSION, and its rust-toolchain.toml must name the Rust that
# RUST_IMAGE carries (the image's RUST_VERSION), so the compiler is the one
# upstream builds with and the image digest pins it. Master's history comes
# as commits only, and the checkout then fetches the pinned commit's files.
RUN set -eu; \
    git init -q rbitcoin; \
    cd rbitcoin; \
    git remote add origin https://github.com/reardencode/rbitcoin.git; \
    git fetch -q --filter=tree:0 origin master; \
    git merge-base --is-ancestor "$RBITCOIN_COMMIT" origin/master || { \
      echo "rbitcoin $RBITCOIN_COMMIT is not on upstream master" >&2; exit 1; }; \
    git -c advice.detachedHead=false checkout -q "$RBITCOIN_COMMIT"; \
    test "$(git rev-parse HEAD)" = "$RBITCOIN_COMMIT"; \
    grep -qx "version = \"$RBITCOIN_VERSION\"" Cargo.toml || { \
      echo "rbitcoin $RBITCOIN_COMMIT is not version $RBITCOIN_VERSION" >&2; exit 1; }; \
    grep -qx "channel = \"$RUST_VERSION\"" rust-toolchain.toml || { \
      echo "rbitcoin $RBITCOIN_COMMIT does not build with Rust $RUST_VERSION, which RUST_IMAGE carries:" >&2; \
      cat rust-toolchain.toml >&2; exit 1; }
# RUSTUP_TOOLCHAIN takes the image's toolchain, the channel checked above,
# without the file's rustfmt and clippy components, which a build does not
# use, and RUSTUP_AUTO_INSTALL=0 makes a missing toolchain an error instead
# of a download. The flags go to the musl target only, so build scripts and
# proc macros link as usual. SOURCE_DATE_EPOCH is the commit's time: mimalloc
# compiles __DATE__ and __TIME__ into its build banner, and GCC takes both
# from SOURCE_DATE_EPOCH when it is set (upstream's nix build sets it too),
# so two builds of one commit give the same bytes.
RUN set -eu; \
    cd rbitcoin; \
    SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) \
    RUSTUP_TOOLCHAIN="$RUST_VERSION" \
    RUSTUP_AUTO_INSTALL=0 \
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_RUSTFLAGS="--remap-path-prefix /build/=/source/ -C debuginfo=0 -C strip=symbols -C target-feature=+crt-static" \
      cargo build --release --locked --target x86_64-unknown-linux-musl -p rbitcoin-node; \
    cp target/x86_64-unknown-linux-musl/release/rbitcoin-node /build/rbitcoin-node
# A step of its own, declared after the compile, so that changing the pin
# reruns only this check. It prints the binary's checksum first, so a
# failing build shows the value to pin in its error summary.
ARG RBITCOIN_NODE_SHA256
RUN sha256sum /build/rbitcoin-node; \
    echo "${RBITCOIN_NODE_SHA256}  /build/rbitcoin-node" | sha256sum -c -

# ---- the node binary for each platform ----
FROM ${ALPINE_IMAGE} AS node-amd64
COPY --from=build /build/rbitcoin-node /rbitcoin-node

# rbitcoin ships no Linux arm64 build, and this image builds none. On a
# Raspberry Pi Umbrel this stub takes the binary's place so the app installs,
# the status page comes up, and it says why the node is not answering,
# instead of the app hanging on a pull of an image that has no arm64 variant.
FROM ${ALPINE_IMAGE} AS node-arm64
RUN printf '%s\n' '#!/bin/sh' \
      'while :; do' \
      '  echo "rbitcoin publishes no Linux arm64 build. This app needs an x86_64 Umbrel (Umbrel Home); a Raspberry Pi Umbrel cannot run it." >&2' \
      '  sleep 300' \
      'done' > /rbitcoin-node; \
    chmod 755 /rbitcoin-node

FROM node-${TARGETARCH} AS node

# ---- runtime ----
FROM ${ALPINE_IMAGE}
ARG RBITCOIN_VERSION
ARG APP_VERSION=dev
ENV RBITCOIN_VERSION=${RBITCOIN_VERSION} APP_VERSION=${APP_VERSION}
# su-exec drops to uid 1000 after the entrypoint has made the data directory
# writable, the same job gosu does in docker/entrypoint.sh for the manager.
# Python serves the allowlisted settings API in a separate container and
# validates saved defaults before execing the static node binary.
RUN apk add --no-cache su-exec python3
COPY --from=node /rbitcoin-node /usr/local/bin/rbitcoin-node
COPY docker/rbitcoin/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY docker/rbitcoin/settings.py /usr/local/lib/rbitcoin/settings.py
# The status page (nginx template and HTML) travels in this image, not in
# the app directory: umbrelOS copies an app's files into APP_DATA_DIR at
# install and on update copies only docker-compose.yml, *.template,
# exports.sh, torrc and hooks (legacy-compat/app-script), so a page shipped
# as app files would stay at its install version for the life of the app.
# The entrypoint puts a copy in /web on every start, which the compose file
# shares with the nginx container, so the page moves with the image digest.
COPY docker/rbitcoin/web /usr/share/beignet-rbitcoin/web
RUN chmod 755 /usr/local/bin/entrypoint.sh && chmod -R a+rX /usr/share/beignet-rbitcoin
EXPOSE 50001 9332 9333
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
