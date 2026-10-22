#!/bin/sh
set -eu

# Docker creates a missing bind-mount source as root, and umbrelOS copies the
# app directory with cp --archive, so /data may be root-owned on the first
# start. Only the top level is fixed: this volume grows to hundreds of GiB,
# and a recursive chown on every start would take minutes for nothing.
# rbitcoin creates its own store/ beneath it as uid 1000 (mode 0700).
mkdir -p /data
chown 1000:1000 /data

# Every flag comes from the compose command: line, so the whole
# configuration is in one reviewed file.
exec su-exec 1000:1000 rbitcoin-node "$@"
