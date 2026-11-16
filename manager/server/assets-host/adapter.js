'use strict';

/**
 * The one file that touches the Taproot Assets library.
 *
 * ts-tap and its Beignet adapter are installed beside the wallet engine, not
 * in the manager, so they are resolved from the directory the manager names
 * (BEIGNET_ASSETS_MODULES) and never by a bare require. Everything else in
 * the host works against two things built here:
 *
 *   lib   small pure helpers over the library (decode an address, read a
 *         fee, build a metadata record), which tests replace with fakes
 *   tap   the adapter over this wallet: minter, freighter, chain, keys
 *
 * and, for a wallet whose engine and library can carry assets in Lightning
 * channels, a third (the Lightning section at the end of this file):
 *
 *   ln    asset channels: the provider the engine is handed, and what the
 *         host asks of the library's Lightning service
 *
 * The state numbers below are the library's own, as stored in its records.
 * They are checked against the loaded library, so a library that renumbers
 * them is refused instead of misread.
 */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { tapBackend, lightningBackend } = require('./store');

const STATES = Object.freeze({
	Batch: Object.freeze({ Pending: 0, Frozen: 1, Committed: 2, Broadcast: 3, Confirmed: 4, Finalized: 5, SeedlingCancelled: 6, SproutCancelled: 7 }),
	Send: Object.freeze({
		StartHandleAddrParcel: 0,
		VirtualCommitmentSelect: 1,
		VirtualSign: 2,
		AnchorSign: 3,
		VerifyPreBroadcast: 4,
		StorePreBroadcast: 5,
		Broadcast: 6,
		WaitTxConf: 7,
		StorePostAnchorTxConf: 8,
		TransferProofs: 9,
		Complete: 10,
		Cancelled: 11
	}),
	Receive: Object.freeze({ Registered: 0, Located: 1, Verified: 2, Complete: 3 })
});

// The key family every Taproot Assets key of a wallet is derived under.
const TAP_KEY_FAMILY = 212;
// The sats an asset output carries: what a mint or a send puts beside it.
const ANCHOR_SATS = 1000;

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const unhex = (text) => Buffer.from(String(text), 'hex');

function sameEnum(mine, theirs) {
	return !!theirs && Object.entries(mine).every(([name, value]) => theirs[name] === value);
}

/** Load ts-tap and its adapter from `modulesDir`. Throws a sentence when they are not usable. */
function loadLibrary(modulesDir) {
	const req = createRequire(path.join(modulesDir, 'noop.js'));
	let tap;
	let bridge;
	try {
		tap = req('ts-tap');
		bridge = req('@ts-tap/beignet');
	} catch (err) {
		throw new Error(`The assets packages could not be loaded from beside the wallet engine (${err.message}).`);
	}
	const ok =
		typeof bridge.createBeignetAdapter === 'function' &&
		tap.tapgarden &&
		tap.tapfreighter &&
		sameEnum(STATES.Batch, tap.tapgarden.BatchState) &&
		sameEnum(STATES.Send, tap.tapfreighter.SendState) &&
		sameEnum(STATES.Receive, tap.tapfreighter.ReceiveState);
	if (!ok) throw new Error('The assets packages beside the wallet engine are not a version this app was built for.');
	return { tap, bridge };
}

/** Metadata as the dashboard shows it: { type, text, bytes }, or null for none. */
function metaView(tap, meta) {
	if (!meta || !meta.data || meta.data.length === 0) return null;
	const data = Buffer.from(meta.data);
	if (meta.type === tap.proof.MetaType.Json) return { type: 'json', text: data.toString('utf8'), bytes: data.length };
	const text = data.toString('utf8');
	const readable = Buffer.from(text, 'utf8').equals(data) && !/[\u0000-\u0008\u000e-\u001f]/.test(text);
	return readable ? { type: 'text', text, bytes: data.length } : { type: 'opaque', text: null, bytes: data.length };
}

/** The helpers the host needs from the library, as plain values. */
function createLib(tap) {
	const displayTxid = (tx) => tap.asset.formatOutPoint({ hash: tap.proof.txid(tx), index: 0 }).split(':')[0];
	const feeOf = (fee) => (fee ? { sats: Number(fee.fee), vbytes: fee.vsize === undefined ? null : Number(fee.vsize) } : null);
	return {
		AssetType: tap.asset.AssetType,
		AddressVersion: tap.address.AddressVersion,
		canLookup: typeof tap.tapfreighter.Freighter.prototype.lookupAsset === 'function',
		/** An address string as plain fields, with the library's own object in `raw`. */
		decodeAddress(text) {
			const encoded = String(text || '').trim();
			const raw = tap.address.decodeAddress(encoded);
			return {
				raw,
				encoded,
				version: raw.version,
				hrp: raw.hrp,
				assetId: hex(raw.assetId),
				groupKey: raw.groupKey ? hex(raw.groupKey) : null,
				scriptKey: hex(raw.scriptKey),
				amount: BigInt(raw.amount),
				courier: raw.proofCourierAddr ? String(raw.proofCourierAddr) : ''
			};
		},
		encodeAddress: (raw) => tap.address.encodeAddress(raw),
		encodeGenesis: (genesis) => hex(tap.asset.encodeGenesis(genesis)),
		decodeGenesis: (text) => tap.asset.decodeGenesis(unhex(text)),
		batchFee: (batch) => feeOf(tap.tapgarden.batchFee(batch)),
		parcelFee: (parcel) => feeOf(tap.tapfreighter.parcelFee(parcel)),
		/** The assets a funded batch will create, in the order it creates them. */
		batchAssets(batch) {
			const encoded = (batch.genesis && batch.genesis.assets) || [];
			return encoded.map((item) => {
				const a = tap.asset.decodeAsset(unhex(item));
				return {
					assetId: hex(tap.asset.genesisId(a.genesis)),
					name: a.genesis.tag,
					type: a.genesis.type,
					amount: BigInt(a.amount),
					groupKey: a.groupKey ? hex(a.groupKey.groupPubKey) : null,
					genesis: hex(tap.asset.encodeGenesis(a.genesis))
				};
			});
		},
		decodeTx: (text) => tap.proof.decodeTx(unhex(text)),
		txid: (signedHex) => displayTxid(tap.proof.decodeTx(unhex(signedHex))),
		/**
		 * A metadata record for a new asset. `meta` is { type: 'json' | 'text',
		 * data } or null; the decimal display travels in the same record.
		 */
		metaReveal(meta, decimalDisplay) {
			const text = meta && meta.data != null ? String(meta.data) : '';
			const decimals = Number.isInteger(decimalDisplay) && decimalDisplay > 0 ? decimalDisplay : undefined;
			if (!text && decimals === undefined) return undefined;
			const json = !!text && meta.type === 'json';
			return {
				type: json ? tap.proof.MetaType.Json : tap.proof.MetaType.Opaque,
				data: Buffer.from(text, 'utf8'),
				...(decimals !== undefined ? { decimalDisplay: decimals } : {}),
				universeCommitments: false,
				unknownOddTypes: []
			};
		},
		metaView: (meta) => metaView(tap, meta),
		/** When the block of an issuance was mined (ms), and how long its proof file is. */
		fileFacts(fileBytes) {
			try {
				const file = tap.proof.decodeFile(Buffer.from(fileBytes));
				const first = tap.proof.fileProofAt(file, 0);
				const seconds = Number(first.blockHeader && first.blockHeader.timestamp);
				return { timestamp: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null, depth: file.proofs.length };
			} catch (_) {
				return { timestamp: null, depth: null };
			}
		},
		/**
		 * What a proof file proves last: which asset, how much of it, the key it
		 * is held under and the output it sits in. Throws when the bytes are not
		 * a proof file. Reading it verifies nothing.
		 */
		proofFacts(fileBytes) {
			const file = tap.proof.decodeFile(Buffer.from(fileBytes));
			const last = tap.proof.fileLastProof(file);
			return {
				assetId: hex(tap.asset.genesisId(last.asset.genesis)),
				groupKey: last.asset.groupKey ? hex(last.asset.groupKey.groupPubKey) : null,
				scriptKey: hex(last.asset.scriptKey),
				anchorOutPoint: tap.asset.formatOutPoint(tap.proof.proofOutPoint(last)),
				amount: BigInt(last.asset.amount),
				depth: file.proofs.length
			};
		},
		/** A proof file's bytes as the library's own object, for the Lightning service. */
		decodeProofFile: (fileBytes) => tap.proof.decodeFile(Buffer.from(fileBytes)),
		/** Where a decoded proof says its asset sits: what a proof server is asked by. */
		proofLocator: (p) => ({
			assetId: hex(tap.asset.genesisId(p.asset.genesis)),
			scriptKey: hex(p.asset.scriptKey),
			anchorOutPoint: tap.asset.formatOutPoint(tap.proof.proofOutPoint(p))
		}),
		/** A courier for a proof server. One attempt per call: the service loop is the retry. */
		makeCourier: (uri, { fetch, resolveEndpoint }) =>
			new tap.courier.UniverseRpcCourier(uri, { fetch, resolveEndpoint, retry: { attempts: 1 } })
	};
}

