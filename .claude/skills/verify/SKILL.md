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
- Demo wallets: `demo-main` (running, mainnet, has NORMAL channels, 6 utxos,
  strict-quorum channel backup), `demo-savings` (running, mainnet, no
  channels, on-chain only), `demo-testnet` (running, testnet, peer-storage
  backup), `demo-fresh` (running, mainnet, one below-reserve channel, seed
  only), `demo-fenced` (running, another device took over its channels),
  `demo-restore` (holding for a guardian restore; its Restore channels button
  runs a scripted restore that lands three channels over about 15s, one of
  them closing safely), `demo-capsule` (peer storage, empty, a peer returned
  a checkpoint; Recover channel funds runs the scripted SCB recovery),
  `demo-lfbw` (lightning-first on `demo-main`; its Receive tab's "Receive
  while offline" card shows an ACTIVE FFOR epoch of three vouchers, one
  paid, one shared, one still to mint, and a return panel above the tabs
  from the book before it; `demo-main` settles for it, so its Overview
  carries the "Offline receives settled for siblings" card and its Edit
  dialog the settle toggle). `/ffor/epoch/start` in the mock runs to
  ACTIVE over about five seconds; `/ffor/recover` and the manager's
  `ffor/return` close the book, marking every shared invoice paid.
  `demo-witness` (mainnet, keeps receipts and issues invoices for
  siblings, a public channel to `demo-main` and a private one to
  `demo-savings`, so its invoices hint through demo-savings: a 150,000 sat
  invoice minted on its Receive tab and pasted into `demo-lfbw`'s Send tab
  shows the no-route reading, `[data-testid="no-route"]`, naming
  demo-savings and the 120,000 sats held with it, with Pay enabled, and
  Pay then fails with the same reading kept on screen; an amount above
  `demo-lfbw`'s Can send meets that wallet's own lightning-first notes
  instead. The too-little-to-send reading with Pay held shows on
  `demo-main`'s Lightning rail with an invoice for more than it can send,
  for example 9,000,000 sats minted on `demo-witness`): its
  Overview carries the
  "Receipts kept for siblings" and "Invoices issued for siblings" cards,
  and the seeded epoch on `demo-lfbw` names it as an acknowledged witness.
  Starting a new book on `demo-lfbw` with the witness ticked and the
  issuer picked runs the mock's setup over about four seconds
  (`[data-testid="ffor-setup"]`) and then shows the offer QR
  (`[data-testid="ffor-offer"]`) with no Create invoice buttons.
- Any non-API path other than the SPA routes gets proxied by Vite to the
  absent backend and 500s; always use the `/w/...` routes.
- Demo mock state is per-page-load module state; a reload resets balances.

## Assets

The Assets tab is `/w/:id/assets`. Its place is in the address: `?view=receive`,
`?view=send`, `?view=create`, and `?asset=<key>` for one asset's page (the key
is the `data-key` of its row on Holdings). The demo's assets backend keeps its
state in sessionStorage (`beignet-demo-assets-v1`), so it survives a reload
within one browser context, and its rows move by the clock: a mint or a
receive gains a confirmation about every 5 s, a send completes in about 11 s,
a prepared send or burn expires after 60 s.

Wallets and what each one is for:

- `demo-main`: the rich mainnet wallet. Three normal assets, two collectibles
  as tiles, the stale-backup note. The Pico row reads
  `90,071,992.54740993`, a balance above 2^53: the last digit must be 3.
- `demo-testnet`: a receive waiting on confirmations and one whose proof is
  late (`[data-testid="asset-proof-late"]`, with Try again now). tUSD is a
  grouped asset.
- `demo-fresh`: the first-run empty state (`assets-empty`) with the limits list.
- `demo-savings`: on-chain only, with a mint found at 2 of 6 confirmations
  (`asset-progress-item`). Watch it across one confirmation: the row must
  not change height.
- `demo-lfbw`: lightning-first, no on-chain bitcoin, so a send is refused for
  sats. `demo-witness` holds no assets: use it as the other party.

Flows:

- Send: make an address on `demo-witness` (Receive, Another asset, paste
  the `data-key` from `demo-main`, an amount, Create address, read
  `asset-address-full`), then paste it into `demo-main`'s Send. Expect
  `asset-send-preview` to reach `data-state="read"`, then `asset-send-cost`,
  then Send, then `asset-send-status` to walk to `data-state="complete"`.
