# Beignet App Store

A [community app store](https://github.com/getumbrel/umbrel-community-app-store) for [Umbrel](https://umbrel.com) that packages the [beignet](https://github.com/coreyphillips/beignet) wallet engine as a multi-wallet Bitcoin and Lightning dashboard.

## Install on Umbrel

1. In umbrelOS, open the **App Store**, then **Community App Stores**.
2. Add this store by URL: `https://github.com/coreyphillips/beignet-umbrel`
3. Install **Beignet** from the store.

**No full node required.** Beignet depends on no other app. Point it at any Electrum server, or, if you run the **Electrs** or **Fulcrum** app on your Umbrel, use the one-click presets in **Settings**. Set an app-wide default Electrum server and network for new wallets, and override them per wallet.

## Features

Hover or tap the **?** beside a setting in the dashboard for what it does.

### Wallets

- **Many wallets at once**, each an independent node with its own on-chain wallet and Lightning identity. The wallet's name is its Lightning alias.
- **Create** a new wallet (12 or 24 words) or **import** a recovery phrase, on mainnet, testnet or regtest.
- **On-chain-only wallets**: a plain Bitcoin wallet with Lightning put away. Switch Lightning on or off later from Edit, on the same seed.
- **Lightning-first wallets**: one balance held in a single channel with a primary node (one of your wallets or an external beignet node). Deposits move into the channel by themselves, and invoices are payable before the channel exists. See [docs/LFBW.md](docs/LFBW.md).
- **Supervised daemons**: a wallet that crashes restarts with backoff, and one whose chain height stalls is restarted.

### Sending and receiving

- **Send** on-chain (address or BIP21, to another of your wallets, Max, fee presets with the exact fee quoted) or over Lightning (BOLT11 invoices, BOLT12 offers, keysend), with a fee and route preview.
- **Receive** with a BIP21 QR that can carry the Lightning invoice too, and invoices that flip to a paid receipt.
- **Receive offline**: an opt-in on the invoice form that prepares an invoice payable while the wallet is stopped, settled by a node that stays online and credited when the wallet is back. Manual voucher books sit under Advanced offline receive. See [docs/FFOR.md](docs/FFOR.md).
- **Offers**: create, share, pay and delete BOLT12 offers.
- **Activity**: on-chain and Lightning history, coins, and fee bumping (RBF or CPFP) for unconfirmed transactions.
- **Notifications** when money arrives, a payment settles or fails, or a channel opens or closes.

### Channels and peers

- **Open** a channel to any node or to one of your own wallets (zero-conf between your own), **splice** funds in or out where the peer supports it, **close** cooperatively or by force, and set each channel's routing fees.
- **Closed channels keep their story**: who closed it and why, the closing transaction, what is being swept and when a force close's balance becomes spendable, with a rebroadcast button for a close the network may not have.
- **Peers**: connect and disconnect peers, and copy this node's address to hand out (local network, clearnet or Tor).
- **Network mode**: the app runs its own Tor, and each wallet chooses Tor (every peer over Tor, only the Tor address announced), Clearnet (clearnet peers dialed directly, Tor peers over Tor, a public address you enter announced) or Hybrid (both addresses announced), plus a switch for whether it announces at all. The wallets' Lightning ports are published on the Umbrel (19101 and up), so peers on your home network dial them directly and, with a router forward, so can anyone.

### Serving other nodes

Every role is off until you switch it on for a wallet, except that a wallet picked as a lightning-first primary becomes a liquidity provider by itself. See [docs/SERVING.md](docs/SERVING.md).

- **Liquidity provider**: fund channels just in time for lightning-first wallets, with your own fees and caps.
- **Swaps**: serve reverse swaps (Lightning to on-chain) and submarine swaps (on-chain to Lightning) for other beignet wallets from this wallet's balance.
- **Guardian**: hold encrypted channel-state journals for other beignet nodes.
- **Offline receive**: settle, witness and issue invoices for wallets receiving while offline.

### Backups

- **Channel backup** per wallet: seed only, checkpoints via peer storage, or three guardians (async or strict quorum), with guardian rotation and restore. See [docs/CHANNEL-BACKUP.md](docs/CHANNEL-BACKUP.md).
- **One encrypted backup of the whole box** (every wallet's seed, API token, settings and roles), with a restore flow on a fresh install. Settings shows when it was last written and which wallets changed since. See [docs/BACKUP.md](docs/BACKUP.md).

### Tools

- A per-wallet **API explorer** (Swagger UI) over the full beignet JSON API, and a **Console** for calling it directly.
- **Logs** per wallet, filterable and downloadable, with the recent node errors.
- **Sign and verify** messages with the node key (lncli-compatible).
- Light and dark themes.

Controls for a feature stay hidden until the bundled engine has the routes behind it, so an older image never shows a button that cannot work.

## Architecture

```
Umbrel app_proxy (SSO)
        |
        v
   manager (this app)                 one beignet daemon per wallet
   - serves the dashboard    ---->    127.0.0.1:3101  wallet A
   - management API                   127.0.0.1:3102  wallet B
   - reverse-proxies /wallets/:id/api 127.0.0.1:3103  wallet C
                                              |
                                +-------------+-------------+
                                v                           v
                     electrs (Umbrel) or           the app's Tor container
                     any Electrum server           (Tor peers, one onion)
```

A single **manager** service (Node) supervises one `beignet` daemon process per wallet, each with its own isolated `HOME`, data directory, mnemonic, internal port, and Electrum configuration. The manager reverse-proxies API calls to the right wallet daemon and injects that wallet's bearer token server-side, so tokens never reach the browser. All wallets share one onion address, each on its own port. Each wallet's Lightning listen port (9101 and up inside the container) is also published on the host at 19101 and up, thirty in all, the same window the onion maps, so a wallet in Clearnet or Hybrid mode can be dialed directly.

Repository layout:

- `umbrel-app-store.yml`: the community store manifest.
- `beignet-wallet/`: the Umbrel app (manifest, compose, Tor config, icon and gallery).
- `manager/`: the manager service (`server/`) and the dashboard UI source (`ui/`).
- `docker/`: Dockerfile and entrypoint for the app image.
- `docs/`: feature documentation.
- `scripts/lfbw-regtest/`: end-to-end scenarios against real daemons on regtest.
- `.github/workflows/`: `build-image.yml` (multi-arch image to GHCR), `tests.yml`, and `check-release.yml` (see Releasing).

## Development

Run the manager against a local beignet daemon and a regtest Electrum server. The manager needs Node 22 or newer.

```sh
# 1. Build beignet locally
cd /path/to/beignet && yarn install && yarn build

# 2. Start a regtest chain. This repo ships no stack of its own; use
#    bitcoin-regtest-dashboard, which bundles bitcoind and an electrs on
#    :60401 and adds an HTTP API for mining, funding and reorgs.
#    https://github.com/coreyphillips/bitcoin-regtest-dashboard
cd /path/to/bitcoin-regtest-dashboard && docker compose up -d
curl -s http://localhost:3000/api/health

# 3. Run the manager. BEIGNET_TRUST_ALL is needed outside Umbrel: without
#    app_proxy in front, the manager's API is otherwise restricted to it
#    and to loopback.
cd /path/to/beignet-umbrel/manager && npm install
DATA_DIR=/tmp/beignet-mgr \
DEFAULT_ELECTRUM_HOST=127.0.0.1 \
DEFAULT_ELECTRUM_PORT=60401 \
DEFAULT_NETWORK=regtest \
BEIGNET_TRUST_ALL=1 \
BEIGNET_BIN=/path/to/beignet/dist/cli/cli.js \
npm start
# open http://localhost:3000
```

The manager serves the dashboard build in `manager/public`, so run
`cd manager/ui && npm run build` first if the UI source changed, or
`npm run dev` there for a Vite server on :5199 that proxies to the manager.

**Demo mode.** With `npm run dev` running, open `http://localhost:5199/?demo`
to drive the whole dashboard against an in-memory mock, with no manager or
daemon at all.

**Tests.** `npm test` in `manager/` runs the server tests, and `npm test` in
`manager/ui/` runs the dashboard's unit and render tests (no browser needed).

For the lightning-first scenarios against real daemons, see
[scripts/lfbw-regtest/README.md](scripts/lfbw-regtest/README.md).

## Build the image

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg BEIGNET_VERSION=<published-npm-version> \
  -f docker/Dockerfile -t ghcr.io/coreyphillips/beignet-app:<tag> .
```

CI builds and pushes multi-arch images to GHCR on any `v*` tag. The engine version it bundles is pinned as `BEIGNET_VERSION` in `.github/workflows/build-image.yml`.

## Releasing

umbrelOS installs this app straight from `main`, so the moment a commit lands there, every Umbrel that syncs the store tries to pull the image named in `docker-compose.yml`. Name an image that does not exist yet and the pull fails, the manager container is never created, and app_proxy waits forever on a backend that will never appear: the app hangs on **"Starting"** with nothing to explain why. The image is built from the tag, so it cannot exist until after the tag is pushed.

Release in three steps, so `main` never advertises an image that is not there:

1. **Merge the code.** Leave `version` in `umbrel-app.yml` and the image in `docker-compose.yml` alone. Nothing about what Umbrel installs has changed yet.
2. **Tag it** (`git tag v0.7.0 && git push origin v0.7.0`) and let the build publish the image.
3. **Bump, in one commit:** `version` and `releaseNotes` in `umbrel-app.yml`, and the image tag *and digest* in `docker-compose.yml`. Take the digest from the published image:

   ```sh
   docker buildx imagetools inspect ghcr.io/coreyphillips/beignet-app:0.7.0 | grep Digest
   ```

That last commit is the only one that changes what Umbrel is told to install, and by then the image is real.

The `check-release` workflow enforces this: it requires the compose image to be pinned to a digest, requires the tag to match the app version, requires the digest to actually resolve in the registry, and requires the release notes to name the bundled beignet version. A digest cannot be known before the build, so a digest that resolves is proof the image exists. It blocks the merge, rather than reporting the breakage after users have already hit it.

## Security notes

- Each wallet's seed is stored on your Umbrel under the app data directory (`wallets/<id>/secrets/mnemonic`, mode 600). This is a single-tenant home-server model, the same as other Umbrel wallet apps. Back up your seed phrase; it is shown once at creation.
- The backup archive holds every seed on the box. It is encrypted with your passphrase and nothing else, so a weak passphrase is the security of every wallet in it, and a lost one cannot be recovered.
- The manager's API is restricted to Umbrel's `app_proxy`, which enforces Umbrel's single sign-on, and to loopback, so other apps on your Umbrel's shared network cannot reach the wallet control plane directly. While `app_proxy` cannot be resolved the rest of the API allows every source, but the backup routes never do: they answer loopback only until it resolves. If you run the manager outside Umbrel, or your setup resolves `app_proxy` differently, set `BEIGNET_TRUST_ALL=1` to disable the restriction (or `APP_PROXY_HOST` to point at the right host).
- The wallet daemons' HTTP APIs bind only to `127.0.0.1` inside the container and are never exposed to your network. Their Lightning listen ports are published on the host (19101 to 19130) so peers can dial them; that transport is authenticated and encrypted end to end (BOLT 8), and a port answers nothing to anyone without the node's public key. Nothing reaches them from the internet unless you forward a port on your router.

## License

MIT