/**
 * The adapter over this wallet and the host's rows. Chain waits are one look
 * each (a 1 ms deadline after the first probe), so nothing here holds a
 * handler or a lock across a block interval.
 */
function buildAdapter({ tap, bridge, wallet, storage, cfg, lock, courierFor, proofPublisher }) {
	const { stores, keyIndexes } = tap.store.keyValueStores(tapBackend(storage));
	return bridge.createBeignetAdapter(wallet, {
		stores,
		keyIndexes,
		lock,
		tapNetwork: cfg.tapNetwork,
		minConfirmations: cfg.minConfirmations,
		courier: courierFor,
		proofPublisher,
		pollIntervalMs: 50,
		timeoutMs: 1,
		maxFeeRate: cfg.limits.maxFeeRate,
		maxFee: cfg.limits.maxFeeSats
	});
}

/* ---------------------------------------------------------------- lightning */

/*
 * Asset channels.
 *
 * The library's Lightning entry, `@ts-tap/beignet/lightning`, is loaded only
 * when the adapter beside the engine ships it. The rest of the host never
 * sees it: it works against the facade `createLightning` returns, which
 * deals in plain values (ids, keys and hashes as lower-case hex, amounts of
 * an asset as bigint, sats as numbers, millisatoshis as bigint, times in
 * milliseconds). The tests run the host through this same facade, over a
 * stand-in for the entry that has its exported names and shapes
 * (test-fakes.js `fakeLightning`).
 *
 * WHAT THIS SECTION LEANS ON
 *
 * Read from the entry's source (ts-tap branch asset-lightning-7-reservations,
 * packages/beignet/src/lightning*.ts, and docs/beignet.md). The entry has
 * run against a fake node only, and the host against a stand-in for the
 * entry only: nothing here has met an engine that carries asset channels.
 * A name or a shape that turns out different is changed here and nowhere
 * else in the host.
 *
 * The entry's exports
 *
 *  1. assetLightningSupport() returns { supported, engineVersion?, missing }.
 *     Synchronous, never throws. It looks at what the installed engine
 *     exposes and never at its version, and is false on every release up to
 *     0.42.0.
 *  2. lightningStore(backend, prefix) returns the store everything else is
 *     built over. `backend` is the engine's IExtensionStorage as it is (get,
 *     set, delete, list, transaction, all synchronous). Every key is written
 *     under `prefix`, which is lower-case segments ending in "/". A
 *     transaction of the store is one of the backend, and one opened inside
 *     another is refused.
 *  3. createAssetLightningHost({ store, hrp, fixedOutputFees, now?, onError? })
 *     returns { attachment, start, service, close }. Synchronous. It needs
 *     no adapter and no node, so it is called at attach, before the wallet's
 *     chain is known. On an engine without auxiliary channels it refuses
 *     with UNSUPPORTED, so 1 is asked first.
 *  4. `attachment` is { auxiliaryChannels, fixedOutputFees, bind(node) }.
 *     `fixedOutputFees` is the value createAssetLightningHost was given,
 *     untouched. The engine calls bind(node) once it has built its node, and
 *     a second, different node is refused. The provider works from that
 *     moment, whether or not the service runs, so a channel is enforceable
 *     either way. The hooks that need the wallet refuse until `start` has
 *     run: a peer's open is turned down and its quote request refused.
 *  5. start(adapter, options) is synchronous and returns the service.
 *     `adapter` is what createBeignetAdapter returned. It refuses with
 *     NOT_READY until the node is bound, and with INVALID when a service
 *     already runs, when `fetchProvenance` is missing and when `forwarding`
 *     is true. The host is ready to start before the engine has a node, so
 *     the facade keeps what it was given and starts once both are there.
 *     The options given:
 *       fetchProvenance(proof)   a decoded proof in, a promise of its
 *                                decoded proof file out (ts-tap's proof.Proof
 *                                and proof.File)
 *       acceptIncoming(p)        p is { peer, pendingChannelId, expiresAt,
 *                                assets: [{ assetId, amount }], inputProofs,
 *                                outputs, groupKey? }, called once the
 *                                peer's assets are verified; true, or a
 *                                promise of it, takes the channel
 *       confirmationDepth        how many confirmations bury a transaction
 *                                for good: the wallet's own (6 if left out)
 *       price                    left out, the service prices as a wallet
 *                                that only pays and is paid: it answers a
 *                                request to be paid over a channel the two
 *                                share, for that channel's asset, at one
 *                                unit a sat. Given, it is asked instead, and
 *                                a throw refuses the request.
 *       onEvent(event)           see 25
 *       onError(error)           what went wrong where nobody was waiting
 *       now()                    unix seconds as a bigint
 *     `forwarding` is left out: the entry routes for nobody.
 *  6. close() of the host closes the service and the quote transport and
 *     lets go of the node: for when the node stops. close() of the service
 *     stops the service alone, and the provider stays. After either, every
 *     call of the service refuses with NOT_READY.
 *
 * The service. Ids, keys and hashes are Buffers, amounts of an asset, sats
 * and millisatoshis are bigint, and a time is unix seconds as a bigint.
 *
 *  7. channels() is synchronous and lists every asset channel, every
 *     unfinished open whichever side began it, and every closed channel
 *     still on record:
 *       { pendingChannelId, channelId?, peer, initiator, phase, engine,
 *         signed, committed, confirmed, fundingTxid?, state?,
 *         fundingSatoshis, reserveSatoshis?, assets: [{ assetId, amount,
 *         local?, remote? }], groupKey?, decimalDisplay,
 *         localAssetBalance, remoteAssetBalance, reserved,
 *         fundingReservation?, fundingInputs?, recovery, error? }
 *     `phase` is the funding phase (receiving, awaiting-ack, accepted,
 *     negotiated, funding-created, committed, broadcasting, broadcast,
 *     active, rejected, failed) or `cancelled`.
 *     `engine` says whether the node holds the channel: `held`; `absent`,
 *     for an open that has not reached the engine or ended before it did,
 *     and for a closed channel the engine has dropped; `missing`, when the
 *     rows say the engine held it and it holds none, with no close on
 *     record, as after a restored backup. A missing channel has no `state`,
 *     its balances are the last known, and it carries no payment.
 *     `signed` says the funding transaction is signed, which is when
 *     cancelChannel starts to refuse. `confirmed` says the funding has
 *     confirmed and its proofs are stored. `state` is the engine's
 *     ChannelState word, there only while the engine holds the channel or
 *     of a closed one. `reserved` is the local units held for payments that
 *     are not in the channel yet, and nothing to do with funding.
 *     `assets` is what the channel was funded with. The balances are
 *     `localAssetBalance` and `remoteAssetBalance`, for the channel as a
 *     whole, and of a closed or missing channel the last known.
 *     `fundingReservation` is set from the moment an open of this wallet
 *     selects its inputs until its funding has confirmed: the wallet's
 *     on-chain records still list those inputs, unspent, with this name
 *     (`funding:<pending id hex>`) as their `reservedBy`. `fundingInputs`
 *     sums them by asset. They can hold more than the channel takes: the
 *     rest is the change of the funding.
 *     `recovery` is 'none' while no close has begun, 'pending' from the
 *     moment a close is asked for or seen until every asset of this
 *     wallet's is back in its on-chain records, then 'complete', and
 *     'complete' at once for a closed channel that held nothing of it. The
 *     host takes a closed channel to be over only on 'complete', and reads
 *     any other word as a recovery still to be done.
 *     A signed funding is always listed, and never as cancelled or
 *     rejected. It is listed as `failed` in one case only: it was proven
 *     unable to confirm (15) and given up. Its reservation is then released,
 *     so `fundingReservation` is gone and its units are back among the
 *     on-chain records.
 *     An open that was cancelled before it signed stays listed until it is
 *     forgotten (14): as `cancelled` when the cancel landed on a negotiated
 *     channel, and as `rejected` or `failed` with `error: 'cancelled'` when
 *     it landed before.
 *  8. peerSupports(peer) is synchronous: whether the connected peer's
 *     features allow an asset channel. False for a peer not connected.
 *  9. quoteFunding({ assets: [{ assetId, amount }], groupKey?,
 *     fundingSatoshis, feeRate }) resolves to { feeSatoshis, vsize,
 *     reserveSatoshis }. An estimate: nothing is selected, reserved or
 *     written.
 * 10. openChannel({ peer, pendingChannelId, assets, groupKey?,
 *     decimalDisplay?, fundingSatoshis, pushMsat?, feeRate, maxFee?,
 *     timeoutMs? }) resolves to { pendingChannelId, channelId } once the
 *     engine holds the signed funding transaction and is publishing it.
 *     Given the id and terms of a flow it already has, it carries that flow
 *     on and opens nothing second. `maxFee` is the most the funding
 *     transaction may pay in sats: one that would pay more is refused with
 *     FEE_BOUND before anything is signed. `timeoutMs` is how long each
 *     step waits for the peer (two minutes when left out, which the host
 *     leaves as it is). An open that fails before the wallet signed is
 *     cancelled by the library and its inputs released, and its id is
 *     spent: the host opens again under a new id. After signing nothing is
 *     released. It rejects with CANCELLED (11), FEE_BOUND,
 *     FUNDING_REJECTED, or TIMEOUT, after which the flow is kept.
 * 11. cancelChannel(pendingChannelId) resolves to true when nothing is left
 *     of the open and what it had set aside is released, also for an id it
 *     never had, and to false once the funding transaction is signed. An
 *     openChannel still running under the id stops at its next step and
 *     rejects with CANCELLED. When the signature wins the race, the cancel
 *     answers false and the open rejects with what really failed, if
 *     anything did. The host does not lean on any of that alone: it
 *     believes a true only once no openChannel call of its own is out for
 *     the id (lightning.js giveUp).
 * 12. closeChannel({ channelId, force? }) resolves once the engine has been
 *     asked to close. The payout goes to keys of this wallet that the
 *     service derives itself. It refuses with UNKNOWN_CHANNEL for a channel
 *     the engine does not hold, and with CHANNEL when the engine will not
 *     close it.
 * 13. resume() carries unfinished opens on, publishes again a signed
 *     funding that has not confirmed, confirms the ones that have, and
 *     settles the wallet's own payment records (22). One look, with no timer
 *     left running: the host calls it from its own loop. rebroadcastFunding
 *     and confirmChannel are what it does, and the host calls neither.
 * 14. forgetChannel(id) is synchronous and drops from the list what is over
 *     and the engine does not hold: a closed or lost channel by its channel
 *     id, an open that ended by its pending channel id. False while the
 *     engine holds it, while assets of it are still coming back, and for a
 *     signed funding that may still confirm.
 * 15. resume() also ends a signed funding that is proven unable to confirm:
 *     an input of it spent by another transaction that is buried
 *     `confirmationDepth` deep. Its reservation is released, it is listed as
 *     `failed` with the reason in `error`, and one channel event says so.
 *     The host reads it from the list on every pass, so an event that never
 *     came costs nothing.
 * 16. recovery.resume() brings the assets of closed channels back and
 *     resolves to [{ channelId, completed, pending, superseded, errors:
 *     [{ txid?, message }] }], `channelId` being hex, or '' for a failure
 *     of the look as a whole. It never rejects once the service runs.
 *     `errors` holds what went wrong in that look: the host logs each, and
 *     says in its status when a channel's recovery has reported nothing
 *     else for an hour.
 * 17. settleFundingReservations() settles what a funding left reserved in
 *     the on-chain records when its flow is not on record, as after a
 *     restore from a backup. It resolves to [{ reservation,
 *     pendingChannelId, outcome, assets, channelId?, fundingTxid?, change?,
 *     reason? }]. `released`: nothing spent the anchors, and the units are
 *     free again. `moved`: the funding transaction on record spent them,
 *     buried deep enough, so they are marked spent and the units are the
 *     channel's; `change` is what went into that transaction and not into
 *     the channel, and those outputs are not brought back by this call.
 *     `kept`: left reserved, for the `reason` given, which for a funding
 *     seen and not buried yet goes away by itself: the host asks again on
 *     each new block for as long as anything is kept.
 * 18. quoteInvoice({ asset: { assetId } | { groupKey }, amount, peer?,
 *     expirySeconds? }) asks a channel's peer what it gives for `amount`
 *     units and resolves to { quoteId, peer, assetAmount, milliSatoshi,
 *     assetRate: { coefficient, scale }, expiresAt, priced }. `assetRate`
 *     is asset units per bitcoin. `priced` is false for the nominal rate of
 *     a peer that sets no price. `expirySeconds` is how long the quote is
 *     asked to stand (an hour when left out).
 * 19. createInvoice({ quoteId, description?, expirySeconds? }) resolves to
 *     { bolt11, paymentHash, assetAmount, milliSatoshi, expiresAt }. The
 *     invoice lives `expirySeconds`, or as long as the quote when that is
 *     shorter. The host passes the time the quote has left all the same, so
 *     the invoice never outlives the price it was made on.
 * 20. invoices() is synchronous: [{ paymentHash, assetAmount, milliSatoshi,
 *     expiresAt, status, bolt11?, description? }] for every asset invoice
 *     kept, `status` being 'open', 'paid' or 'expired'. `bolt11` and
 *     `description` are there only while the engine keeps the invoice, so
 *     the host keeps its own row of each (`inv/<hash>`).
 * 21. quotePayment({ invoice, asset, amountMsat?, channelId? }) resolves to
 *     { quoteId, paymentHash, peer, channelId, assetAmount, milliSatoshi,
 *     feeMsat, assetRate, expiresAt, priced } and sends nothing.
 *     `amountMsat` is for an invoice that names no amount.
 * 22. payInvoice({ quoteId, maxAssetAmount }) rejects only while nothing has
 *     left the wallet, and only with a code of the exported
 *     ASSET_PAYMENT_REFUSALS, PAYMENT among them for an engine that did not
 *     take the payment. The facade hands that list on as `refusals`, and
 *     the host keeps no copy of it. Once the payment is handed to the
 *     engine the call resolves, to { paymentHash, assetAmount, status,
 *     feeMsat?, failure? }, with `pending` while the end is not known.
 *     payment(paymentHash) is synchronous and returns the same shape, or
 *     undefined for a hash this wallet made no payment under. That record
 *     is the wallet's own and the only word on how a payment ended:
 *       - it is written before the payment is handed over, and taken away
 *         again (or put back to what an earlier try left) when payInvoice
 *         refuses. So a payment with no record was never sent;
 *       - it survives a restart of the daemon;
 *       - `complete` and `failed` do not change again, except that paying a
 *         failed invoice again starts the record over;
 *       - resume() fails a pending record only when the engine has no
 *         payment for it, it is at least a minute old, and the engine holds
 *         the channel with no HTLC of that hash. Its failure then reads
 *         'the payment never left this wallet';
 *       - `failure` is the engine's own text, or 'the payment failed'. The
 *         host shows neither, and words a failure itself (errors.js);
 *       - before `start`, and after `close`, it throws NOT_READY and never
 *         answers undefined for a payment it would know of.
 * 23. paymentLimits() is synchronous: for each asset, [{ assetId? |
 *     groupKey?, maxSend, maxReceive, sendChannelId?, receiveChannelId? }],
 *     the most ONE payment can send and receive, from the best single
 *     NORMAL channel whose peer is connected, less what payments under way
 *     have set aside. A payment is never split across channels, so these
 *     are never sums.
 *
 * Events and errors
 *
 * 24. A rejection carries a string `code`. errors.js words the ones a
 *     caller can act on: ERR_BEIGNET_LN_ and UNSUPPORTED, NOT_READY,
 *     INVALID, PEER_OFFLINE, PEER_UNSUPPORTED, FUNDING_REJECTED, TIMEOUT,
 *     CANCELLED, FEE_BOUND, UNKNOWN_CHANNEL, NO_QUOTE, QUOTE_EXPIRED,
 *     PRICE_BOUND, INSUFFICIENT_OUTBOUND, INSUFFICIENT_INBOUND, BAD_INVOICE,
 *     INVOICE_EXPIRED, AMOUNT_REQUIRED, ALREADY_PAID and PAYMENT. CHANNEL,
 *     FUNDING and RECOVERY carry the library's own account of what went
 *     wrong inside: that goes to the log, and the caller gets a sentence of
 *     the host's. So do the library's own ERR_LIGHTNING_* and ERR_FUNDING_*
 *     codes. The adapter's ERR_BEIGNET_FUNDING, ERR_BEIGNET_WALLET and
 *     ERR_BEIGNET_FEE pass through for the funding transaction, as for a
 *     mint or a send.
 * 25. onEvent receives { type: 'channel', pendingChannelId?, channelId?,
 *     phase?, error? }, { type: 'invoice', paymentHash, status: 'paid',
 *     assetAmount, channelId }, { type: 'payment', paymentHash, status,
 *     assetAmount, channelId, feeMsat?, failure? } and { type: 'recovery',
 *     channelId, status }, each after the change is stored and outside any
 *     storage transaction. A peer that turns an open down after openChannel
 *     ended is a channel event with `error`; a payment's end after
 *     `pending` is a payment event. The host treats each as a reason to
 *     look again and reads the state itself, so an event that is missed
 *     costs time and nothing else.
 *
 * The backup
 *
 * 26. assetLightningBackup(store) is synchronous and returns { version: 1,
 *     rows: [{ key, value }] }: exactly the rows a backup may carry (which
 *     channels there were, the keys their payouts go to, the proofs of what
 *     funded them, the record of each close seen) and nothing that could
 *     sign, publish or settle something: no funding flow, quote, invoice or
 *     payment record.
 * 27. restoreAssetLightningBackup(store, backup) is synchronous, writes
 *     those rows into a store that holds no Lightning row at all, and
 *     refuses with INVALID any other store, a row a backup may not carry
 *     and a row given twice. All of them are written, or none. The wallet
 *     then knows its channels and lists them as not held by the engine. It
 *     can finish bringing home the assets of a cooperative close that was on
 *     record. It cannot run, close or sign for a channel, and it cannot by
 *     itself bring home what was in a channel still open when the backup
 *     was made, or in a force close.
 * 28. Building the host and starting the service write nothing. The store
 *     holds a row only once a channel has been asked for or offered: a
 *     wallet with any row under its prefix is taken to have Lightning
 *     records of its own, and a backup's are then left out
 *     (backup.js, lightning.js refuseImportUnasked).
 *
 * The engine and the adapter
 *
 * 29. The engine reads three members of an extension's attachment, on the
 *     attachment itself: `auxiliaryChannels` (handed to the node as it is,
 *     and kept for the life of that node whatever becomes of the
 *     extension), `fixedOutputFees` (read only beside it) and `bind(node)`
 *     (called once the node exists, in the turn that built it, outside any
 *     storage transaction and before any extension's start; synchronous).
 *     They are handed over on every path, including one whose routes only
 *     refuse. The daemon refuses to boot with ASSET_PROVIDER_REQUIRED when
 *     it holds an asset channel and no attachment brought a provider. Its
 *     own GET /channels rows carry `auxiliary: true` on an asset channel
 *     and no such key otherwise (engine issue 2093, steps 11 and 12).
 * 30. node.connectPeer(pubkey, host, port) resolves once the peer is
 *     connected, also when it already was.
 * 31. No hook of the provider is called inside an engine storage
 *     transaction: the store is synchronous and a transaction of its own
 *     would then be one inside another.
 * 32. The adapter's chain can say what spent an outpoint (`spender`).
 *     Without it no signed funding is ever proven unable to confirm (15),
 *     and every reservation of 17 is kept.
 */

