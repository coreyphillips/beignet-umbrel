# rbitcoin dashboard and saved defaults

The next rbitcoin app image includes a responsive dashboard with three views:

- **Overview:** sync or indexing progress, block height history, measured download traffic, peer transports, mempool capacity, minimum fee rate, uptime, and process memory.
- **Connect a wallet:** separate home-network and internal addresses, copy controls, connection readiness, and setup instructions.
- **Settings:** persistent node defaults, the values used at the last node launch, pending restart status, and browser display preferences.

The currently published app manifest and image pin are unchanged. The new dashboard is available in a locally built image until the next app image is published and the release configuration is updated.

## What is measured

The page polls `/readyz`, `/progress`, and `/metrics` through nginx. Only a successful readiness response marks the node ready. An index stage's percentage is labeled as stage progress. During catch-up, a header height ahead of the block height supplies the target; otherwise the target is estimated from the tip block time and the ten-minute target interval. An estimated percentage cannot mark the node ready.

Charts collect samples in the current tab, retain up to one hour, and reset on reload. The chart window can be five minutes, fifteen minutes, or one hour. Rates use counter deltas and actual elapsed time. Missing metrics produce gaps, and counter resets or node restarts do not produce negative rates. Pace estimates require at least one minute of observed forward progress and reset on a gap, restart, or rollback. An unavailable metric is never displayed as zero.

Mempool capacity is measured in transaction weight units. Upstream's `--mempool-size-mb` flag is misleadingly named: a value of 300 means 300 million weight units, corresponding to a capacity of 75 million virtual bytes. It is not a 300 MB process-memory limit. The capacity chart uses the node's live reported cap, so a saved but unapplied setting does not change its denominator.

## Saved node settings

| Setting | Default | Accepted values | Node flag |
| --- | --- | --- | --- |
| Outbound peer limit | 16 | 1 to 128 | `--max-outbound` |
| Inbound peer limit | 125 | 0 to 1000 | `--max-inbound` |
| Mempool capacity | 300 million WU | 1 to 16384 million WU | `--mempool-size-mb` |
| Log detail | info | error, warn, info, debug, trace, off | `--log-level` |

These are deliberate dashboard bounds, not a claim that all values are suitable for every machine. Defaults match the pinned upstream node. Network, data paths, listeners, validation policy, and indexing flags remain operator-managed in compose.

`settings.json` and `launched.json` live in `${APP_DATA_DIR}/settings`, outside the chain data and the replaceable web assets. The settings service runs as uid 1000 and atomically saves validated JSON with a revision check. Conflicting edits from another browser return HTTP 409. Restoring defaults fills a draft for review; the user still chooses Save changes.

The node launcher reads the saved defaults, prepends their CLI arguments, records those values plus any explicit compose overrides in `launched.json`, and execs the node. Docker's stop signal still reaches the node directly. There is no Docker socket or restart endpoint. To apply a saved change, restart the app in Umbrel and allow the store to flush normally. Last-launched values describe the launch attempt, not a guarantee that the node is healthy; Overview reports live readiness.

The settings service has no published host port. It accepts requests only from the web container, with nginx's overwritten client address identifying one of this app's Umbrel proxy containers. Docker DNS is refreshed every five seconds and failed resolution denies access. Browser writes additionally require a same-origin `Origin`, JSON, and a custom header, with no CORS support. The web container preserves the browser Host header. `WEB_HOST` and `APP_PROXY_HOSTS` are operator-only environment overrides for deployments with different container names. An unrelated app cannot bypass Umbrel authentication by calling the API or nginx directly.

Appearance (device, light, or dark), refresh frequency (5, 10, or 30 seconds), and chart window are stored in browser local storage. If storage is unavailable, preferences work for the current visit and the page says they were not persisted.

## Verification

From the repository root:

```sh
python3 -m unittest discover -s docker/rbitcoin/tests -p 'test_*.py'
node --test docker/rbitcoin/tests/model.test.mjs
```

The browser test uses Playwright installed outside the repository:

```sh
npm install --prefix /tmp/rbitcoin-browser playwright@1.62.1
/tmp/rbitcoin-browser/node_modules/.bin/playwright install chromium
PLAYWRIGHT_MODULE=/tmp/rbitcoin-browser/node_modules/playwright \
  node docker/rbitcoin/tests/browser.test.mjs
```

Set `SCREENSHOT_DIR` to an existing directory to capture desktop, mobile, and dark-mode screenshots. Browser fixtures are test-only and are never shipped with the dashboard. The test covers ready, syncing, indexing, offline, and missing-metric states; saving and restoring settings; a conflicting save; persisted display choices; copying addresses; and overflow checks from 320 to 1440 pixels.

For the actual image and backend:

```sh
docker buildx build --load --platform linux/amd64 \
  -f docker/rbitcoin/Dockerfile -t rbitcoin:dashboard .
sh docker/rbitcoin/tests/smoke.sh
```

The runtime smoke uses unique temporary containers, private volumes, an isolated regtest node, and a localhost-only web port. It checks the actual nginx module MIME type and proxy chain, rejects cross-origin and direct-app writes, saves settings, checks a clean stop, restarts the node, and verifies that the reported mempool cap changed. It cleans up its containers, network, and volumes. It never mounts an installed app or mainnet data. The existing Electrum and node lifecycle smoke remains in CI alongside these checks.

## Preview wiring and release

`docker/rbitcoin/compose.dashboard.yml` is an override for the next image, intended to be combined with the base app compose file in an Umbrel development environment. It changes both app services to the local `rbitcoin:dashboard` image, adds the persistent settings volume and the settings API service, removes the fixed log-level flag, and supplies `SETTINGS_HOST` to nginx. It assumes Umbrel supplies its normal `app_proxy` service and shared app network. For an isolated local verification, use the regtest smoke above instead of starting mainnet with this override.

The published compose file deliberately keeps its existing image digest. Adding a `settings-server` command to that old image would break installed apps because that image does not contain the settings service.

When releasing:

1. Publish the next app patch using the existing rbitcoin image release workflow. The upstream binary pins are unchanged by this dashboard work.
2. Fold the service changes from `compose.dashboard.yml` into `beignet-rbitcoin/docker-compose.yml`.
3. Pin **both** `node` and `settings` to the newly published image tag and digest. Keep the official nginx digest pinned.
4. Keep `${APP_DATA_DIR}/settings:/settings` on both app services; keep the node's existing data and web mounts. Remove `--log-level info` from the node command so the dashboard choice can take effect. Explicit compose flags otherwise take precedence.
5. Keep `SETTINGS_HOST=beignet-rbitcoin_settings_1`, include `SETTINGS_HOST` in `NGINX_ENVSUBST_FILTER`, and add the settings service to the web service's dependencies.
6. Bump `umbrel-app.yml` and describe the dashboard, persistent settings, and restart requirement in the release notes. No chain-data migration or fresh sync is needed for these packaging changes.
7. Run the release checks and the runtime smoke against the published image before updating installed apps.
