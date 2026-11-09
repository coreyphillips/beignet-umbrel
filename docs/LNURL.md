# LNURL

The dashboard reads LNURLs and Lightning addresses in two places:

- **Send tab.** Paste one into either box, the on-chain one or the Lightning one, and it's handled like any other Lightning payment. The tab doesn't change: a pay link fills the same table and amount field an invoice does, and a withdraw or login link shows its own short panel in place of the Pay button.
- **Tools tab.** The LNURL card takes the same input and does the same three things, for when you know up front that's what you want.

## What's supported

| | What it does |
| --- | --- |
| Pay (LUD-06) and Lightning addresses (LUD-16) | Pay a service an amount inside its limits, with an optional comment (LUD-12) when it takes one. Whatever it sends back after the payment (LUD-09) is shown, and an encrypted message (LUD-10) is opened with the payment's preimage when you ask. |
| Withdraw (LUD-03) | The wallet makes an invoice for the amount, the same way the Receive tab would (a lightning-first wallet gets a just-in-time invoice when its channel can't take it), and hands it to the service, which pays it. |
| Login (LUD-04, LUD-05) | Signs the site's challenge with a key derived for that one domain. Nothing is paid. |

Every form a link turns up in is read: `lnurl1...`, `lightning:lnurl1...`, the `lnurlp://`, `lnurlw://` and `keyauth://` schemes (LUD-17), `name@domain` with or without a leading `₿`, an https link carrying `?lightning=lnurl1...` (LUD-01), and a `bitcoin:` request whose `lightning=` is an LNURL. Channel requests (`lnurlc`) are refused with a reason, and so is a service that requires details about the payer (LUD-18).

## Where the requests go

The beignet daemon doesn't speak LNURL, so the manager does the fetching and hands the daemon only a checked invoice to pay.

- **Routing follows the wallet's network mode.** A Tor wallet's requests go through Umbrel's Tor; if Tor is down they fail, they don't fall back to a direct connection. Clearnet and Hybrid wallets go direct. An onion address always goes over Tor.
- **https only,** apart from onion addresses, where Tor already encrypts the hop. A redirect is followed at most three times, each hop checked again, and never from https down to http.
- **Nothing on your own network.** Loopback, private and link-local addresses are refused, whether they're written into the link or a domain resolves to one.
- **Small answers only.** A response over 128 KiB is refused, and a service gets 20 seconds to answer directly or 60 over Tor.

Regtest wallets relax the https and private-address rules so a test service on your own machine works.

## What's checked before paying

A pay link's invoice is refused, with nothing paid, unless:

- it's for the wallet's network,
- its amount is exactly what you entered,
- its description hash matches the description you were shown (the `h` tag against the service's metadata),
- and, for a Lightning address, the service's own identifier (when it sends one) is that address.

A withdrawal's invoice is checked against the service's limits before it's handed over. A link is held for ten minutes after it's read, for the wallet that read it only; past that, paste it again.

## Login keys

The key a site sees is derived from the wallet's seed the LUD-05 way: a hashing key at `m/138'/0`, an HMAC of the site's domain under it, and the linking key at `m/138'/<four indexes from that HMAC>`. So:

- a site sees the same key every time you log in from this wallet,
- two sites can't tell they're talking to the same wallet,
- and another LUD-05 wallet restored from the same seed logs in as the same account.

The seed is read from the wallet's own file for each login and is never logged or sent anywhere. The wallet's log notes each login and withdrawal by domain.

## Not covered

- BIP 353 names (`₿name@domain` resolved over DNS) aren't looked up; a `₿` in front of an address is just dropped.
- LNURL lives in the manager for now. If the engine grows it (beignet #794), this moves there.
