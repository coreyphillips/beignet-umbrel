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
online-only invoice. An external connected node can be used too. The node needs
the same settlement and funding policy described below.

Changing the checkbox or receiving node clears the displayed invoice and its
BIP21 attachment. Create a new invoice for the new choice. An invoice already
shared is not changed or cancelled. The form distinguishes stopping the wallet
from closing the browser, which leaves the Umbrel daemon running. Manual voucher
book controls remain under **Advanced offline receive**.

Lightning-first wallets continue to prepare every invoice for offline receiving
automatically and do not show the checkbox. RN and web wallet behavior is unchanged.

## Automatic Lightning-first receiving

Lightning-first wallets receive over Lightning the way they always have
(a plain invoice when the home channel covers it, a just-in-time one through
the primary when it does not). Ticking "Receive offline" on the Receive form
instead prepares a fixed-amount invoice that remains payable while the wallet
daemon is stopped. Users do not select channels, create voucher books or
trigger a return. The box is off by default and selectable only with an amount
of at least 354 sats and the primary connected. The primary must support the
automatic receive protocol and opt into settlement; if another channel is
needed, it must also opt into funding with explicit cumulative caps. Both are
the primary's own settings and are never switched on by a wallet picking it.
The Edit form exposes total channels, channels per peer, maximum channel size
and total funding budget. Connected external peers can request funding too.

The daemon persists preparation before exposing an invoice and discovers
receipts while running, including after restart. Paid reservations reconcile
into the normal invoice history and balance. Unpaid invoices remain active for
their ten-minute lifetime plus a two-minute settlement grace period. Receipt
query failures retain the reservation. Recovery still requires the settlement
peer to return; this path never force closes automatically.

The manager excludes `/receive/status` reservations from channelization and
legacy startup return. If it cannot read the journal, it postpones those actions.
Retries after a lost creation response reuse the same request id. Fixed amounts
below 354 sats and amountless requests cannot be received offline. With the box
ticked, an unsupported engine or peer shows an error instead of silently
producing an online-only invoice; unticking it returns to the ordinary invoice.

**Engine requirement:** the daemon `/receive/*` API and funding-policy environment
variable require Beignet 0.21.9 or newer. The image workflow pins 0.21.9. Older
engines fail the capability check and cannot create automatic offline invoices.

The advanced manual workflow below remains available for other Lightning wallets.
Its startup return does not own automatic reservations.

## How it works

Before going away, the wallet (the receiver, R in the spec) pre-signs a book
of fixed-amount vouchers with a **settlement peer** (S) on one of its
channels: an **epoch**. Each voucher is one slot with one payment hash that
S generated. The wallet hands out one BOLT 11 invoice per slot, then can go
offline. A payer's HTLC for one of those invoices reaches S, which settles it
at once against the pre-signed voucher and sends the wallet nothing. When
the wallet is back, it **returns**: it closes the epoch cooperatively, S
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
  blocks and days at ten minutes a block. Close the book now runs the same
  return the manager runs on start. A closed book shows what was paid and
  offers Start another; an aborted setup shows the engine's reason and the
  form again.
- **The header** carries a green `receiving offline` badge while an epoch
  is ACTIVE and a red `enforce on-chain` badge when the peer contradicted
  it.
- **Witnesses and the issuer on the card.** When a sibling keeps receipts,
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
  answer). With the settlement peer away, the receipts alone credit the
  paid vouchers on the record; the book still closes once the peer is
  back, or is enforced on-chain.
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