// What a new asset channel is funded with, and the bitcoin each asset
// payment through it travels with.
const CHANNEL_SATS = 100_000;
const CARRIER_SATS = 354;
// The nominal price: one unit of an asset to the sat, as units per bitcoin.
const NOMINAL_RATE = Object.freeze({ coefficient: 100_000_000n, scale: 0 });

// What the engine's fee pool for fixed outputs is given, by chain, in sats.
// On mainnet 25,000 is about 100 sat/vB for the transaction that claims an
// HTLC output with one fee coin beside it (some 250 vB), and the split that
// makes four fee coins (about 235 vB) is paid at 10 sat/vB so it does not
// wait on the transaction that spends from it. The total is a budget the
// pool charges a whole cap at a time and does not give back: about a
// hundred claims on mainnet, and on regtest more than any test closes.
const FIXED_OUTPUT_FEES = Object.freeze({
	mainnet: Object.freeze({ one: 25_000, preparation: 10_000, total: 2_500_000, preparationRate: 10 }),
	testnet: Object.freeze({ one: 10_000, preparation: 10_000, total: 1_000_000, preparationRate: 1 }),
	regtest: Object.freeze({ one: 10_000, preparation: 10_000, total: 100_000_000, preparationRate: 1 })
});

/**
 * What the engine may spend from the wallet on the fees of a channel's
 * fixed outputs. `maxFeeSatoshis` bounds what one such transaction may burn
 * and `maxPreparationFeeSatoshis` what one split into fee coins may pay,
 * and neither passes the wallet's own ceiling for an asset transaction.
 * `maxTotalFeeSatoshis` is the pool's budget for all of them, many
 * transactions' worth, so it is not held to the ceiling for one: held to
 * it, a wallet would run out after a handful of claims and could then not
 * bring an HTLC home.
 */
