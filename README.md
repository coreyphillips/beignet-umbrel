# Beignet App Store

A [community app store](https://github.com/getumbrel/umbrel-community-app-store) for [Umbrel](https://umbrel.com) that packages the [beignet](https://github.com/coreyphillips/beignet) wallet engine as a multi-wallet Bitcoin and Lightning dashboard.

## Install on Umbrel

1. In umbrelOS, open the **App Store**, then **Community App Stores**.
2. Add this store by URL: `https://github.com/coreyphillips/beignet-umbrel`
3. Install **Beignet** from the "Beignet App Store".

**No full node required.** Beignet does not depend on any other app, so it installs on its own. Point it at any Electrum server you like. If you run the **Electrs** or **Fulcrum** app on your Umbrel, use the one-click presets in **Settings** (or the per-wallet Electrum field) to connect to it. You can set an app-wide default Electrum server and network for new wallets, and override them per wallet.

## What it does

Beignet runs one or many self-custodial wallets on your Umbrel:

- **Multiple wallets at once**, each an independent node with its own on-chain wallet and Lightning identity.
- **Create** a new wallet (generates a fresh seed) or **import** your own recovery phrase.
- **Bring your own Electrum server**: no full node needed. Point at any Electrum server, or connect to your Umbrel's Electrs/Fulcrum with a one-click preset. Set an app-wide default and override it per wallet.
- A per-wallet **API explorer** (Swagger UI) over the full beignet JSON API.

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
                                              v
                                   electrs (Umbrel) or a custom Electrum
```

A single **manager** service (Node) supervises one `beignet` daemon process per wallet, each with its own isolated `HOME`, data directory, mnemonic, internal port, and Electrum configuration. The manager reverse-proxies API calls to the right wallet daemon and injects that wallet's bearer token server-side, so tokens never reach the browser. Umbrel's `app_proxy` provides single sign-on in front of everything.

Repository layout:

- `umbrel-app-store.yml` — community store manifest.
- `beignet-wallet/` — the Umbrel app (manifest + compose + icon/gallery).
- `manager/` — the manager service and dashboard UI source.
- `docker/` — Dockerfile + entrypoint for the app image.
- `.github/workflows/` — multi-arch image build to GHCR.

## Development

Run the manager against a local beignet daemon and a regtest Electrum server.

```sh
# 1. Build beignet locally
cd ../beignet/beignet && yarn install && yarn build

# 2. Start the regtest stack (bitcoind + electrs on :60001)
docker compose -f docker/docker-compose.yml up -d bitcoind electrs

# 3. Run the manager
cd ../../beignet-umbrel/manager && npm install
DATA_DIR=/tmp/beignet-mgr \
DEFAULT_ELECTRUM_HOST=127.0.0.1 \
DEFAULT_ELECTRUM_PORT=60001 \
DEFAULT_NETWORK=regtest \
BEIGNET_BIN="$(cd ../../beignet/beignet && pwd)/dist/cli/cli.js" \
npm start
# open http://localhost:3000
```

## Build the image

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg BEIGNET_VERSION=<published-npm-version> \
  -f docker/Dockerfile -t ghcr.io/coreyphillips/beignet-app:<tag> .
```

CI builds and pushes multi-arch images to GHCR on any `v*` tag. After a release, pin the produced digest in `beignet-wallet/docker-compose.yml`.

## Security notes

- Each wallet's seed is stored on your Umbrel under the app data directory (`wallets/<id>/secrets/mnemonic`, mode 600). This is a single-tenant home-server model, the same as other Umbrel wallet apps. Back up your seed phrase; it is shown once at creation.
- The manager and all wallet dashboards sit behind Umbrel's single sign-on.
- The wallet daemons bind only to `127.0.0.1` inside the container and are never exposed to your network.

## License

MIT
