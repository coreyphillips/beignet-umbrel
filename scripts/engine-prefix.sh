#!/usr/bin/env bash
#
# Makes an engine prefix for development: the daemon and the Taproot Assets
# packages installed side by side, the way docker/Dockerfile installs them
# into /opt/beignet.
#
#   scripts/engine-prefix.sh <dir> [<engine>]
#
# <engine> is anything npm installs: a version (beignet@0.42.0), or a tarball
# from `npm pack` in an engine checkout. Left out, vendor/beignet-local.tgz is
# used when it exists (the same override the image build honours), and
# otherwise the release the image is built on.
#
# Then run the manager against it:
#
#   BEIGNET_BIN=<dir>/node_modules/beignet/dist/cli/cli.js npm start
#
# Assets are offered when the engine in the prefix carries the host extension
# contract; scripts/check-engine-prefix.js says whether it does.
set -euo pipefail

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
	sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor"
mkdir -p "$1"
PREFIX="$(cd "$1" && pwd)"

if [ $# -eq 2 ]; then
	ENGINE="$2"
	# A relative tarball path is relative to where the script was called.
	if [ -f "$ENGINE" ]; then ENGINE="$(cd "$(dirname "$ENGINE")" && pwd)/$(basename "$ENGINE")"; fi
elif [ -f "$VENDOR/beignet-local.tgz" ]; then
	ENGINE="$VENDOR/beignet-local.tgz"
else
	VERSION="$(sed -nE 's/^[[:space:]]*BEIGNET_VERSION:[[:space:]]*"([^"]+)".*/\1/p' "$ROOT/.github/workflows/build-image.yml" | head -1)"
	[ -n "$VERSION" ] || { echo "could not read BEIGNET_VERSION from .github/workflows/build-image.yml" >&2; exit 1; }
	ENGINE="beignet@$VERSION"
fi

TARBALLS=()
if [ -f "$VENDOR/SHA256SUMS" ]; then
	(cd "$VENDOR" && shasum -a 256 -c SHA256SUMS)
	while read -r _ file; do TARBALLS+=("$VENDOR/$file"); done < "$VENDOR/SHA256SUMS"
else
	echo "vendor/SHA256SUMS is missing: installing the engine alone, so assets will be off" >&2
fi

# better-sqlite3 needs its install script, approved by name as in the image.
echo '{"private":true,"allowScripts":{"better-sqlite3":true}}' > "$PREFIX/package.json"
rm -rf "$PREFIX/node_modules" "$PREFIX/package-lock.json"
npm install --omit=dev --no-audit --no-fund --prefix "$PREFIX" "$ENGINE" ${TARBALLS[@]+"${TARBALLS[@]}"}
node "$ROOT/scripts/check-engine-prefix.js" "$PREFIX"
echo
echo "BEIGNET_BIN=$PREFIX/node_modules/beignet/dist/cli/cli.js"