function fixedOutputFees(cfg) {
	const ceiling = cfg.limits.maxFeeSats;
	const f = FIXED_OUTPUT_FEES[cfg.network] || FIXED_OUTPUT_FEES.testnet;
	return {
		maxFeeSatoshis: BigInt(Math.min(f.one, ceiling)),
		maxTotalFeeSatoshis: BigInt(f.total),
		maxPreparationFeeSatoshis: BigInt(Math.min(f.preparation, ceiling)),
		feeCoinCount: 4,
		preparationFeeRatePerVbyte: f.preparationRate
	};
}

// What the entry has to export for this app to use it.
const ENTRY_FUNCTIONS = ['assetLightningSupport', 'lightningStore', 'createAssetLightningHost', 'assetLightningBackup', 'restoreAssetLightningBackup'];

/**
 * The library's Lightning entry from `modulesDir`, or null when the adapter
 * installed there does not ship one. Throws a sentence when it ships one
 * this app cannot use.
 */
function loadLightning(modulesDir) {
	// The file, as the manager looks for it (engine.js assetChannelsAvailable),
	// so an adapter without the entry is never asked to load anything.
	if (!fs.existsSync(path.join(modulesDir, '@ts-tap', 'beignet', 'dist', 'lightning.js'))) return null;
	let entry;
	try {
		entry = createRequire(path.join(modulesDir, 'noop.js'))('@ts-tap/beignet/lightning');
	} catch (err) {
		throw new Error(`The asset channels package beside the wallet engine could not be loaded (${err.message}).`);
	}
	const ok = !!entry && ENTRY_FUNCTIONS.every((name) => typeof entry[name] === 'function') && Array.isArray(entry.ASSET_PAYMENT_REFUSALS);
	if (!ok) throw new Error('The asset channels package beside the wallet engine is not a version this app was built for.');
	return entry;
}

