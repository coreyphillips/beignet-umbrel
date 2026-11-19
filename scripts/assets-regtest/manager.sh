#!/usr/bin/env bash
#
# Starts a manager for the assets regtest scenarios (README.md): the chain
# and universe from stack.sh, the engine from an engine prefix, and a data
# directory of its own.
#
#   scripts/assets-regtest/manager.sh [<engine prefix>]
#
# The prefix defaults to .engine-prefix at the repository root, which
# scripts/engine-prefix.sh makes. PORT (3900) and DATA_DIR
# (scripts/assets-regtest/.state/data) can be set in the environment.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PREFIX="${1:-$ROOT/.engine-prefix}"
BIN="$PREFIX/node_modules/beignet/dist/cli/cli.js"

[ -f "$HERE/.state/env.sh" ] || { echo "Start the chain first: scripts/assets-regtest/stack.sh up" >&2; exit 1; }
[ -f "$BIN" ] || { echo "No engine at $PREFIX. Make one with: scripts/engine-prefix.sh $PREFIX" >&2; exit 1; }
# shellcheck disable=SC1091
. "$HERE/.state/env.sh"

export PORT="${PORT:-3900}"
export DATA_DIR="${DATA_DIR:-$HERE/.state/data}"
export BEIGNET_BIN="$BIN"
export CHILD_PORT_BASE="${CHILD_PORT_BASE:-$((PORT + 1))}"
export CHILD_PORT_MAX="${CHILD_PORT_MAX:-$((PORT + 60))}"
# The scenarios call the manager from this machine, which its access guard
# always admits, so the guard is left on (no BEIGNET_TRUST_ALL).
mkdir -p "$DATA_DIR"

echo "manager on http://127.0.0.1:$PORT, data in $DATA_DIR, engine $BIN"
cd "$ROOT/manager"
exec node server/index.js
