# Lightning-first regtest scenarios

Drive a local manager through the lightning-first feature against real
beignet daemons, a regtest bitcoind and a CLN payer. Each script prints
`PASS`/`FAIL` lines and, where a later script needs them, a final JSON line
with the wallet ids and node ids to pass on.

## Stack

- bitcoind container `bitcoin` (RPC 43782, `polaruser`/`polarpass`, wallet
  `default`), an electrs on `127.0.0.1:60001`, and CLN container `cln` with
  regtest funds. `lib.mjs` shells out to `docker exec` for both.
- An engine checkout built with `yarn build` (master past 0.9.3, or the
  branch of coreyphillips/beignet#667).

## Manager

From `manager/`:

```sh
PORT=3900 DATA_DIR=/tmp/lfbw-e2e BEIGNET_BIN=/path/to/beignet/dist/cli/cli.js \
DEFAULT_NETWORK=regtest DEFAULT_ELECTRUM_HOST=127.0.0.1 DEFAULT_ELECTRUM_PORT=60001 \
DEFAULT_ELECTRUM_TLS=false CHILD_PORT_BASE=3901 CHILD_PORT_MAX=3950 BEIGNET_TRUST_ALL=1 \
node server/index.js
```

Wallet daemons listen on `3901 + 6000` and up, which is what the scripts pass
as the primary's address.

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

`02` reads the on-chain balance right after a splice; the figure lags until
the electrum server sees the splice transaction, so its two balance checks
can report a stale number on a fast machine while the channel figures are
right. `03` opens the CLN channel from the primary's side and pays CLN over
it first, because CLN needs outbound toward the primary to pay its
dependents; a CLN-initiated open trips coreyphillips/beignet#670.
