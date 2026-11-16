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
 * milliseconds), so a test replaces it whole (test-fakes.js `fakeLightning`).
 *
 * WHAT THIS SECTION ASSUMES OF THE ENTRY AND OF THE ENGINE
 *
 * Nothing below has run against a real entry: it was written before one
 * existed, to this list. A name or a shape that turns out different is
 * changed here and nowhere else in the host.
 *
 * The entry's exports
 *
 *  1. assetLightningSupport() returns { supported: boolean, missing: string[] }.
 *     Synchronous, never throws, and touches nothing an engine without
 *     auxiliary channels lacks.
 *  2. lightningStore(backend, prefix) returns the store the host is built
 *     over. `backend` is the engine's IExtensionStorage as it is (get, set,
 *     delete, list, transaction, all synchronous). Every key the store
 *     writes starts with `prefix` and is at most 512 characters. It never
 *     opens a transaction inside another.
 *  3. createAssetLightningHost({ store, hrp, fixedOutputFees }) returns
 *     { attachment, start }. Synchronous. It needs no adapter and no node,
 *     so it can be called before the wallet's chain is known.
 *  4. `attachment` is { auxiliaryChannels, fixedOutputFees, bind(node) }.
 *     `fixedOutputFees` is the object createAssetLightningHost was given.
 *     The engine calls bind(node) once it has built its node. Every hook
 *     that needs the adapter fails closed until `start` has run.
 *  5. start(adapter, options) returns the service, or a promise of it.
 *     `adapter` is what createBeignetAdapter returned. The options:
 *       fetchProvenance(proof)   a decoded proof in, a promise of its
 *                                decoded proof file out (ts-tap's proof.Proof
 *                                and proof.File)
 *       acceptIncoming(p)        p is { pendingChannelId: Buffer, peer:
 *                                Buffer, assets: [{ assetId: Buffer, amount:
 *                                bigint }], groupKey?: Buffer }; a promise
 *                                of true takes the channel
 *       forwarding               false: this wallet routes for nobody
 *       onEvent(event)           see 20; called outside any storage
 *                                transaction, its return ignored
 *       price                    left out, the service prices as a plain
 *                                wallet does: it answers a request only from
 *                                a peer it has a NORMAL asset channel with,
 *                                for that channel's asset, at one unit a sat
 *                                ({ coefficient: 100000000n, scale: 0 }).
 *                                Given, it is asked instead, and a throw
 *                                refuses the request.
 *
 * The service. Ids, keys and hashes are Buffers, amounts of an asset and
 * millisatoshis are bigint, sats are bigint, and a time is unix seconds as a
 * number or a bigint.
 *
 *  6. channels() is synchronous and lists every asset channel and every
 *     unfinished open, whichever side began it:
 *       { pendingChannelId, channelId?, peer, initiator, phase, signed,
 *         confirmed, state?, fundingSatoshis, reserveSatoshis?,
 *         assets: [{ assetId, local, remote }], groupKey?, reserved,
 *         recovery }
 *     `phase` is the funding phase (accepted, negotiated, funding-created,
 *     committed, broadcasting, broadcast, active, rejected, failed).
 *     `signed` says the funding transaction has been signed, which is when
 *     cancelChannel starts to refuse. `confirmed` says confirmChannel has
 *     completed. `state` is the engine's ChannelState word, absent until the
 *     engine has the channel. `reserveSatoshis` is what the peer has to keep
 *     on its side. `reserved` is the local units live quotes and payments
 *     hold. A flow whose funding transaction is signed is always listed,
 *     with `signed` true, whatever became of its negotiation: its inputs
 *     have left the wallet's on-chain records, and it may confirm.
 *     `recovery` is 'none' while the channel is open, 'pending' from
 *     its close until every asset of this wallet's is back in its on-chain
 *     records, then 'complete'. A closed channel never says 'none': the
 *     host takes a closed channel to be over only on 'complete', and reads
 *     any other word as a recovery still to be done. `local` and `remote`
 *     of a closed channel are its last balances. A closed channel stays
 *     listed while its rows are kept.
 *  7. peerSupports(peer) is synchronous: whether the connected peer's
 *     features allow an asset channel. False for a peer not connected.
 *  8. quoteFunding({ assets: [{ assetId, amount }], groupKey?,
 *     fundingSatoshis, feeRate }) resolves to { feeSatoshis, vsize,
 *     reserveSatoshis? } and reserves and writes nothing.
 *  9. openChannel({ peer, assets, groupKey?, decimalDisplay?,
 *     fundingSatoshis, pushMsat, feeRate, maxFee, pendingChannelId })
 *     resolves to { pendingChannelId, channelId } once the funding
 *     transaction is on its way. Given the id of a flow it already has, it
 *     carries that flow on and opens nothing second. `maxFee` is the most
 *     the funding transaction may pay in sats: one that would pay more is
 *     refused with FEE_BOUND before anything is signed. quoteFunding is an
 *     estimate, so this is the bound that holds.
 * 10. cancelChannel(pendingChannelId) resolves to true when the flow is gone
 *     and what it had set aside is released (also for an id it never had),
 *     and to false once the funding transaction is signed. An openChannel
 *     still running under the id then rejects with CANCELLED and signs
 *     nothing. The host does not lean on that alone: it believes a true
 *     only once no openChannel call of its own is out for the id
 *     (lightning.js giveUp).
 * 11. closeChannel({ channelId, force }) resolves once the engine has been
 *     asked to close. The payout goes to keys of this wallet that the
 *     service derives itself.
 * 12. resume() carries unfinished opens on and confirms channels whose
 *     funding has confirmed. recovery.resume() brings the assets of closed
 *     channels back and resolves to [{ channelId, completed: [], pending:
 *     [], superseded: [], errors: [{ txid?, message }] }]. Each is one look
 *     at the chain with no timer left running; the host calls both from its
 *     own loop and never calls watch(). `errors` holds what went wrong in
 *     that look and is empty for a job that is only waiting: the host logs
 *     each, and says in its status when a channel's recovery has reported
 *     nothing else for an hour.
 * 13. quoteInvoice({ asset: { assetId } | { groupKey }, amount, peer? })
 *     asks a channel's peer what it gives for `amount` units and resolves
 *     to { quoteId, peer, assetAmount, milliSatoshi, assetRate: {
 *     coefficient, scale }, expiresAt }. `assetRate` is asset units per
 *     bitcoin, as in the price messages.
 * 14. createInvoice({ quoteId, description?, expirySeconds }) resolves to
 *     { bolt11, paymentHash, assetAmount, milliSatoshi, expiresAt }. The
 *     host passes the time the quote has left as `expirySeconds`, so the
 *     invoice never outlives the price it was made on.
 * 15. invoices() is synchronous: [{ paymentHash, assetAmount, status }] for
 *     every asset invoice kept, `status` being 'open', 'paid' or 'expired'.
 * 16. quotePayment({ invoice, asset, amountMsat? }) resolves to { quoteId,
 *     paymentHash, peer, channelId, assetAmount, milliSatoshi, assetRate,
 *     expiresAt } and sends nothing. `amountMsat` is for an invoice that
 *     names no amount.
 * 17. payInvoice({ quoteId, maxAssetAmount }) resolves to { paymentHash,
 *     assetAmount, status, feeMsat?, failure? } once the payment is in the
 *     engine's hands, `status` being 'pending', 'complete' or 'failed'. It
 *     rejects before anything is sent when paying would take more than
 *     `maxAssetAmount` units. The host reads nothing from what it resolves
 *     to but that the payment was taken: how it ended is read from 18.
 *     A rejection with one of these codes is raised before any HTLC leaves
 *     the wallet, and means nothing was sent (errors.js PAY_NOTHING_SENT):
 *     NOT_READY, NO_QUOTE, QUOTE_EXPIRED, PRICE_BOUND,
 *     INSUFFICIENT_OUTBOUND, BAD_INVOICE, INVOICE_EXPIRED, AMOUNT_REQUIRED
 *     and ALREADY_PAID. Any other rejection, TIMEOUT and PEER_OFFLINE among
 *     them, may come after the engine has the payment, and says nothing
 *     about whether it was sent.
 * 18. payment(paymentHash) is synchronous: the same shape for a payment the
 *     engine has a record of, or undefined. This record is the only word on
 *     how a payment ended, so the host needs of it:
 *       - it exists before the first HTLC of the payment leaves, and at the
 *         latest when payInvoice settles, whichever way it settles. So a
 *         payment with no record, that no payInvoice call is still working
 *         on, was never sent;
 *       - it survives a restart of the daemon, and after one it still says
 *         'pending' for a payment that is in flight;
 *       - `failure` of a failed payment is one of the words no_route,
 *         timeout, rejected, expired and insufficient_balance. Any other
 *         text is logged and shown to nobody (errors.js PAYMENT_FAILURES);
 *       - before `start`, and after `close`, it throws NOT_READY and never
 *         answers undefined for a payment it would know of.
 * 19. close() stops the service. The host does not wait for what it returns.
 * 19a. paymentLimits() is synchronous: for each asset, [{ assetId? |
 *     groupKey?, maxSend, maxReceive, sendChannelId?, receiveChannelId? }],
 *     the most ONE payment can send and receive, from the best single
 *     usable channel whose peer is connected. A payment is never split
 *     across channels, so these are never sums.
 *
 * Events and errors
 *
 * 20. onEvent receives { type: 'channel', pendingChannelId, channelId?,
 *     phase? }, { type: 'invoice', paymentHash, status: 'paid',
 *     assetAmount }, { type: 'payment', paymentHash, status, feeMsat?,
 *     failure? } and { type: 'recovery', channelId, status }. The host
 *     treats each as a reason to look again and reads the state itself, so
 *     an event that is missed costs time and nothing else. An event is
 *     sent when something changed, never for a look that found nothing new:
 *     the host looks again after each one, and resume() is part of a look.
 * 21. A rejection carries a string `code` (errors.js maps these):
 *       ERR_BEIGNET_LN_NOT_READY             before bind and start
 *       ERR_BEIGNET_LN_PEER_OFFLINE          the peer is not connected
 *       ERR_BEIGNET_LN_PEER_UNSUPPORTED      its features allow no asset channel
 *       ERR_BEIGNET_LN_FUNDING_REJECTED      it turned the channel down
 *       ERR_BEIGNET_LN_TIMEOUT               no answer in time; the flow is kept
 *       ERR_BEIGNET_LN_CANCELLED             the open was given up, unsigned
 *       ERR_BEIGNET_LN_FEE_BOUND             the funding would pay more than maxFee
 *       ERR_BEIGNET_LN_UNKNOWN_CHANNEL       no channel with that id
 *       ERR_BEIGNET_LN_NO_QUOTE              the peer gave no price
 *       ERR_BEIGNET_LN_QUOTE_EXPIRED         the quote is used up or too old
 *       ERR_BEIGNET_LN_PRICE_BOUND           the price is past the bound given
 *       ERR_BEIGNET_LN_INSUFFICIENT_OUTBOUND no channel can send that much
 *       ERR_BEIGNET_LN_INSUFFICIENT_INBOUND  no channel can receive that much
 *       ERR_BEIGNET_LN_BAD_INVOICE           the invoice cannot be read
 *       ERR_BEIGNET_LN_INVOICE_EXPIRED       the invoice is past its time
 *       ERR_BEIGNET_LN_AMOUNT_REQUIRED       it names no amount and none was given
 *       ERR_BEIGNET_LN_ALREADY_PAID          this wallet has paid it
 *     and the adapter's own ERR_BEIGNET_FUNDING, ERR_BEIGNET_WALLET and
 *     ERR_BEIGNET_FEE for the funding transaction, as a mint or a send.
 *
 * The engine
 *
 * 22. An attachment may carry the provider as its `lightning` member, on
 *     every path including one whose routes only refuse, and the daemon
 *     refuses to boot when it holds an asset channel and no attachment
 *     brought one (engine issue 2093, step 12).
 * 23. node.connectPeer(pubkey, host, port) resolves once the peer is
 *     connected, also when it already was.
 * 24. No hook of the provider is called inside an engine storage
 *     transaction: the store is synchronous and a transaction of its own
 *     would then be one inside another.
 *
 * The store
 *
 * 25. Building the host and starting the service write nothing. The store
 *     holds a row only once a channel has been asked for or offered: a
 *     wallet with any row under its prefix is taken to have Lightning
 *     records of its own, and a backup the manager left for it is then not
 *     restored at start (lightning.js refuseImportUnasked).
 * 26. The rows a backup must not carry to another machine are the ones
 *     under `tap/quotes/` and `lightning/invoice/` (backup.js LEFT_OUT), as
 *     on the earlier branch. Every other row is either safe to restore into
 *     a wallet that has none (funding, destination and recovery rows) or is
 *     ignored by a node that does not hold the channel it describes.
 */