- Send refusals (`asset-send-refusal`, with `data-code`): the address cut
  short (it fails its checksum, and so does one whose prefix was edited),
  an address made on `demo-testnet` (wrong network), an amount above the
  balance, a fee rate of 9999, the address pasted into the wallet that made
  it (own address), into `demo-savings` (asset not held) and into
  `demo-lfbw` (no sats). A bitcoin address gets a blue note instead, and so
  does a Lightning invoice on an on-chain only wallet (elsewhere in the demo
  it opens the pay flow, see Lightning below). A refusal is always a
  sentence, never a bare code.
- Short of bitcoin: a transaction is built around 2,000 vbytes' worth of
  fee, so the wallet has to hold more than the transaction costs. On
  `demo-fresh` (about 1,023,000 sats), Create with a fee rate of 500 shows
  `mint-refusal`: "Minting costs 78,000 sats, but the wallet has to hold
  about 1,077,000 sats on-chain to build the transaction. What is not spent
  comes straight back." with the wallet's balance, and the button waits.
  Send and Burn word it the same way.
- Receive: under a new address, the line that it takes one payment
  (`asset-address-once`), and in the Status card the quiet line that the
  wallet checks it by itself, with Check now (`asset-watched`).
- Create: a name of 60 characters and one of 60 with no space in it, minted
  together. Then look at the Creating card, the In progress row, the
  Holdings row, the asset's page and the Receive chips at 480 px.
- Burn: an asset's page, Burn, an amount and the asset's name typed exactly.
- Settings: the Settings button at the end of the views bar. Test, Custom,
  and Advanced for the lookup by ID.
- Proof files (a proof handed over as a file, for when the proof server
  will not carry it). Sender: `assets-demo=send-refused` on `demo-main`
  gives a send with the red note, whose buttons are Offer it again now,
  Save the proof file (`asset-proof-save`, a download named
  `proof-<8 hex>-<8 hex>.assetproof`) and Mark as handed over
  (`asset-proof-handed`). Marked, the send leaves In progress and the count
  beside the tab; on the asset's page its history row reads "handed over" in
  green, and its dialog has the blue `asset-proof-handed-over` note with
  Save the file again and Undo. Recipient: every Receive view ends its
  Recent receives card with the quiet line `asset-proof-handover` and Import
  a proof file (`asset-proof-import`, over a hidden
  `asset-proof-import-file` input). The whole round trip: put
  `assets-demo=proof-server-down` on `demo-witness`, make an address there,
  pay it from `demo-main`, wait about 10 s for the blue undelivered note
  under `demo-main`'s In progress and on its Sent card, save the file
  (`page.waitForEvent('download')`), then on `demo-witness` wait for the
  receive to read "proof late", open it and give the saved file to
  `asset-proof-late-import-file` with `setInputFiles`. Expect the toast "The
  proof checks out, and the asset is in your holdings." and the asset under
  Holdings. Any other
  file is refused in a sentence, and the same file on `demo-savings` says it
  is not for an address that wallet made.

Lightning (asset channels). Real wallets hide all of it until the engine can
carry asset channels: the manager answers `assetChannelsAvailable: false` and
the host `status.lightning.mode: 'off'`. The demo answers true, so it shows on
every demo wallet that has Lightning. Use `demo-main`, which has one open BUSD
channel with "Lightning Labs edge" (2,400.00 yours, 3,100.00 theirs).

- Channels, `/w/demo-main/channels`: the "Asset channels" card
  (`asset-channels`) sits under the bitcoin channels on the Open view only.
  Open asset channel (`asset-channel-open`) gives the dialog
  (`asset-channel-open-dialog`): an asset, an amount, a peer, a fee rate,
  then the cost table (`asset-channel-cost`: 100,000 sats go in with the
  asset, 4,320 sats of miner fee at 18 sat/vB). The new row reads "opening"
  for about 15 s, then "open". A typed peer whose key starts `0200000000` is
  refused (`asset-channel-refusal`, `PEER_NO_ASSET_CHANNELS`). Close on a row
  gives the cooperative page, with force close behind a second page. The same
  dialog opens from an asset's page (`asset-action-open-channel`) with that
  asset already chosen.
- Receive, `/w/demo-main/assets?view=receive`: pick BUSD and type 250. The
  "Lightning invoice" card (`asset-invoice-card`) prices it
  (`data-state="priced"`), Create invoice shows the QR and a 60 s countdown,
  and about 12 s later the QR gives way to `asset-invoice-paid`. An amount of
  5000 is refused in words (more than the 3,100.00 the peer holds).
