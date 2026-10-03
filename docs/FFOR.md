# Concurrent receive in Beignet 0.25.0

The next image bundles published Beignet 0.26.0, release commit `026d202b96ada2d88f7cf0a206f36697fcf6b3fe`. Capability detection checks implemented daemon routes, engine methods and configuration parsing. A documentation marker alone does not enable concurrent controls.

A negotiated version 2 book can use a funded home channel. Ordinary online payments keep the engine's remaining capacity. Reconnect synchronizes receipts without retiring concurrent books. Refresh receipts requests signed live sync; Close the book now calls `/ffor/epoch/close` explicitly. Closing stops new admissions and invoice exposure. Unknown version 2 slots remain reserved in DRAINING until safely resolved, even after expiry or a close acknowledgement.

Concurrent advertisement and acceptance of new books default on. Settlement remains an explicit opt-in. Disabling new-book acceptance preserves service for existing books. Version 2 issuer provisioning remains unavailable. Reserved homes wait for channelization instead of opening a replacement or attempting a splice.

Closing the browser leaves the daemon online. Stopping the daemon does not. Ordinary HTLC deadlines still apply and are distinct from offline voucher expiry. Proof custody and a successful sync request are not confirmation of wallet credit.

The manager passed the full concurrent regtest sequence against the npm-installed `beignet@0.25.0` daemon on Node 22.13.1. A single 500,000-sat home channel started with 100,000 sats owned by the receiver. A live 20,000-sat offline invoice allowed ordinary payments of 5,000 sats out and 6,000 sats in. The receiver daemon was stopped before external payment. Both cold starts automatically reconciled to 121,000 sats total and 116,000 sats available, with exactly one completed payment in the ledger used by Activity. A manual two-voucher book redeemed 12,000 sats while its 13,000-sat voucher remained payable. Early closure of another book retained one unknown 17,000-sat reservation in DRAINING. Further ordinary payments completed, leaving 147,000 sats total and 142,000 sats available.

Server tests: 251 passed. Dashboard tests: 324 passed. The dashboard production build passed. The regtest drives the manager and daemon endpoints used by the dashboard; it does not automate browser rendering. `scripts/lfbw-regtest/concurrent-adapter.cjs` runs with the portable engine's shared `scripts/regtest-ffor.cjs` acceptance driver through `FFOR_RUNTIME_ADAPTER`. Set `MANAGER_URL` to a disposable manager, `BEIGNET_SOURCE_DIR` to the published package directory, and `BEIGNET_WALLET_CORE_DIR` and `BEIGNET_RELAY_DIR` to local dependencies. `BEIGNET_EVIDENCE_FILE` records balances and restart times.

Historical validation below covers earlier behavior and does not establish version 2 qualification.

# Receive while offline (FFOR)