// What a new asset channel is funded with, and the bitcoin each asset
// payment through it travels with.
const CHANNEL_SATS = 100_000;
const CARRIER_SATS = 354;
// The nominal price: one unit of an asset to the sat, as units per bitcoin.
const NOMINAL_RATE = Object.freeze({ coefficient: 100_000_000n, scale: 0 });

/**
 * What the engine may spend from the wallet on the fees of a channel's
 * fixed outputs: for one transaction, for all of them, and for the coins it
 * sets aside to pay with. Neither one transaction nor all of them together
 * pass the wallet's own ceiling for an asset transaction.
 */
function fixedOutputFees(cfg) {
	const ceiling = cfg.limits.maxFeeSats;
	const one = BigInt(Math.min(10_000, ceiling));
	return { maxFeeSatoshis: one, maxTotalFeeSatoshis: BigInt(Math.min(1_000_000, ceiling)), maxPreparationFeeSatoshis: one, feeCoinCount: 4 };
}

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
	const ok = !!entry && ['assetLightningSupport', 'lightningStore', 'createAssetLightningHost'].every((name) => typeof entry[name] === 'function');
	if (!ok) throw new Error('The asset channels package beside the wallet engine is not a version this app was built for.');
	return entry;
}

const asHex = (value) => (typeof value === 'string' ? value.toLowerCase() : hex(value));
const millis = (seconds) => Number(seconds) * 1000;
const whole = (value) => (value === undefined || value === null ? null : Number(value));
const specifier = ({ assetId, groupKey }) => (groupKey ? { groupKey: unhex(groupKey) } : { assetId: unhex(assetId) });
const inUnits = (list) => list.map((a) => ({ assetId: unhex(a.assetId), amount: BigInt(a.amount) }));
const rateOf = (r) => ({ coefficient: BigInt(r.coefficient), scale: Number(r.scale) || 0 });