- Pay, `/w/demo-main/assets?view=send`: paste a BOLT11 invoice (copy one from
  `asset-invoice-full`, or build one in the page with `bech32Encode` from
  `src/lib/payment-uri.js` and an hrp like `lnbc50u`; the checksum must be
  right). `asset-pay` shows what the invoice asks for, the assets that can pay
  it and a price held for 30 s; the button reads "Pay 3.57 BUSD" and the
  receipt is `asset-pay-receipt`. Left alone for 30 s the button becomes "Get
  a new price" (`asset-pay-renew`) and nothing is paid. A price that moved is
  only reachable when the wallet's clock is ahead of the page's: in the same
  `page.evaluate`, replace `Date.now` with one 31 s ahead and click
  `asset-pay-submit`. Expect `asset-pay-changed` (about 1% more), no receipt,
  the button showing the new amount and held disabled for a second.
- `demo-testnet` has Lightning and no asset channel: an empty Asset channels
  card, an invoice card that says nothing can be received, and `asset-pay-none`
  for a pasted `lntb` invoice. `demo-savings` (on-chain only) must show none of
  this: no Channels tab, no invoice card, no "Open channel" on an asset's page.

States a healthy wallet never shows are switched from the address, for the
wallet in the address, and stick until switched back:
`/w/demo-main/assets?assets-demo=<state>`.

| `assets-demo=` | What to expect |
| --- | --- |
| `failed` | One card, `assets-unavailable`: the reason, and that the bitcoin wallet is unaffected. No views bar, no warnings, no toast, no skeleton. |
| `unloaded` | The same card, from a route answering 503 `EXTENSION_UNAVAILABLE`. |
| `starting` | `assets-starting`: quiet, with a count (3 of 12) and no spinner. |
| `restarting` | `assets-restarting`: a wait, not a failure. |
| `proof-server-down` | The red `PROOF_SERVER_DOWN` warning above every view, `asset-send-waits` on Send and `asset-receive-waits` on Receive. |
| `ok` | Back to normal (the three rows below stay until they are dealt with). |
| `stuck` | A send two hours without a block: the blue `STUCK` note says fees cannot be bumped, with Broadcast again (`asset-rebroadcast`). Pressing it clears the note and the send goes on to confirm. |
| `proof-refused` | Use `demo-testnet`. Its finished mint carries a blue note, `asset-proof-unpublished`, in the In progress list and on the asset's page: created and held, the proof server has not taken its proof. Never red, never "failed". Try again clears it. |
| `send-refused` | A send six blocks deep whose proof the proof server answered "no" to. Its In progress row carries a red note, `asset-proof-undelivered` (`data-code="PROOF_REFUSED"`): the server answered, the recipient does not have the asset yet, nothing is lost. The headline reads "the proof server did not take the proof", the In progress tile and the dialog's pill read "proof refused" (red), and the timeline's proof step gives the server's reason and never says "not answering". Offer it again now clears it and the send completes. |
| `unwatched` | Use `demo-testnet` with `view=receive`. An address nine days unpaid reads "not checked" in Recent receives, and its dialog has `asset-not-watched` with Check now, which finds the payment. |

What to look at, in dark, in light (`localStorage['beignet-theme'] = 'light'`
before load) and at 480 px wide:

- Nothing scrolls sideways and nothing leaves its card. Asset IDs, addresses
  and transaction IDs are shortened or wrap inside their box; a full address
  is only ever shown inside `asset-address-full`. To check by measurement:
  `document.documentElement.scrollWidth` must not exceed `clientWidth`. The
  connector lines of a timeline (`li.tl-step`) report a scroll width wider
  than their box by design; that one is not an overflow.
- Right after a mint, send or burn is broadcast there must be no "no
  bitcoin on-chain" banner: the wallet's balance reads zero for a moment
  and the page waits for the first block before saying so.
- At 480 px the receive and history tables become two-line rows, and the
  stat tiles take one line each (the app's convention on a phone).
- Figures line up on the right in Holdings and keep their decimals; the unit
  beside a figure is smaller and muted.
- Hover and keyboard focus on asset rows, tiles and chips: the focus ring is
  the orange outline, fully visible, not clipped by the card.
- The timeline (`.tl-step`) in a progress row, in the Sent card and in the
  transfer dialog: marks aligned on one line, the current step distinct.
- Notes in both themes: red for what is blocked, blue for what is only
  said, both readable on the light background.

## Gotchas

- Polling hooks (`usePoll`) mean some UI (wallet dropdown, channel gating
  note) appears a beat after first paint; use waitForSelector, not immediate
  assertions.
- Buttons keep their color when disabled; check the `disabled` attribute,
  not appearance.
