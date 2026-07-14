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

CI builds and pushes multi-arch images to GHCR on any `v*` tag.

## Releasing

umbrelOS installs this app straight from `main`, so the moment a commit lands there, every Umbrel that syncs the store tries to pull the image named in `docker-compose.yml`. Name an image that does not exist yet and the pull fails, the manager container is never created, and app_proxy waits forever on a backend that will never appear: the app hangs on **"Starting"** with nothing to explain why. The image is built from the tag, so it cannot exist until after the tag is pushed.

Release in three steps, so `main` never advertises an image that is not there:

1. **Merge the code.** Leave `version` in `umbrel-app.yml` and the image in `docker-compose.yml` alone. Nothing about what Umbrel installs has changed yet.
2. **Tag it** (`git tag v0.7.0 && git push origin v0.7.0`) and let the build publish the image.
3. **Bump, in one commit:** `version` in `umbrel-app.yml`, and the image tag *and digest* in `docker-compose.yml`. Take the digest from the published image:

   ```sh
   docker buildx imagetools inspect ghcr.io/coreyphillips/beignet-app:0.7.0 | grep Digest
   ```

That last commit is the only one that changes what Umbrel is told to install, and by then the image is real.

The `check-release` workflow enforces this: it requires the compose image to be pinned to a digest, requires the tag to match the app version, and requires the digest to actually resolve in the registry. A digest cannot be known before the build, so a digest that resolves is proof the image exists. It blocks the merge, rather than reporting the breakage after users have already hit it.

## Security notes

- Each wallet's seed is stored on your Umbrel under the app data directory (`wallets/<id>/secrets/mnemonic`, mode 600). This is a single-tenant home-server model, the same as other Umbrel wallet apps. Back up your seed phrase; it is shown once at creation.
- The manager and all wallet dashboards sit behind Umbrel's single sign-on.
- The manager's API is restricted to Umbrel's `app_proxy` (which enforces that sign-on) and loopback, so other apps on your Umbrel's shared network cannot reach the wallet control plane directly. If you run the manager outside Umbrel, or your setup resolves `app_proxy` differently, set `BEIGNET_TRUST_ALL=1` to disable the restriction (or `APP_PROXY_HOST` to point at the right host).
- The wallet daemons bind only to `127.0.0.1` inside the container and are never exposed to your network.

## License

MIT