const asHex = (value) => (typeof value === 'string' ? value.toLowerCase() : hex(value));
const millis = (seconds) => Number(seconds) * 1000;
const whole = (value) => (value === undefined || value === null ? null : Number(value));
const specifier = ({ assetId, groupKey }) => (groupKey ? { groupKey: unhex(groupKey) } : { assetId: unhex(assetId) });
const inUnits = (list) => list.map((a) => ({ assetId: unhex(a.assetId), amount: BigInt(a.amount) }));
const outUnits = (list) => (list || []).map((a) => ({ assetId: asHex(a.assetId), amount: BigInt(a.amount || 0) }));
const rateOf = (r) => ({ coefficient: BigInt(r.coefficient), scale: Number(r.scale) || 0 });
const notReady = () => Object.assign(new Error('ERR_BEIGNET_LN_NOT_READY: asset channels have not started'), { code: 'ERR_BEIGNET_LN_NOT_READY' });

/*
 * WHAT THE LIBRARY IS ABOUT TO CHANGE
 *
 * Seven things its author has said will change. Each is read in one place
 * here, a function that today answers what the library at 2df9663 can
 * answer, so that the change is that function and the host rule that reads
 * what it returns. None of them is built yet.
 *
 *  S1 openIsFinal(c)        `signed` will mean that the peer has signed
 *                           this wallet's first commitment, so the open can
 *                           no longer be cancelled. Until then an open is
 *                           cancellable and its reservation released, also
 *                           when the funding transaction was signed here.
 *                           The host's rule "a signed funding is a channel
 *                           in being" reads this flag and nothing else.
 *  S2 paymentLost(p)        a pending payment may say that the engine no
 *                           longer has a record of it. The host is to keep
 *                           its row pending, say so in a sentence, and
 *                           never pay that invoice again.
 *  S3 attemptOf(p)          every try at a payment gets an id, and how a
 *                           payment ended is matched to the try.
 *  S4 receivedOf(i)         an invoice will say what was received beside
 *                           what was invoiced. The host is to store and
 *                           show what was received.
 *  S5 quoteInvoice          can refuse a rate too coarse to invoice the
 *                           amount, with a code of its own. The code gets
 *                           its sentence in errors.js LIGHTNING_REFUSALS.
 *                           Until then it reads as any refusal the host has
 *                           no words for.
 *  S6 reclaimFunding(id)    a call that spends the inputs of a funding that
 *                           will not confirm back to the wallet. It needs a
 *                           route of the host's.
 *  S7 plainReservation(r)   after a restore, settleFundingReservations will
 *                           bring a funding's change back as well, and keep
 *                           a reservation whose funding may still confirm.
 *                           The host's note of change that did not come
 *                           back (lightning.js settleReservations, the rows
 *                           l-change/<id>) goes when it does.
 */

