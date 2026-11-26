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
 * Read from the entry's source (ts-tap branch asset-lightning-7-reservations
 * at 878e775: packages/beignet/src/lightning*.ts, docs/beignet.md,
 * docs/error-codes.md and CHANGELOG.md), item by item. The entry has
 * run against a fake node only, and the host against a stand-in for the
 * entry only: nothing here has met an engine that carries asset channels.
 * A name or a shape that turns out different is changed here and nowhere
 * else in the host.
 *
 * The entry's exports
 *
 *  1. assetLightningSupport() returns { supported, engineVersion?,
 *     apiVersion?, missing }. Synchronous, never throws. It reads what the
 *     installed engine states of itself (`channel.AUXILIARY_CHANNELS_API`,
 *     { version, surfaces }) and concludes nothing from the shape of a
 *     function: supported only for version 1 or later with every surface
 *     the adapter uses stated. An engine that states no contract, which is
 *     every release up to 0.42.0, is not supported.
 *  2. lightningStore(backend, prefix) returns the store everything else is
 *     built over. `backend` is the engine's IExtensionStorage as it is (get,
 *     set, delete, list, transaction, all synchronous). Every key is written
 *     under `prefix`, which is lower-case segments ending in "/". A
 *     transaction of the store is one of the backend, and one opened inside
 *     another is refused.
 *  3. createAssetLightningHost({ store, hrp, fixedOutputFees,
 *     invoiceRetentionSeconds?, now?, onError? }) returns { attachment,
 *     start, service, close }. Synchronous. `invoiceRetentionSeconds` is
 *     how long a paid or expired invoice is kept (a day when left out,
 *     which the host leaves as it is: it keeps its own row of each). It needs
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
 *       groupProofResolver(key)  a group key as hex in, a promise of the
 *                                encoded proof file of the issuance that
 *                                created the group out. See below.
 *     Left out: `forwarding` (the entry routes for nobody) and
 *     `validateAcceptedChannel` (a check of a channel's Bitcoin parameters
 *     that this host has no rule for). Any other member is a mistake of
 *     this file's, and the fake of the tests refuses it.
 *
 *     What a channel with a grouped asset needs (src/lightning/
 *     funding-verify.ts, verifyFundingInput and verifyFundingGroups): each
 *     side verifies every funding input, and an input of a group must have
 *     its group shown to be real. That is so by itself when the input's
 *     own history begins with the issuance that created the group (its
 *     first proof reveals the group key), and when the wallet already knows
 *     the group: its records hold the group or any asset of it, which is
 *     always so for the side that funds, since it holds what it funds
 *     with. It is not so for the side that accepts when the asset is a
 *     later issuance into a group that wallet has never held: the verifier
 *     then throws 'unknown asset group' unless it is given
 *     `groupProofResolver`, which it asks for the group's first issuance
 *     and verifies before it trusts it. The same resolver is asked again
 *     when a group's anchor moved in a reorg. The host answers it from the
 *     wallet's proof server, as the wallet's own receive of such an asset
 *     does (the courier's receiveGroupProof). Without it, or when it
 *     fails, the peer's channel is not accepted and onError hears
 *     ERR_BEIGNET_LN_GROUP_PROOF.
 *
 *     A channel this wallet funds holds units of ONE asset ID (docs/beignet.md,
 *     "Grouped assets"); one a peer funds may hold units of up to three
 *     issuances of one group, and acceptIncoming takes it. quoteFunding and
 *     openChannel take `assets` with
 *     exactly one entry, and several asset IDs, a collectible, or a
 *     `groupKey` the asset is not of are refused with
 *     ERR_BEIGNET_LN_CHANNEL_ASSETS before anything is written or funded.
 *     A channel of a grouped asset is a channel of its group: channels()
 *     gives its `groupKey`, paymentLimits() names the group (`groupKey`,
 *     no `assetId`), and quoteInvoice and quotePayment are asked with
 *     `asset: { groupKey }` for a grouped asset, never `{ assetId }`, which
 *     is how the peer is asked for a price (specifier below). The bitcoin
 *     of a funding and of a reclaim comes only from native witness coins:
 *     short of those, both refuse with ERR_BEIGNET_LN_FUNDING_INPUTS and
 *     `details: { eligibleSatoshis, neededSatoshis, otherSatoshis }`.
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
 *         sendablePayments?, receivablePayments?, recoveryWaitsUntil?,
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
 *     `signed` says the open is past its point of no return, and nothing
 *     else: the engine holds the peer's signature on the first commitment
 *     (for an open a peer funds, this node's own on the peer's), so the
 *     funding transaction may be published. It does not say that this
 *     wallet signed the funding transaction: the wallet signs earlier, and
 *     that binds nothing, since no witness of the transaction leaves the
 *     process before the peer has committed. From `signed` on cancelChannel
 *     refuses and the inputs stay reserved until the chain resolves them.
 *     `committed` says the peer's signature on the first commitment is
 *     held. `fundingTxid` is there once this wallet or the engine has the
 *     transaction, which can be before `signed`. `confirmed` says the
 *     funding has confirmed and its proofs are stored. `state` is the engine's
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
 *     An open past that point is always listed, and never as cancelled or
 *     rejected. It is listed as `failed` in one case only: it was proven
 *     unable to confirm (15) and given up. Its reservation is then released,
 *     so `fundingReservation` is gone and its units are back among the
 *     on-chain records. With no channel in the engine nothing is published
 *     from here: such an open is listed with `engine: 'missing'` and stays
 *     reserved.
 *     Before that point an open that fails, or that this wallet gives up,
 *     is ended and its inputs released, whatever was signed here. It stays
 *     listed until it is forgotten (14): one this wallet gave up as
 *     `cancelled`, which the host also reads from `rejected` or `failed`
 *     with `error: 'cancelled'`.
 *  8. peerSupports(peer) is synchronous: whether the connected peer's
 *     features allow an asset channel. False for a peer not connected.
 *  9. quoteFunding({ assets: [{ assetId, amount }], groupKey?,
 *     fundingSatoshis, feeRate }) resolves to { feeSatoshis, vsize,
 *     reserveSatoshis }. An estimate: nothing is selected, reserved or
 *     written.
 * 10. openChannel({ peer, pendingChannelId, assets, groupKey?,
 *     decimalDisplay?, fundingSatoshis, pushMsat?, feeRate, maxFee?,
 *     timeoutMs? }) resolves to { pendingChannelId, channelId } once the
 *     open is past its point of no return (7) and the funding transaction
 *     is on its way: this wallet publishes it itself once the engine
 *     reports the peer's signature as verified.
 *     Given the id and terms of a flow it already has, it carries that flow
 *     on and opens nothing second. `maxFee` is the most the funding
 *     transaction may pay in sats: one that would pay more is refused with
 *     FEE_BOUND before anything is signed. `timeoutMs` is how long each
 *     step waits for the peer (two minutes when left out, which the host
 *     leaves as it is). An open that fails before its point of no return
 *     is ended by the library and its inputs released, whatever this wallet
 *     had signed, and its id is spent: the host opens again under a new id.
 *     Past that point nothing is released. It rejects with CANCELLED (11),
 *     FEE_BOUND, FUNDING_REJECTED, or TIMEOUT, after which the flow is kept.
 * 11. cancelChannel(pendingChannelId) resolves to true when nothing is left
 *     of the open and what it had set aside is released, also for an id it
 *     never had, and to false, changing nothing, once the open is past its
 *     point of no return (7). It also resolves to false while the engine
 *     holds the funding transaction and waits for the peer's signature,
 *     unless the engine can be made to drop the open first: such an open
 *     can be given up once the engine has dropped it, and its way out
 *     meanwhile is 33. An openChannel still running under the id stops at
 *     its next step and rejects with CANCELLED. When the peer's signature
 *     wins the race, the cancel answers false and the open rejects with
 *     what really failed, if anything did. The host does not lean on any
 *     of that alone: it
 *     believes a true only once no openChannel call of its own is out for
 *     the id (lightning.js giveUp).
 * 12. closeChannel({ channelId, force? }) resolves once the engine has been
 *     asked to close. The payout goes to keys of this wallet that the
 *     service derives itself. It refuses with UNKNOWN_CHANNEL for a channel
 *     the engine does not hold, and with CHANNEL when the engine will not
 *     close it.
 * 13. resume() carries unfinished opens on, ends an open the engine dropped
 *     before the peer signed and releases its inputs, publishes again the
 *     funding of an open past its point of no return while the engine holds
 *     the channel, confirms the ones that have confirmed, and writes the
 *     record of an invoice whose own write failed (20). It ends no payment:
 *     only the engine's word on a try does (22). One look, with no timer
 *     left running: the host calls it from its own loop. rebroadcastFunding
 *     is part of what it does, and the host does not call it.
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
 *     changeRestored?, reason? }], settled by the chain alone. `released`:
 *     the units are free again. With no funding transaction on record for
 *     the open, that is when nothing spent the anchors. With a signed one
 *     on record, only on the proof of 15. `moved`: the funding transaction
 *     on record spent them and is buried, so they are marked spent and the
 *     units are the channel's. The outputs of that transaction that are
 *     the wallet's, the change among them, are stored with their proofs in
 *     the same write, and `changeRestored` says whether that could be
 *     done: it is false for a backup made before the funding was signed,
 *     which carries no record to rebuild them from. `change` is what went
 *     into the transaction and not into the channel. `kept`: left
 *     reserved, for the `reason` given, as while a signed funding on
 *     record can still confirm: the host asks again on each new block for
 *     as long as anything is kept.
 * 18. quoteInvoice({ asset: { assetId } | { groupKey }, amount, peer?,
 *     expirySeconds? }) asks a channel's peer what it gives for `amount`
 *     units and resolves to { quoteId, peer, assetAmount, milliSatoshi,
 *     assetRate: { coefficient, scale }, expiresAt, priced }. `assetRate`
 *     is asset units per bitcoin. `priced` is false for the nominal rate of
 *     a peer that sets no price. `expirySeconds` is how long the quote is
 *     asked to stand (an hour when left out). The peer names the rate, so
 *     it is held to the amount: a rate under which the amount does not
 *     come back within one unit, once turned into millisatoshis and back,
 *     is refused with RATE_TOO_COARSE, and nothing of the answer is kept.
 * 19. createInvoice({ quoteId, description?, expirySeconds? }) resolves to
 *     { bolt11, paymentHash, assetAmount, milliSatoshi, expiresAt }. The
 *     invoice lives `expirySeconds`, or as long as the quote when that is
 *     shorter. The host passes the time the quote has left all the same, so
 *     the invoice never outlives the price it was made on.
 * 20. invoices() is synchronous: [{ paymentHash, assetAmount,
 *     receivedAssetAmount, milliSatoshi, expiresAt, status, bolt11?,
 *     description? }] for every asset invoice kept, `status` being 'open',
 *     'paid', 'lost' or 'expired'. `assetAmount` is what was invoiced, and
 *     `receivedAssetAmount` what arrived, summed over the HTLCs that
 *     settled it, less those the payer took back on the chain: 0 while
 *     none has. Each HTLC can come a unit short where the rate rounds a
 *     payer down, so it can be under the amount invoiced by up to one unit
 *     for each HTLC that paid it. A payer may pay an invoice in parts, each
 *     an HTLC of its own: the invoice reads `paid` from the first part that
 *     settles, and `receivedAssetAmount` rises as each later part's end
 *     arrives. It falls when the payer takes an HTLC back on the chain
 *     after the wallet had let its preimage go, and once none is left
 *     received the invoice reads `lost`, never `open` again. A paid
 *     invoice keeps reading `paid` after the engine has forgotten the
 *     payment. `bolt11`
 *     and `description` are there only while the engine keeps the invoice,
 *     so the host keeps its own row of each (`inv/<hash>`). The record of
 *     an invoice is pruned a day after it expired: its hash then stays on
 *     record for good, with how it ended, and every HTLC for it is
 *     refused, so plain bitcoin never settles an asset invoice.
 * 21. quotePayment({ invoice, asset, amountMsat?, channelId? }) resolves to
 *     { quoteId, paymentHash, peer, channelId, assetAmount, milliSatoshi,
 *     feeMsat, assetRate, expiresAt, priced, parts, channelIds,
 *     carrierMsat } and sends nothing. `amountMsat` is for an invoice that
 *     names no amount. It first tries one HTLC over every channel, whatever
 *     its peer. When none carries the payment, and the invoice offers
 *     basic_mpp with a payment secret, the payment goes in parts over the
 *     asset channels of one peer, at the rate of that peer's own quote:
 *     the fewest parts the channels and routes allow, at most 8
 *     (MAX_ASSET_PAYMENT_PARTS), under one quote. `parts` is 1 for one
 *     HTLC; `channelIds` names each part's channel in the order they are
 *     sent, `channelId` the first; `assetAmount` is the units of every
 *     part, each the fewest worth what its route carries, so the payer
 *     pays up to a unit a part more than one HTLC would; `milliSatoshi` is
 *     what the routes carry together and `feeMsat` what they charge; and
 *     `carrierMsat` the bitcoin the HTLCs carry, one carrier each, which
 *     leaves with the payment beside the fee. While no channel of the
 *     asset can send and one that holds units to send is reconnecting (its
 *     peer connected, its reestablish under way), it waits up to 5 seconds
 *     for that one, asking the peer nothing meanwhile, and goes on once it
 *     is back, or refuses with CHANNEL_SETTLING.
 * 22. payInvoice({ quoteId, maxAssetAmount }) is one try at an invoice. It
 *     rejects only while nothing has left the wallet, and only with a code
 *     of the exported ASSET_PAYMENT_REFUSALS: PAYMENT among them for an
 *     engine that did not take the payment, SPENDING_LIMIT for the wallet's
 *     own spending limits refusing it before anything was recorded or sent,
 *     and UNSUPPORTED for an engine that does not state how it takes the
 *     asset side of a payment. While a channel its quote sends over is
 *     reconnecting it waits up to 5 seconds for it, with nothing written,
 *     and refuses with CHANNEL_SETTLING when it is still so: the quote
 *     stays usable. The facade hands that list on as
 *     `refusals`, and the host keeps no copy of it. Once the payment is
 *     handed to the engine the call resolves, to { paymentHash,
 *     assetAmount, status, attempt, channelId, htlcId?, parts, planned,
 *     feeMsat?, failure?, preimage?, engineHasNoRecord?,
 *     assetRecordsUnconfirmed? }, with `pending` while the end is not
 *     known. A payment in parts starts only with 20 seconds of its quote
 *     left (QUOTE_EXPIRED otherwise), checks every part before the first
 *     is sent and sends each part once: `parts` is how many went out and
 *     `planned` how many the quote was given for. When a later part is
 *     refused the call resolves `pending` with `parts` under `planned`,
 *     and the parts out end as the payee lets them, by its timeout when it
 *     does not take them; a refusal of the first part rejects, nothing
 *     having left. The record completes at the first part that settles and
 *     fails once no part can settle. There is one rejection after
 *     that point, and it is not in the list: RECORDS_UNCONFIRMED, for a
 *     send the engine does not confirm to carry the asset records. The
 *     record is then kept, flagged `assetRecordsUnconfirmed`, and ends as
 *     the engine reports, its units not known to have left. The host
 *     treats it as any throw after hand-over: the row stays pending and is
 *     settled from the record.
 *     payment(paymentHash) is synchronous and returns the same shape, or
 *     undefined for a hash this wallet made no payment under. That record
 *     is the wallet's own and the only word on how a payment ended:
 *       - it stands for the latest try, numbered by `attempt` from 1, and
 *         is written in the one write that precedes the engine call. A try
 *         that is refused leaves the record of the try before as it was.
 *         So a try whose number the record does not carry was never sent;
 *       - an outcome is applied only to the try it belongs to, matched by
 *         the channel and the HTLC the try left as. The host does the same
 *         with its row: a record of an earlier try says nothing of a later
 *         one (lightning.js recordPayment);
 *       - it becomes `complete` only with the preimage, or on the engine's
 *         word that the HTLC of the try was fulfilled, and `failed` only on
 *         a failure the engine reports of that very try. Nothing else ends
 *         it, and time does not;
 *       - `complete` and `failed` do not change again, except that paying a
 *         failed invoice again is a new try;
 *       - while it is pending, for whatever reason, quotePayment and
 *         payInvoice refuse with ALREADY_PAID;
 *       - a pending record the engine has no record of, on a channel that
 *         holds no HTLC of it, stays pending and carries
 *         `engineHasNoRecord`: the engine forgets a payment a day after it
 *         ended, so nothing can say any more how this one ended, and it may
 *         have been paid;
 *       - it survives a restart of the daemon, and the end of an HTLC is
 *         written by the library's host object in the engine's hook,
 *         whether or not the service runs;
 *       - `failure` is the engine's own text, or 'the payment failed'. The
 *         host shows neither, and words a failure itself (errors.js);
 *       - before `start`, and after `close`, it throws NOT_READY and never
 *         answers undefined for a payment it would know of.
 * 23. paymentLimits() is synchronous: for each asset, [{ assetId? |
 *     groupKey?, maxSend, maxReceive, pendingSend, pendingReceive,
 *     sendChannelId?, sendPeer?, receiveChannelId? }], the most ONE
 *     payment can send and receive over NORMAL channels whose peer is
 *     connected, less what payments under way have set aside. A payment
 *     is sent over the asset channels of one
 *     peer, in parts when one channel does not hold it, so `maxSend` is
 *     what the channels of the best peer (`sendPeer`) hold together, each
 *     with a slot and a carrier for one more HTLC, and `sendChannelId` the
 *     fullest of them. A payment above what one channel holds goes only
 *     when its invoice offers basic_mpp, and in N parts takes up to N units
 *     more than one HTLC would. An invoice is quoted only through a channel
 *     that can receive the whole of it, so `maxReceive` is the best single
 *     channel's and never a sum. A channel that is reconnecting (its peer
 *     connected, its reestablish under way, marked by the engine to return
 *     to NORMAL) is in neither: what it would add to each is in
 *     `pendingSend` and `pendingReceive`, always there and 0n when nothing
 *     is pending. An asset whose channels are all reconnecting has an
 *     entry that names no channel and no peer.
 *
 * Events and errors
 *
 * 24. A rejection carries a string `code`. errors.js words the ones a
 *     caller can act on: ERR_BEIGNET_LN_ and UNSUPPORTED, NOT_READY,
 *     INVALID, PEER_OFFLINE, PEER_UNSUPPORTED, FUNDING_REJECTED, TIMEOUT,
 *     CANCELLED, FEE_BOUND, UNKNOWN_CHANNEL, NO_QUOTE, QUOTE_EXPIRED,
 *     PRICE_BOUND, RATE_TOO_COARSE, SPENDING_LIMIT, INSUFFICIENT_OUTBOUND,
 *     INSUFFICIENT_INBOUND, BAD_INVOICE, INVOICE_EXPIRED, AMOUNT_REQUIRED,
 *     CHANNEL_SETTLING, ALREADY_PAID and PAYMENT. RECORDS_UNCONFIRMED is
 *     no refusal and has no sentence: the payment it speaks of is followed
 *     (22). CHANNEL, FUNDING and RECOVERY carry the library's own account
 *     of what went wrong inside: that goes to the log, and the caller gets
 *     a sentence of the host's. So do the library's own ERR_LIGHTNING_* and
 *     ERR_FUNDING_* codes. The adapter's ERR_BEIGNET_FUNDING,
 *     ERR_BEIGNET_WALLET and ERR_BEIGNET_FEE pass through for the funding
 *     transaction, as for a mint or a send.
 * 25. onEvent receives { type: 'channel', pendingChannelId?, channelId?,
 *     phase?, error? }, { type: 'invoice', paymentHash, status: 'paid' |
 *     'lost', assetAmount, receivedAssetAmount, channelId } once for each
 *     HTLC that paid an invoice (`lost` for one the payer took back on the
 *     chain, with what is left received), { type: 'payment',
 *     paymentHash, attempt, status, assetAmount, channelId, parts,
 *     feeMsat?, failure? } once a payment, a payment in parts included, on
 *     the end of the part that ended it, and { type: 'recovery',
 *     channelId, status }, each after the change is stored and outside any
 *     storage transaction. A peer that turns an open down after openChannel
 *     ended is a channel event with `error`; a payment's end after
 *     `pending` is a payment event. The host treats each as a reason to
 *     look again and reads the state itself, so an event that is missed
 *     costs time and nothing else. The library also has { type:
 *     'forward' }, the end of a leg of a forward a primary took on; a
 *     wallet here forwards nothing, so it never comes, and would be one
 *     more reason to look.
 *
 * The backup
 *
 * 26. assetLightningBackup(store) is synchronous and returns { version: 1,
 *     rows: [{ key, value }] }: exactly the rows a backup may carry (which
 *     channels there were, the keys their payouts go to, the proofs of what
 *     funded them, the record of each close seen, and what rebuilds the
 *     asset change of a signed funding transaction) and nothing that could
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
 *
 * Added with the library at 878e775
 *
 * 33. reclaimFundingInputs({ pendingChannelId, feeRate }) is the way out of
 *     an open whose funding transaction will not confirm. It publishes a
 *     transaction that spends Bitcoin inputs of the funding transaction
 *     back to the wallet at that fee rate, so that the two conflict, and
 *     resolves to { txid, transaction, feeSat }, `txid` in the byte order
 *     of the wire. It releases nothing by itself: whichever of the two is
 *     buried decides, through 15, and if the funding confirms instead the
 *     open carries on as if the call had never been made. It refuses with
 *     UNKNOWN_CHANNEL for an id with no open of this wallet's, and with
 *     FUNDING while the funding transaction is confirmed, for an open whose
 *     funding transaction this wallet has not signed (which cancelChannel
 *     gives up), for one that ended, and when the Bitcoin wallet cannot
 *     make the spend, as when the funding reserved no input of its own. A
 *     node that already has the funding transaction takes the spend only as
 *     a replacement, so the fee rate must then be above the funding's own.
 *     It is also the way out for an open that cancelChannel cannot give up
 *     because the engine holds its funding transaction (11).
 * 34. advertisement() is synchronous: { advertised, reason? }, or undefined
 *     for an engine that cannot say. A node whose feature set lacks
 *     something the overlay depends on advertises none of it, and no peer
 *     opens an asset channel with it.
 * 35. A quote this wallet gives a peer lives an hour, however long the peer
 *     asks for, and one peer holds at most eight live ones. The quotes
 *     this wallet asks a peer for are counted apart and are never refused
 *     because of those.
 * 36. What the engine itself refuses reaches the host inside an error of
 *     the library's, as its `cause` or named in its text: the engine's
 *     ASSET_PAYMENT_REFUSED becomes SPENDING_LIMIT with the engine's error
 *     as the cause, and FEE_BUDGET_EXHAUSTED, for a fee pool of a channel's
 *     fixed outputs that is used up, comes as it is. errors.js
 *     ENGINE_REFUSALS is the one place that knows those names.
 * 37. fixedOutputFeeStatus(forFeeSatoshis?) is a synchronous method of the
 *     object createAssetLightningHost returns. It hands on what the
 *     engine's node says of its fee coin pool (getFixedOutputFeeStatus),
 *     unchanged, and changes nothing by being asked: undefined before the
 *     node is bound and for a node with no fee policy; { available: false,
 *     error: { code: 'FEE_POLICY_REFUSED', remedy: 'operator', message } }
 *     when the engine refused the policy it was given, and such a node
 *     neither opens nor accepts an asset channel; and otherwise
 *     { available: true, budget: { totalSatoshis, reservedSatoshis,
 *     spentSatoshis, remainingSatoshis }, feeCoins: { ready,
 *     readySatoshis, unconfirmed }, actions: [...], splits: [...],
 *     preparation: { possible, forFeeSatoshis, neededSatoshis,
 *     largestConfirmedSatoshis, reason?: 'FEE_FUNDS_UNAVAILABLE' |
 *     'FEE_BUDGET_EXHAUSTED' }, lastRefusal?: { code, remedy, at } }, the
 *     amounts bigints. A fee coin is a small confirmed coin of ordinary
 *     bitcoin that pays the miner fee of claiming an output of a force
 *     closed asset channel, and preparing one takes a block: a wallet with
 *     an asset channel and no confirmed bitcoin to make one from could
 *     miss a deadline. A library that has no such method is one that
 *     cannot say, and nothing is said for it.
 * 38. The node the engine binds says who it is connected to and what it
 *     holds, synchronously and without changing anything: listPeers()
 *     gives { pubkey, remoteInit } for each peer, `remoteInit` set once
 *     the peer's greeting has arrived, which is the library's own rule
 *     for a peer a channel can be used with; listChannels() gives every
 *     channel of any kind with its `channelId`, its `temporaryChannelId`
 *     where the engine has one, and `localBalanceMsat`, this wallet's side
 *     of the channel's bitcoin in millisatoshis. A channel's state
 *     word is one of the engine's ChannelState (views.channelWord has
 *     them all): AWAITING_REESTABLISH is a channel waiting for its peer,
 *     and ERRORED one the engine gave up, which closes only by force.
 * 39. openChannel answers once the funding is negotiated, before the
 *     peer has signed, with the channel's id. An open it answered is on
 *     its list after a restart, carried on or ended with a reason. The
 *     host does not rest on that: an answered open that is on no list is
 *     ended by the host once nothing holds anything of it
 *     (lightning.js endLost).
 * 40. peerRefusal(peer) says why no asset channel can be opened with a
 *     peer, as { code, message, reason? }, or undefined when one can:
 *     ERR_BEIGNET_LN_PEER_OFFLINE and ERR_BEIGNET_LN_PEER_UNSUPPORTED are
 *     the peer's, and ERR_BEIGNET_LN_MODE_UNAVAILABLE is this node's own
 *     (its engine and the peer agree on no HTLC mode, or it does not
 *     advertise asset channels), with the engine's words in `reason`.
 *     openChannel rejects with the same code and `details.reason`, and
 *     with ERR_BEIGNET_LN_FEE_POLICY_REFUSED on an engine that refused
 *     its fee policy, before anything is written. peerSupports(peer) is
 *     the same question as a boolean.
 * 41. quotePayment and quoteInvoice reject with
 *     ERR_BEIGNET_LN_PEER_OFFLINE when a channel could carry the amount
 *     and its peer is away. ASSET_PAYMENT_REFUSALS also holds
 *     ERR_BEIGNET_LN_PAYMENT_UNSUPPORTED (the engine does not send the
 *     payment as an asset payment: an invoice of its own, a payment given
 *     up while a part of it is still out, asset HTLCs mixed with ones that
 *     carry no units, a blinded path that starts at this node; a payment
 *     in parts is not among them), ERR_BEIGNET_LN_OUTCOMES_UNDELIVERED
 *     (results of earlier payments on the channel were not taken in;
 *     `details.undeliveredOutcomes`, and the channel's view carries
 *     `undeliveredOutcomes` while above zero) and, since the library at
 *     dc499b8, ERR_BEIGNET_LN_HTLC_NOT_ADMITTED (the channel did not take
 *     the HTLC at its add; `details.channelId` and `details.reason`, the
 *     engine's words): nothing was recorded or sent by any of them, and for
 *     a payment in parts no part left. A try that ended because its HTLC never entered
 *     the channel is `failed` with `neverSent: true`: nothing left the
 *     wallet, and the invoice can be paid again. The library hands over
 *     no forwarding hooks.
 * 42. Since the library at 83bf1a9: openChannel resolves only once the peer
 *     has signed, the engine keeps the channel and the flow is stored as
 *     committed. No signature within the call's timeoutMs rejects with
 *     ERR_BEIGNET_LN_TIMEOUT and the flow is KEPT: an open still under
 *     way, to be read from channels(), never a failure. After a restart
 *     resume() deals with every opener's flow by phase and drops none
 *     silently: before the peer named a funding it is carried on, or,
 *     where the engine forgot the open, ended, its inputs released, and
 *     listed with phase `failed` and its reason in `error`; from
 *     committed on it is carried on while the engine holds the channel
 *     and listed `engine: 'missing'` when it holds none. The host makes
 *     such a failed flow a failed open with that reason (endFailed), and
 *     keeps its own rule for a marker with no flow at all (endLost).
 * 43. On the accepting side an open that was never funded ends by
 *     itself: a `channel` event with phase `failed` and a reason, then
 *     off the list. `engine: 'missing'` is only a channel this wallet
 *     funded and the peer signed for, or one whose funding the chain
 *     showed confirmed. An acceptor's open with no engine channel and an
 *     unconfirmed funding reads `engine: 'absent'`: an inbound open still
 *     waiting, worded OPENING and never MISSING (views.channelWord).
 * 44. A quote can be refused with ERR_LIGHTNING_TOO_MANY_REQUESTS, as its
 *     own code or as the cause: a peer keeps at most eight live unused
 *     quotes for a wallet. The host says TOO_MANY_QUOTES (429).
 */

/**
 * What the engine says of its fee coin pool (37) as plain values: amounts
 * as strings of sats, counts as numbers, and the lists as how many they
 * hold. Null for nothing said.
 */
function plainFeeStatus(said) {
	if (!said || typeof said !== 'object') return null;
	const sats = (value) => {
		try {
			const n = BigInt(value);
			return n >= 0n ? n.toString() : '0';
		} catch (_) {
			return '0';
		}
	};
	const count = (value) => {
		const n = Number(value);
		return Number.isSafeInteger(n) && n >= 0 ? n : 0;
	};
	const name = (value) => (typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null);
	if (said.available === false) {
		const e = said.error && typeof said.error === 'object' ? said.error : {};
		return { available: false, error: { code: name(e.code) || 'FEE_POLICY_REFUSED', remedy: name(e.remedy), message: typeof e.message === 'string' ? e.message : '' } };
	}
	const budget = said.budget || {};
	const coins = said.feeCoins || {};
	const preparation = said.preparation || {};
	const last = said.lastRefusal && typeof said.lastRefusal === 'object' ? said.lastRefusal : null;
	return {
		available: true,
		budget: { totalSats: sats(budget.totalSatoshis), reservedSats: sats(budget.reservedSatoshis), spentSats: sats(budget.spentSatoshis), remainingSats: sats(budget.remainingSatoshis) },
		feeCoins: { ready: count(coins.ready), readySats: sats(coins.readySatoshis), unconfirmed: count(coins.unconfirmed) },
		actions: Array.isArray(said.actions) ? said.actions.length : 0,
		splits: Array.isArray(said.splits) ? said.splits.length : 0,
		preparation: {
			possible: preparation.possible === true,
			forFeeSats: sats(preparation.forFeeSatoshis),
			neededSats: sats(preparation.neededSatoshis),
			largestConfirmedSats: sats(preparation.largestConfirmedSatoshis),
			reason: name(preparation.reason)
		},
		lastRefusal: last ? { code: name(last.code), remedy: name(last.remedy), at: Number.isFinite(Number(last.at)) ? Number(last.at) : null } : null
	};
}

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
 * WHAT THE LIBRARY SAYS SINCE 878e775, AND WHERE IT IS READ
 *
 * Seven things were each given one function here before the library said
 * them. It says them now, and each function reads it. What the host does
 * with each is in lightning.js.
 *
 *  S1 openIsFinal(c)        `signed`: the open is past its point of no
 *                           return, and nothing else (item 7).
 *  S2 paymentLost(p)        `engineHasNoRecord` on a pending payment. Not
 *                           evidence of failure: the row stays pending and
 *                           the invoice is never paid again (item 22).
 *  S3 attemptOf(p)          `attempt`, the try a record stands for. An
 *                           outcome is taken only for the try it belongs
 *                           to (item 22).
 *  S4 receivedOf(i)         `receivedAssetAmount`, what an invoice brought
 *                           in, beside what was invoiced (item 20).
 *  S5 quoteInvoice          refuses with RATE_TOO_COARSE, which has its
 *                           sentence in errors.js (item 18).
 *  S6 reclaimFunding(...)   reclaimFundingInputs, the way out of an open
 *                           that will not confirm (item 33).
 *  S7 plainReservation(r)   `changeRestored`: a funding's change comes
 *                           back with the reservation (item 17).
 */

/** S1. Whether an open has passed the point where it can be cancelled: the library's `signed`, and only a plain true. */
const openIsFinal = (c) => c.signed === true;

/** S2. Whether the engine has lost its record of a payment the library still holds as pending. */
const paymentLost = (p) => p.engineHasNoRecord === true;

/** S3. Which try at its payment hash a record stands for, from 1. Null when the library names none. */
const attemptOf = (p) => (Number.isInteger(p.attempt) && p.attempt > 0 ? p.attempt : null);

/** S4. The units an invoice brought in, or null when the library says only what was invoiced. */
const receivedOf = (i) => (i.receivedAssetAmount === undefined || i.receivedAssetAmount === null ? null : BigInt(i.receivedAssetAmount));

/**
 * This wallet's side of the bitcoin of each channel the node holds, in
 * whole sats, by the channel's id and by the id its open was given: the
 * node's `localBalanceMsat` (38). Empty when the node cannot say.
 */
function ownSatsOf(node) {
	const out = new Map();
	if (!node || typeof node.listChannels !== 'function') return out;
	let held = [];
	try {
		held = node.listChannels() || [];
	} catch (_) {
		return out;
	}
	for (const c of held) {
		if (!c || (typeof c.localBalanceMsat !== 'bigint' && !Number.isSafeInteger(c.localBalanceMsat))) continue;
		const msat = BigInt(c.localBalanceMsat);
		if (msat < 0n) continue;
		for (const id of [c.channelId, c.temporaryChannelId]) if (id) out.set(asHex(id), Number(msat / 1000n));
	}
	return out;
}

/** One entry of the service's list, in plain values. `own` is what ownSatsOf read of the node. */
function plainChannel(c, own = new Map()) {
	const assets = outUnits(c.assets);
	const phase = String(c.phase || '');
	const state = c.state ? String(c.state) : null;
	const ownKey = [c.channelId, c.pendingChannelId].map((id) => (id ? asHex(id) : null)).find((id) => id && own.has(id));
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
		// This wallet's side of the channel's bitcoin, while the node holds
		// the channel: it comes home when the channel closes.
		...(ownKey ? { localSats: own.get(ownKey) } : {}),
		reserveSats: whole(c.reserveSatoshis),
		// The name its funding inputs still sit under in the on-chain
		// records, and what they hold, until the funding has confirmed.
		fundingReservation: c.fundingReservation ? String(c.fundingReservation) : null,
		fundingInputs: outUnits(c.fundingInputs),
		// Anything but a plain 'none' or 'complete' is a recovery still to be
		// done: a word this host has not met must never read as "nothing owed".
		recovery: c.recovery === 'none' || c.recovery === 'complete' ? c.recovery : 'pending',
			// How many results of earlier payments the wallet has not taken in,
		// where the library says there are any.
		...(Number.isInteger(c.undeliveredOutcomes) && c.undeliveredOutcomes > 0 ? { undeliveredOutcomes: c.undeliveredOutcomes } : {}),
		// How many more payments this side's bitcoin in the channel carries,
		// and the peer's side's to this wallet, where the library says. At 0
		// that side pays nothing, whatever units it holds, until a payment
		// comes its way.
		...(Number.isInteger(c.sendablePayments) && c.sendablePayments >= 0 ? { sendablePayments: c.sendablePayments } : {}),
		...(Number.isInteger(c.receivablePayments) && c.receivablePayments >= 0 ? { receivablePayments: c.receivablePayments } : {}),
		// While what a close brings back waits out a time lock: the height
		// before which the next transaction of it cannot be in a block.
		...(Number.isInteger(c.recoveryWaitsUntil) && c.recoveryWaitsUntil > 0 ? { recoveryWaitsUntil: c.recoveryWaitsUntil } : {}),
		// An open this wallet gave up, however far it had got: listed as
		// `cancelled`, or as turned down or failed with that for a reason.
		cancelled: phase === 'cancelled' || ((phase === 'rejected' || phase === 'failed') && c.error === 'cancelled'),
		// The library's own account. For the log, and for the detail of a
		// failed open's row. Never part of a sentence of the host's.
		error: c.error ? String(c.error) : null,
		// Why the library ended the flow, as the reason code it names on
		// `reasonCode`: one of the closed set it exports as
		// ASSET_OPEN_ENDED_REASONS, which the host has sentences for
		// (lightning.js OPEN_ENDED_BECAUSE). Null from a library that names none.
		because: typeof c.reasonCode === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(c.reasonCode) ? c.reasonCode : null
	};
}

