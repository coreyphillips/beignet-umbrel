# Taproot Assets regtest scenarios

Drive a local manager through Taproot Assets against real beignet daemons, a
regtest chain and tapd, Lightning Labs' daemon. tapd verifies every proof it
is handed, so a mint it lists and a transfer it credits are its own word that
what this app produced is valid. Each script prints `PASS`/`FAIL` lines, ends
with a JSON line naming the wallets it made, and exits non-zero if any check
failed.

## The chain

`stack.sh` starts ts-tap's own Docker stack (bitcoind, electrs, lnd, and a
tapd built from the commit ts-tap pins) under a project name and ports of its
own, so it runs beside any other stack on the machine:

```sh
TS_TAP_DIR=/path/to/ts-tap scripts/assets-regtest/stack.sh up
source scripts/assets-regtest/.state/env.sh
```

| | Default |
| --- | --- |
| Compose project | `umbrel-assets-regtest` (`ASSETS_REGTEST_PROJECT`) |
| bitcoind RPC | `127.0.0.1:18543`, `taptest`/`taptest`, wallet `mining` |
| electrs | `127.0.0.1:60501` |
| tapd REST | `https://localhost:18189`, certificate copied to `.state/tapd.cert` |
| tapd gRPC | `127.0.0.1:10129` |

`env.sh` holds what the manager needs to find them: the Electrum server, and
the regtest universe (`ASSETS_REGTEST_UNIVERSE_COURIER`, `_REST` and `_CA`).
Regtest has no public universe, so without those three a regtest wallet's
assets host has no proof server and says so.

`stack.sh up` also tells tapd's universe to take proofs from outside
(`tapcli universe federation config global --allow_insert true` for issuance
and transfer proofs). A stock tapd refuses them, and a mint here would then
finish with its proof unpublished and the wallet saying so.

The stack's tapd also runs with `--proofactivationheight=1`
(`compose.override.yml`). A stock regtest tapd keeps the proof rules of
before v0.8.5 for ever; with the flag it applies today's from the first
block, the ones mainnet, testnet3 and testnet4 are past the activation height
for. So what tapd accepts here is what those networks' rules accept, and a
proof made the old way would be refused here as it would be there.

tapd takes several minutes to build the first time. `stack.sh` reuses the
image ts-tap's own `npm run regtest` builds (`ts-tap-regtest-tapd:latest`)
when it is there. `stack.sh down` stops this project's containers and keeps
the chain; `stack.sh wipe` deletes it.

## The engine

Assets need an engine with the host extension contract and the two ts-tap
packages installed beside it. Make a prefix the way the image does:

```sh
scripts/engine-prefix.sh .engine-prefix                    # the release the image is built on
scripts/engine-prefix.sh .engine-prefix /path/to/beignet-0.42.0.tgz   # or an `npm pack` of a checkout
```

It ends by saying whether assets are available on that prefix, and prints
the `BEIGNET_BIN` to use.

## The manager

```sh
scripts/assets-regtest/manager.sh [<engine prefix>]
```

It reads `.state/env.sh`, points `BEIGNET_BIN` at the prefix (`.engine-prefix`
by default), keeps its wallets under `.state/data`, and listens on
`127.0.0.1:3900` with the wallets' daemons on the ports after it. `PORT` and
`DATA_DIR` in the environment change those.

`GET http://127.0.0.1:3900/api/config` should answer `assetsAvailable: true`.
If it does not, the manager's first lines say why (an engine without the
contract, or an assets host the daemon would refuse to load).

## Order

Each script makes its own wallets, so they run in any order and can be run
again on the same chain:

```sh
cd scripts/assets-regtest
node 01-mint.mjs       # normal, collectible, grouped and reissued, two in one transaction, refusals
node 02-tapd.mjs       # receive what tapd minted, send it back, send an asset minted here to tapd
node 03-wallets.mjs    # wallet to wallet with change, send back, burn, previews, every send refusal
node 04-restart.mjs    # restarts mid-mint and mid-send, idempotent replay, receive while stopped
node 05-backup.mjs     # archive, purge both wallets, restore, spend the restored assets
node 06-crash.mjs      # daemons killed outright mid-mint, mid-preview, mid-send and mid-receive
node 07-reorg.mjs      # the mint's block leaves the chain; tapd then judges the rebuilt proofs
node 08-settings.mjs   # broadcast again, test and change the proof server, assets off and on
node 09-proof-files.mjs  # the server refuses transfer proofs: the proof goes by file, twice, then to tapd
```

