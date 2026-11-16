# Taproot Assets

A wallet can create, receive, send and burn [Taproot Assets](https://docs.lightning.engineering/the-lightning-network/taproot-assets): tokens and collectibles that live in ordinary bitcoin transactions. It works on mainnet, testnet (testnet3 and testnet4) and regtest, for Lightning wallets and on-chain only wallets alike, from the **Assets** tab.

This release covers assets on-chain. Assets in Lightning channels are built in the dashboard and stay hidden until the engine can carry them (see [Not covered](#not-covered)).

**Read [Before you use this on mainnet](#before-you-use-this-on-mainnet) first.** The short version: the recovery phrase alone does not bring assets back, none of this code has had an independent security review, and a transfer only arrives if the proof server accepts its proof, which the public testnet3 server did not when this was tested (see [Transfers and the public universe servers](#transfers-and-the-public-universe-servers)).

## What you can do

- **Create.** A normal asset with a supply and up to 12 decimal places, or a collectible (one indivisible unit). Give it a name, optional metadata, and choose whether more of it can be created later. Several assets can share one transaction. The form shows what creating will cost in sats before you confirm.
- **Receive.** Pick an asset you hold, or look one up by its asset ID or group key, and enter an amount. The wallet makes an address for that one payment and shows it as a QR code. The row moves from waiting, to seen on chain, to verified, by itself. **Use each address once:** a second payment to the same address is not credited. An address nobody has paid is checked automatically for seven days; after that its row says so and offers **Check now**.
- **Send.** Paste a Taproot Assets address. The wallet reads it and shows the asset, the amount the address asks for, where the proof will be delivered and the exact fee, and nothing is broadcast until you confirm.
- **Burn.** Destroy an amount of an asset for good. The dialog asks for the amount twice.
- **See it all.** Holdings with their bitcoin locked beside them, every mint, receive, send and burn with its progress, and the details of each asset: its ID, metadata, where it was issued, how much this wallet created.

An asset address pasted into the ordinary Send tab is recognised and handed to the Assets tab.

### How long things take

An asset is spendable after **6 confirmations** on mainnet and testnet (1 on regtest), about an hour. That is the depth at which the wallet builds and stores the proof, and the depth a received proof must have before it is imported. The progress line under each row counts the confirmations, and it keeps counting if you close the page or the wallet restarts.

## How it runs

The protocol is [ts-tap](https://github.com/coreyphillips/ts-tap), a TypeScript implementation that follows Lightning Labs' `tapd`. It needs the wallet's keys and coins in the same process, so it runs **inside each wallet's daemon**, as a host extension of the engine (the engine's `docs/EXTENSIONS.md`):

```
browser ──> manager ──> /wallets/:id/api/x/assets/*  ──> the wallet's daemon
                                                          ├─ beignet (bitcoin, Lightning)
                                                          └─ assets host (manager/server/assets-host)
                                                               └─ ts-tap + @ts-tap/beignet
```

- The manager never loads ts-tap and never sees a key. It tells a wallet's daemon which module to load (`BEIGNET_EXTENSIONS`) and with which settings, and reverse-proxies the browser to it like every other wallet route, with the wallet's token added server-side.
- The assets host keeps its records in the wallet's own database, beside the channel state, and writes a backup file whenever they change.
- If the host fails to start, the bitcoin wallet runs without it. The Assets tab says what went wrong, and nothing else about the wallet changes.

**Which chain a wallet is on.** A wallet's network is a setting, and the chain it really sees is whatever its Electrum server is on. So when a wallet starts, its assets host asks that server for block 0 and reads the chain off its hash, before it looks at a single asset:

- A **testnet** wallet is on testnet3 or testnet4. The app calls testnet3 `testnet` and asks before it saves a testnet4 server for a wallet, and assets work on both: the host uses the rules and the universe server of the testnet the wallet turns out to be on. The Assets settings say which.
- A wallet that **holds assets stays on the chain they were made on**. Pointed at a server on the other testnet, its Assets tab says so and nothing is checked or spent until the server is changed back. A wallet that holds none follows its server.
- On **every network**, a server that turns out to be on another chain (a mainnet wallet given a testnet server) leaves assets off until that is put right. Asset records checked against the wrong chain would all look spent.
- A server that does not answer is asked again. Until it has answered, nothing is spent.

**Where the code comes from.** ts-tap is not published to npm. Two tarballs built from one ts-tap commit are committed under `vendor/`, with their checksums and the commit they came from (`vendor/ts-tap.lock.json`). The image build checks the checksums and installs them beside the engine in one step, so the adapter and the daemon share a single copy of the engine.

**When the tab appears.** Assets need an engine release that carries the host extension contract. The manager looks at the engine it is bundled with: on an older engine the Assets tab is simply absent and every wallet runs as before. `BEIGNET_ASSETS=off` in the app's environment switches assets off for the whole box.

## Where the requests go

Assets add one kind of outside connection: a **universe server**, which is where proofs are left for the recipient of a transfer and fetched by them. An asset address names the server its proof should be delivered to.

| Network | Default universe server | Run by |
| --- | --- | --- |
| mainnet | `universe.lightning.finance` | Lightning Labs |
| testnet, on testnet3 | `testnet.universe.lightning.finance` | Lightning Labs |
| testnet, on testnet4 | `testnet4.universe.lightning.finance` | Lightning Labs |
| regtest | none, unless the operator names one | you |

What that server learns:

- **Which assets this wallet asks about, sends and receives.** A proof names the asset, the amount and the outputs on chain it moved through. Proofs are how the protocol works: whoever holds one can verify it, and a universe holds many.
- **This Umbrel's IP address**, unless the wallet is in Tor mode. A wallet in **Tor mode** reaches its universe server through the app's Tor, and refuses rather than connecting directly if Tor is unavailable. An onion universe address always goes over Tor. This is the same rule the app applies to LNURL.
- When you **create** an asset, its issuance proof is published there so that anyone you send it to can verify it. A universe that refuses the upload does not undo the mint: the asset is yours and the row says the proof is still to be published, with **Try again** beside it. The wallet also keeps trying by itself, less and less often, up to once an hour.
- When you **send**, the transfer's proof is left there for the recipient once the transaction is deep enough. A server that does not answer is tried again after 15 seconds, then twice as long each time, up to every five minutes, and at once when it is seen to be back. A server that answers and refuses the proof is a different thing, and the row says so with the server's own reason: the wallet offers the proof again less and less often, up to once an hour, and **Offer it again now** asks at once.

The wallet's Electrum server sees the transactions that carry assets, as it sees every other transaction of the wallet. They look like ordinary taproot spends on chain.

**Using your own universe server.** Assets, Settings takes a proof courier address (`universerpc://host:10029`) and the web address of the same server's REST gateway (`https://host:8089` on a stock `tapd`). New addresses then name your server. The public server for the network stays known to the wallet, so a payment to an address that names it can still deliver its proof. Web addresses are https only (or an onion), and never an address on your own network, except on regtest.

Addresses are made in the **version 1** format, which is what a universe running stock `tapd` can deliver to. A version 2 address pasted into Send is refused with a note to ask for a version 1 address (ts-tap issue 46).

## Transfers and the public universe servers

A transfer reaches its recipient only when a universe server takes its proof and hands it on. What the default servers did with what this app produced, when it was tested in November 2026:

| Server | Issuance proofs (create) | Transfer proofs (send) |
| --- | --- | --- |
| testnet4, `testnet4.universe.lightning.finance` | accepted | accepted, and delivered to the second wallet |
| testnet3, `testnet.universe.lightning.finance` | accepted | **refused**, with `invalid split commitment proof` |
| mainnet, `universe.lightning.finance` | not tested | not tested |
| a local `tapd` on regtest, with the proof rules of mainnet in force | accepted | accepted |

What is known about the testnet3 refusal:

- It is every transfer, not one: an asset with and without a group, a transaction with ordinary bitcoin change and one whose every output is taproot. Creating an asset there works, and so does a second wallet learning the asset from that server.
- The same proofs pass `tapd`'s own verification, run the way a universe runs it and with the rules of that block height in force, at every release from v0.8.5 to v0.8.8 and on its main branch. A local `tapd` accepts and credits them, and the testnet4 server accepts transfers of the same shape. Field by field they match transfers made by `tapd` that the testnet3 server holds. Nothing in the published code explains the refusal, so the cause is not known.
- The mainnet server was not tried, because nothing was spent on mainnet. It is set up like the testnet3 server and unlike the testnet4 one, so **expect the same there until it is shown otherwise**.

What a refusal means for you:

- **Creating, holding and burning are not affected.** Your own assets never wait on a universe.
- **A send goes out and confirms, and the recipient does not have the asset until the server takes its proof.** The amount is not lost: it sits in the recipient's output on chain, the sending wallet keeps the proof (it is in the assets backup) and goes on offering it, and what is left over stays with the sender. But nothing in this release can hand a proof over any other way, so until the server takes it the recipient cannot use what was sent.
- **Try a small amount first**, on any network, and wait for the recipient to see it.
- **A universe server of your own avoids it.** Both wallets name the same server under Assets, Settings (see [Where the requests go](#where-the-requests-go)): a `tapd` whose universe takes proofs from outside (`tapcli universe federation config global --proof_type issuance --allow_insert true --allow_export true`, and the same for `transfer`). That is the setup every regtest scenario here runs on.

## Fees

You choose the fee rate. A send or burn is prepared first, funded and signed but not broadcast, so the fee you confirm is the fee that is paid, to the sat. A prepared transaction that you do not confirm is cancelled after three minutes and holds nothing.

The wallet refuses a fee rate above 500 sat/vB or a fee above 250,000 sats for one asset transaction (`BEIGNET_ASSETS_MAX_FEE_RATE` and `BEIGNET_ASSETS_MAX_FEE_SATS` in the app's environment change the limits).

**There is no fee bumping for asset transactions yet.** An asset transaction that is stuck in the mempool cannot be replaced or pulled along by a child from this app. The row says when a transaction has waited unusually long, and **Broadcast again** puts the same transaction back out. Choose the fee with that in mind, and prefer a quiet mempool for anything you cannot wait for.

## Bitcoin locked with assets

Every asset sits in a bitcoin output, its **anchor**, worth about 1,000 sats. Those sats are yours and they are not spendable as bitcoin while the asset is there: the wallet keeps them out of its balance and out of coin selection, and shows them on the Overview and in the Assets tab as **locked with assets**. Sending or burning an asset moves or releases them.

Creating, sending and burning also need ordinary bitcoin for the miner fee. A wallet that holds an asset and no spendable bitcoin cannot move it, and the Send form says how much is missing.

**The wallet has to hold more than the transaction costs.** An asset transaction is built around a working amount, the fee for 2,000 vbytes at the rate you chose, and what is not spent comes straight back as change. At 2 sat/vB that is about 4,300 sats on hand for a transaction that costs about 1,300; at 50 sat/vB it is over 100,000. A wallet that holds the cost but not the working amount is told both figures.

A **lightning-first** wallet moves its on-chain bitcoin into its channel by itself once it holds 25,000 sats or more ([LFBW.md](LFBW.md)). It can receive assets like any other wallet, and it can pay asset fees only from what it keeps on-chain below that amount. An ordinary Lightning wallet or an on-chain only wallet is the easier home for assets.

## Backup and recovery

**A recovery phrase alone does not restore assets.** The phrase recreates the keys. What makes an output an asset is its proof, which exists nowhere on chain, and the wallet finds its assets through records only it holds.

What does restore them is the app backup:

- The assets host writes `wallets/<id>/assets/backup.json` whenever the wallet's assets change. It holds the records, the proofs and the key counters, never a private key, and is only useful together with the wallet's seed.
- **Settings, Back up all wallets** puts that file in the archive with the seed. See [BACKUP.md](BACKUP.md).
- Restoring the archive puts the file where the host looks on the wallet's first start, and the host imports it, checks every anchor against the chain, and carries on.
- The file is tied to its wallet and its chain. It is refused by a wallet with another recovery phrase, on another network, or on the other testnet: assets made on testnet3 do not exist on testnet4.

So: **back up the box again after you create or receive an asset.** Settings, Backups marks a wallet whose assets changed since the last archive, the same way it marks an edited one, and the Assets tab offers **Back up now** when that is so. Settings and the wallet list also name a wallet whose assets the last archive could not carry, and why: the wallet was not running to write its file, or the file is too large for an archive (see [BACKUP.md](BACKUP.md#knowing-when-to-back-up-again)).

Channel backup, guardians and peer storage do not cover assets. A wallet moved to another machine by its phrase alone will show its bitcoin and none of its assets, and the bitcoin in the anchors will not appear either until the assets backup is imported.

Deleting a wallet takes its assets out of the app, and erasing its data deletes their records. The dialog says so when the wallet holds any, and whether the last backup has them.

## Before you use this on mainnet

Mainnet is on by default, with no extra step. That is a choice for convenience, not a statement about maturity. Know these first:

1. **No independent security review.** Neither ts-tap nor the path the engine loads it through has been audited. `tapd` itself is described by its authors as alpha software. A bug can lose assets, and the bitcoin anchoring them.
2. **The phrase is not enough.** See above. Without the app backup, lost data means lost assets.
3. **No fee bumping.** See [Fees](#fees).
4. **You depend on a universe server, and it has to accept the proof.** A recipient needs the proof to credit a transfer. If the server is down, a send's proof delivery waits and is retried, and a receive waits. If the server refuses the proof, the recipient does not get the asset until it changes its mind, and the public testnet3 server refused every transfer proof from this app when it was tested. The mainnet server has not been tried. Read [Transfers and the public universe servers](#transfers-and-the-public-universe-servers) and send a small amount first.
5. **Your Electrum server is trusted more than usual.** It tells the wallet which block is at which height and whether an anchor is unspent. The wallet checks each proof's merkle path and header, not proof of work. A dishonest server working with a dishonest sender could make the wallet accept a proof that is not on the real chain. Use an Electrum server you run.
6. **A name is not an identity.** Anyone can create an asset called USDT. An asset is identified by its ID (or group key), which is what the coloured avatar is drawn from, and the Send and Receive forms show it. Check the ID with whoever issued the asset.
7. **Privacy.** A universe server is public by design, and proofs carry an asset's history.

## Not covered

- **Lightning.** Asset channels, invoices and payments are the next milestone. They need engine changes that have not landed, so the dashboard's Lightning controls for assets stay hidden. Nothing in this release puts an asset in a channel.
- **Fee bumping** (RBF or CPFP) for asset transactions.
- **Version 2 addresses**, to receive or to pay.
- **One address, several payments.** An address is for one payment of one amount. A second payment to it sits on chain uncredited, and this app has no way to claim it yet.
- Sending to several addresses in one transaction, choosing coins by hand, and merging small asset outputs.
- Exporting a proof as a file, or importing one by hand. Proofs travel through the proof server only.
- Running a universe server, or syncing with a federation of them.
- Hardware signing, multi-signature and scripted asset keys.

## How this was verified

Three layers, each of which can be run again.

- **Unit tests.** The assets host, the manager's part and the dashboard each have tests beside the code (`cd manager && npm test`, `cd manager/ui && npm test`). With `ASSETS_ENGINE_PREFIX` pointing at an engine prefix, the manager's tests also load the real vendored packages into a real daemon and exercise the contract between them.
- **Regtest, end to end.** `scripts/assets-regtest/` drives a real manager and real wallet daemons against a regtest chain and `tapd`, Lightning Labs' daemon. `tapd` verifies every proof it is given, so an issuance it stores and a transfer it credits are its word that what this app produced is valid, and the app in turn receives what `tapd` mints and sends. The scenarios cover: every kind of mint, with refusals; both directions with `tapd`; wallet to wallet with change, and burn; previews that are cancelled, replaced or abandoned; restarts and outright kills of the daemon in the middle of a mint, a preview, a send and a receive; a request repeated with its key; a reorganisation that takes the mint's block out of the chain; archive, wipe and restore; changing the proof server; and switching assets off and on for one wallet.
- **Testnet4,** against `testnet4.universe.lightning.finance`. Two mints (a normal asset with two decimals and a collectible in one transaction, a grouped asset in another), six confirmations, all three issuances found on the public universe, a second wallet that learned the asset from that universe alone, and a transfer to it that completed on both sides with its proof delivered through the public server. Then the second wallet sent part of it back, the first burned some, both wallets were archived, erased and restored from the archive, held what they held before, and the restored wallets sent and received again. Every proof went through the public server.
- **Testnet3,** against `testnet.universe.lightning.finance`. The same mints, six confirmations, the issuances found on the public universe and learned from it by a second wallet, and a transfer that confirmed. Its proof was refused by the server, so the transfer did not complete: see [Transfers and the public universe servers](#transfers-and-the-public-universe-servers).

The regtest stack runs its `tapd` with today's proof rules in force from the first block (`--proofactivationheight=1`), so the scenarios exercise what mainnet, testnet3 and testnet4 require of a proof and not the older rules a stock regtest `tapd` keeps.

Nothing was spent on mainnet to test this. Mainnet runs the same code with a different address prefix, activation height and universe server, and its universe server is the one unknown above.

What is covered by unit tests only, because the regtest stack cannot produce it: a preview expiring by the clock, a transaction that waits an hour unconfirmed, and Tor mode.

## For operators and developers

| Setting (app environment) | Effect |
| --- | --- |
| `BEIGNET_ASSETS=off` | No wallet loads the assets host; the tab is hidden |
| `BEIGNET_ASSETS_MAX_FEE_RATE`, `BEIGNET_ASSETS_MAX_FEE_SATS` | The fee ceilings above |
| `ASSETS_REGTEST_UNIVERSE_COURIER`, `ASSETS_REGTEST_UNIVERSE_REST`, `ASSETS_REGTEST_UNIVERSE_CA` | The universe a regtest wallet uses: a local tapd's courier address, REST gateway and certificate |

A wallet's record carries `assets: { enabled, universe }`, set with `PATCH /api/wallets/:id`, and reports `holdsAssets`, the host's `phase` and `error`, whether its backup file exists (`backupFile`) and why the last archive left its assets out (`notArchived`). `GET /api/config` reports `assetsAvailable`, `assetChannelsAvailable` and the `universeServers` the app knows.

- **Updating ts-tap.** `scripts/vendor-ts-tap.sh <ts-tap checkout> [commit]` rebuilds both tarballs from one commit and rewrites `vendor/SHA256SUMS` and `vendor/ts-tap.lock.json`; `--verify` rebuilds and compares. The adapter names the engine releases it was built for, and the image build fails if the bundled engine is outside that range, so an engine bump past it needs a ts-tap build for the new engine first.
- **A development engine.** `scripts/engine-prefix.sh <dir> [engine]` installs an engine and the vendored packages side by side, as the image does, and says whether assets are available on it.
- **End to end.** `scripts/assets-regtest/` drives a real manager and real daemons against a regtest chain and `tapd`.
