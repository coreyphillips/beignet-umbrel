#!/usr/bin/env bash
#
# Vendors the Taproot Assets library this app bundles (docs/ASSETS.md).
#
#   scripts/vendor-ts-tap.sh <ts-tap checkout> [<commit>]
#   scripts/vendor-ts-tap.sh --verify <ts-tap checkout>
#
# ts-tap is not on npm, so the image installs it from two tarballs committed
# under vendor/: ts-tap itself and @ts-tap/beignet, the adapter that runs it
# on this app's engine. This script builds both from one commit of a ts-tap
# checkout (HEAD by default), with that repository's own `npm run
# pack:release`, and writes:
#
#   vendor/ts-tap-<version>-g<commit>.tgz
#   vendor/ts-tap-beignet-<version>-g<commit>.tgz
#   vendor/SHA256SUMS         what docker/Dockerfile checks before it installs
#   vendor/ts-tap.lock.json   the commit, the engine range, each file's hash
#
# The build runs in a temporary worktree of the commit, never in the checkout
# itself, so uncommitted work there is neither read nor touched. The build
# time is the commit's own, so one commit packs to the same bytes each time.
#
# --verify builds the commit named in vendor/ts-tap.lock.json again and
# compares it with what is vendored, changing nothing. It needs the Node and
# npm releases the tarballs were built with to give the same bytes.
set -euo pipefail

VERIFY=0
if [ "${1:-}" = "--verify" ]; then
	VERIFY=1
	shift
fi
if [ $# -lt 1 ] || [ $# -gt 2 ]; then
	sed -n '3,6p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor"
CHECKOUT="$(cd "$1" && pwd)"

if [ "$VERIFY" = 1 ]; then
	[ -f "$VENDOR/ts-tap.lock.json" ] || { echo "vendor/ts-tap.lock.json is missing: nothing to verify" >&2; exit 1; }
	COMMIT="$(node -e "process.stdout.write(require('$VENDOR/ts-tap.lock.json').commit)")"
else
	COMMIT="${2:-HEAD}"
fi
SHA="$(git -C "$CHECKOUT" rev-parse --verify "${COMMIT}^{commit}")"
SHORT="${SHA:0:12}"

WORK="$(mktemp -d)"
cleanup() {
	git -C "$CHECKOUT" worktree remove --force "$WORK/src" >/dev/null 2>&1 || true
	rm -rf "$WORK"
}
trap cleanup EXIT

echo "Building ts-tap at $SHA"
git -C "$CHECKOUT" worktree add --detach "$WORK/src" "$SHA" >/dev/null
SOURCE_DATE_EPOCH="$(git -C "$CHECKOUT" show -s --format=%ct "$SHA")"
export SOURCE_DATE_EPOCH
(cd "$WORK/src" && npm run pack:release -- "$WORK/out")

# Name each tarball after its commit, and describe the pair.
node - "$WORK/out" "$WORK/named" "$SHA" "$SHORT" "$SOURCE_DATE_EPOCH" "$WORK/src" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const [out, named, sha, short, epoch, src] = process.argv.slice(2);
fs.mkdirSync(named, { recursive: true });
const manifests = [path.join(src, 'package.json'), path.join(src, 'packages', 'beignet', 'package.json')].map((file) =>
	JSON.parse(fs.readFileSync(file, 'utf8'))
);
const packages = manifests.map((manifest) => {
	const base = `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}`;
	const file = `${base}-g${short}.tgz`;
	fs.copyFileSync(path.join(out, `${base}.tgz`), path.join(named, file));
	const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(named, file))).digest('hex');
	return { name: manifest.name, version: manifest.version, file, sha256 };
});
const lock = {
	repository: 'https://github.com/coreyphillips/ts-tap',
	commit: sha,
	sourceDateEpoch: Number(epoch),
	engine: manifests[1].peerDependencies.beignet,
	packages
};
fs.writeFileSync(path.join(named, 'ts-tap.lock.json'), `${JSON.stringify(lock, null, '\t')}\n`);
fs.writeFileSync(path.join(named, 'SHA256SUMS'), packages.map((p) => `${p.sha256}  ${p.file}\n`).join(''));
NODE

if [ "$VERIFY" = 1 ]; then
	if diff -u "$VENDOR/SHA256SUMS" "$WORK/named/SHA256SUMS"; then
		(cd "$VENDOR" && shasum -a 256 -c SHA256SUMS)
		echo "vendor/ matches a fresh build of ts-tap at $SHA"
		exit 0
	fi
	echo "vendor/ does not match a fresh build of ts-tap at $SHA (see the diff above)." >&2
	echo "A different Node or npm release packs different bytes; otherwise the tarballs were not built from that commit." >&2
	exit 1
fi

mkdir -p "$VENDOR"
# One vendored build at a time: the image installs whatever SHA256SUMS names.
find "$VENDOR" -maxdepth 1 -type f \( -name 'ts-tap-*.tgz' \) -delete
cp "$WORK/named/"*.tgz "$WORK/named/SHA256SUMS" "$WORK/named/ts-tap.lock.json" "$VENDOR/"
echo
cat "$VENDOR/SHA256SUMS"
echo "Vendored ts-tap at $SHA into vendor/. Commit vendor/ with the change that needs it."
