#!/usr/bin/env bash
# One Electrum conversation with a server, in bash alone: server.version must
# name rbitcoin, and server.features must carry the genesis hash of the chain
# asked for. Used by the smoke workflow and handy against a live box:
#
#   bash beignet-rbitcoin/scripts/electrum-check.sh umbrel.local 50011 mainnet
#
# The node binds its Electrum listener only once catch-up and the scripthash
# index are done, a few seconds after /healthz answers, and a published Docker
# port accepts and then resets a connection until the container listens. So
# the conversation is retried for up to ELECTRUM_WAIT seconds (default 60).
set -euo pipefail
host=${1:?host}
port=${2:?port}
chain=${3:-mainnet}
wait_s=${ELECTRUM_WAIT:-60}
case "$chain" in
  mainnet) genesis=000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f ;;
  testnet) genesis=000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943 ;;
  signet) genesis=00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6 ;;
  regtest) genesis=0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206 ;;
  *) echo "unknown chain $chain" >&2; exit 2 ;;
esac

# Prints the two replies, one per line; fails if either does not arrive.
converse() {
  local version features
  exec 3<>"/dev/tcp/$host/$port" || return 1
  printf '%s\n' '{"jsonrpc":"2.0","id":0,"method":"server.version","params":["beignet-rbitcoin-smoke","1.4"]}' >&3 || return 1
  read -r -t 10 version <&3 || return 1
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"server.features","params":[]}' >&3 || return 1
  read -r -t 10 features <&3 || return 1
  exec 3>&-
  printf '%s\n%s\n' "$version" "$features"
}

replies=""
for i in $(seq 1 "$wait_s"); do
  if replies=$(converse 2>/dev/null) && [ -n "$replies" ]; then
    [ "$i" -gt 1 ] && echo "answered after ${i} s"
    break
  fi
  replies=""
  sleep 1
done
if [ -z "$replies" ]; then
  echo "no Electrum answer from $host:$port within ${wait_s} s" >&2
  exit 1
fi
version=$(printf '%s\n' "$replies" | sed -n 1p)
features=$(printf '%s\n' "$replies" | sed -n 2p)
echo "server.version: $version"
echo "server.features: $features"
echo "$version" | grep -q 'rbitcoin' || { echo "server.version does not name rbitcoin" >&2; exit 1; }
echo "$features" | grep -q "$genesis" || { echo "server.features does not carry the $chain genesis" >&2; exit 1; }
echo "ok: rbitcoin on $chain at $host:$port"