/** One channel of the service's list, in plain values. A channel of several issuances is one figure a side. */
function plainChannel(c) {
	const assets = c.assets || [];
	const sum = (side) => assets.reduce((total, a) => total + BigInt(a[side] || 0), 0n);
	return {
		pendingChannelId: asHex(c.pendingChannelId),
		channelId: c.channelId ? asHex(c.channelId) : null,
		peerPubkey: asHex(c.peer),
		initiator: !!c.initiator,
		phase: String(c.phase || ''),
		signed: !!c.signed,
		confirmed: !!c.confirmed,
		state: c.state ? String(c.state) : null,
		assetId: assets.length ? asHex(assets[0].assetId) : null,
		groupKey: c.groupKey ? asHex(c.groupKey) : null,
		local: sum('local'),
		remote: sum('remote'),
		reserved: BigInt(c.reserved || 0),
		fundingSats: Number(c.fundingSatoshis || 0),
		reserveSats: whole(c.reserveSatoshis),
		// Anything but a plain 'none' or 'complete' is a recovery still to be
		// done: a word this host has not met must never read as "nothing owed".
		recovery: c.recovery === 'none' || c.recovery === 'complete' ? c.recovery : 'pending'
	};
}

const plainPayment = (p) => ({
	paymentHash: p.paymentHash ? asHex(p.paymentHash) : null,
	assetAmount: p.assetAmount === undefined || p.assetAmount === null ? null : BigInt(p.assetAmount),
	status: p.status === 'complete' || p.status === 'failed' ? p.status : 'pending',
	feeMsat: p.feeMsat === undefined || p.feeMsat === null ? null : BigInt(p.feeMsat),
	failure: p.failure ? String(p.failure) : null
});

