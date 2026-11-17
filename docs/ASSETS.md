# Taproot Assets

A wallet can create, receive, send and burn [Taproot Assets](https://docs.lightning.engineering/the-lightning-network/taproot-assets): tokens and collectibles that live in ordinary bitcoin transactions. It works on mainnet, testnet (testnet3 and testnet4) and regtest, for Lightning wallets and on-chain only wallets alike, from the **Assets** tab.

A Lightning wallet can also keep an asset in a Lightning channel: open a channel with it, make invoices for it and pay invoices with it. **That needs an engine that can carry asset channels. Beignet 0.43.0, the engine this app bundles, is the first that can.** On an older engine everything about asset channels stays hidden and nothing puts an asset in a channel. [Assets over Lightning](#assets-over-lightning) describes them.

**Read [Before you use this on mainnet](#before-you-use-this-on-mainnet) first.** The short version: the recovery phrase alone does not bring assets back, none of this code has had an independent security review, and a transfer normally reaches its recipient through a proof server, which has to accept its proof. The public testnet3 server did not when this was tested; such a transfer is finished by handing the proof over as a file (see [Transfers and the public universe servers](#transfers-and-the-public-universe-servers)). An asset channel adds limits of its own, and the first is that no backup brings a channel back (see [Asset channels and backups](#asset-channels-and-backups)).

## What you can do

- **Create.** A normal asset with a supply and up to 12 decimal places, or a collectible (one indivisible unit). Give it a name, optional metadata, and choose whether more of it can be created later. Several assets can share one transaction. The form shows what creating will cost in sats before you confirm.
- **Receive.** Pick an asset you hold, or look one up by its asset ID or group key, and enter an amount. The wallet makes an address for that one payment and shows it as a QR code. The row moves from waiting, to seen on chain, to verified, by itself. **Use each address once:** a second payment to the same address is not credited. An address nobody has paid is checked automatically for seven days; after that its row says so and offers **Check now**.
- **Send.** Paste a Taproot Assets address. The wallet reads it and shows the asset, the amount the address asks for, where the proof will be delivered and the exact fee, and nothing is broadcast until you confirm.
- **Burn.** Destroy an amount of an asset for good. The dialog asks for the amount twice.
- **Hand a proof over as a file.** When a proof server will not carry a transfer's proof, the sender saves it as a file and the recipient imports it. See [Handing a proof over as a file](#handing-a-proof-over-as-a-file).
- **See it all.** Holdings with their bitcoin locked beside them, every mint, receive, send and burn with its progress, and the details of each asset: its ID, metadata, where it was issued, how much this wallet created.

On an engine that can carry asset channels, a Lightning wallet can also:

- **Open an asset channel** with a peer, from the Channels tab. The dialog shows what goes in and what it costs before you confirm.
- **Make a Lightning invoice** for an amount of an asset, under Assets, Receive.
- **Pay a Lightning invoice with an asset**, by pasting it under Assets, Send. What it takes of the asset is shown first, and nothing is paid until you confirm.
- **Close a channel**, together with its peer or alone, and have the asset back on-chain.

An asset address pasted into the ordinary Send tab is recognised and handed to the Assets tab.

### How long things take

An asset is spendable after **6 confirmations** on mainnet and testnet (1 on regtest), about an hour. That is the depth at which the wallet builds and stores the proof, and the depth a received proof must have before it is imported. The progress line under each row counts the confirmations, and it keeps counting if you close the page or the wallet restarts.

An asset channel carries payments once its funding transaction has confirmed. Until then its row reads **opening**.

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

**Where the code comes from.** ts-tap is not published to npm. Two tarballs built from one ts-tap commit are committed under `vendor/`, with their checksums and the commit they came from (`vendor/ts-tap.lock.json`). They hold the compiled library, its type declarations and source maps that name each source file and line. They do not hold ts-tap's TypeScript sources. The image build checks the checksums and installs them beside the engine in one step, so the adapter and the daemon share a single copy of the engine.

**When the tab appears.** Assets need an engine release that carries the host extension contract. Beignet 0.42.0 is the first; this app bundles 0.43.0. The manager looks at the engine it is bundled with: on an older engine the Assets tab is simply absent and every wallet runs as before. `BEIGNET_ASSETS=off` in the app's environment switches assets off for the whole box.

**When asset channels appear.** They need more than the tab does: an engine whose extension contract hands the assets host the node's channels, and a ts-tap build that ships its Lightning part. The build under `vendor/` ships it, so the engine is what decides. The manager looks for both in the engine it is bundled with and reports what it found (`assetChannelsAvailable` in `GET /api/config`). Beignet 0.43.0, the engine this app bundles, is the first that can carry asset channels. On an older engine that reads false and nothing about them is shown. On an engine that can, a wallet has them when it is a Lightning wallet (not on-chain only), its assets are on, and its channel backup is not kept by guardians.

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

A transfer is complete for its recipient once their wallet holds its proof. A universe server is how the proof usually gets there: the sender's wallet gives it to the server the address names, and the recipient's wallet fetches it. What the default servers did with what this app produced, when it was tested in November 2026:

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
- **A send goes out and confirms, and the recipient's wallet waits for a proof the server does not have.** The amount is not lost: it sits in the recipient's output on chain, the sending wallet keeps the proof (it is in the assets backup) and goes on offering it, and what is left over stays with the sender.
- **The sender can hand the proof over as a file instead**, and the recipient has the asset as soon as they import it. See below. Both transfers the testnet3 server refused were finished this way.
- **Try a small amount first**, on any network, and wait for the recipient to see it.
- **A universe server of your own avoids it.** Both wallets name the same server under Assets, Settings (see [Where the requests go](#where-the-requests-go)): a `tapd` whose universe takes proofs from outside (`tapcli universe federation config global --proof_type issuance --allow_insert true --allow_export true`, and the same for `transfer`). That is the setup every regtest scenario here runs on.

### Handing a proof over as a file

A proof is a file: the asset's whole history, from its creation to the payment. A server is one way to move it. When the server refuses it, or cannot be reached, move it yourself.

1. **The sender saves it.** A send whose proof was not delivered says so in red (refused) or blue (server away) under In progress, with **Save the proof file**. The same button is in the send's details, also after it completes. The file is named `proof-<asset>-<transaction>.assetproof`. It exists once the transaction is 6 blocks deep (1 on regtest).
2. **The sender gives it to the recipient**, any way a file travels. It holds no key and cannot move anything. It does show the asset's history to whoever reads it, as a universe server would.
3. **The recipient imports it.** Assets, Receive, **Import a proof file**, or **Import the proof file** on the receive that is waiting. The asset is in their holdings when the wallet says the proof checks out.
4. **The sender marks it as handed over**, so the send stops reading as waiting. This is the sender's own note and changes nothing else: the wallet cannot know what the recipient did with a file, and it goes on offering the proof to the server from time to time. **Undo** in the send's details takes the mark back.

What the recipient's wallet does with a file, which is what it does with a proof from a server:

- It takes a proof only for a payment **it found on the chain itself, at an address it made**. A file for anything else is refused, and a file imported before the payment is in a block is refused with the reason.
- The proof has to be for that exact output, asset and amount, and **every step of its history is verified against the chain**. A file that fails is dropped, nothing is taken from it, and the wallet goes on asking the proof server as before.
- A proof that names a block the chain does not have, as one does after a reorganisation, is not taken at its word: the wallet reads the block that really holds the transaction from the chain, and verifies the proof against that.
- A file imported before the payment is 6 blocks deep is kept, and used by itself when it is.
- Importing the same file twice changes nothing. A file can be up to 4 MB.

So a file from someone you do not trust can waste a moment and cannot give you a false balance, any more than a dishonest proof server could. What [Before you use this on mainnet](#before-you-use-this-on-mainnet) says about the Electrum server applies to a file exactly as it does to a server's proof.

Both ends need a wallet that can take a file. This app can. Lightning Labs' `tapd` can verify one (`tapcli proofs verify`) and receives proofs through a universe server, so a payment to a `tapd` address still depends on the server that address names.

## Fees

You choose the fee rate. A send or burn is prepared first, funded and signed but not broadcast, so the fee you confirm is the fee that is paid, to the sat. A prepared transaction that you do not confirm is cancelled after three minutes and holds nothing.

The wallet refuses a fee rate above 500 sat/vB or a fee above 250,000 sats for one asset transaction (`BEIGNET_ASSETS_MAX_FEE_RATE` and `BEIGNET_ASSETS_MAX_FEE_SATS` in the app's environment change the limits).

**There is no fee bumping for asset transactions yet.** An asset transaction that is stuck in the mempool cannot be replaced or pulled along by a child from this app. The row says when a transaction has waited unusually long, and **Broadcast again** puts the same transaction back out. Choose the fee with that in mind, and prefer a quiet mempool for anything you cannot wait for.

## Bitcoin locked with assets

Every asset sits in a bitcoin output, its **anchor**, worth about 1,000 sats. Those sats are yours and they are not spendable as bitcoin while the asset is there: the wallet keeps them out of its balance and out of coin selection, and shows them on the Overview and in the Assets tab as **locked with assets**. Sending or burning an asset moves or releases them.

Creating, sending and burning also need ordinary bitcoin for the miner fee. A wallet that holds an asset and no spendable bitcoin cannot move it, and the Send form says how much is missing.

**The wallet has to hold more than the transaction costs.** An asset transaction is built around a working amount, the fee for 2,000 vbytes at the rate you chose, and what is not spent comes straight back as change. At 2 sat/vB that is about 4,300 sats on hand for a transaction that costs about 1,300; at 50 sat/vB it is over 100,000. A wallet that holds the cost but not the working amount is told both figures.

A **lightning-first** wallet moves its on-chain bitcoin into its channel by itself once it holds 25,000 sats or more ([LFBW.md](LFBW.md)). It can receive assets like any other wallet, and it can pay asset fees only from what it keeps on-chain below that amount. An ordinary Lightning wallet or an on-chain only wallet is the easier home for assets.

## Assets over Lightning

Everything in this section needs an engine that can carry asset channels: Beignet 0.43.0, which this app bundles, or later. On an older engine none of it is shown.

An asset channel is a Lightning channel funded with an asset. What moves through it is the asset. Asset channels are listed under **Asset channels** on the Channels tab, apart from the wallet's bitcoin channels, and they are left out of the bitcoin figures there.

The limits, first:

- **Only a Lightning wallet has them.** An on-chain only wallet does not, and neither does a wallet whose channel backup is kept by guardians (see [Asset channels and backups](#asset-channels-and-backups)).
- **The peer has to take asset channels.** Another wallet running this app, on an engine that can carry them, does. So does a peer that runs Lightning Labs' daemons, lnd with tapd, with the limits under [Peers that run Lightning Labs' daemons](#peers-that-run-lightning-labs-daemons).
- **A wallet of this app sets no bitcoin price for an asset.** Between two wallets of this app an invoice is for the asset alone and only the channel's peer can pay it. A peer that sets a price, such as lnd with tapd, lets anyone pay an invoice of yours in bitcoin and lets you pay bitcoin invoices with the asset. See [Invoices, payments and prices](#invoices-payments-and-prices).
- **This wallet never forwards a payment for anyone else**, and never sells an asset for bitcoin.
- **An asset payment goes out in one part, over one channel.** What you can send or receive at once is what the best single channel carries, never the sum of several.
- **No backup brings a channel back.** See [Asset channels and backups](#asset-channels-and-backups).

### Opening a channel

**Open asset channel**, on the Channels tab, asks for the asset, the amount, the peer (as `02abc…@host:9735`) and the fee rate of the funding transaction, which starts at the fast rate so the channel does not sit unconfirmed. Before you confirm it shows what the open costs:

| Row | What it is |
| --- | --- |
| Goes into the channel | The amount of the asset, and 100,000 sats of bitcoin with it |
| Starts on the peer's side | A small part of that bitcoin, about 1,700 sats, so the peer can pay you back. The dialog says the figure |
| Miner fee | The fee of the funding transaction, at the rate you chose |
| Total in bitcoin | The 100,000 sats and the miner fee |
| On-chain available | What the wallet has to pay that with |

The bitcoin in the channel stays yours and comes back when the channel is closed, all but the part that starts on the peer's side: that is the peer's. The miner fee is spent.

- **The asset all starts on your side.** You can pay with it as soon as the channel is open, and receive only once some has gone out.
- **The bitcoin has to be on native SegWit addresses.** A wallet that has too little there is refused, with what it has on those addresses, what the open needs and what sits on addresses of other types, which cannot be used for it. Nothing is spent.
- **One asset per channel.** Of an asset that was created in several issuances a channel holds one, so the most a channel can take is the most the wallet holds of a single issuance on-chain. A collectible cannot go into a channel.
- **The peer is asked before anything is funded.** The wallet connects to it and asks whether it takes asset channels. If it does not, the wallet says so, and nothing is opened and nothing is spent.
- **The wallet needs a proof server.** The proofs of the asset are put there before the open, and that is where the peer's wallet checks what it is being handed.
- **Keep bitcoin on-chain beside it.** The dialog says how much, and [Fee coins](#fee-coins) says why.

**A channel a peer opens to you is accepted by itself.** Nobody is asked. It is taken when asset channels are on for the wallet and it has finished starting, when fewer than four channels that peers began are still opening, when the asset is one this wallet knows or one whose issuance its own proof server can show, and when it is not a collectible. Anything else is turned down, and the wallet's log says why.

**While it opens.** The channel is listed as **opening**, with "Opening. It can carry payments once its funding transaction has confirmed." That takes three confirmations. A funding transaction that will not confirm can be taken back: **Take the funding back** on the row sends a transaction that spends the same bitcoin back to this wallet at a higher fee, so the funding can never confirm and the asset stays in the wallet. The miner fee comes out of the bitcoin that returns. Most fundings confirm by themselves, and waiting costs nothing.

**An open that was interrupted.** Asking twice never opens two channels: an open carries a key, and the same request answers the same channel, also across a restart. A wallet that stops in the middle of an open carries it on at its next start. An open that ended before any bitcoin or asset left the wallet stays listed for seven days as **not opened**, with the reason, for example "This channel open was interrupted before any bitcoin or asset left the wallet, so nothing was opened and nothing was spent. It can be tried again." There is nothing to close on such a row, and it goes by itself.

### Invoices, payments and prices

**An invoice** is made under Assets, Receive, in the **Lightning invoice** card: pick the asset, type the amount, add a note for the payer if you like. The wallet asks your channel peer, and the invoice is shown as text and a QR code. It holds for as long as the peer keeps its answer for it, an hour at most. Its row says when it was paid and what arrived. What arrives can be one unit less than what was invoiced when a payer's price rounds down, and the balance counts what arrived.

**A payment** is made under Assets, Send, by pasting a Lightning invoice. The wallet asks your channel peer first and shows what the payment takes of the asset and how long that is held for. Nothing is paid until you confirm, and a payment never takes more of the asset than you were shown. If what you were shown has run out or changed, the wallet says so, nothing is paid, and you are shown the new figure. An invoice this wallet has already paid is refused. A payment whose end is not known yet stays **pending** until the wallet's node says how it ended, also across a restart.

**Prices.** In an asset channel the peer is the one that can exchange the asset for bitcoin, at a price it quotes each time. **A wallet of this app sets no price.** So between two wallets of this app:

- **No worth in sats and no rate is shown**, on an invoice or on a payment.
- **An invoice is for the asset alone, and only the channel's peer can pay it.** The sats written on such an invoice are not a price.
- **Paying somebody else's bitcoin invoice with an asset needs a peer that sets a price**, and a wallet of this app is not one.

With a peer that does set a price, an invoice shows what the payer is asked for in sats and the rate, and a payment shows what the invoice gets and the price. That path ran on regtest against a peer that runs lnd with tapd: a node with no asset paid an invoice of this wallet in bitcoin and this wallet received the asset, and this wallet paid a bitcoin invoice of that node with the asset, both through the peer. The peer's price decides how much of the asset that is.

- **At most eight unused answers from one peer at a time.** Every invoice you make, and every figure you ask for before paying, is one the peer keeps for you until it is used or runs out. A peer keeps eight for one wallet at once, so no more than eight unpaid asset invoices are open with one peer at a time. The next is refused with "The peer is already keeping as many unused prices for this wallet as it keeps at once, so it gave no new one. Try again in a few minutes."
- **One part, one channel.** A payment larger than the best single channel can send is refused ("No asset channel of this wallet can send that much."), also when two channels together could. An invoice for more than one channel can receive is refused the same way.
- **At most eight payments in flight each way in one channel.** A ninth is refused before anything is sent, until one of them has ended.
- **A peer that is away.** A channel whose peer is not connected carries nothing until it is back. Its row says **peer offline**, and an invoice or a payment that would need that channel says who is away, with nothing made and nothing paid.

### Closing a channel

**Together with the peer.** **Close** on the channel's row. Your side of the asset comes back to this wallet on-chain once the closing transaction confirms. The bitcoin on your side goes straight back to the on-chain balance, all but the 1,000 sats that stay locked with the asset, as with any asset the wallet holds. A channel is closed together only while its peer is connected. With the peer away the close is refused, and the dialog says so before you try.

**Alone, a force close.** It does not ask the peer. It is for a peer that has stopped answering, and for nothing else. Your side of the asset comes back only after the channel's safety delay, 144 blocks or about a day between two wallets of this app, and the transaction costs more in miner fees than an agreed close. **The bitcoin on your side comes back with the asset, on the same output, and stays locked with it**: it does not return to the on-chain balance by itself. The next time that asset is sent or burned, the transaction that does it returns the bitcoin to the on-chain balance as change, all but the usual 1,000 sats. The row reads **closing** while the delay runs and **force closed** once it is over. The wallet brings what is yours home by itself when the delay has passed, and it has to be running to do that. If the assets of a closed channel are not back yet, the Channels tab says "The assets of a closed channel have not come back on-chain yet. The wallet keeps trying, and its log says why." That is a wait, not a loss.

What a row offers, by what it reads:

| The row reads | What it means | What you can do |
| --- | --- | --- |
| opening | The funding transaction has not confirmed | Wait, or take the funding back |
| open | It carries payments | Invoice, pay, close |
| open, peer offline | The peer is not connected, so the channel carries nothing until it is back | Wait, or force close if the peer is gone for good |
| failed | The wallet's node gave the channel up. It carries nothing | Force close. It can no longer be closed together with its peer |
| closing | A close is under way | Wait |
| closed, force closed | Over. The row stays for a while and then goes | Nothing |
| not opened | An open that ended before anything left the wallet | Nothing. The open can be tried again |
| not held here | On the wallet's record, and its node does not hold it: what a restore from a backup leaves | See [Asset channels and backups](#asset-channels-and-backups) |

### The bitcoin in an asset channel

Opening a channel takes 100,000 sats and the miner fee out of the wallet's on-chain balance. **While the channel is there, the bitcoin on your side of it is in neither the on-chain balance, nor the Lightning balance, nor the total**: it cannot be spent as bitcoin and it is not sent over Lightning. The dashboard shows it on a line of its own, the way it shows sats locked with assets:

- **On the Overview**, under the Lightning figure: **in asset channels**, and while a channel is closing, **on their way back from a closing asset channel**.
- **In the wallet list**, after the wallet's figures, in the same words.
- **On each channel's row**, as **Bitcoin in the channel**: the whole of the channel's bitcoin, your side and the peer's.

A channel that is closing stays on the second line until its close is over, which after a force close is the whole of the safety delay. Then the line is gone. After a close together with the peer the bitcoin is back in the on-chain balance. After a force close it sits on the output the asset came back on and is counted under [Bitcoin locked with assets](#bitcoin-locked-with-assets) until that asset is next sent or burned. The wallet's figure for it is the real one; the figure on one asset's own page counts 1,000 sats for each output and so reads low until then.

**Each payment moves a little of the channel's bitcoin with it.** A payment over an asset channel carries 355 sats of the channel's bitcoin from the payer's side to the payee's, and they stay there. A side that has paid many times without being paid can run out of bitcoin to carry the next payment while it still has units of the asset. The side that did not open the channel starts with about 1,700 sats, of which 1,000 have to stay on its side, so it can pay once before it has been paid itself. The wallet refuses a payment its side cannot carry, and an invoice the peer's side cannot carry, before anything is sent, and one payment the other way makes it possible again.

### Fee coins

A payment that is in flight when a channel goes on chain is claimed with an on-chain transaction of its own, and that transaction pays its miner fee from the wallet's ordinary bitcoin: from a small confirmed coin the wallet sets aside for it, a **fee coin**. Preparing fee coins takes a confirmed coin of the wallet's own, and a block.

**So a wallet with an asset channel should keep some confirmed bitcoin on-chain.** The open dialog says how much, beside what the open itself takes. What the Channels tab says when something is short:

- **No confirmed coin large enough**, on a wallet with a channel: "Keep at least N sats of confirmed bitcoin on-chain in this wallet. A payment caught in an asset channel that has to be closed without the peer is claimed with an on-chain transaction, and its miner fee comes from the wallet's own bitcoin. The wallet has no confirmed coin large enough for that now, so such a claim could come too late."
- **The budget is used up**: "The budget this app sets for the miner fees of asset channels is used up, so nothing was done. Nothing was lost: the channels and what is in them are as they were."
- **The wallet's node did not take the fee settings**: no new asset channel is opened, the channels there already are keep working, and the wallet's log says what the node refused. This one is for whoever runs the box.

The limits this app gives the wallet's node for those fees:

| | mainnet | testnet | regtest |
| --- | --- | --- | --- |
| One claim, at most | 25,000 sats | 10,000 sats | 10,000 sats |
| One preparation of fee coins (four at a time), at most | 10,000 sats, at 10 sat/vB | 10,000 sats, at 1 sat/vB | 10,000 sats, at 1 sat/vB |
| All of them together | 2,500,000 sats | 1,000,000 sats | 100,000,000 sats |

The first two never pass the wallet's ceiling for one asset transaction (`BEIGNET_ASSETS_MAX_FEE_SATS`, see [Fees](#fees)). The app has no setting of its own for the rest. The total is a budget for the wallet's whole life. What claims and preparations of fee coins have spent is never given back, and a claim that is under way holds back up to its limit of the budget until it is over.

### Peers that run Lightning Labs' daemons

A peer that runs lnd with tapd, Lightning Labs' daemons, takes an asset channel from this wallet. It ran on regtest through this app against `tapd-integrated` built from taproot-assets `0ab6c01c`, with no patch: the open, a payment each way, both sides restarted, the payments through the peer to and from a node with no asset, a close together, a close by force from each side, and every share that came home checked by `tapd`. What differs from a channel between two wallets of this app:

- **The channel is one tapd can sign.** Such a peer offers none of this engine's fixed HTLC outputs, so the channel's payments are signed the way tapd signs them, and both sides wait the same delay after a close by force: 144 blocks with the peer as tested.
- **The peer sets the price.** It quotes the price of an invoice and of a payment, and the dashboard shows it. It also judges the price this wallet gives: tapd refuses one further from its own than its tolerance, 5% unless its operator set another. This wallet prices one unit of an asset at one sat, so a peer whose price is further from that cannot make an invoice for this wallet to pay. An invoice of yours, and your payment of a bitcoin invoice, are not affected.
- **It brings you the asset only up to its bitcoin in the channel.** tapd sends a payment that carries units only while the bitcoin it can spend on its side of the channel covers the payment's whole worth in sats, and it sends that bitcoin along with the units. After an open from this wallet its side holds about 1,700 sats, of which 1,000 must stay, so it can pay you, or pass on a payment to you, worth well under 1,100 sats until it holds more. What you pay it is not limited this way.
- **It invoices over a new channel after six blocks.** It can make an invoice over the channel only once this wallet's terms for the channel reach it, which this wallet sends once the funding is six blocks deep.

Not run with such a peer: a channel it opens to this wallet, a payment in flight that goes to the chain, testnet and mainnet, and Lightning Terminal (`litd`), which packages the same daemons.

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

### Asset channels and backups

**No backup brings an asset channel back.** A channel is held by the wallet's node on this machine, and its state changes with every payment. What the box backup carries of asset channels is the record around them: which channels there were, where their payouts go, the proofs of what funded them, and each close the wallet saw. It does not carry the channels themselves, the answers a peer gave about a price, or the invoices made.

So a wallet restored from the box backup:

- **Keeps what it had on-chain**, as above.
- **Lists each channel that was open as *not held here***, with the last balance it knew, and says: "An asset channel is on record that the wallet's node does not hold, as happens after a restore from a backup. It cannot be used or closed from this wallet, and its balance is the last one known. This wallet cannot bring the assets in it back by itself."
- **Cannot invoice, pay or close through that channel.** A close of it is refused in a sentence.
- **The peer still holds the channel and can close it.** That brings the peer's side home. **For your own side the app can do nothing today**: it says so in the words above and offers nothing more. Count the asset and the bitcoin on your side of an open channel as covered by no backup.

**A backup is never restored over a channel.** Importing an assets backup into a wallet that has an asset channel which is not over is refused: "This wallet has an asset channel, and a backup is never restored over one. Close its asset channels first." What the file says the wallet holds on-chain is from before the channel, and the two would not agree. A wallet that already has channel records of its own keeps them, and the file's are left out.

**Restoring channel state from a peer's checkpoint.** The channel backup for bitcoin channels ([CHANNEL-BACKUP.md](CHANNEL-BACKUP.md)) restores channel state from a checkpoint a peer kept. It does not bring asset channels back:

- **A checkpoint that holds an asset channel is refused**, with nothing restored and nothing written, and the card lists the asset channels it holds.
- **The way round is confirmed by typing.** The restore can be run without them: type `leave them out`. The bitcoin channels then come back, held as that card explains, and payments and invoices are kept. The asset channels do not come back: the wallet then has no record of them and cannot bring the assets in them back by itself. The peer of each can still close its channel.
- **Payments that can no longer be followed.** The result counts the payments that were under way on the channels left out. Each stays pending for good: it is not counted as paid or as failed, and it cannot be cancelled or tried again from there.
- **The automatic apply says the same.** A wallet that applies a returned checkpoint by itself does not apply one that holds an asset channel. Nothing is changed, the checkpoint still waits, and the same card lists the channels and offers the restore without them.
- **A backup that carried no state for an asset channel** skips it, and the result lists what was skipped in the same words: no record, nothing the wallet can bring back by itself, and a peer that can still close.

**An older version of the app's engine does not run asset channels.** A wallet's node from before asset channels, started over a wallet that has one, skips that channel, starts, runs its bitcoin channels, and leaves the asset channel stored as it was. Until a version that knows asset channels is back, nothing answers the channel's peer, claims a payment before its deadline, or punishes a cheating close. So a box is never taken back to an older release while a wallet on it has an asset channel that is not over.

**Guardians and asset channels do not go together.** A channel backup kept by guardians does not cover asset channels.

- A wallet on a guardian backup has no asset channels, and nothing about them is shown.
- A wallet with an asset channel that is not over cannot be moved to a guardian backup, made on-chain only, or have its assets turned off. The change is refused until the channel is closed on the Channels tab and its assets are back on-chain.
- A wallet that has both all the same is not started, and nothing is sent to the guardians. The wallet list says why and what to do: take it off the guardian backup, start it, and close the channel.

## Before you use this on mainnet

Mainnet is on by default, with no extra step. That is a choice for convenience, not a statement about maturity. Know these first:

1. **No independent security review.** Neither ts-tap nor the path the engine loads it through has been audited. `tapd` itself is described by its authors as alpha software. A bug can lose assets, and the bitcoin anchoring them.
2. **The phrase is not enough.** See above. Without the app backup, lost data means lost assets.
3. **No fee bumping.** See [Fees](#fees).
4. **You depend on a universe server, and it has to accept the proof.** A recipient needs the proof to credit a transfer. If the server is down, a send's proof delivery waits and is retried, and a receive waits. If the server refuses the proof, the recipient's wallet does not get it from there, and the public testnet3 server refused every transfer proof from this app when it was tested. The mainnet server has not been tried. The way through is to [hand the proof over as a file](#handing-a-proof-over-as-a-file), which needs the recipient to be someone you can send a file to, using a wallet that can import one. Read [Transfers and the public universe servers](#transfers-and-the-public-universe-servers) and send a small amount first.
5. **Your Electrum server is trusted more than usual.** It tells the wallet which block is at which height and whether an anchor is unspent. The wallet checks each proof's merkle path and header, not proof of work. A dishonest server working with a dishonest sender could make the wallet accept a proof that is not on the real chain. Use an Electrum server you run.
6. **A name is not an identity.** Anyone can create an asset called USDT. An asset is identified by its ID (or group key), which is what the coloured avatar is drawn from, and the Send and Receive forms show it. Check the ID with whoever issued the asset.
7. **Privacy.** A universe server is public by design, and proofs carry an asset's history.

With an asset channel, also:

8. **No independent review of any of it.** Item 1 covers asset channels too: ts-tap's channel code, the engine's part and this app's. They have so far been run on regtest only (see [How this was verified](#how-this-was-verified)).
9. **A wallet with a channel has to come online regularly**, as with any Lightning channel. What is yours in a channel that goes on chain is claimed by your own wallet, and only while it runs. There is no remote watchtower for asset channels.
10. **Keep confirmed bitcoin on-chain for fees.** See [Fee coins](#fee-coins).
11. **Back up the box after you open a channel, and know what a backup does not bring back.** It does not bring back the channel, and the app cannot bring back your side of one its node no longer holds. See [Asset channels and backups](#asset-channels-and-backups).
12. **Do not downgrade the app with a channel open.** An engine release from before asset channels (older than Beignet 0.43.0) starts the wallet without the channel: it neither runs nor watches it, so nothing answers the peer, enforces a payment's deadline or answers an old state the peer publishes. The channel is whole again once the newer engine is back, but it is unprotected in between. Close every asset channel and wait for the assets to be back on-chain first.

## Not covered

- **For assets over Lightning:**
  - Forwarding a payment for anyone else.
  - A payment in several parts, or over more than one channel.
  - Several assets in one channel.
  - Splicing an asset channel, or funding one from both sides.
  - BOLT 12 offers for assets.
  - Receiving an asset while the wallet is offline.
  - A remote watchtower for asset channels.
  - **A channel that a peer running Lightning Labs' daemons opens to this wallet**, and such a peer on testnet or mainnet. See [Peers that run Lightning Labs' daemons](#peers-that-run-lightning-labs-daemons).
- **Fee bumping** (RBF or CPFP) for asset transactions.
- **Version 2 addresses**, to receive or to pay.
- **One address, several payments.** An address is for one payment of one amount. A second payment to it sits on chain uncredited, and this app has no way to claim it yet.
- Sending to several addresses in one transaction, choosing coins by hand, and merging small asset outputs.
- Importing a proof file for anything but a payment to one of this wallet's own addresses (an asset somebody holds for you, say), and exporting the proof of an asset this wallet holds without sending it. A proof file here is a transfer's, saved by its sender for its recipient.
- Running a universe server, or syncing with a federation of them.
- Hardware signing, multi-signature and scripted asset keys.

## How this was verified

Three layers, each of which can be run again.

- **Unit tests.** The assets host, the manager's part and the dashboard each have tests beside the code (`cd manager && npm test`, `cd manager/ui && npm test`). With `ASSETS_ENGINE_PREFIX` pointing at an engine prefix, the manager's tests also load the real vendored packages into a real daemon and exercise the contract between them.
- **Regtest, end to end.** `scripts/assets-regtest/` drives a real manager and real wallet daemons against a regtest chain and `tapd`, Lightning Labs' daemon. `tapd` verifies every proof it is given, so an issuance it stores and a transfer it credits are its word that what this app produced is valid, and the app in turn receives what `tapd` mints and sends. The scenarios cover: every kind of mint, with refusals; both directions with `tapd`; wallet to wallet with change, and burn; previews that are cancelled, replaced or abandoned; restarts and outright kills of the daemon in the middle of a mint, a preview, a send and a receive; a request repeated with its key; a reorganisation that takes the mint's block out of the chain; archive, wipe and restore; changing the proof server; switching assets off and on for one wallet; and a proof server that refuses transfer proofs, where the proof goes by file instead, `tapd` verifies each exported file with its own `tapcli proofs verify`, forged files with every checksum right (ten times the amount, a larger issuance, a history cut short) are refused by verification, and what arrived by file is sent on by file and then to `tapd`, which credits it.
- **Testnet4,** against `testnet4.universe.lightning.finance`. Two mints (a normal asset with two decimals and a collectible in one transaction, a grouped asset in another), six confirmations, all three issuances found on the public universe, a second wallet that learned the asset from that universe alone, and a transfer to it that completed on both sides with its proof delivered through the public server. Then the second wallet sent part of it back, the first burned some, both wallets were archived, erased and restored from the archive, held what they held before, and the restored wallets sent and received again. Every proof went through the public server.
- **Testnet3,** against `testnet.universe.lightning.finance`. The same mints, six confirmations, the issuances found on the public universe and learned from it by a second wallet, and a transfer that confirmed. Its proof was refused by the server, so the transfer did not complete through it: see [Transfers and the public universe servers](#transfers-and-the-public-universe-servers). Both refused transfers (an asset with a group and one without) were then completed by saving their proof files from the sending wallet and importing them into the receiving one, which verified each against the chain and credited it. The receiving wallet then sent part of it back, the server refused that proof too, and the first wallet took it by file the same way.

The regtest stack runs its `tapd` with today's proof rules in force from the first block (`--proofactivationheight=1`), so the scenarios exercise what mainnet, testnet3 and testnet4 require of a proof and not the older rules a stock regtest `tapd` keeps.

The unit tests and the regtest scenarios were first run on an engine built from the pull request that added the host extension contract, run again on the published Beignet 0.42.0, and run again on the published Beignet 0.43.0, the engine this app bundles.

Nothing was spent on mainnet to test this. Mainnet runs the same code with a different address prefix, activation height and universe server, and its universe server is the one unknown above.

What is covered by unit tests only, because the regtest stack cannot produce it: a preview expiring by the clock, a transaction that waits an hour unconfirmed, and Tor mode.

**Asset channels** were run on regtest on the builds this app ships: Beignet 0.43.0 as published and the library under `vendor/`, installed by `scripts/engine-prefix.sh` with no installed file changed, through a real manager and real daemons, between two wallets of this app. The five scenarios `20-ln-open` to `24-ln-crash-restore` passed, 121 checks. They cover: what an open costs and the refusals before anything is funded; one open however often it is asked for; an invoice and its payment in both directions, repeated with its key, at the limits each way, at a price that is gone, and across a restart of both daemons; a close agreed by both sides; a close by force with the peer stopped, the wait before a share can be swept, both sweeps, and the swept units sent on; daemons killed before an open has answered, as it answers and during a payment; and the opener restored from an archive, where the channel reads as one its node no longer holds and the peer closes it by force. At each stage the two wallets held between them exactly what was minted, and after each close the units that came back were handed to `tapd`, which verified their proofs and credited them. Two more runs, by scripts that are not among the scenarios here, passed on the same builds: a side with too little bitcoin left to carry a payment was refused in words and could pay again once it had been paid (7 checks), and a channel was closed by force with a payment in flight, the payer took the payment back on chain after its expiry, and `tapd` credited everything both sides held (15 checks). The nine on-chain scenarios passed beside them, 171 checks.

**Against a peer that runs Lightning Labs' daemons** (lnd with tapd in one process, `tapd-integrated` built from taproot-assets `0ab6c01c` with no patch, on the stack's chain), `25-ln-upstream` passed through a real manager and a wallet daemon of this app, 32 checks: the open, in the form of HTLC signatures tapd signs with one delay of 144 blocks on both sides; an invoice of the peer paid, an invoice of the wallet paid by the peer; both restarted and a payment again; a price quoted by the peer and shown as one; a node with no asset paying an invoice of the wallet in bitcoin, the wallet receiving the asset through the peer; the wallet paying a bitcoin invoice of that node with the asset, that node's invoice settled; a close together; a close by force from the peer and one from the wallet with the peer stopped. At each stage the wallet and the peer held between them exactly what was minted, and every share that came home to the wallet was handed to the stack's `tapd`, which verified it. ts-tap's own example ran the same peer without the app and passed.

Not run through this app: an asset channel on testnet or mainnet, a payment in flight that its payee claims on chain, and a commitment that was revoked and is punished. ts-tap's own regtest example, which drives two nodes of this engine without the app, passed on Beignet 0.43.0 and does cover the last two.

## For operators and developers

| Setting (app environment) | Effect |
| --- | --- |
| `BEIGNET_ASSETS=off` | No wallet loads the assets host; the tab is hidden |
| `BEIGNET_ASSETS_MAX_FEE_RATE`, `BEIGNET_ASSETS_MAX_FEE_SATS` | The fee ceilings above |
| `ASSETS_REGTEST_UNIVERSE_COURIER`, `ASSETS_REGTEST_UNIVERSE_REST`, `ASSETS_REGTEST_UNIVERSE_CA` | The universe a regtest wallet uses: a local tapd's courier address, REST gateway and certificate |

A wallet's record carries `assets: { enabled, universe }`, set with `PATCH /api/wallets/:id`, and reports `holdsAssets`, the host's `phase` and `error`, whether its backup file exists (`backupFile`) and why the last archive left its assets out (`notArchived`). `GET /api/config` reports `assetsAvailable`, `assetChannelsAvailable` and the `universeServers` the app knows.

**Asset channels.** There is no app setting for them. The manager tells each wallet's daemon whether its assets host may use asset channels (`BEIGNET_ASSETS_LIGHTNING`, `full` or `off`), from what the engine can carry, whether the wallet has Lightning, and whether its channel backup is kept by guardians. The fee ceilings in the table above hold for a channel's funding too, and the limits for the fees of channels on chain are in [Fee coins](#fee-coins).

The routes, under `/wallets/:id/api/x/assets`:

| Route | What it does |
| --- | --- |
| `GET /channels` | The wallet's asset channels, `{ channels: [] }` on a wallet that cannot have one |
| `POST /channels/quote` | What an open would cost: `channelSats`, `pushSats`, `feeSats`, `totalSats` |
| `POST /channels/open` | Opens a channel |
| `POST /channels/close` | Closes one, by `channelId`. `force: true` closes without the peer |
| `POST /channels/reclaim` | Takes back the funding of an open that has not confirmed |
| `POST /invoices/quote`, `POST /invoices`, `GET /invoices` | Asks the peer, makes an invoice, lists the invoices made |
| `POST /pay/quote`, `POST /pay` | Asks the peer what an invoice takes, and pays it |

An open, a reclaim and a payment carry an `X-Idempotency-Key`, and the same key never does the thing twice, also across a restart. On a wallet without asset channels every one of these but `GET /channels` refuses with `LIGHTNING_UNAVAILABLE`.

`GET /status` carries `assetChannels`, the number of channels that are not over, and `lightning`:

| Field | Meaning |
| --- | --- |
| `mode` | `full` or `off` |
| `usableChannels` | How many channels can carry a payment now |
| `feeCoins` | `null` when the node cannot say. Otherwise `possible`, `neededSats`, `largestConfirmedSats`, `ready`, `budgetRemainingSats`, and `reason` when not possible: `FEE_FUNDS_UNAVAILABLE` or `FEE_BUDGET_EXHAUSTED` |
| `unavailable` | Only when the node does not offer asset channels to its peers: `{ code: 'NOT_ADVERTISED', message, reason }` |
| `warnings` | `[{ code, text }]`, each a sentence to show: `CHANNEL_MISSING`, `CHANGE_NOT_BACK`, `RECOVERY_STUCK`, `FEE_COINS_UNAVAILABLE`, `FEE_BUDGET_EXHAUSTED`, `FEE_POLICY_REFUSED`. `warning` is the same sentences joined |

A channel in the list has a `state`: `OPENING`, `NORMAL`, `CLOSING`, `FORCE_CLOSING`, `CLOSED`, `FORCE_CLOSED`, `FAILED` (an open that ended, with `failure: { code, message, detail }`: the message is the host's own sentence, and `detail`, present only when the wallet's node gave a reason, is that reason in the node's words, which the dashboard shows small beneath the sentence), `ERRORED` (the node gave it up after its funding was on chain; one it gives up before that stays `OPENING` until the open ends, since nothing is on chain to close) or `MISSING` (on record, not held by the node). A state the host has no word for is passed on in the node's own. `peerConnected` says whether the peer is there, and amounts of an asset are strings. `undeliveredOutcomes` is on a channel only while above zero: how many results of earlier payments the wallet has not taken in yet. A payment through that channel is refused with `OUTCOMES_UNDELIVERED` until it has, and the row says so.

Every refusal carries a `code` and a sentence that can be shown as it is. The codes a client of these routes meets:

| When | Codes |
| --- | --- |
| The wallet cannot use asset channels now | `LIGHTNING_UNAVAILABLE`, `LIGHTNING_NOT_ADVERTISED`, `ASSETS_STARTING`, `ASSETS_STOPPING` |
| Opening | `PEER_UNREACHABLE`, `PEER_NO_ASSET_CHANNELS`, `CHANNEL_MODE_UNAVAILABLE`, `FUNDING_INPUTS`, `INSUFFICIENT_BTC`, `CHANNEL_ASSETS`, `NO_PROOF_SERVER`, `FEE_TOO_HIGH`, `FEE_POLICY_REFUSED`, `IDEMPOTENCY_KEY_REQUIRED`, `CHANNEL_CANCELLED`, `CHANNEL_OPEN_INTERRUPTED`, `CHANNEL_OPEN_FAILED` |
| Closing and taking a funding back | `CHANNEL_NOT_FOUND`, `CHANNEL_OPENING`, `CHANNEL_MISSING`, `CHANNEL_NOT_FUNDED` (a force close of a channel whose funding transaction is not on chain), `CHANNEL_ERRORED`, `PEER_OFFLINE`, `CHANNEL_CLOSE_FAILED` |
| Asking the peer | `PEER_GAVE_NO_PRICE`, `TOO_MANY_QUOTES`, `QUOTE_EXPIRED`, `QUOTE_CHANGED`, `RATE_TOO_COARSE`, `PEER_OFFLINE` |
| Invoices and payments | `BAD_INVOICE`, `ALREADY_PAID`, `PAYMENT_IN_FLIGHT`, `INSUFFICIENT_OUTBOUND`, `INSUFFICIENT_INBOUND`, `PAYMENT_UNSUPPORTED`, `PAYMENT_NOT_SENT`, `OUTCOMES_UNDELIVERED`, `SPENDING_LIMIT`, `FEE_BUDGET_EXHAUSTED` |
| Backups and wallet settings | `ASSET_CHANNELS_OPEN`, from the host for an import over a channel and from the manager for a change that would take asset channels away from a wallet that has one |

The engine's `GET /balance` carries `assetChannelSats` and, while one is closing, `assetChannelClosingSats`: the bitcoin on this wallet's side of its asset channels, in neither `lightning` nor `total`. Both keys are absent on a wallet without asset channels and on Beignet 0.42.0.

- **Updating ts-tap.** `scripts/vendor-ts-tap.sh <ts-tap checkout> [commit]` rebuilds both tarballs from one commit and rewrites `vendor/SHA256SUMS` and `vendor/ts-tap.lock.json`; `--verify` rebuilds and compares. It refuses a build whose source maps carry the text of the sources. The adapter names the engine releases it was built for, and the image build fails if the bundled engine is outside that range, so an engine bump past it needs a ts-tap build for the new engine first.
- **A development engine.** `scripts/engine-prefix.sh <dir> [engine]` installs an engine and the vendored packages side by side, as the image does, and says whether assets are available on it.
- **End to end.** `scripts/assets-regtest/` drives a real manager and real daemons against a regtest chain and `tapd`.