/** S1. Whether an open has passed the point where it can be cancelled. */
const openIsFinal = (c) => !!c.signed;

/** S2. Whether the engine has lost its record of a payment the library still holds as pending. The library does not say yet. */
const paymentLost = () => false;

/** S3. The id of the try at a payment that a record speaks of. The library names none yet. */
const attemptOf = () => null;

/** S4. The units an invoice brought in, or null when the library says only what was invoiced. */
const receivedOf = () => null;

/** One entry of the service's list, in plain values. */
function plainChannel(c) {
	const assets = outUnits(c.assets);
	const phase = String(c.phase || '');
	const state = c.state ? String(c.state) : null;
	return {
		pendingChannelId: asHex(c.pendingChannelId),
		channelId: c.channelId ? asHex(c.channelId) : null,
		peerPubkey: asHex(c.peer),
		initiator: !!c.initiator,
		phase,
		// Whether the node holds it. A word this host has not met is read by
		// whether the engine names a state for the channel.
		engine: ['held', 'absent', 'missing'].includes(c.engine) ? c.engine : state ? 'held' : 'absent',
		signed: openIsFinal(c),
		committed: !!c.committed,
		confirmed: !!c.confirmed,
		fundingTxid: c.fundingTxid ? String(c.fundingTxid) : null,
		state,
		// A channel of several issuances is named by the first.
		assetId: assets.length ? assets[0].assetId : null,
		groupKey: c.groupKey ? asHex(c.groupKey) : null,
		assets,
		local: BigInt(c.localAssetBalance || 0),
		remote: BigInt(c.remoteAssetBalance || 0),
		reserved: BigInt(c.reserved || 0),
		fundingSats: Number(c.fundingSatoshis || 0),
		reserveSats: whole(c.reserveSatoshis),
		// The name its funding inputs still sit under in the on-chain
		// records, and what they hold, until the funding has confirmed.
		fundingReservation: c.fundingReservation ? String(c.fundingReservation) : null,
		fundingInputs: outUnits(c.fundingInputs),
		// Anything but a plain 'none' or 'complete' is a recovery still to be
		// done: a word this host has not met must never read as "nothing owed".
		recovery: c.recovery === 'none' || c.recovery === 'complete' ? c.recovery : 'pending',
		// An open this wallet gave up, however far it had got: listed as
		// `cancelled`, or as turned down or failed with that for a reason.
		cancelled: phase === 'cancelled' || ((phase === 'rejected' || phase === 'failed') && c.error === 'cancelled'),
		// The library's own account. For the log, and for nobody else.
		error: c.error ? String(c.error) : null
	};
}

const plainPayment = (p) => ({
	paymentHash: p.paymentHash ? asHex(p.paymentHash) : null,
	assetAmount: p.assetAmount === undefined || p.assetAmount === null ? null : BigInt(p.assetAmount),
	status: p.status === 'complete' || p.status === 'failed' ? p.status : 'pending',
	feeMsat: p.feeMsat === undefined || p.feeMsat === null ? null : BigInt(p.feeMsat),
	failure: p.failure ? String(p.failure) : null,
	attempt: attemptOf(p),
	lost: paymentLost(p)
});

const plainInvoice = (i) => ({
	paymentHash: asHex(i.paymentHash),
	assetAmount: BigInt(i.assetAmount),
	received: receivedOf(i),
	// A status this host has no word for is an open invoice until it is paid or expired.
	status: i.status === 'paid' || i.status === 'expired' ? i.status : 'open'
});

/** S7. One report of what became of a funding's reservation, in plain values. */
const plainReservation = (r) => ({
	reservation: String(r.reservation || ''),
	pendingChannelId: r.pendingChannelId ? asHex(r.pendingChannelId) : null,
	// Anything but a plain word that it is settled is one to ask about again.
	outcome: r.outcome === 'released' || r.outcome === 'moved' ? r.outcome : 'kept',
	assets: outUnits(r.assets),
	channelId: r.channelId ? asHex(r.channelId) : null,
	fundingTxid: r.fundingTxid ? String(r.fundingTxid) : null,
	// Units that went into the funding transaction and not into the channel.
	change: outUnits(r.change),
	reason: r.reason ? String(r.reason) : null
});

function plainEvent(e) {
	const out = { type: String((e && e.type) || '') };
	for (const name of ['pendingChannelId', 'channelId', 'paymentHash']) if (e && e[name]) out[name] = asHex(e[name]);
	for (const name of ['phase', 'status', 'failure', 'error']) if (e && e[name] !== undefined) out[name] = e[name];
	return out;
}