`09-proof-files.mjs` turns transfer proof inserts off in the stack's tapd
while it runs (`tapcli universe federation config global --proof_type
transfer --allow_insert=false`) and back on when it ends, whatever happened.
Run it by itself: any other scenario sending at the same time would have its
proofs refused too.

Every script leaves its wallets running, to be looked at afterwards, and each
one holds a connection to the stack's Electrum server. Past a few dozen, that
server (electrs 0.10) stops answering after the reorganisation in
`07-reorg.mjs`, and every wallet then waits on it. `node tidy.mjs` stops the
wallets earlier runs left, and `node tidy.mjs --delete` removes them and
their data, which also gives back the ports they hold (the manager refuses a
new wallet with `NO_PORT` once its range is used up). Run it between rounds,
and `docker compose -p umbrel-assets-regtest restart electrs` if the server
has already stopped answering.

`06-crash.mjs` finds a wallet's daemon by the port it listens on (`lsof`) and
sends it `SIGKILL`, so it needs the manager and the scripts on one machine.
`07-reorg.mjs` calls `invalidateblock` on the stack's bitcoind and mines a
longer chain; the wallets it made in earlier runs follow it like any other
reorganisation.

## Lightning

The scripts from 20 up drive asset channels between two wallets of this app.
They need an engine that can carry asset channels: `GET
http://127.0.0.1:3900/api/config` then answers `assetChannelsAvailable: true`,
and a wallet's assets status reads `lightning.mode: "full"`. Beignet 0.42.0
cannot, so on a prefix of that release both read off, the first check of
`20-ln-open.mjs` fails saying so, and the scripts above are unaffected. Until
a release can, make the prefix from an `npm pack` of an engine checkout that
does (the second form under "The engine").

```sh
node 20-ln-open.mjs           # what an open costs, the refusals before anything is funded, one open however often it is asked for
node 21-ln-pay.mjs            # an invoice and its payment both ways, replay, the limits each way, a price that is gone, both daemons restarted
node 22-ln-close.mjs          # closed together: each side's share back on-chain
node 23-ln-force-close.mjs    # closed alone with the peer stopped: the delay, the sweeps, the peer coming back
node 24-ln-crash-restore.mjs  # daemons killed before an open has answered, as it answers and with a payment in flight, then the opener restored from an archive
```

Each one makes two wallets, mints 100,000 units of an asset of its own on the
first, and opens a channel of 40,000 from it. Every stage ends on the same
count: what the two wallets hold between them, on-chain and in the channel,
is what was minted. After a close, the units that came out of the channel are
sent to the stack's tapd, which checks every proof in their history before it
credits them. So a share that left a channel is shown to be spendable by
someone else's software, and not only listed by this app.

`23-ln-force-close.mjs` stops the peer's wallet, and mines twelve blocks at a
time until the closer's share has waited out its delay and been swept.
`24-ln-crash-restore.mjs` kills daemons the way `06-crash.mjs` does. An open
cut before it has answered must end, on both wallets, as a channel that was
carried on or as an open that failed and says why, never as an open the peer
heard of that is simply gone; an open cut as it answers must become a channel
on both. Then it deletes the opener with its data and restores it from an
archive of the box.
What a restore cannot bring back is part of what it checks: the restored
wallet lists the channel as one its node does not hold, keeps everything it
had on-chain, and the peer, which still holds the channel, force closes it and
takes its own share home.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MANAGER_URL` | `http://127.0.0.1:3900` | The manager |
| `ASSETS_REGTEST_PROJECT` | `umbrel-assets-regtest` | The compose project the scripts mine and call tapd in |
| `PRIMARY_LOCAL_HOST` | `127.0.0.1` | The host one wallet's node reaches the other's on, in the Lightning scripts |
| `CUT_OPEN_AFTER_MS` | `300` | How long after the open is asked for `24-ln-crash-restore.mjs` kills the opener the first time |
| `CUT_OPEN_WAIT_MS` | `60000` | How long it waits for both wallets to settle after that cut |

What the scripts do not cover, and why: a preview expiring by time (three
minutes, covered by the host's unit tests with a clock), fee bumping (the
library has none yet), and Tor (the stack has no Tor; the outbound rules are
covered by `manager/server/outbound.test.js` and the host's tests).

The Lightning scripts do not yet cover a force close with a payment in
flight, a held invoice, a revoked commitment being punished, or a peer that
runs Lightning Labs' daemons.