// How many HTLCs a payment goes or went out as: 1 where the library says
// nothing, as a library before payments in parts does not.
const partsOf = (n) => (Number.isSafeInteger(n) && n >= 1 ? n : 1);

const plainPayment = (p) => ({
	paymentHash: p.paymentHash ? asHex(p.paymentHash) : null,
	assetAmount: p.assetAmount === undefined || p.assetAmount === null ? null : BigInt(p.assetAmount),
	status: p.status === 'complete' || p.status === 'failed' ? p.status : 'pending',
	feeMsat: p.feeMsat === undefined || p.feeMsat === null ? null : BigInt(p.feeMsat),
	failure: p.failure ? String(p.failure) : null,
	attempt: attemptOf(p),
	lost: paymentLost(p),
	// The engine took the try and did not confirm that it left with its
	// asset records: its units are not known to have left, whatever its status.
	unconfirmed: p.assetRecordsUnconfirmed === true,
	// A failed try whose HTLC never entered the channel: nothing left the wallet.
	...(p.neverSent === true ? { neverSent: true } : {}),
	// The HTLCs the try went out as, and how many its quote was given for:
	// fewer went out when the sending of a payment in parts stopped short.
	parts: partsOf(p.parts),
	planned: Math.max(partsOf(p.planned), partsOf(p.parts))
});

