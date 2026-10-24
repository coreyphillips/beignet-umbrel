#!/usr/bin/env bash
# One Electrum conversation with a server, in bash alone: server.version must
# name rbitcoin, server.features must carry the genesis hash of the chain
# asked for, and a JSON-RPC batch must come back as one array with an answer
# for each request. Beignet's Electrum client syncs a wallet with batched
# requests (address histories, unspent outputs, transactions), so a server
# that takes single requests but not batches looks healthy here and still
# cannot serve a Beignet wallet. Used by the smoke workflow and handy against
# a live box:
#
#   bash beignet-rbitcoin/scripts/electrum-check.sh umbrel.local 50011 mainnet
#
# The node binds its Electrum listener only once catch-up and the scripthash
# index are done, a few seconds after /healthz answers, and a published Docker
# port accepts and then resets a connection until the container listens. So
# the conversation is retried until ELECTRUM_WAIT seconds (default 60) have
# passed, counted on the clock: a server that accepts and never answers
# spends the rest of the budget on one read, not ten seconds per attempt.
set -euo pipefail
host=${1:?host}
port=${2:?port}
chain=${3:-mainnet}
wait_s=${ELECTRUM_WAIT:-60}
deadline=$(( $(date +%s) + wait_s ))
case "$chain" in
  mainnet) genesis=000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f ;;
  testnet) genesis=000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943 ;;
  signet) genesis=00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6 ;;
  regtest) genesis=0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206 ;;
  *) echo "unknown chain $chain" >&2; exit 2 ;;
esac

# Seconds left before the deadline, at least 1 so a read always waits a little.
left() {
  local l=$(( deadline - $(date +%s) ))
  [ "$l" -ge 1 ] && echo "$l" || echo 1
}

# The script hash of an output nobody pays; any 64 hex digits will do, the
# balance asked for is not checked.
scripthash=9623df75239b5daa7f5f03042d325b51498c4bb7059c7748b17049bf96f73888

# Prints the three replies, one per line; fails if any does not arrive
# before the deadline.
converse() {
  local version features batch
  exec 3<>"/dev/tcp/$host/$port" || return 1
  printf '%s\n' '{"jsonrpc":"2.0","id":0,"method":"server.version","params":["beignet-rbitcoin-smoke","1.4"]}' >&3 || return 1
  read -r -t "$(left)" version <&3 || return 1
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"server.features","params":[]}' >&3 || return 1
  read -r -t "$(left)" features <&3 || return 1
  printf '%s\n' '[{"jsonrpc":"2.0","id":2,"method":"server.ping","params":[]},{"jsonrpc":"2.0","id":3,"method":"blockchain.scripthash.get_balance","params":["'"$scripthash"'"]}]' >&3 || return 1
  read -r -t "$(left)" batch <&3 || return 1
  exec 3>&-
  printf '%s\n%s\n%s\n' "$version" "$features" "$batch"
}

replies=""
started=$(date +%s)
while :; do
  if replies=$(converse 2>/dev/null) && [ -n "$replies" ]; then
    took=$(( $(date +%s) - started ))
    [ "$took" -gt 1 ] && echo "answered after ${took} s"
    break
  fi
  replies=""
  [ "$(date +%s)" -lt "$deadline" ] || break
  sleep 1
done
if [ -z "$replies" ]; then
  echo "no Electrum answer from $host:$port within ${wait_s} s" >&2
  exit 1
fi
version=$(printf '%s\n' "$replies" | sed -n 1p)
features=$(printf '%s\n' "$replies" | sed -n 2p)
batch=$(printf '%s\n' "$replies" | sed -n 3p)
echo "server.version: $version"
echo "server.features: $features"
echo "batch: $batch"
echo "$version" | grep -q 'rbitcoin' || { echo "server.version does not name rbitcoin" >&2; exit 1; }
echo "$features" | grep -q "$genesis" || { echo "server.features does not carry the $chain genesis" >&2; exit 1; }
case "$batch" in
  \[*\]) ;;
  *) echo "a JSON-RPC batch did not come back as an array" >&2; exit 1 ;;
esac
for id in 2 3; do
  echo "$batch" | grep -qE "\"id\": *$id[,}]" || { echo "the batch reply has no answer for id $id" >&2; exit 1; }
done
echo "$batch" | grep -q '"error"' && { echo "the batch reply carries an error" >&2; exit 1; }
echo "ok: rbitcoin on $chain at $host:$port"
