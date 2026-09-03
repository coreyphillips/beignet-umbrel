# Lightning-first wallets

A lightning-first wallet is a Beignet wallet with one balance the user sees,
held in a single Lightning channel with a **primary node**. Bitcoin that lands
on its deposit address moves into that channel by itself once it confirms,
invoices are payable even before the channel exists, and sending to a bitcoin
address spends from the channel. The user never manages a channel; the
Advanced view still shows one.

This document is the product and trust model as built. The protocol behind
the direct-funding request is in `bolt-draft-direct-funding.md` (revision 2,
the envelope the engine implements); the engine work is tracked in
coreyphillips/beignet#532.

## What the user sees

- **Creating a wallet** gains "Make this a lightning-first wallet" with a
  primary node: one of your own wallets on this Umbrel (running, same
  network, Lightning on, not lightning-first itself), or an external beignet
  node as `pubkey@host:port`. The wallet trusts its primary for zero-conf by
  default in both modes (a checkbox turns that off; channels then confirm
  first and just-in-time receives are off); an internal primary is trusted
  back, and can open a starting channel to the new wallet right away from
  its own on-chain balance.
- **The wallet's page** has three tabs: Overview, Receive, Send. The header
  shows one figure. "Advanced view" in the nav restores the full tab set for
  looking under the hood; the choice sticks for the browser session.
- **Overview**: Total balance, Can send, Can receive, Pending; a note for each
  kind of arriving sats (unconfirmed deposit, confirmed deposit moving or
  waiting below the floor, channel funding confirming, splice locking); the
  primary node with its connection and trust; the home channel with a
  cooperative Close; the direct-funding minimum; setup state with a Retry.
- **Receive**: "Deposit bitcoin" is a BIP21 request that also carries a
  direct-funding request (`bgnq`), so a beignet wallet paying it funds the
  channel in one transaction. Any other wallet pays the address and the
  deposit moves into Lightning after one confirmation. The Lightning invoice
  is provisioned through the primary just in time when the home channel
  cannot cover the amount, and the fee the primary quotes (zero for your own
  wallets) is said on screen.
- **Send**: opens on Lightning. "Bitcoin address" is a splice-out of the home
  channel, priced by the daemon; the slider stops at what the channel can
  release net of fee and reserve. A pasted request from a beignet wallet is
  paid as a direct funding when a confirmed deposit of ours covers it, else it
  is a plain payment the recipient moves into Lightning themselves.
- **Every wallet's Send tab** offers "Pay as direct funding" for a pasted
  request that carries one, with the fallback rule below.

## The pieces

| Piece | Where | What it does |
| --- | --- | --- |
| Record model and rules | `manager/server/lfbw.js` | Who may be a primary, the provider env, the direct-funding policy, reachability, the channelize decision. Pure and tested. |
| Setup | `WalletManager.setupLfbw` | Runs on every healthy start: trust (both ways for a trusted internal pair), the direct-funding policy naming the primary as liquidity peer and relay, the peer connection, the starting channel once. |
| Channelize | `WalletManager._lfbwChannelize` | Confirmed on-chain funds at or above 25,000 sats move into the home channel: a splice-in when it exists, a max open when it does not. Never while any UTXO is unconfirmed, and never while the daemon's quoted fee is more than a twentieth of the amount (`CHANNELIZE_FEE_MULTIPLE`): the funds wait for the rate to come down or for more to arrive, the Overview says so, and "Move now anyway" (`POST /api/wallets/:id/lfbw/channelize`) runs one pass past the fee wait, never past the channel minimums. The last decision rides on the record as `lfbw.lastChannelize`. Driven by the daemon's transaction and channel events with a one-minute backstop. |
| Liquidity provider | `rec.liquidityProvider`, `rec.jit` | A wallet chosen as an internal primary runs the engine's JIT role (`BEIGNET_JIT_RECEIVE`, fee and exposure caps) and the direct-funding relay (`BEIGNET_DF_RELAY`). Editable in the Edit dialog. |
| Dashboard reduction | `manager/ui/src/lib/lfbw.js` | One derivation of spendable, receivable and the arriving sats; which invoice to mint. |
| Envelope reader | `manager/ui/src/lib/funding-envelope.js` | Reads the frozen head of a v3 request (node id, expiry, amount, chain) to show the payer who is asking. Fails closed. |
| Fallback rule | `manager/ui/src/lib/direct-funding.js` | A plain send may follow a direct funding only on a rejection or a status from before the witness left the device. |

## Trust and safety

- **Zero-conf is a pairing decision, never a default toward strangers.** The
  wallet trusts its chosen primary (a JIT open or a zero-conf splice arrives
  as unconfirmed funding from it), in both modes, because a primary the
  wallet does not trust cannot provision inbound just in time: its zero-conf
  open is refused and the held payment fails. Declining that trust is an
  option; deposits and direct funding still work and confirm first. An
  internal primary trusts the wallet back; an external one never does. Nobody
  else is added to anyone's trusted set.
- **Deposits move only once confirmed.** An unconfirmed deposit can be
  replaced by its sender; channelizing it would hand the pair a channel whose
  funding the depositor can still yank. One block settles it.
