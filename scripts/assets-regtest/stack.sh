#!/usr/bin/env bash
#
# The regtest chain the assets scenarios run on: ts-tap's own Docker stack
# (bitcoind, electrs, lnd and a tapd built from its pinned commit), started
# under a project name and ports of its own so it runs beside anything else.
#
#   scripts/assets-regtest/stack.sh up        start it, fund lnd, write env.sh
#   scripts/assets-regtest/stack.sh upstream  start the upstream peer beside it
#   scripts/assets-regtest/stack.sh down      stop it and keep its volumes
#   scripts/assets-regtest/stack.sh wipe      stop it and delete its volumes
#
# TS_TAP_DIR names the ts-tap checkout whose docker/compose.yml is used
# (default: ../ts-tap beside this repository). Only this project's
# containers are ever started or stopped.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TS_TAP_DIR="${TS_TAP_DIR:-$ROOT/../ts-tap}"
[ -f "$TS_TAP_DIR/docker/compose.yml" ] || { echo "no ts-tap checkout at $TS_TAP_DIR (set TS_TAP_DIR)" >&2; exit 1; }

export COMPOSE_PROJECT_NAME="${ASSETS_REGTEST_PROJECT:-umbrel-assets-regtest}"
export TAP_BITCOIND_PORT="${TAP_BITCOIND_PORT:-18543}"
export TAP_ELECTRUM_PORT="${TAP_ELECTRUM_PORT:-60501}"
export TAPD_REST_PORT="${TAPD_REST_PORT:-18189}"
export TAPD_RPC_PORT="${TAPD_RPC_PORT:-10129}"
STATE="${ASSETS_REGTEST_STATE:-$HERE/.state}"
# compose.upstream.yml adds the upstream peer, which only `upstream` starts;
# naming it here lets `down` and `wipe` reach it too.
compose=(docker compose -p "$COMPOSE_PROJECT_NAME" -f "$TS_TAP_DIR/docker/compose.yml" -f "$HERE/compose.override.yml" -f "$HERE/compose.upstream.yml")

btc() {
	"${compose[@]}" exec -T bitcoind bitcoin-cli -regtest -rpcport=18443 -rpcuser=taptest -rpcpassword=taptest "$@"
}

case "${1:-}" in
up)
	"${compose[@]}" up -d --wait bitcoind electrs lnd
	# A wallet to mine to, coinbase maturity, and coins for lnd, which funds
	# what tapd mints and sends.
	btc -named createwallet wallet_name=mining >/dev/null 2>&1 || btc loadwallet mining >/dev/null 2>&1 || true
	HEIGHT="$(btc getblockcount)"
	if [ "$HEIGHT" -lt 101 ]; then
		btc -rpcwallet=mining generatetoaddress $((101 - HEIGHT)) "$(btc -rpcwallet=mining getnewaddress)" >/dev/null
	fi
	LND_ADDR="$("${compose[@]}" exec -T lnd lncli --network=regtest newaddress p2wkh | sed -nE 's/.*"address": *"([^"]+)".*/\1/p')"
	btc -rpcwallet=mining sendtoaddress "$LND_ADDR" 10 >/dev/null
	btc -rpcwallet=mining generatetoaddress 6 "$(btc -rpcwallet=mining getnewaddress)" >/dev/null
	# tapd exits if lnd's chain notifier is still starting, which it is for a
	# moment after the blocks above: wait until lnd has caught up with them.
	for _ in $(seq 1 90); do
		if "${compose[@]}" exec -T lnd lncli --network=regtest getinfo 2>/dev/null | grep -q '"synced_to_chain": *true'; then break; fi
		sleep 1
	done
	if docker image inspect "${ASSETS_TAPD_IMAGE:-ts-tap-regtest-tapd:latest}" >/dev/null 2>&1; then
		"${compose[@]}" up -d --no-build --wait tapd
	else
		"${compose[@]}" up -d --build --wait tapd
	fi
	# A tapd universe takes proofs from nobody until it is told to. The app
	# publishes each issuance it creates and delivers each transfer proof
	# there, as it does to a public universe on the other networks.
	for proof_type in issuance transfer; do
		"${compose[@]}" exec -T tapd tapcli --network=regtest universe federation config global \
			--proof_type "$proof_type" --allow_insert true --allow_export true >/dev/null
	done
	mkdir -p "$STATE"
	"${compose[@]}" cp tapd:/root/.tapd/tls.cert "$STATE/tapd.cert" >/dev/null
	cat > "$STATE/env.sh" <<ENV
# Written by scripts/assets-regtest/stack.sh up. Source it before starting
# the manager and before running a scenario.
export ASSETS_REGTEST_PROJECT=$COMPOSE_PROJECT_NAME
export TS_TAP_DIR=$TS_TAP_DIR
export DEFAULT_NETWORK=regtest
export DEFAULT_ELECTRUM_HOST=127.0.0.1
export DEFAULT_ELECTRUM_PORT=$TAP_ELECTRUM_PORT
export DEFAULT_ELECTRUM_TLS=false
export ASSETS_REGTEST_UNIVERSE_COURIER=universerpc://tapd:10029
export ASSETS_REGTEST_UNIVERSE_REST=https://localhost:$TAPD_REST_PORT
export ASSETS_REGTEST_UNIVERSE_CA=$STATE/tapd.cert
ENV
	echo "stack up: electrs 127.0.0.1:$TAP_ELECTRUM_PORT, tapd REST https://localhost:$TAPD_REST_PORT"
	echo "source $STATE/env.sh"
	;;
upstream)
	# The peer of 25-ln-upstream.mjs: lnd and tapd of the upstream
	# implementation in one process, on this stack's chain. `up` first.
	image="${ASSETS_UPSTREAM_IMAGE:-ts-tap-native-interop:upstream}"
	if ! docker image inspect "$image" >/dev/null 2>&1; then
		echo "no image $image: ts-tap's npm run regtest:lightning:upstream builds it (docker/native-interop)" >&2
		exit 1
	fi
	"${compose[@]}" up -d --no-build --wait integrated
	echo "upstream peer up: 127.0.0.1:${ASSETS_UPSTREAM_P2P_PORT:-19835}, image $image"
	;;
down)
	"${compose[@]}" stop
	;;
wipe)
	"${compose[@]}" down -v
	rm -rf "$STATE"
	;;
*)
	sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
	;;
esac