FFOR (Fast-Forward Offline Receive, spec at github.com/coreyphillips/ffor,
Variant D) lets a wallet on this box be paid while its daemon is off. This
document is what the app does with it as built: the roles, what the user
sees, the constraints the engine imposes, and how to verify it against real
daemons. The engine side is beignet's `/ffor/*` surface (beignet #729) and
the role switches it honours from 0.21.4 on (beignet #865).

## Optional receiving for regular wallets

Regular Lightning wallets show an unchecked **Receive offline** option in the
ordinary invoice form. It becomes available once a fixed amount of at least
354 sats is entered and the engine supports the automatic receive API. Leaving
it unchecked preserves ordinary receiving, including amountless invoices.

When checked, select a connected receiving node and review its sender fee terms.
Known settlement wallets are listed first. The daemon checks protocol support
before creation; unsupported peers and failed preparation never fall back to an
online-only invoice. An external connected node can be used too. The node must
have settlement switched on (its own setting), and a channel with it must
already have room for the amount: since beignet 0.21.10 receiving offline never
opens a channel. With no such channel the form says so, and unticking the box
gives the ordinary invoice.

Changing the checkbox or receiving node clears the displayed invoice and its
BIP21 attachment. Create a new invoice for the new choice. An invoice already
shared is not changed or cancelled. The form distinguishes stopping the wallet
from closing the browser, which leaves the Umbrel daemon running. Manual voucher
book controls remain under **Advanced offline receive**.

Lightning-first wallets show the same checkbox, with their primary as the
receiving node; see below. RN and web wallet behavior is unchanged.

## Automatic Lightning-first receiving

Lightning-first wallets receive over Lightning the way they always have
(a plain invoice when the home channel covers it, a just-in-time one through
the primary when it does not). Ticking "Receive offline" on the Receive form
instead prepares a fixed-amount invoice that remains payable while the wallet
daemon is stopped. Users do not select channels, create voucher books or
trigger a return. The box is off by default and selectable only with an amount
of at least 354 sats and the primary connected. The primary must support the
automatic receive protocol and opt into settlement, its own setting, which a
wallet picking it as primary never switches on. Since beignet 0.21.10 an
offline receive only uses a channel that already exists with the primary and
has room for the amount; it never has the primary open one, so the primary's
separate "Fund channels for automatic receiving" switch is not needed for it.
With no such channel the box says so, and unticking it gives the ordinary
just-in-time invoice.

The daemon persists preparation before exposing an invoice and discovers
receipts while running, including after restart. Paid reservations reconcile
into the normal invoice history and balance. Unpaid invoices remain payable for their invoice lifetime. Concurrent version 2
slots without conclusive payment or cancellation evidence remain reserved, even
after the settlement grace period. Receipt query failures retain the reservation. Recovery still requires the settlement
peer to return; this path never force closes automatically.

The manager excludes `/receive/status` reservations from channelization and
legacy startup return. If it cannot read the journal, it postpones those actions.
Retries after a lost creation response reuse the same request id. Fixed amounts
below 354 sats and amountless requests cannot be received offline. With the box
ticked, an unsupported engine or peer shows an error instead of silently
producing an online-only invoice; unticking it returns to the ordinary invoice.

**Engine requirement:** the daemon `/receive/*` API and funding-policy environment
variable require Beignet 0.21.9 or newer. The image workflow pins 0.26.0; from 0.21.10 an offline receive is only for a channel that already exists with the primary and has room for the amount, never one the primary opens for it. Older
engines fail the capability check and cannot create automatic offline invoices.

The advanced manual workflow below remains available for other Lightning wallets.
Its startup return does not own automatic reservations.

## How it works

Before going away, the wallet (the receiver, R in the spec) pre-signs a book
of fixed-amount vouchers with a **settlement peer** (S) on one of its
channels: an **epoch**. Each voucher is one slot with one payment hash that
S generated. The wallet hands out one BOLT 11 invoice per slot, then can go
offline. A payer's HTLC for one of those invoices reaches S, which settles it
at once against the pre-signed voucher and sends the wallet nothing. With a
concurrent book, live signed sync credits redeemed vouchers while keeping other
invoices payable. With a baseline book, the wallet **returns**: it closes the epoch cooperatively, S
answers with the settled bitmap and the preimages, and the paid vouchers
land in the wallet's channel balance. If S is gone or contradicts the
epoch, the wallet can **enforce** on-chain: a force close that claims every
settled voucher through the signature S gave at setup.

The legacy manual workflow leaves these responsibilities to the host:

- **Manual books use the manager return.** On reestablish it only
  notices a mismatch; nothing credits the settled slots. The manager calls
  `POST /ffor/recover` (cooperative only, never a force close on its own)
  after every healthy start, for every epoch the wallet receives on whose
  channel still operates, once the channel to S is back in NORMAL. The
  daemon's `action` only says what the call initiated (it answers
  `nothing` for a drain in progress and for an epoch already closed as
  well as for a peer that is not there), so the manager reads the outcome
  off the epoch and the channel: `closed`, `draining` (kept watched until
  the drain completes), `enforced` (the channel is closed on-chain),
  `unreachable`, `failed`. The outcome is on the wallet record
  (`fforReturn`) and in the wallet log, and the dashboard shows it above
  the tabs. Enforce stays a user action, through the manager: the daemon
  answers a refusal inside a 200 (the force-close route's shape), the
  manager turns it into an error, records a real broadcast
  (`fforEnforced`) and answers the enforce warning, which the epoch's state
  never does since a force close leaves the epoch ACTIVE by design.
- **A settlement peer must opt in.** Without `BEIGNET_FFOR_SETTLE=true` a
  daemon refuses every book. Every beignet node advertises the protocol's
  feature bit whether or not it settles, so "which peer can I use" cannot
  be read from `/peers`; the manager answers it from its own records.

## Roles in the app

- **Settle offline receives for sibling wallets**: a per-wallet toggle on
  the create form and the Edit dialog (`ffor.settle` on the record, the
  `FforSettleField` component). It sets `BEIGNET_FFOR_SETTLE=true` plus the
  fee floor and the optional caps (`BEIGNET_FFOR_FEE_BASE_MSAT`, `_FEE_PPM`,
  `_MAX_BUDGET_MSAT`, `_MAX_EPOCH_BLOCKS`). Off contributes nothing to the
  env. Refused on an engine without the surface (`FFOR_UNSUPPORTED`) and
  for an on-chain only wallet (`FFOR_NEEDS_LIGHTNING`); parking Lightning
  drops it. Changing it restarts the wallet. The natural settler is the
  primary node of your lightning-first wallets, or any wallet that stays
  online.
- **Receiving** needs no role: any Lightning wallet with an open channel to
  a settling sibling can start an epoch.
- **Keep receipts for sibling wallets receiving offline (witness)**: the
  same toggle group (`ffor.witness`, with optional caps on mailboxes and
  bytes) sets `BEIGNET_FFOR_WITNESS=true`. A sibling going offline can name
  this wallet in its book; payments to the book then route through this
  wallet, which stores an encrypted receipt of each before passing the
  fulfil on, so the sibling can collect what it was paid even if its
  settlement peer disappears. The receipts are opaque to the witness.
- **Issue invoices for sibling wallets receiving offline (issuer)**:
  `ffor.issuer` sets `BEIGNET_FFOR_ISSUER=true` and needs the witness on
  the same wallet (the daemon refuses to start otherwise, and so does the
  manager). A sibling hands it a BOLT 12 offer; a payer who holds no
  invoice asks this wallet and gets the invoice for the next unused
  voucher, one per request.

## What the user sees

- **Receive tab, "Receive while offline"** (`OfflineReceiveCard`), on an
  engine with the routes: the settlement peer picked among the wallet's
  open channels whose peer is a settling sibling, the amount per voucher,
  the number of vouchers, the days away, and the fee offered to the peer
  under a disclosure. Start calls `/ffor/epoch/start`; setup runs to ACTIVE
  by itself and the card shows it. While ACTIVE the card lists every slot
  with its state, offers Create invoice for a slot that has none (the
  invoice shows as a QR with a copy row), and says the return-by height in
  blocks and days at ten minutes a block. Refresh receipts synchronizes a concurrent book without retiring it. Close the
  book now explicitly calls `/ffor/epoch/close`; unknown version 2 reservations
  remain held in DRAINING. A closed book shows what was paid and
  offers Start another; an aborted setup shows the engine's reason and the
  form again.
- **The header** carries a green `receiving offline` badge while an epoch
  is ACTIVE and a red `enforce on-chain` badge when the peer contradicted
  it.
- **Witnesses and legacy issuers on the card.** Version 2 books can use
  witnesses, but issuer provisioning is unavailable. For baseline books, when a sibling keeps receipts,
  the start form offers it as a witness (never the settlement peer itself:
  a witness sits on the path before it), and among the chosen witnesses
  one that issues can be named as the issuer with an offer description.
  The manager runs the whole setup in one call (`POST
  /api/wallets/:id/ffor/epoch`): the book names the witnesses, setup runs
  to ACTIVE, each witness is connected over loopback and provisioned, and
  the issuer gets the offer and its path template, built from the issuer's
  own channel toward the settlement peer and the forwarding policy it
  applies on it. The card shows the progress step by step and offers Retry
  provisioning when a step failed (`POST /api/wallets/:id/ffor/provision`).
  With an issuer, the whole book is the issuer's to hand out: the card
  shows the offer as a QR to share and mints no invoices itself.
- **Above the tabs** (`FforReturnPanel`): what the last return produced,
  with Try again when the peer was unreachable and Enforce on-chain behind
  a confirmation that explains the force close. A return is never presented
  as complete while a slot the wallet could be owed still reads unsettled.
- **Overview**: an Offline receive row in Node status, and on a settling
  wallet a card listing the books it holds for siblings with what each has
  settled; on a witness the mailboxes it keeps (`/ffor/witness/status`),
  on an issuer the offers it answers (`/ffor/issuer/status`).
- **The return with witnesses**: the manager connects every sibling
  witness over loopback before asking the daemon to recover, and the panel
  lists what each witness answered (receipts, credited, or did not
  answer). Witness receipts establish proof custody, not spendable wallet credit
  for a concurrent book. Credit is shown only after authoritative redemption.
  Concurrent reconnect synchronizes without retiring the book; baseline recovery
  follows its existing retirement path.
- **Channel history** records every `ffor:state` and `ffor:enforce` on the
  epoch's channel; the Logs tab carries every `ffor:*` event and the
  return line.

## Constraints worth knowing

- **The book is fixed.** One amount per slot, at most 483 slots, every
  amount above the channel's HTLC minimum and dust, the sum within what S's
  side of the channel can lock beyond its reserve and fee buffer. A payer
  pays exactly one voucher's amount; there is no partial or larger payment.
- **Heights, not dates.** `settlementDeadline` is the return-by height;
  `voucherExpiry` must sit at least 1008 blocks past it (the engine's
  reconcile margin) and is where unpaid vouchers time out back to S on
  chain. The card derives both from the days away at 144 blocks a day and
  words the date conservatively.
- **One invoice per slot, once.** The daemon hands the invoice out on
  `/ffor/invoice` and refuses the slot afterwards. From beignet 0.21.5 the
  epoch view carries the invoice on every exposed slot (`bolt11`, beignet
  #875), so the card shows it wherever it was minted; on an older engine
  the card only knows what this browser session minted.
- **The slot invoice also lists under Recent invoices.** The receiver never
  sees the HTLC (S settled it), so on engines before 0.21.5 the row stayed
  PENDING for a voucher the channel balance already carried. From 0.21.5
  the close completes each credited voucher's payment record and emits
  `payment:received` and `invoice:settled` (beignet #876): the row reads
  PAID and the receive toasts like any other.
- **Witnesses change who may pay.** With witnesses named in the book, the
  settlement peer settles a delegated HTLC only when it arrives from one of
  them (TLV 13), so payers must route through a witness. A hand-minted
  BOLT 11 invoice still hints only the last hop (S to R); the payer finds
  the witness's channel to S from gossip, so that channel must be public
  and confirmed. An issuer's BOLT 12 invoices carry a blinded path through
  the witness, so a payer needs a route to the witness and a live peer
  connection to it for the request. Without witnesses the book sends
  `witnessPeers: []` and any payer may pay.
- **Nothing dials.** Provisioning, the return's witness fetch and a
  payer's offer request all ride existing peer connections. The manager
  connects siblings over loopback before each; a witness or issuer off the
  box needs the wallet's own reconnect to reach it.
- **The book is not shared between hand-minted invoices and the issuer.**
  The issuer's ledger lives on the issuer; R's record only learns a slot
  was issued once it is paid. The card therefore gives the whole book to
  the issuer when one is named.
- **`minReceipts` stays 0.** The engine's witness refuses guardian
  receipts today; the manager never sends the field.
- **A refusal by the peer is an ABORTED epoch, not a 400.** The start call
  returns NEGOTIATING; the peer's `ff_abort` (reason 2 for a peer that does
  not settle or refuses the terms) arrives a moment later. The card and the
  log both say so.
- **Reachability.** Siblings talk over loopback, so an internal settlement
  peer is always reachable to the wallet; payers reach it through whatever
  routes reach that sibling. A settlement peer off the box needs to be
  reachable through the onion or a public address.

## Verifying against real daemons

`scripts/lfbw-regtest/08-ffor-plain.mjs` and `09-ffor-lfbw.mjs` drive the
whole round on the bitcoin-regtest-dashboard chain: a settling sibling, a
receiver (a plain wallet in 08, a lightning-first wallet on its primary in
09) and a payer sibling, no CLN needed. `10-ffor-witness-issuer.mjs` adds a
witness and issuer sibling on a public channel to the settlement peer and
a payer behind it: round A pays a hand-minted invoice through the witness
and returns with the settlement peer away, so the receipt alone credits the
voucher; round B pays the issuer's offer with no invoice in hand. Each creates the wallets, funds
and channels them, starts a two-voucher book, mints the first invoice,
stops the receiver, pays the invoice from the payer while it is down,
starts the receiver, and asserts the manager's return closed the epoch,
the slot reads settled, the channel balance grew by the voucher, the log
carries the return line and the channel history carries the states. The
manager and environment are described in `scripts/lfbw-regtest/README.md`.