// The statuses of an invoice the host has words for, beside 'open' (20).
const INVOICE_ENDS = Object.freeze(['paid', 'lost', 'expired']);

const plainInvoice = (i) => ({
	paymentHash: asHex(i.paymentHash),
	assetAmount: BigInt(i.assetAmount),
	received: receivedOf(i),
	// A status this host has no word for is an open invoice until it is paid, lost or expired.
	status: INVOICE_ENDS.includes(i.status) ? i.status : 'open'
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
	// Units that went into the funding transaction and not into the channel,
	// and whether their outputs were brought back into the on-chain records.
	// Only a plain true says they were.
	change: outUnits(r.change),
	changeRestored: r.changeRestored === true,
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
 *                                fetchProof, fetchGroupProof, acceptIncoming, onEvent,
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
 *                                fundingSats, localSats?, reserveSats,
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
 *                                status }], assetAmount being what was
 *                                invoiced and received what arrived (S4),
 *                                status 'open', 'paid', 'lost' or 'expired'
 *
 *   quotePayment({ bolt11, assetId, groupKey, amountMsat })
 *                              -> { quoteId, paymentHash, peerPubkey,
 *                                   channelId, assetAmount, amountMsat,
 *                                   feeMsat, unitsPerBtc, expiresAt, priced,
 *                                   parts, channelIds, carrierMsat } (21)
 *   payInvoice({ quoteId, maxAssetAmount })
 *                              -> { paymentHash, assetAmount, status,
 *                                   feeMsat, failure, parts, planned }
 *   payment(paymentHash)       the same shape, or null. Both carry
 *                                `attempt`, `lost` and `unconfirmed` as
 *                                well (S2, S3)
 *   paymentLimits()            [{ assetId, groupKey, maxSend, maxReceive,
 *                                pendingSend, pendingReceive, sendChannelId,
 *                                sendPeer, receiveChannelId }]: the most one
 *                                payment can move of each asset, sent over
 *                                one peer's channels and received over one
 *                                channel, and what channels that are
 *                                reconnecting would add to each (23)
 *
 *   resume()                   carries opens on and confirms channels
 *   resumeRecovery()           -> [{ channelId, completed, pending, errors }]
 *   settleFundingReservations()
 *                              -> [{ reservation, pendingChannelId, outcome,
 *                                   assets, channelId, fundingTxid, change,
 *                                   changeRestored, reason }]
 *   reclaimFunding({ pendingChannelId, feeRate })
 *                              -> { txid, feeSats }: the spend that
 *                                conflicts with the funding (S6)
 *   advertisement()            { advertised, reason } or null: whether the
 *                                node offers asset channels to its peers
 *   feeStatus()                what the engine says of its fee coin pool
 *                                (37), amounts as strings of sats:
 *                                { available: true, budget, feeCoins,
 *                                actions, splits, preparation: { possible,
 *                                forFeeSats, neededSats,
 *                                largestConfirmedSats, reason },
 *                                lastRefusal }, or { available: false,
 *                                error: { code, remedy, message } }, or
 *                                null when nobody can say
 *
 *   backup()                   the rows a backup may carry, as the library
 *                                gives them: { version, rows }
 *   restore(backup)            -> how many rows were written, into a store
 *                                that held none
 *
 * `assets` and `change` are [{ assetId, amount }]. `unitsPerBtc` is
 * { coefficient, scale }. The events `onEvent` is given are { type,
 * pendingChannelId?, channelId?, paymentHash?, phase?, status?, failure?,
 * error? }, type being 'channel', 'invoice', 'payment' or 'recovery' (or
 * 'forward', which only a node that forwards is given: see 25).
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
	// A peer that runs lnd with tapd offers no fixed HTLC outputs, and signs
	// a channel's HTLCs the way tapd does. The engine asks this only about
	// such a peer: two wallets of this app, which both keep fee coins, open
	// with fixed outputs whatever it answers. With a peer it allows, the
	// library gives the channel one CSV delay for both sides, which tapd's
	// signatures need. The answer is the same for every peer, on every
	// network.
	//
	// A peer that signals neither of the asset features that say how the
	// first commitment is derived (Lightning Terminal v0.17.11 signals
	// neither) is taken to derive it from the channel's negotiated settings,
	// as this wallet does. A peer that derives it otherwise signs a
	// different first commitment, and the open fails at that signature,
	// before anything is funded.
	const made = entry.createAssetLightningHost({
		store,
		hrp: cfg.hrp,
		fixedOutputFees: fixedOutputFees(cfg),
		allowLegacyHtlcSignatures: () => true,
		assumeNegotiatedChannelConfig: () => true,
		...(seconds ? { now: seconds } : {}),
		onError
	});
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
		start({ adapter, lib, quiet = false, confirmations, fetchProof, fetchGroupProof, acceptIncoming, onEvent, onError: said, onStartError }) {
			if (typeof said === 'function') report = said;
			const options = {
				fetchProvenance: async (p) => lib.decodeProofFile(await fetchProof(lib.proofLocator(p))),
				// The issuance that created a group, for a peer's asset of a
				// group this wallet has never held. The library verifies it.
				...(typeof fetchGroupProof === 'function' ? { groupProofResolver: async (groupKey) => Buffer.from(await fetchGroupProof(String(groupKey))) } : {}),
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

		channels: () => {
			const listed = live().channels();
			const own = ownSatsOf(node);
			return listed.map((c) => plainChannel(c, own));
		},
		async connect({ pubkey, host, port }) {
			live();
			await node.connectPeer(pubkey, host, port);
		},
		peerSupports: (pubkey) => !!live().peerSupports(unhex(pubkey)),
		// Why no asset channel can be opened with that peer now, as { code,
		// reason }, or null when one can. The code is the library's and says
		// whose refusal it is: the peer's (not connected, or no asset
		// channels), or this node's own, with the engine's reason on one line.
		peerRefusal(pubkey) {
			const service = live();
			if (typeof service.peerRefusal !== 'function') return service.peerSupports(unhex(pubkey)) ? null : { code: 'ERR_BEIGNET_LN_PEER_UNSUPPORTED', reason: null };
			const said = service.peerRefusal(unhex(pubkey));
			if (!said) return null;
			const reason = typeof said.reason === 'string' ? said.reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
			return { code: String(said.code || 'ERR_BEIGNET_LN_PEER_UNSUPPORTED'), reason: reason || null };
		},
		// Whether the node is connected to that peer and has its greeting,
		// which is the library's own rule for a peer a channel can be used
		// with. Null when the node cannot say.
		peerConnected(pubkey) {
			live();
			if (typeof node.listPeers !== 'function') return null;
			const key = String(pubkey || '').toLowerCase();
			return node.listPeers().some((p) => !!p && String(p.pubkey).toLowerCase() === key && !!p.remoteInit);
		},
		// Whether the node holds a channel under one of these ids, of any
		// kind and in any state: the id an open was given, or the channel's
		// own. Null when the node cannot say.
		engineHolds(ids) {
			live();
			if (typeof node.listChannels !== 'function') return null;
			const wanted = new Set((ids || []).filter(Boolean).map((id) => String(id).toLowerCase()));
			const named = (value) => !!value && wanted.has(asHex(value));
			return node.listChannels().some((c) => !!c && (named(c.channelId) || named(c.temporaryChannelId)));
		},
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
				priced: !!q.priced,
				// One HTLC, or the parts of a payment over one peer's channels,
				// each with a carrier of its own (21).
				parts: partsOf(q.parts),
				channelIds: Array.isArray(q.channelIds) && q.channelIds.length > 0 ? q.channelIds.map(asHex) : [asHex(q.channelId)],
				carrierMsat: q.carrierMsat === undefined || q.carrierMsat === null ? null : BigInt(q.carrierMsat)
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
					// What the asset's channels that are reconnecting would add to
					// each: the library waits a few seconds for such a channel
					// before it prices or pays.
					pendingSend: BigInt(l.pendingSend || 0),
					pendingReceive: BigInt(l.pendingReceive || 0),
					sendChannelId: l.sendChannelId ? asHex(l.sendChannelId) : null,
					sendPeer: l.sendPeer ? asHex(l.sendPeer) : null,
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
		// S6. The way out of an open whose funding will not confirm: a spend
		// of the funding's own Bitcoin inputs back to the wallet. The txid is
		// handed on as it is displayed.
		async reclaimFunding({ pendingChannelId, feeRate }) {
			const made = await live().reclaimFundingInputs({ pendingChannelId: unhex(pendingChannelId), feeRate });
			return { txid: Buffer.from(made.txid).reverse().toString('hex'), feeSats: Number(made.feeSat) };
		},
		// Whether the node offers asset channels to its peers, and the node's
		// own word for why not. Null for an engine that cannot say.
		advertisement() {
			const service = live();
			const said = typeof service.advertisement === 'function' ? service.advertisement() : undefined;
			if (!said || typeof said !== 'object') return null;
			return { advertised: said.advertised === true, reason: typeof said.reason === 'string' && said.reason ? said.reason : null };
		},
		// The engine's fee coin pool, which pays the miner fees of an asset
		// channel's on-chain claims, in plain values. Null for a library or
		// an engine that cannot say, and for a node with no fee policy. It
		// is asked of the object createAssetLightningHost returned (37): the
		// service it starts has no such call.
		feeStatus() {
			live();
			return plainFeeStatus(typeof made.fixedOutputFeeStatus === 'function' ? made.fixedOutputFeeStatus() : undefined);
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