- **A liquidity provider fronts its own coins**, for any beignet wallet that
  asks, within its caps: most fronted per client (default 1,000,000 sats),
  fundings in flight at once (3), and an optional lifetime budget. The caps
  are on the Edit dialog. Funds that arrive through a confirming splice or a
  dual-funded open show as pending to the receiver until they confirm.
- **Direct funding never pays twice.** The daemon rejects only before the
  payer's witness leaves the device; after that it resolves with the status
  as it stands. The dashboard falls back to a plain send only on a rejection
  or a `CREATED`/`OFFERED` status, and shows `SIGNED_PENDING`, `ABORTED` and
  `FAILED` as what they are.
- **Anonymous senders get a confirmed channel; paired senders splice.** A
  payer outside the receiver's trusted set always opens a new channel that
  confirms first. The primary (paired) grows the home channel.
- **A primary in use cannot be deleted, parked, or stop providing liquidity**
  (409 `PRIMARY_IN_USE` naming its dependents). Orphaning a lightning-first
  wallet would cost it inbound, direct funding and its channelize path at
  once.

## Reachability

Umbrel publishes no Lightning ports on the host. Inside the app container
every wallet reaches every sibling on `127.0.0.1`, which is how an internal
primary is connected to and named as relay. Off the box, a wallet is
reachable only on its onion (when it announces one) or on a host the operator
has exposed themselves (`PUBLIC_HOST` on the manager, for a LAN setup). A
payment request carries a direct address only in those cases; otherwise a
payer reaches the wallet through the primary's relay or the onion-message
lane, and a payer that already holds a connection to the wallet (the primary
paying its own dependent) uses it directly.

## Engine requirements

The routes and policy this needs (`POST /jit/invoice`, the four
`/direct-funding` routes with `allowSplice`, `address` on splice-out,
`BEIGNET_JIT_*` including the exposure caps, `BEIGNET_DF_RELAY`) landed on the
engine's master after 0.9.3 (coreyphillips/beignet#532 and #667). The manager
probes the bundled engine's OpenAPI module for them and the dashboard hides
the controls when they are absent, so an image bundling 0.9.3 runs as before.

To build an image against unreleased engine work, `npm pack` in the engine
checkout and copy the tarball to `vendor/beignet-local.tgz`; the Dockerfile
prefers it over `BEIGNET_VERSION`. Release builds never carry one.

## Regtest runbook

The scripts in `scripts/lfbw-regtest/` drive a local manager through the
whole feature against real daemons: setup, channelize, JIT receive paid by
CLN, direct funding (anonymous and paired), splice-out to an address, the
delete guard, and an external primary. See the README there for the manager
command line and the docker stack they expect.

## Progress and exposure

The daemon relays the progress of a funding it fronts (`jit:intent`,
`jit:intercepted`, `jit:funding`, `jit:forwarded`, `jit:failed`) and of a
direct funding it receives (`direct-funding:offer:accepted` with `paired`,
`direct-funding:offer:declined`, `direct-funding:offer:failed`,
`direct-funding:offer:completed`) over SSE (beignet #669). The dashboard
toasts the ones a user acts on and the manager writes every one to the
wallet's log, so the Logs tab tells the story of a just-in-time channel.

A liquidity provider's Overview carries a card backed by `GET /jit/status`
(beignet #668): sats fronted so far, sats committed right now with the
fundings in flight, live intents and held payments, the fee, and the caps.

## The price before the invoice

A just-in-time receive costs what the primary charges, and the primary may
not be able to front it at all right now (its on-chain balance short, its
caps reached, the peer connection down). `GET /jit/quote` (beignet #687)
asks the primary over the peer connection without registering anything, so
the Receive tab prices the amount as it is typed: the fee it will take from
the delivery, or the reason it cannot fund the invoice, in which case Create
is held rather than minting an invoice that fails at the payer. This works
for internal and external primaries alike, with no cross-wallet reads. The
manager probes the bundled engine's OpenAPI module for the route
(`jitQuoteAvailable`); older engines get the tab as it was.

## Restoring by itself

A peer-storage wallet's checkpoint rides with its channel peers, and the
engine can apply the newest one by itself on an empty database (beignet
#690, `BEIGNET_RECOVERY_AUTO_APPLY`). The import form asks the one question
that makes this safe to automate, once: is the previous device stopped?
Nothing fences the old device under peer storage, so the answer is the
owner's. With it the daemon waits a moment for the storage peers to answer,
applies the newest checkpoint, rebuilds the node on it in-process, and the
channels come back held (no new payments in until each peer confirms them;
a close needs the owner to accept that a peer may hold a newer state). The
Backup row narrates the phases off `GET /recovery/status`'s `autoApply`, a
channel the checkpoint did not carry is named as closing safely, and the
checkpoint card steps aside. Without the answer the card offers both ways
out: resume the channels through the daemon's exact restore (the manager
restarts the wallet on the installed database), or recover the funds
through the SCB path. The manager probes the engine's config module for the
env name (`recoveryAutoApplyAvailable`).

## Deferred

- Peer failover: a lightning-first wallet has one primary. Re-pointing it is
  an edit; automatic failover to another provider is not built.
