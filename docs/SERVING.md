# Serving other nodes

A wallet here can do work for other beignet wallets, its siblings on this
Umbrel or nodes elsewhere. Every role is off until you switch it on (a wallet
picked as a lightning-first primary becomes a liquidity provider by itself),
each one commits this wallet's own coins or storage, and saving any of them
restarts the wallet so its daemon takes the new role.

| Role | Where it is switched on | What the Overview shows |
| --- | --- | --- |
| Liquidity provider | Edit, **Liquidity provider** | Liquidity provider card |
| Reverse swaps | Edit, under Liquidity provider, **Reverse swaps** | Swaps card |
| Submarine swaps | Edit, under Reverse swaps, **Submarine swaps** | Swaps card |
| Guardian | Create form or Edit, **Serve as a guardian** | Guardian for other nodes card |
| Offline-receive roles | Create form or Edit, **Offline receive** | One card per role |

## Liquidity provider

When a lightning-first wallet is paid and has no room to receive, it asks its
primary for inbound capacity. A liquidity provider holds the incoming
payment, funds a channel to that wallet from its own on-chain balance (or
grows the one it has), then forwards the payment minus its fee. Any beignet
wallet may ask, including external ones; the caps bound what is committed.

A wallet becomes a provider by itself when a lightning-first sibling picks it
as its primary, and it cannot be switched off while any wallet still uses it
that way. You can also switch it on by hand to serve external wallets.

| Setting | Default |
| --- | --- |
| Flat fee | 0 sats |
| Proportional fee | 0 ppm |
| Most fronted per client | 1,000,000 sats |
| Fundings in flight at once | 3 |
| Lifetime budget | none |

The fees default to zero because a provider's clients are, by default, your
own wallets.

## Swaps

A liquidity provider can also serve swaps between Lightning and on-chain
bitcoin. Only a Lightning wallet that is not lightning-first itself can do
this. Other beignet wallets request the swaps; this app serves them and has
no screen for requesting one.

- **Reverse swaps (Lightning to on-chain).** A wallet pays this node over
  Lightning, and this node pays the same amount, minus its fee, to an address
  the wallet chose, from its own on-chain balance. The node settles the
  Lightning payment only once the wallet has claimed the coins, and takes them
  back after the refund height if it never does.
- **Submarine swaps (on-chain to Lightning).** The other direction, available
  once reverse swaps are on. A wallet locks coins on chain to a contract this
  node can claim. Once those coins confirm, this node pays the wallet's
  Lightning invoice, under a deadline set back from the wallet's refund height
  by the claim margin, then claims the coins with the preimage the payment
  reveals.

The fee, size and exposure settings apply to both directions, and the daemon
enforces one budget over both.

| Setting | Default |
| --- | --- |
| Flat fee | 500 sats |
| Proportional fee | 1000 ppm |
| Smallest swap | 10,000 sats |
| Largest swap | 1,000,000 sats |
| Most committed at once | 5,000,000 sats |
| Swaps in flight at once | 8 |
| Claim margin before the refund (submarine) | 24 blocks |
| Routing fee cap (submarine) | 5000 ppm of the invoice |

The 500-sat flat fee covers the provider's own refund transaction when a swap
is never claimed; at 0, every small swap is subsidised.

The Overview's Swaps card shows, per direction, what is committed right now
against the caps, the size range, the fee, and the ledger by state. A swap
whose payment went out while its contract was not claimable is counted as
exposed and flagged. Every `swap:*` event is written to the Logs tab.

## Guardian

A wallet that serves as a guardian holds an encrypted journal of channel
state for beignet nodes that pinned it as one of their three guardians. See
[channel backup](CHANNEL-BACKUP.md#serving-as-a-guardian).

## Offline-receive roles

A wallet that stays online can settle offline receives for sibling wallets,
fund channels for automatic receiving, keep encrypted receipts as a witness,
and issue invoices from a BOLT 12 offer for payers who hold none. See
[receive while offline](FFOR.md#roles-in-the-app).