/**
 * The Lightning side of this wallet's assets, or null when there is none to
 * have: no entry beside the engine, or an engine that cannot carry asset
 * channels.
 *
 * Built at attach, before the wallet's chain is known and whatever else is
 * wrong with the host, because the engine has to be handed `attachment`
 * whenever it might hold an asset channel. `start` comes later, once the
 * adapter exists, and the service itself starts once the engine has bound
 * its node as well. Until then `ready()` is false and everything that asks
 * the service throws NOT_READY. `now`, when given, is the host's clock in
 * milliseconds.
 *
 *   attachment                 what the engine is handed: the library's
 *                                own, with the node noted on its way through
 *   start(options)             { adapter, lib, quiet, confirmations,
 *                                fetchProof, acceptIncoming, onEvent,
 *                                onError, onStartError }. Kept until the
 *                                node is bound, when the service starts. A
 *                                service that will not start is said to
 *                                onStartError, whenever that is.
 *   stop()                     closes the service; the provider stays
 *   close()                    closes everything, for when the node stops
 *   ready()                    whether the node is bound and the service runs
 *   refusals                   the codes payInvoice rejects with, each of
 *                                which means nothing left the wallet
 *
 *   channels()                 [{ pendingChannelId, channelId, peerPubkey,
 *                                initiator, phase, engine, signed, committed,
 *                                confirmed, fundingTxid, state, assetId,
 *                                groupKey, assets, local, remote, reserved,
 *                                fundingSats, reserveSats,
 *                                fundingReservation, fundingInputs,
 *                                recovery, cancelled, error }]
 *   connect({ pubkey, host, port })
 *   peerSupports(pubkey)       boolean
 *   quoteFunding({ assets, groupKey, fundingSats, feeRate })
 *                              -> { feeSats, vbytes, reserveSats }
 *   openChannel({ pendingChannelId, peerPubkey, assets, groupKey,
 *                 decimalDisplay, fundingSats, pushSats, feeRate,
 *                 maxFeeSats })
 *                              -> { channelId }
 *   cancelFlow(pendingChannelId)  -> boolean, true when nothing is left of it
 *   closeChannel({ channelId, force })
 *   forgetChannel(id)          -> boolean, true when it is off the list
 *
 *   quoteInvoice({ assetId, groupKey, amount, peerPubkey, expirySeconds })
 *                              -> { quoteId, peerPubkey, assetAmount,
 *                                   amountMsat, unitsPerBtc, expiresAt,
 *                                   priced }
 *   createInvoice({ quoteId, description, expirySeconds })
 *                              -> { bolt11, paymentHash, assetAmount,
 *                                   amountMsat, expiresAt }
 *   invoices()                 [{ paymentHash, assetAmount, received,
 *                                status }], received being null until the
 *                                library says it (S4)
 *
 *   quotePayment({ bolt11, assetId, groupKey, amountMsat })
 *                              -> { quoteId, paymentHash, peerPubkey,
 *                                   channelId, assetAmount, amountMsat,
 *                                   feeMsat, unitsPerBtc, expiresAt, priced }
 *   payInvoice({ quoteId, maxAssetAmount })
 *                              -> { paymentHash, assetAmount, status,
 *                                   feeMsat, failure }
 *   payment(paymentHash)       the same shape, or null. Both carry `attempt`
 *                                and `lost` as well (S2, S3), null and false
 *                                until the library says them
 *   paymentLimits()            [{ assetId, groupKey, maxSend, maxReceive,
 *                                sendChannelId, receiveChannelId }]: the
 *                                most one payment can move of each asset
 *
 *   resume()                   carries opens on and confirms channels
 *   resumeRecovery()           -> [{ channelId, completed, pending, errors }]
 *   settleFundingReservations()
 *                              -> [{ reservation, pendingChannelId, outcome,
 *                                   assets, channelId, fundingTxid, change,
 *                                   reason }]
 *   reclaimFunding(id)         refuses: the library has no such call yet (S6)
 *
 *   backup()                   the rows a backup may carry, as the library
 *                                gives them: { version, rows }
 *   restore(backup)            -> how many rows were written, into a store
 *                                that held none
 *
 * `assets` and `change` are [{ assetId, amount }]. `unitsPerBtc` is
 * { coefficient, scale }. The events `onEvent` is given are { type,
 * pendingChannelId?, channelId?, paymentHash?, phase?, status?, failure?,
 * error? }, type being 'channel', 'invoice', 'payment' or 'recovery'.
 */
