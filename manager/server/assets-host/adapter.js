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
 * The state numbers below are the library's own, as stored in its records.
 * They are checked against the loaded library, so a library that renumbers
 * them is refused instead of misread.
 */
const path = require('path');
const { createRequire } = require('module');
const { tapBackend } = require('./store');

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

module.exports = { STATES, TAP_KEY_FAMILY, ANCHOR_SATS, loadLibrary, createLib, buildAdapter, hex, unhex };
