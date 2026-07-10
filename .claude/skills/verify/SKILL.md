---
name: verify
description: Build, run, and drive the beignet-umbrel dashboard to verify UI changes end-to-end using demo mode and headless Chromium.
---

# Verifying beignet-umbrel dashboard changes

The dashboard is a React/Vite SPA in `manager/ui/`. There is no need for a
running manager or beignet daemon: demo mode serves every API call from an
in-memory mock (`manager/ui/src/mock/mockApi.js`).

## Build

```bash
cd manager/ui && npm run build   # output goes to manager/public (gitignored)
```

## Run

```bash
cd manager/ui && npm run dev     # Vite dev server on http://localhost:5199
```

Open with `?demo` once (e.g. `http://localhost:5199/?demo`); it sticks via
sessionStorage for the rest of the browser session.

## Drive

Use Playwright (chromium) headless. Install into the scratchpad, not the repo.

- Routes: `/` wallet list, `/w/:id` wallet, `/w/:id/:tab` tab
  (tabs: overview, receive, send, channels, peers, activity, offers).
- Demo wallets: `demo-main` (running, mainnet, has NORMAL channels, 6 utxos),
  `demo-savings` (running, mainnet, no channels), `demo-testnet` (running,
  testnet).
- Any non-API path other than the SPA routes gets proxied by Vite to the
  absent backend and 500s; always use the `/w/...` routes.
- Demo mock state is per-page-load module state; a reload resets balances.

## Gotchas

- Polling hooks (`usePoll`) mean some UI (wallet dropdown, channel gating
  note) appears a beat after first paint; use waitForSelector, not immediate
  assertions.
- Buttons keep their color when disabled; check the `disabled` attribute,
  not appearance.