function plainEvent(e) {
	const out = { type: String((e && e.type) || '') };
	for (const name of ['pendingChannelId', 'channelId', 'paymentHash']) if (e && e[name]) out[name] = asHex(e[name]);
	for (const name of ['phase', 'status', 'failure']) if (e && e[name] !== undefined) out[name] = e[name];
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
 * adapter exists. Until then, and until the engine has bound its node,
 * `ready()` is false and everything else throws.
 *
 *   attachment                 what the engine is handed, as it is
 *   start(options)             { adapter, lib, quiet, fetchProof,
 *                                acceptIncoming, onEvent }
 *   stop()                     closes the service; waits for nothing
 *   ready()                    whether the node is bound and start has run
 *
 *   channels()                 [{ pendingChannelId, channelId, peerPubkey,
 *                                initiator, phase, signed, confirmed, state,
 *                                assetId, groupKey, local, remote, reserved,
 *                                fundingSats, reserveSats, recovery }]
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
 *
 *   quoteInvoice({ assetId, groupKey, amount, peerPubkey })
 *                              -> { quoteId, peerPubkey, assetAmount,
 *                                   amountMsat, unitsPerBtc, expiresAt }
 *   createInvoice({ quoteId, description, expirySeconds })
 *                              -> { bolt11, paymentHash, assetAmount,
 *                                   amountMsat, expiresAt }
 *   invoices()                 [{ paymentHash, assetAmount, status }]
 *
 *   quotePayment({ bolt11, assetId, groupKey, amountMsat })
 *                              -> { quoteId, paymentHash, peerPubkey,
 *                                   channelId, assetAmount, amountMsat,
 *                                   unitsPerBtc, expiresAt }
 *   payInvoice({ quoteId, maxAssetAmount })
 *                              -> { paymentHash, assetAmount, status,
 *                                   feeMsat, failure }
 *   payment(paymentHash)       the same shape, or null
 *   paymentLimits()            [{ assetId, groupKey, maxSend, maxReceive,
 *                                sendChannelId, receiveChannelId }]: the
 *                                most one payment can move of each asset
 *
 *   resume()                   carries opens on and confirms channels
 *   resumeRecovery()           -> [{ channelId, completed, pending, errors }]
 *
 * `assets` is [{ assetId, amount }]. `unitsPerBtc` is { coefficient, scale }.
 * The events `onEvent` is given are { type, pendingChannelId?, channelId?,
 * paymentHash?, phase?, status?, failure? }, type being 'channel',
 * 'invoice', 'payment' or 'recovery'.
 */
function createLightning({ entry, storage, cfg }) {
	if (!entry) return null;
	const support = entry.assetLightningSupport();
	if (!support || support.supported !== true) return null;
	const { backend, prefix } = lightningBackend(storage);
	const made = entry.createAssetLightningHost({ store: entry.lightningStore(backend, prefix), hrp: cfg.hrp, fixedOutputFees: fixedOutputFees(cfg) });
	let node = null;
	let service = null;
	const live = () => {
		if (!node || !service) throw Object.assign(new Error('ERR_BEIGNET_LN_NOT_READY: asset channels have not started'), { code: 'ERR_BEIGNET_LN_NOT_READY' });
		return service;
	};
	return {
		attachment: {
			...made.attachment,
			bind(bound) {
				node = bound;
				return made.attachment.bind(bound);
			}
		},
		async start({ adapter, lib, quiet = false, fetchProof, acceptIncoming, onEvent }) {
			const options = {
				fetchProvenance: async (p) => lib.decodeProofFile(await fetchProof(lib.proofLocator(p))),
				acceptIncoming: (p) =>
					acceptIncoming({
						pendingChannelId: asHex(p.pendingChannelId),
						peerPubkey: asHex(p.peer),
						assets: (p.assets || []).map((a) => ({ assetId: asHex(a.assetId), amount: BigInt(a.amount) })),
						groupKey: p.groupKey ? asHex(p.groupKey) : null
					}),
				forwarding: false,
				onEvent: (e) => {
					try {
						onEvent(plainEvent(e));
					} catch (_) {
						/* the host looks again on its own */
					}
				}
			};
			// A wallet whose Lightning side is off gives nobody a price.
			if (quiet) {
				options.price = () => {
					throw new Error('This wallet is not taking asset payments.');
				};
			}
			service = await made.start(adapter, options);
		},
		stop() {
			const closing = service;
			service = null;
			if (!closing) return;
			try {
				const done = closing.close();
				if (done && typeof done.catch === 'function') done.catch(() => undefined);
			} catch (_) {
				/* a service that will not close is being left behind anyway */
			}
		},
		ready: () => !!node && !!service,

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

		async quoteInvoice({ assetId, groupKey, amount, peerPubkey }) {
			const q = await live().quoteInvoice({ asset: specifier({ assetId, groupKey }), amount: BigInt(amount), ...(peerPubkey ? { peer: unhex(peerPubkey) } : {}) });
			return {
				quoteId: asHex(q.quoteId),
				peerPubkey: asHex(q.peer),
				assetAmount: BigInt(q.assetAmount),
				amountMsat: BigInt(q.milliSatoshi),
				unitsPerBtc: rateOf(q.assetRate),
				expiresAt: millis(q.expiresAt)
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
		invoices: () =>
			live()
				.invoices()
				.map((i) => ({
					paymentHash: asHex(i.paymentHash),
					assetAmount: BigInt(i.assetAmount),
					status: i.status === 'paid' || i.status === 'expired' ? i.status : 'open'
				})),

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
				unitsPerBtc: rateOf(q.assetRate),
				expiresAt: millis(q.expiresAt)
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
				channelId: asHex(r.channelId),
				completed: (r.completed || []).length,
				pending: (r.pending || []).length,
				errors: (r.errors || []).map((e) => String((e && e.message) || e))
			}));
		}
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
