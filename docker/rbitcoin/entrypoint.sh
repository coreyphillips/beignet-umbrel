#!/bin/sh
set -eu

# Node defaults live outside the chain data and the replaceable web assets.
mkdir -p /settings
chown 1000:1000 /settings
if [ "${1:-}" = "settings-server" ]; then
  exec su-exec 1000:1000 python3 /usr/local/lib/rbitcoin/settings.py serve
fi

# The status page for the nginx container. /web is a directory the compose
# file mounts into both containers; it is refreshed from this image on every
# start so that an update of the image updates the page (umbrelOS does not
# re-copy app files on update, see the Dockerfile). The stamp written last
# carries the app version umbrelOS exports, and the nginx container waits
# for the stamp to name its own version before it renders the template, so
# a start after an update never serves the previous version's page.
if [ -d /usr/share/beignet-rbitcoin/web ]; then
  mkdir -p /web
  rm -rf /web/templates /web/html
  cp -R /usr/share/beignet-rbitcoin/web/. /web/
  printf '%s' "${APP_VERSION:-dev}" > /web/.version.tmp
  mv -f /web/.version.tmp /web/.version
fi

# Docker creates a missing bind-mount source as root, and umbrelOS copies the
# app directory with cp --archive, so /data may be root-owned on the first
# start. Only the top level is fixed: this volume grows to hundreds of GiB,
# and a recursive chown on every start would take minutes for nothing.
# rbitcoin creates its own store/ beneath it as uid 1000 (mode 0700). A
# filesystem that has no owners (exFAT or NTFS on an external drive) refuses
# the chown; that is reported and left to rbitcoin, which then says plainly
# whether it can write there.
mkdir -p /data
chown 1000:1000 /data || echo "warning: could not chown /data; continuing" >&2

# The launcher validates saved defaults, records the launch settings, then
# execs the node. No supervisor sits between Docker's SIGTERM and the node.
# Explicit compose flags override saved defaults.
exec su-exec 1000:1000 python3 /usr/local/lib/rbitcoin/settings.py "$@"