function createLightning({ entry, storage, cfg, now = null }) {
	if (!entry) return null;
	const support = entry.assetLightningSupport();
	if (!support || support.supported !== true) return null;
	const { backend, prefix } = lightningBackend(storage);
	const store = entry.lightningStore(backend, prefix);
	const seconds = typeof now === 'function' ? () => BigInt(Math.floor(now() / 1000)) : null;
	// Where the library says what went wrong when nobody was waiting. The
	// host names the place once it has one.
	let report = () => undefined;
	const onError = (err) => {
		try {
			report(err);
		} catch (_) {
			/* a host that cannot be told is stopping */
		}
	};
	const made = entry.createAssetLightningHost({ store, hrp: cfg.hrp, fixedOutputFees: fixedOutputFees(cfg), ...(seconds ? { now: seconds } : {}), onError });
	let node = null;
	let service = null;
	// What `start` was given, until the node is there to start over.
	let wanted = null;
	const live = () => {
		if (!node || !service) throw notReady();
		return service;
	};
	const begin = () => {
		if (!node || !wanted || service) return;
		const { adapter, options, failed } = wanted;
		try {
			service = made.start(adapter, options);
		} catch (err) {
			wanted = null;
			if (typeof failed !== 'function') throw err;
			failed(err);
		}
	};
	const stop = () => {
		const closing = service;
		service = null;
		wanted = null;
		if (!closing) return;
		try {
			const done = closing.close();
			if (done && typeof done.catch === 'function') done.catch(() => undefined);
		} catch (_) {
			/* a service that will not close is being left behind anyway */
		}
	};
	return {
		attachment: {
			...made.attachment,
			bind(bound) {
				made.attachment.bind(bound);
				node = bound;
				begin();
			}
		},
		start({ adapter, lib, quiet = false, confirmations, fetchProof, acceptIncoming, onEvent, onError: said, onStartError }) {
			if (typeof said === 'function') report = said;
			const options = {
				fetchProvenance: async (p) => lib.decodeProofFile(await fetchProof(lib.proofLocator(p))),
				acceptIncoming: (p) =>
					acceptIncoming({
						pendingChannelId: asHex(p.pendingChannelId),
						peerPubkey: asHex(p.peer),
						assets: outUnits(p.assets),
						groupKey: p.groupKey ? asHex(p.groupKey) : null
					}),
				onEvent: (e) => {
					try {
						onEvent(plainEvent(e));
					} catch (_) {
						/* the host looks again on its own */
					}
				},
				onError,
				...(Number.isInteger(confirmations) && confirmations > 0 ? { confirmationDepth: confirmations } : {}),
				...(seconds ? { now: seconds } : {})
			};
			// A wallet whose Lightning side is off gives nobody a price.
			if (quiet) {
				options.price = () => {
					throw new Error('This wallet is not taking asset payments.');
				};
			}
			wanted = { adapter, options, failed: onStartError };
			begin();
		},
		stop,
		close() {
			stop();
			node = null;
			try {
				made.close();
			} catch (_) {
				/* it is being left behind either way */
			}
		},
		ready: () => !!node && !!service,
		refusals: Object.freeze(entry.ASSET_PAYMENT_REFUSALS.map(String)),

		channels: () => live().channels().map(plainChannel),
		async connect({ pubkey, host, port }) {
			live();
			await node.connectPeer(pubkey, host, port);
		},
		peerSupports: (pubkey) => !!live().peerSupports(unhex(pubkey)),
		async quoteFunding({ assets, groupKey, fundingSats, feeRate }) {
			const q = await live().quoteFunding({
				assets: inUnits(assets),
				...(groupKey ? { groupKey: unhex(groupKey) } : {}),
				fundingSatoshis: BigInt(fundingSats),
				feeRate
			});
			return { feeSats: Number(q.feeSatoshis), vbytes: whole(q.vsize), reserveSats: whole(q.reserveSatoshis) };
		},
		async openChannel({ pendingChannelId, peerPubkey, assets, groupKey, decimalDisplay, fundingSats, pushSats, feeRate, maxFeeSats }) {
			const opened = await live().openChannel({
				peer: unhex(peerPubkey),
				assets: inUnits(assets),
				...(groupKey ? { groupKey: unhex(groupKey) } : {}),
				...(Number.isInteger(decimalDisplay) ? { decimalDisplay } : {}),
				fundingSatoshis: BigInt(fundingSats),
				pushMsat: BigInt(pushSats) * 1000n,
				feeRate,
				// Refused by the library before anything is signed when the
				// funding transaction it builds would pay more.
				...(Number.isInteger(maxFeeSats) ? { maxFee: BigInt(maxFeeSats) } : {}),
				pendingChannelId: unhex(pendingChannelId)
			});
			return { channelId: asHex(opened.channelId) };
		},
		cancelFlow: async (pendingChannelId) => !!(await live().cancelChannel(unhex(pendingChannelId))),
		async closeChannel({ channelId, force }) {
			await live().closeChannel({ channelId: unhex(channelId), force: !!force });
		},
		forgetChannel: (id) => !!live().forgetChannel(unhex(id)),

		// S5. A rate too coarse for the amount will be refused here, with a code of its own.
		async quoteInvoice({ assetId, groupKey, amount, peerPubkey, expirySeconds }) {
			const q = await live().quoteInvoice({
				asset: specifier({ assetId, groupKey }),
				amount: BigInt(amount),
				...(peerPubkey ? { peer: unhex(peerPubkey) } : {}),
				...(Number.isInteger(expirySeconds) && expirySeconds > 0 ? { expirySeconds } : {})
			});
			return {
				quoteId: asHex(q.quoteId),
				peerPubkey: asHex(q.peer),
				assetAmount: BigInt(q.assetAmount),
				amountMsat: BigInt(q.milliSatoshi),
				unitsPerBtc: rateOf(q.assetRate),
				expiresAt: millis(q.expiresAt),
				priced: !!q.priced
			};
		},
		async createInvoice({ quoteId, description, expirySeconds }) {
			const invoice = await live().createInvoice({ quoteId: unhex(quoteId), ...(description ? { description } : {}), expirySeconds });
			return {
				bolt11: String(invoice.bolt11),
				paymentHash: asHex(invoice.paymentHash),
				assetAmount: BigInt(invoice.assetAmount),
				amountMsat: BigInt(invoice.milliSatoshi),
				expiresAt: millis(invoice.expiresAt)
			};
		},
		invoices: () => live().invoices().map(plainInvoice),

		async quotePayment({ bolt11, assetId, groupKey, amountMsat }) {
			const q = await live().quotePayment({
				invoice: bolt11,
				asset: specifier({ assetId, groupKey }),
				...(amountMsat === undefined || amountMsat === null ? {} : { amountMsat: BigInt(amountMsat) })
			});
			return {
				quoteId: asHex(q.quoteId),
				paymentHash: asHex(q.paymentHash),
				peerPubkey: asHex(q.peer),
				channelId: asHex(q.channelId),
				assetAmount: BigInt(q.assetAmount),
				amountMsat: BigInt(q.milliSatoshi),
				feeMsat: q.feeMsat === undefined || q.feeMsat === null ? null : BigInt(q.feeMsat),
				unitsPerBtc: rateOf(q.assetRate),
				expiresAt: millis(q.expiresAt),
				priced: !!q.priced
			};
		},
		payInvoice: async ({ quoteId, maxAssetAmount }) => plainPayment(await live().payInvoice({ quoteId: unhex(quoteId), maxAssetAmount: BigInt(maxAssetAmount) })),
		payment(paymentHash) {
			const p = live().payment(unhex(paymentHash));
			return p ? plainPayment(p) : null;
		},
		paymentLimits: () =>
			live()
				.paymentLimits()
				.map((l) => ({
					assetId: l.assetId ? asHex(l.assetId) : null,
					groupKey: l.groupKey ? asHex(l.groupKey) : null,
					maxSend: BigInt(l.maxSend || 0),
					maxReceive: BigInt(l.maxReceive || 0),
					sendChannelId: l.sendChannelId ? asHex(l.sendChannelId) : null,
					receiveChannelId: l.receiveChannelId ? asHex(l.receiveChannelId) : null
				})),

		async resume() {
			await live().resume();
		},
		async resumeRecovery() {
			const reports = (await live().recovery.resume()) || [];
			return reports.map((r) => ({
				channelId: r.channelId ? asHex(r.channelId) : '',
				completed: (r.completed || []).length,
				pending: (r.pending || []).length,
				errors: (r.errors || []).map((e) => String((e && e.message) || e))
			}));
		},
		settleFundingReservations: async () => ((await live().settleFundingReservations()) || []).map(plainReservation),
		// S6. The way out of an open whose funding never confirms. The library
		// ships no call for it yet, so nothing in the host asks for it.
		async reclaimFunding() {
			live();
			throw Object.assign(new Error('ERR_BEIGNET_LN_UNSUPPORTED: the funding of a channel cannot be taken back yet'), { code: 'ERR_BEIGNET_LN_UNSUPPORTED' });
		},

		// Over the store alone: neither needs the service, or a node.
		backup: () => entry.assetLightningBackup(store),
		restore: (backup) => Number(entry.restoreAssetLightningBackup(store, backup, seconds ? { now: seconds } : {}))
	};
}

module.exports = {
	STATES,
	TAP_KEY_FAMILY,
	ANCHOR_SATS,
	CHANNEL_SATS,
	CARRIER_SATS,
	NOMINAL_RATE,
	loadLibrary,
	createLib,
	buildAdapter,
	loadLightning,
	createLightning,
	fixedOutputFees,
	hex,
	unhex
};
