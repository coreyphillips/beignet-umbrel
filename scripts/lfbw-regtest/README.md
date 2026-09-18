# Lightning-first regtest scenarios

Drive a local manager through the lightning-first feature against real
beignet daemons, a regtest bitcoind and a CLN payer. Each script prints
`PASS`/`FAIL` lines and, where a later script needs them, a final JSON line
with the wallet ids and node ids to pass on.

## Two chains

The scripts take their chain from the environment. Nothing else changes.

**bitcoin-regtest-dashboard** (preferred). Set `REGTEST_API` and funding,
mining and the waits go through its control API. The faucet confirms in the
same call it sends and returns the outpoint, so no script has to mine
blindly after a send, and a virgin chain needs no pre-mining: the faucet
mines to coinbase maturity by itself.

```sh
cd <bitcoin-regtest-dashboard checkout>
docker compose -p bitcoin-regtest-dashboard up -d
export REGTEST_API=http://localhost:3000/api
```

The dashboard ships no Lightning node, so 03, 05 and 06 need a CLN that can
reach its bitcoind. Attach one to `bitcoin-regtest-dashboard_regtest_network`
and point it at the `bitcoin` service. That bitcoind is cookie-only, so CLN
takes `--bitcoin-datadir=/bitcoin/.bitcoin` with the `bitcoin_data` volume
mounted read-only, rather than a user and password. Then:

```sh
export CLN_CONTAINER=cln-d CLN_P2P_PORT=19856
```

**A Polar style stack** (the original, still the default). Leave
`REGTEST_API` unset and the scripts shell out exactly as they always have:
bitcoind container `bitcoin` (RPC 43782, `polaruser`/`polarpass`, wallet
`default`), an electrs on `127.0.0.1:60001`, and CLN container `cln`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `REGTEST_API` | unset | Dashboard API base. Unset selects the docker path. |
| `REGTEST_API_TOKEN` | unset | Bearer token, when the dashboard requires one |
| `MANAGER_URL` | `http://127.0.0.1:3900` | The manager |
| `BTC_CONTAINER` | `bitcoin` | docker path only |
| `BTC_CLI_ARGS` | Polar's RPC port and credentials | docker path only |
| `CLN_CONTAINER` | `cln` | empty means no CLN, and the scripts that need one say so |
| `CLN_P2P_HOST` / `CLN_P2P_PORT` | `127.0.0.1` / `19846` | what a beignet daemon dials to reach CLN |
| `PRIMARY_DIAL_HOST` | `host.docker.internal` | what CLN dials to reach a manager daemon |
| `PRIMARY_LOCAL_HOST` | `127.0.0.1` | what a sibling daemon dials |

Daemon listen ports are read from the manager (`listenPort` on the wallet
record), so nothing assumes `9901` and any `CHILD_PORT_BASE` works.

## Manager

From `manager/`, with `DEFAULT_ELECTRUM_PORT` pointing at whichever electrs
belongs to the chain you chose (`60401` for the dashboard, `60001` for the
Polar stack):

```sh
PORT=3900 DATA_DIR=/tmp/lfbw-e2e BEIGNET_BIN=/path/to/beignet/dist/cli/cli.js \
DEFAULT_NETWORK=regtest DEFAULT_ELECTRUM_HOST=127.0.0.1 DEFAULT_ELECTRUM_PORT=60401 \
DEFAULT_ELECTRUM_TLS=false CHILD_PORT_BASE=3901 CHILD_PORT_MAX=3950 BEIGNET_TRUST_ALL=1 \
node server/index.js
```

## Order

```sh
cd scripts/lfbw-regtest
node 01-setup.mjs                       # -> {"P","L1","Pnode","L1node"}
node 02-channelize.mjs '<json from 01>'
node 04-direct-funding.mjs '<json from 01>'
node 03-jit.mjs '<json from 01>'        # -> adds "L2"
node 05-paired-and-outgrow.mjs '<json with L2>'
node 06-external-primary.mjs '<json from 01>'
```

`08-ffor-plain.mjs`, `09-ffor-lfbw.mjs` and `10-ffor-witness-issuer.mjs`
(offline receive, FFOR) take no argument and need no CLN: the payer is a
sibling wallet. Run them against the manager above, in any order:

```sh
REGTEST_API=http://<dashboard>/api CLN_CONTAINER= node 08-ffor-plain.mjs
REGTEST_API=http://<dashboard>/api CLN_CONTAINER= node 09-ffor-lfbw.mjs
REGTEST_API=http://<dashboard>/api CLN_CONTAINER= node 10-ffor-witness-issuer.mjs
```

`10` needs an engine whose dual-funded acceptor announces the channel
(beignet 0.21.6 or a build carrying that fix): the payer routes to the
settlement peer through the witness's public channel, which it learns
from gossip.

Each creates its own wallets, opens the channels it needs, starts a
two-voucher book on the receiver's channel to the settling sibling, mints
the first invoice, stops the receiver, pays the invoice from the payer
while it is down, starts the receiver, and asserts the manager's return
closed the book with the voucher credited. `08` also checks the record
model (an on-chain only wallet cannot settle, a peer without the role
aborts the book with the engine's reason 2). See `docs/FFOR.md`.

`07-recovery.mjs` is separate and takes no argument. Run it against its own
manager, on its own `DATA_DIR` and port window, because the guardian set is
app-wide settings and quorum mode is sticky per wallet: pinning a set inside
the run above would change what every later wallet there is created with.

```sh
PORT=3910 DATA_DIR=/tmp/lfbw-recovery CHILD_PORT_BASE=3921 CHILD_PORT_MAX=3935 \
  ... node server/index.js
MANAGER_URL=http://127.0.0.1:3910 node 07-recovery.mjs
```

It covers guardian hosting over bolt8, resolving a guardian by URI, pinning
and validating a set, quorum status, rotation with the wallet running and
the outgoing set retiring, the SCB round trip, and the peer-storage capsule
surface. Two things are reported rather than asserted: whether a storage
peer has returned a capsule is the peer's behaviour, not the wallet's, and
rotation on an empty journal is skipped with a pointer to beignet #862.

`03` opens the CLN channel from the primary's side and pays CLN over it
first, because CLN needs outbound toward the primary to pay its dependents;
a CLN-initiated open trips coreyphillips/beignet#670. `06` tops CLN up again
for the same reason, since `03` spends most of what it was given.

## Diagnosing a timing failure

A chain assertion depends on three clocks: bitcoind sees a block, electrs
indexes it, and only then does a daemon's Electrum client report it. The
assertions that read a balance after a splice gate on the splice transaction
reaching the wallet's own view, and `tips(id)` prints all three side by side.
Read it as: `chain > electrs` is electrs lag, `electrs > wallet` is that
daemon's Electrum client, and all three equal with the assertion still
failing is the engine.
