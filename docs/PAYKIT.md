# Paykit

Paykit lets someone pay a wallet knowing only its pubky. The wallet publishes how it can be paid (a Lightning offer, a Bitcoin address, and a direct funding request when it has one) under its pubky on a Pubky homeserver, and a payer's wallet looks that list up and pays from it. It's built on [paykit-discovery](https://github.com/coreyphillips/paykit-discovery).

## Publishing

On the **Tools** tab, the Paykit card shows the wallet's pubky (with a QR) and a **Set payment details** button. Pressing it publishes:

| Published as | What it is |
| --- | --- |
| `btc-lightning-bolt12` | A BOLT 12 offer with no amount, so payers choose it. The same offer is reused on later publishes while the wallet still has it. Left out for an on-chain only wallet. |
| `btc-bitcoin-p2wpkh` | An unused address from the wallet. It stays the same until it's paid. |
| `btc-bitcoin-bip21` | The same address as a `bitcoin:` request carrying a direct funding request (`bgnq`), so a beignet payer's on-chain payment becomes this wallet's channel funding. Only for a lightning-first wallet whose setup is done, and only with an engine that can make a request last a week. |

Each payload is `{"value": "..."}`, under the app id `beignet`. Publishing again replaces what this app published before and leaves other apps' entries alone.

### Keeping it up to date

A direct funding request works once and lasts seven days, so a published list goes stale. With **Keep these up to date** on (it's on after the first publish), the manager checks every fifteen minutes while the wallet runs and publishes again when:

- the direct funding request was paid, or is within a day of expiring,
- direct funding became available, or stopped being available,
- the offer is gone,
- or a coin arrived at the published address.

When a direct funding lands on the wallet, the check runs about ten seconds later instead of waiting for the next quarter hour, so the next payer gets a fresh request rather than the spent one. A payer reading the list in those few seconds still gets the spent request: a different wallet is refused by the payee and pays the address instead, and the wallet that just paid it gets its earlier payment's answer back, with nothing new sent.

The first check after the wallet starts waits a random one to five minutes, so a box starting many wallets doesn't hit the homeserver all at once. A failed check is retried with a growing delay, up to six hours, and the card shows the last error.

### The pubky

The pubky comes from the wallet's seed, so there's nothing new to back up and restoring the wallet brings the same pubky back. It's derived the BIP 85 way: a 12-word phrase at `m/83696968'/39'/0'/12'/0'`, whose BIP 39 seed's first 32 bytes are the ed25519 secret. **Use in Pubky Ring** shows that phrase, behind a warning, for importing the same pubky into Pubky Ring. The phrase can't spend the wallet's coins, but whoever has it controls the pubky and what it publishes. That route answers only loopback and Umbrel itself, like the recovery phrase route, and each read is noted in the wallet's log.

### Signing up

A pubky that has never published is signed up with a homeserver first, through Pubky's Homegate service. Homegate limits signups per IP address, by default to two a week, and every wallet on the box shares that limit. A wallet in Tor mode signs up from a Tor exit, which other people share too. When the limit is hit, the card says so: open the pubky in Pubky Ring once (which signs it up from your phone), then set the payment details again.

## Paying a pubky

Paste a pubky into the **Send** tab, in either box. It's read in any of these forms: `pubky<key>`, `pubky://<key>`, `pk:<key>`, or the bare 52-character key. The tab doesn't change; it shows "Reading ...'s payment details" while the manager looks it up, then:

- **In the on-chain box,** the pubky is replaced by one `bitcoin:` request built from what it publishes: the address, the direct funding request when there is one (with **Pay as direct funding** on, as for any beignet request), and the offer as **Pay over Lightning instead**.
- **In the Lightning box,** the offer is filled in and paid like any other offer.
- A pubky that takes only one rail is moved to the box for that rail, with a note saying so.

Each published value goes through the same parser as anything pasted, so an entry for another network or one that doesn't parse is skipped rather than paid. When nothing is payable, the error names what the pubky does publish.

The Paykit card also has a **Look up a pubky** field, which lists everything a pubky publishes, other apps' entries included, with copy buttons.

## Where the requests go

The Pubky client runs in a worker thread for each call, so its networking stays out of the manager. Routing follows the wallet's network mode, as for LNURL: a Tor wallet's lookups and publishes go through Umbrel's Tor and fail rather than going direct if Tor is down, and Clearnet and Hybrid wallets go direct. A lookup is cached for a minute per pubky and route.

## What to keep in mind

- **A published list is public and isn't signed** beyond what the homeserver vouches for. A payer's wallet checks each entry like any pasted string, but a homeserver that lies could point payers somewhere else. A direct funding request is signed by the node it names, and the Send tab shows that node, but nothing ties a pubky to a node, so a substitute request signed by another node would read as valid too.
- **There's no way to take published details down from here yet.** Publishing again replaces them. Removal needs a change in paykit-discovery.
- **Only P2WPKH addresses are published** for now; the engine doesn't say which address type it hands out.
- **A primary paying its own lightning-first wallet's offer fails** in the engine today, because the offer's path starts at the payer. Direct funding to the same pubky works. This is an engine bug, tracked separately.
