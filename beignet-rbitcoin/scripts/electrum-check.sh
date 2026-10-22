#!/usr/bin/env bash
# One Electrum conversation with a server, in bash alone: server.version must
# name rbitcoin, and server.features must carry the genesis hash of the chain
# asked for. Used by the smoke workflow and handy against a live box:
#
#   bash beignet-rbitcoin/scripts/electrum-check.sh umbrel.local 50011 mainnet
set -euo pipefail
host=${1:?host}
port=${2:?port}
chain=${3:-mainnet}
case "$chain" in
  mainnet) genesis=000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f ;;
  testnet) genesis=000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943 ;;
  signet) genesis=00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6 ;;
  regtest) genesis=0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206 ;;
  *) echo "unknown chain $chain" >&2; exit 2 ;;
esac
exec 3<>"/dev/tcp/$host/$port"
printf '%s\n' '{"jsonrpc":"2.0","id":0,"method":"server.version","params":["beignet-rbitcoin-smoke","1.4"]}' >&3
read -r -t 10 version <&3
echo "server.version: $version"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"server.features","params":[]}' >&3
read -r -t 10 features <&3
echo "server.features: $features"
exec 3>&-
echo "$version" | grep -q 'rbitcoin' || { echo "server.version does not name rbitcoin" >&2; exit 1; }
echo "$features" | grep -q "$genesis" || { echo "server.features does not carry the $chain genesis" >&2; exit 1; }
echo "ok: rbitcoin on $chain at $host:$port"
