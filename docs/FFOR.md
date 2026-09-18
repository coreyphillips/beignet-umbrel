# Receive while offline (FFOR)

FFOR (Fast-Forward Offline Receive, spec at github.com/coreyphillips/ffor,
Variant D) lets a wallet on this box be paid while its daemon is off. This
document is what the app does with it as built: the roles, what the user
sees, the constraints the engine imposes, and how to verify it against real
daemons. The engine side is beignet's `/ffor/*` surface (beignet #729) and
the role switches it honours from 0.21.4 on (beignet #865).

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

Two things the engine leaves to the host, and this app does:

- **The return is not automatic in the engine.** On reestablish it only
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
- **Witness and issuer** (receipt witnesses that keep an encrypted copy of
  every settlement, and a BOLT 12 issuer for payers with no invoice) are in
  the engine and reachable over the proxied daemon API, but the app sets
  neither role yet and the dashboard does not drive them. That is the
  follow-up phase of umbrel #98.

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
- **Above the tabs** (`FforReturnPanel`): what the last return produced,
  with Try again when the peer was unreachable and Enforce on-chain behind
  a confirmation that explains the force close. A return is never presented
  as complete while a slot the wallet could be owed still reads unsettled.
- **Overview**: an Offline receive row in Node status, and on a settling
  wallet a card listing the books it holds for siblings with what each has
  settled.
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
- **Payers are unrestricted.** The card sends `witnessPeers: []`. A named
  list makes S refuse HTLCs from anyone but those peers, which is the
  witness path this phase does not use.
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
09) and a payer sibling, no CLN needed. Each creates the wallets, funds
and channels them, starts a two-voucher book, mints the first invoice,
stops the receiver, pays the invoice from the payer while it is down,
starts the receiver, and asserts the manager's return closed the epoch,
the slot reads settled, the channel balance grew by the voucher, the log
carries the return line and the channel history carries the states. The
manager and environment are described in `scripts/lfbw-regtest/README.md`.
