'use strict';

/**
 * Stand-ins for the wallet, the Taproot Assets library and the proof server,
 * for the host's unit tests. Not a test file itself, and not loaded by the
 * host.
 *
 * The fake library keeps its records in memory and moves them through the
 * same numbered states as the real one, one stage per step, throwing the
 * same error codes. It records every call it receives in `calls`, which is
 * how the tests check order (a marker before an advance, a cancel at start).
 * A "restart" in a test is a new host over the same storage and the same
 * fake library: what the real library keeps in the database, this keeps in
 * its maps.
 *
 * `fakeLightning` stands in for the library's Lightning entry, which
 * adapter.js builds the wallet's asset channels over. It also keeps the two
 * rules that entry needs kept: it notes every call made to it with the
 * host's lock held that could have reached the node, and every call made
 * inside a storage transaction, in `violations`.
 */
const { memoryStorage, sha256Hex } = require('./store');
const { parseConfig } = require('./config');
const { createLightning } = require('./adapter');
const { createHost } = require('./service');
const { bind } = require('./routes');

const MODULES = '/opt/engine/node_modules';
const UNIVERSES = [
	{ courier: 'universerpc://universe.example.com:10029', rest: 'https://universe.example.com', isDefault: true },
	{ courier: 'universerpc://other.example.org:10029', rest: 'https://other.example.org:8443/', isDefault: true }
];

function tapError(code, message) {
	const err = new Error(`${code}: ${message || 'fake'}`);
	err.code = code;
	return err;
}

const encodeFake = (fields, hrp = 'taprt') => `${hrp}1${Buffer.from(JSON.stringify(fields)).toString('hex')}`;

/**
 * A stand-in for a proof file: the facts of its last proof as JSON, and
 * whether the fake library will find it valid.
 */
const fakeProof = (fields) => Buffer.from(JSON.stringify({ proof: 1, valid: true, ...fields }));
function readFakeProof(bytes) {
	let f = null;
	try {
		f = JSON.parse(Buffer.from(bytes).toString('utf8'));
	} catch (_) {
		/* not one of ours */
	}
	if (!f || f.proof !== 1) throw tapError('ERR_PROOF_INVALID_RECORD', 'not a proof file');
	return f;
}

function fakeLib() {
	return {
		AssetType: { Normal: 0, Collectible: 1 },
		AddressVersion: { V0: 0, V1: 1, V2: 2 },
		canLookup: true,
		decodeAddress(text) {
			const encoded = String(text || '').trim();
			const m = /^(tap[a-z]{2})1([0-9a-f]+)$/.exec(encoded);
			if (!m) throw tapError('ERR_ADDRESS_INVALID_BECH32M');
			let f;
			try {
				f = JSON.parse(Buffer.from(m[2], 'hex').toString('utf8'));
			} catch (_) {
				throw tapError('ERR_ADDRESS_INVALID_BECH32M');
			}
			return {
				raw: { ...f, encoded },
				encoded,
				version: f.version,
				hrp: m[1],
				assetId: f.assetId,
				groupKey: f.groupKey || null,
				// One key per address, as a V1 address has.
				scriptKey: `02${sha256Hex(`rk:${encoded}`)}`,
				amount: BigInt(f.amount),
				courier: f.courier
			};
		},
		encodeAddress: (raw) => raw.encoded,
		encodeGenesis: (g) => `g:${g.assetId}`,
		decodeGenesis: (text) => ({ assetId: String(text).slice(2) }),
		batchFee: (b) => (b.genesis && b.genesis.fee ? { sats: b.genesis.fee, vbytes: b.genesis.vsize } : null),
		parcelFee: (p) => (p.fee ? { sats: p.fee, vbytes: p.vsize } : null),
		batchAssets: (b) => (b.genesis ? b.genesis.assets : []),
		decodeTx: (text) => text,
		txid: (text) => text,
		metaReveal: (meta, decimals) => (meta || decimals ? { text: meta ? meta.data : '', decimalDisplay: decimals } : undefined),
		metaView: () => null,
		fileFacts: () => ({ timestamp: null, depth: 1 }),
		// What the Lightning glue asks for a peer's proof: where to find its
		// file, and the file decoded.
		proofLocator: (p) => ({ assetId: p.assetId, scriptKey: p.scriptKey, anchorOutPoint: p.anchorOutPoint }),
		decodeProofFile: (bytes) => ({ decoded: readFakeProof(bytes) }),
		proofFacts(bytes) {
			const f = readFakeProof(bytes);
			return { assetId: f.assetId, groupKey: null, scriptKey: f.scriptKey, anchorOutPoint: f.anchorOutPoint, amount: BigInt(f.amount || 0), depth: 1 };
		},
		makeCourier: () => {
			throw new Error('the fake host is given couriers by its harness');
		}
	};
}

/**
 * The fake adapter. `opts` switches failures on: mintFee, parcelFee,
 * fundFails, mintBroadcastFails, storeFails, sendBroadcastFails,
 * courierDown, courierRefuses (the server's words), proofMissing, notBuried.
 * `chain.confirm(txid, height)` puts a transaction in a block.
 */
function fakeTap({ now = () => Date.now(), wallet } = {}) {
	const calls = [];
	const opts = { mintFee: 306, parcelFee: 500 };
	const batches = new Map();
	const parcels = new Map();
	const receives = new Map();
	const records = [];
	const groups = new Map();
	const heights = new Map();
	const paid = new Map();
	const decimals = new Map();
	let n = 0;
	const id = (prefix) => `${prefix}${sha256Hex(`id:${(n += 1)}`)}`;
	const log = (...entry) => calls.push(entry);
	const live = (r) => !r.spent && !r.reservedBy;
	const tap = { calls, opts, batches, parcels, receives, records, groups, proofPublisher: null };

	tap.chain = {
		confirm(txid, height) {
			heights.set(txid, height);
			if (wallet && wallet.data.header.height < height) wallet.data.header.height = height;
		},
		pay(encoded, txid) {
			paid.set(encoded, txid);
		},
		async txBlockHeight(buf) {
			const txid = Buffer.from(buf).reverse().toString('hex');
			if (!heights.has(txid)) throw tapError('ERR_BEIGNET_CHAIN', `transaction ${txid} is unconfirmed`);
			return heights.get(txid);
		}
	};

	tap.minter = {
		async pendingBatch() {
			return [...batches.values()].find((b) => b.state === 0);
		},
		async queue(s) {
			log('minter.queue', s.name);
			let b = await this.pendingBatch();
			if (!b) {
				b = { id: id('02'), state: 0, seedlings: [], createdAt: now() };
				batches.set(b.id, b);
			}
			if (b.seedlings.some((x) => x.name === s.name)) throw tapError('ERR_TAPGARDEN_DUPLICATE_SEEDLING', s.name);
			b.seedlings.push({ name: s.name, type: s.type, amount: String(s.amount), decimalDisplay: (s.meta && s.meta.decimalDisplay) || 0, newGroup: !!s.newGroup, groupKey: s.groupKey || null });
			return { batchId: b.id };
		},
		async freeze({ feeRate, maxFee }) {
			log('minter.freeze', feeRate, maxFee);
			const b = await this.pendingBatch();
			if (!b) throw tapError('ERR_TAPGARDEN_EMPTY_BATCH');
			Object.assign(b, { state: 1, feeRate, maxFee });
			return b;
		},
		async advance(batchId, target = 5) {
			log('minter.advance', batchId, target);
			const b = await this.getBatch(batchId);
			if (b.state >= 6) throw tapError('ERR_TAPGARDEN_BATCH_CANCELLED', batchId);
			while (b.state < target) {
				if (b.state === 1) {
					if (opts.fundFails) throw tapError('ERR_BEIGNET_FUNDING', 'wallet has no spendable fee input');
					if (b.maxFee !== undefined && BigInt(opts.mintFee) > b.maxFee) throw tapError('ERR_WALLET_FEE_ABOVE_LIMIT', 'fee above limit');
					b.genesis = {
						fee: opts.mintFee,
						vsize: 153,
						anchorOutputIndex: 0,
						assets: b.seedlings.map((s) => {
							const assetId = sha256Hex(`asset:${b.id}:${s.name}`);
							decimals.set(assetId, s.decimalDisplay);
							return { assetId, name: s.name, type: s.type, amount: BigInt(s.amount), groupKey: s.newGroup ? `03${sha256Hex(`group:${assetId}`)}` : s.groupKey ? Buffer.from(s.groupKey).toString('hex') : null, genesis: `g:${assetId}` };
						})
					};
					b.state = 2;
				} else if (b.state === 2) {
					b.genesis.signedTx = b.genesis.signedTx || sha256Hex(`tx:${b.id}`);
					if (opts.mintBroadcastFails) throw tapError('ERR_BEIGNET_WALLET', 'electrum is not connected');
					b.state = 3;
				} else if (b.state === 3) {
					if (!heights.has(b.genesis.signedTx)) throw tapError('ERR_BEIGNET_TIMEOUT', 'confirmation wait timed out');
					b.block = { height: heights.get(b.genesis.signedTx) };
					b.state = 4;
				} else if (b.state === 4) {
					for (const a of b.genesis.assets) {
						const rec = { assetId: a.assetId, scriptKey: `02${sha256Hex(`sk:${a.assetId}`)}`, name: a.name, type: a.type, amount: a.amount.toString(), anchorOutPoint: `${b.genesis.signedTx}:0` };
						if (a.groupKey) {
							rec.groupKey = a.groupKey;
							groups.set(a.groupKey, { decimalDisplay: 0 });
						}
						records.push(rec);
						if (tap.proofPublisher) await tap.proofPublisher.deliverProof({ assetId: rec.assetId, scriptKey: rec.scriptKey, anchorOutPoint: rec.anchorOutPoint });
					}
					b.state = 5;
				}
			}
			return b;
		},
		async cancel(batchId) {
			log('minter.cancel', batchId);
			const b = await this.getBatch(batchId);
			if (b.state >= 6) return b;
			if (b.state >= 3 || (b.genesis && b.genesis.signedTx)) throw tapError('ERR_TAPGARDEN_NOT_CANCELLABLE', batchId);
			b.state = b.genesis ? 7 : 6;
			b.updatedAt = now();
			return b;
		},
		async getBatch(batchId) {
			const b = batches.get(batchId);
			if (!b) throw tapError('ERR_TAPGARDEN_BATCH_NOT_FOUND', batchId);
			return b;
		},
		async resume() {
			throw new Error('the host must never resume everything');
		},
		async listGroups() {
			return [...groups.keys()].map((groupKey) => ({ groupKey, canIssue: true }));
		},
		async exportProof() {
			return Buffer.from('proof');
		},
		async repairProofs() {
			log('minter.repairProofs');
			return [];
		}
	};

	const wanted = (p, lib) => {
		if (p.burn) return { assetId: p.burn.assetId, amount: BigInt(p.burn.amount) };
		const a = lib.decodeAddress(p.addresses[0]);
		return { assetId: a.assetId, amount: a.amount };
	};
	const lib = fakeLib();

	tap.freighter = {
		async createAddress({ genesis, amount, proofCourierAddr, groupKey }) {
			log('freighter.createAddress', genesis.assetId, amount);
			const fields = { n: (n += 1), assetId: genesis.assetId, groupKey: groupKey ? Buffer.from(groupKey).toString('hex') : null, amount: amount.toString(), courier: proofCourierAddr, version: 1 };
			const encoded = encodeFake(fields);
			receives.set(encoded, { id: encoded, address: encoded, state: 0, createdAt: now() });
			return { ...fields, encoded };
		},
		async queueSend({ addresses, feeRate, maxFee }) {
			log('freighter.queueSend', addresses[0].encoded);
			const p = { id: id('03'), state: 0, addresses: addresses.map((a) => a.encoded), feeRate, maxFee, createdAt: now() };
			parcels.set(p.id, p);
			return p;
		},
		async queueBurn({ assetId, amount, feeRate, maxFee }) {
			log('freighter.queueBurn', Buffer.from(assetId).toString('hex'), amount);
			const p = { id: id('03'), state: 0, addresses: [], burn: { assetId: Buffer.from(assetId).toString('hex'), amount: amount.toString() }, feeRate, maxFee, createdAt: now() };
			parcels.set(p.id, p);
			return p;
		},
		async advance(parcelId, target = 10) {
			log('freighter.advance', parcelId, target);
			const p = await this.getParcel(parcelId);
			if (p.state === 11) throw tapError('ERR_TAPFREIGHTER_PARCEL_CANCELLED', parcelId);
			while (p.state < target) {
				if (p.state < 5) {
					const want = wanted(p, lib);
					const coins = records.filter((r) => r.assetId === want.assetId && live(r));
					if (coins.reduce((sum, r) => sum + BigInt(r.amount), 0n) < want.amount) throw tapError('ERR_TAPFREIGHTER_INSUFFICIENT_BALANCE');
					if (opts.fundFails) throw tapError('ERR_BEIGNET_FUNDING', 'wallet has no spendable fee input');
					for (const r of coins) r.reservedBy = p.id;
					Object.assign(p, { fee: opts.parcelFee, vsize: 250, signedTx: sha256Hex(`tx:${p.id}`), state: 5 });
				} else if (p.state === 5) {
					if (opts.storeFails) throw tapError('ERR_BEIGNET_WALLET', 'the wallet could not sign the transaction');
					p.state = 6;
				} else if (p.state === 6) {
					if (opts.sendBroadcastFails) throw tapError('ERR_BEIGNET_WALLET', 'electrum is not connected');
					p.state = 7;
				} else if (p.state === 7) {
					if (!heights.has(p.signedTx)) throw tapError('ERR_BEIGNET_TIMEOUT', 'confirmation wait timed out');
					p.block = { height: heights.get(p.signedTx) };
					p.state = 8;
				} else if (p.state === 8) {
					const want = wanted(p, lib);
					const coins = records.filter((r) => r.reservedBy === p.id);
					const total = coins.reduce((sum, r) => sum + BigInt(r.amount), 0n);
					for (const r of coins) Object.assign(r, { spent: true, reservedBy: undefined });
					if (total > want.amount) records.push({ ...coins[0], spent: false, reservedBy: undefined, amount: (total - want.amount).toString(), anchorOutPoint: `${p.signedTx}:1` });
					if (!p.burn) {
						const to = lib.decodeAddress(p.addresses[0]);
						p.proofs = [{ locator: { assetId: to.assetId, scriptKey: to.scriptKey, anchorOutPoint: `${p.signedTx}:0` }, address: to.encoded }];
					}
					p.state = 9;
				} else if (p.state === 9) {
					if (opts.courierDown) throw Object.assign(tapError('ERR_COURIER_HTTP', 'Courier returned HTTP 503'), { status: 503 });
					if (opts.courierRefuses) {
						log('courier.refused', p.id);
						throw Object.assign(tapError('ERR_COURIER_HTTP', `Courier returned HTTP 500: ${opts.courierRefuses}`), { status: 500 });
					}
					p.state = 10;
				}
			}
			return p;
		},
		async cancel(parcelId) {
			log('freighter.cancel', parcelId);
			const p = await this.getParcel(parcelId);
			if (p.state >= 6 && p.state !== 11) throw tapError('ERR_TAPFREIGHTER_NOT_CANCELLABLE', parcelId);
			p.state = 11;
			p.updatedAt = now();
			for (const r of records) if (r.reservedBy === p.id) r.reservedBy = undefined;
			return p;
		},
		async getParcel(parcelId) {
			const p = parcels.get(parcelId);
			if (!p) throw tapError('ERR_TAPFREIGHTER_PARCEL_NOT_FOUND', parcelId);
			return p;
		},
		async receive(raw, target = 3) {
			log('freighter.receive', raw.encoded);
			const r = receives.get(raw.encoded);
			if (!r) throw tapError('ERR_TAPFREIGHTER_ADDRESS_NOT_FOUND');
			if (r.state === 0 && target > 0) {
				if (!paid.has(raw.encoded)) throw tapError('ERR_BEIGNET_TIMEOUT', 'confirmation wait timed out');
				r.locator = { assetId: raw.assetId, scriptKey: lib.decodeAddress(raw.encoded).scriptKey, anchorOutPoint: `${paid.get(raw.encoded)}:0` };
				r.state = 1;
			}
			if (r.state === 1 && target > 1) {
				// As the real library does: the proof comes from the courier it
				// was given, and is checked against the payment it found.
				if (tap.courierFor) {
					const proof = readFakeProof(await tap.courierFor(raw.courier).receiveProof(r.locator));
					if (!proof.valid || proof.anchorOutPoint !== r.locator.anchorOutPoint) throw tapError('ERR_TAPFREIGHTER_INVALID_PROOF', 'proof does not match receive address');
				} else if (opts.proofMissing) throw tapError('ERR_COURIER_PROOF_NOT_FOUND');
				if (opts.notBuried) throw tapError('ERR_TAPGARDEN_NOT_BURIED', 'the anchor is not buried yet');
				r.state = 2;
			}
			if (r.state === 2 && target > 2) {
				records.push({ assetId: raw.assetId, scriptKey: `02${sha256Hex(`rk:${raw.encoded}`)}`, name: 'received', type: 0, amount: String(raw.amount), anchorOutPoint: r.locator.anchorOutPoint });
				r.state = 3;
			}
			return r;
		},
		async exportProof(assetId, scriptKey, anchorOutPoint) {
			log('freighter.exportProof', anchorOutPoint);
			return fakeProof({ assetId: Buffer.from(assetId).toString('hex'), scriptKey: Buffer.from(scriptKey).toString('hex'), anchorOutPoint });
		},
		async resume() {
			throw new Error('the host must never resume everything');
		},
		async reconcile() {
			log('freighter.reconcile');
		},
		async repairProofs() {
			log('freighter.repairProofs');
			return [];
		},
		async lookupAsset({ assetId }) {
			const hexId = Buffer.from(assetId).toString('hex');
			const rec = records.find((r) => r.assetId === hexId);
			if (!rec) throw tapError('ERR_COURIER_PROOF_NOT_FOUND');
			return { assetId, genesis: { assetId: hexId }, name: rec.name, type: rec.type, decimalDisplay: decimals.get(hexId) || 0, issued: BigInt(rec.amount), anchorOutPoint: rec.anchorOutPoint, blockHeight: 100, source: 'wallet' };
		}
	};

	tap.anchor = {
		async protectAnchor(op) {
			log('anchor.protectAnchor', op);
		},
		async releaseFunding(reservation) {
			log('anchor.releaseFunding', reservation);
		},
		async fundGenesis() {
			if (opts.fundFails) throw tapError('ERR_BEIGNET_FUNDING', 'wallet has no spendable fee input');
			return { fee: BigInt(opts.mintFee), vsize: 153 };
		},
		async broadcast(tx) {
			log('anchor.broadcast', tx);
		}
	};
	tap.keys = { derive: async () => ({ publicKey: Buffer.from(`02${'11'.repeat(32)}`, 'hex') }) };
	tap.stores = {
		assets: { listAssets: async () => records, getGroup: async (key) => groups.get(key) },
		batches: { listBatches: async () => [...batches.values()] },
		parcels: { listParcels: async () => [...parcels.values()] },
		receives: { listReceives: async () => [...receives.values()], getReceive: async (key) => receives.get(key) },
		proofs: { getProofFile: async () => undefined }
	};
	tap.tapLockedSats = async () => BigInt(new Set(records.filter((r) => !r.spent).map((r) => r.anchorOutPoint)).size * 1000);
	return tap;
}

/** An invoice the fake Lightning service can read. Leave `msat` out for one that names no amount. */
const fakeInvoice = ({ msat, hash } = {}) =>
	`lnbcrt1${Buffer.from(JSON.stringify({ hash: hash || sha256Hex(`invoice:${msat}`), msat: msat === undefined || msat === null ? null : String(msat) })).toString('hex')}`;

/**
 * The fake asset channels: a stand-in for the library's Lightning entry,
 * `@ts-tap/beignet/lightning`, with its exported names and its shapes (ids,
 * keys and hashes as Buffers, amounts and sats as bigint, times in unix
 * seconds as a bigint), and a node for it to be bound to. A host under test
 * is given the real facade (adapter.js createLightning) built over `entry`,
 * so every test of the host also runs through the glue.
 *
 * What the real entry keeps in the node's database this keeps in its maps,
 * in plain values, and writes a row of under the store it was given, so
 * that a wallet with channels has Lightning rows and a backup has something
 * to carry.
 *
 * `opts` switches behaviour: supported (the engine can carry asset
 * channels), startFails (the message the service refuses to start with),
 * supports (the peer takes asset channels), connectFails, fundFails,
 * fundingFee, reserveSats, openHangs (the open never answers), openGate (a
 * promise the open waits on before the service has heard of it), openFails
 * (a code the open rejects with, nothing signed), openTimesOut (it rejects
 * with a timeout and the flow is kept), openFailsSigned (a code it rejects
 * with after the funding transaction is signed), openFee (what the funding
 * transaction really costs, when that is not what the quote said),
 * connectGate (a promise a connect waits on), cancelFails (a cancel
 * throws), cancelMissed (a cancel of an open the service has no record of
 * yet answers true and stops nothing), cancelNegotiated (a cancel lands on
 * a negotiated channel, and is listed as cancelled and not as failed),
 * closeFails (a code a close rejects with), recoveryErrors (what bringing
 * a closed channel's assets home reports as having gone wrong),
 * openAnswersUnsigned (the open answers as the real service does, once the
 * funding is negotiated and before the peer has signed), engineChannels
 * (channels the node holds that the service does not list, as { channelId,
 * temporaryChannelId }), offlinePeers (the peers that are not connected),
 * peerOffline (no channel's peer is connected), settleKeeps (the reason a
 * funding reservation with no flow is left reserved), rate, priced (whether
 * the peer sets a price), quoteMs, quoteFails, payStatus, payFailure (the
 * text a failed payment's record carries), payFails (a code the payment is
 * refused with before anything is sent), payThrowsAfter (a code it rejects
 * with once the node has the payment, which the real entry never does),
 * payMoved (the peer's price is past the bound), payFeeMsat.
 *
 * A test moves a channel on by hand: `confirm(id)` buries its funding and
 * makes it NORMAL, `set(id, fields)` changes it, `abandon(id, reason)` gives
 * a signed funding up as unable to confirm, `recover(id)` brings a closed
 * channel's assets home, `settle(paymentHash)` pays an invoice,
 * `finish(paymentHash, status)` ends a payment that was left pending, and
 * `offer(proposal)` is a peer offering a channel.
 */
const LN = 'ERR_BEIGNET_LN_';
const ASSET_PAYMENT_REFUSALS = Object.freeze(
	[
		'UNSUPPORTED',
		'NOT_READY',
		'INVALID',
		'UNKNOWN_CHANNEL',
		'NO_QUOTE',
		'QUOTE_EXPIRED',
		'PRICE_BOUND',
		'SPENDING_LIMIT',
		'INSUFFICIENT_OUTBOUND',
		'BAD_INVOICE',
		'INVOICE_EXPIRED',
		'AMOUNT_REQUIRED',
		'ALREADY_PAID',
		'PAYMENT',
		'PAYMENT_UNSUPPORTED',
		'OUTCOMES_UNDELIVERED'
	].map((name) => LN + name)
);
// The rows a backup may carry, as the entry's own list has them.
const CARRIED = [
	'tap/channel/v1/channel/',
	'tap/channel/v1/destination/',
	'tap/channel/v1/destinations/',
	'tap/channel/v1/last/',
	'tap/channel/v1/funding-change/',
	'tap/recovery/v1/channel/',
	'tap/recovery/v1/proof/',
	'tap/recovery/v1/job/'
];
const RESTORED = 'tap/channel/v1/restored';
const FUNDING_PHASES = ['funding-created', 'committed', 'broadcasting', 'broadcast', 'active'];
const ENDED_PHASES = ['rejected', 'failed', 'cancelled'];
const CLOSING_STATES = ['SHUTTING_DOWN', 'NEGOTIATING_CLOSING', 'CLOSED', 'FORCE_CLOSED'];

function fakeLightning({ now = () => Date.now(), tap, storage, held = () => false } = {}) {
	const calls = [];
	const violations = [];
	const opts = {
		supported: true,
		startFails: null,
		supports: true,
		connectFails: false,
		fundFails: false,
		fundingFee: 420,
		reserveSats: undefined,
		openHangs: false,
		openGate: null,
		openFails: null,
		openTimesOut: false,
		openAnswersUnsigned: false,
		peerRefusal: null,
		payNeverSent: false,
		engineChannels: [],
		offlinePeers: [],
		openFailsSigned: null,
		// What the engine refused the loop's own step with, as the cause of what resume() throws.
		resumeFails: null,
		// Whether this wallet has ever held an asset of the group a peer offers.
		knowsGroups: true,
		// What the library says its native witness coins hold, when they are short of a funding.
		fundingInputs: null,
		// The wallet has signed the funding transaction and the peer has not
		// signed its commitment: the open fails there, or gets no answer.
		openFailsUnsigned: null,
		openStopsUnsigned: false,
		// The engine holds the funding transaction and cannot be made to drop the open.
		engineHoldsFunding: false,
		reclaimFails: null,
		reclaimFee: 300,
		// Whether a restored backup carried what rebuilds a funding's change.
		changeRestorable: true,
		// What the node says of offering asset channels. Undefined for an engine that cannot say.
		advertisement: { advertised: true },
		// What the engine says of its fee coin pool. Undefined is an engine with no fee policy.
		feeStatus: undefined,
		openFee: null,
		connectGate: null,
		cancelFails: false,
		cancelMissed: false,
		cancelNegotiated: false,
		closeFails: null,
		recoveryErrors: [],
		peerOffline: false,
		settleKeeps: null,
		rate: { coefficient: 100_000_000n, scale: 0 },
		priced: null,
		quoteMs: 60_000,
		quoteFails: null,
		payStatus: 'complete',
		payFailure: 'no route to the destination',
		payFails: null,
		// What the engine itself threw, carried as the cause of a refusal.
		payCause: null,
		payThrowsAfter: null,
		payMoved: false,
		payFeeMsat: 2000n
	};
	const flows = new Map();
	// Opens given up, by id: one still running stops at its next step, and
	// the id is spent. Kept by the running service, so a restart forgets it.
	const cancelled = new Set();
	const hung = new Map();
	const quotes = new Map();
	const invoices = new Map();
	const payments = new Map();
	// What the newest host of this entry was given. `options` are the
	// library's own start options, as the glue hands them over.
	const state = { started: false, bound: false, options: null, adapter: null, node: null, made: null, store: null };
	let n = 0;
	const id = (what) => sha256Hex(`ln:${what}:${(n += 1)}`);
	const log = (...entry) => calls.push(entry);
	const hexOf = (bytes) => Buffer.from(bytes).toString('hex');
	const bytes = (text) => Buffer.from(String(text), 'hex');
	const seconds = (ms) => BigInt(Math.floor(ms / 1000));
	const refuse = (name, message) => tapError(LN + name, message);
	// The library's own types name every member a call takes. A member it
	// does not name is a mistake of the caller's, and is refused here so
	// that the glue cannot hand over one the library would silently drop.
	const only = (name, given, allowed) => {
		for (const key of Object.keys(given || {})) if (!allowed.includes(key)) throw refuse('INVALID', `${name} takes no ${key}`);
	};
	// The real service keeps its records in the node's database, a
	// transaction at a time: a call made inside one of the host's would be a
	// transaction inside another.
	const stored = (name) => {
		if (!storage) return;
		try {
			storage.transaction(() => undefined);
		} catch (err) {
			if (/inside another transaction/.test(err.message)) violations.push(`${name} inside a storage transaction`);
			throw err;
		}
	};
	const isNominal = () => BigInt(opts.rate.coefficient) === 100_000_000n * 10n ** BigInt(opts.rate.scale);
	const priced = () => (opts.priced === null ? !isNominal() : !!opts.priced);
	const msatOf = (units) => (BigInt(units) * 100_000_000n * 1000n * 10n ** BigInt(opts.rate.scale)) / BigInt(opts.rate.coefficient);
	const unitsOf = (msat) => {
		const units = (BigInt(msat) * BigInt(opts.rate.coefficient)) / (100_000_000n * 1000n * 10n ** BigInt(opts.rate.scale));
		return units > 0n ? units : 1n;
	};
	const byChannel = (channelId) => [...flows.values()].find((f) => f.channelId === channelId) || null;
	const total = (assets) => assets.reduce((sum, a) => sum + BigInt(a.amount), 0n);

	/* The on-chain records an open holds: reserved under its name from the
	 * moment its inputs are selected until its funding has confirmed. */
	const nameOf = (flow) => `funding:${flow.pendingChannelId}`;
	const reservedBy = (name) => tap.records.filter((r) => !r.spent && r.reservedBy === name);
	const reserve = (flow) => {
		if (flow.reserving) return;
		for (const a of flow.assets) {
			let left = BigInt(a.amount);
			for (const r of tap.records.filter((x) => x.assetId === a.assetId && !x.spent && !x.reservedBy)) {
				if (left <= 0n) break;
				r.reservedBy = nameOf(flow);
				left -= BigInt(r.amount);
			}
			if (left > 0n) {
				for (const r of reservedBy(nameOf(flow))) r.reservedBy = undefined;
				throw tapError('ERR_TAPFREIGHTER_INSUFFICIENT_BALANCE', 'not enough of the asset');
			}
		}
		flow.reserving = true;
	};
	const release = (flow) => {
		for (const r of reservedBy(nameOf(flow))) r.reservedBy = undefined;
		flow.reserving = false;
	};
	/** The funding is buried: its inputs are spent, and what they held beyond the channel is change. */
	const bury = (flow) => {
		if (!flow.reserving) return;
		const inputs = reservedBy(nameOf(flow));
		for (const a of flow.assets) {
			const mine = inputs.filter((r) => r.assetId === a.assetId);
			const had = mine.reduce((sum, r) => sum + BigInt(r.amount), 0n);
			if (had > BigInt(a.amount) && mine[0]) {
				tap.records.push({ ...mine[0], spent: false, reservedBy: undefined, amount: (had - BigInt(a.amount)).toString(), anchorOutPoint: `${flow.fundingTxid}:1` });
			}
		}
		for (const r of inputs) Object.assign(r, { spent: true, reservedBy: undefined });
		flow.reserving = false;
	};

	/* ------------------------------------------------------------- the store */

	const own = (store) => {
		if (!store || typeof store.transaction !== 'function') throw refuse('INVALID', 'store must be the store lightningStore() returns');
		return store;
	};
	const stringify = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
	const lastSeen = (f) => ({
		version: 1,
		pendingChannelId: f.pendingChannelId,
		peer: f.peerPubkey,
		initiator: f.initiator,
		fundingSatoshis: String(f.fundingSats),
		fundingTxid: f.fundingTxid || undefined,
		assets: f.assets.map((a) => ({ assetId: a.assetId, amount: a.amount.toString() })),
		groupKey: f.groupKey || undefined,
		decimalDisplay: f.decimalDisplay || 0,
		local: f.local.toString(),
		remote: f.remote.toString(),
		state: f.state || f.lastState || 'NORMAL'
	});
	/** Write what the entry would have in its store by now. Never inside a transaction of the host's. */
	const persist = () => {
		const store = state.store;
		if (!store) return;
		const rows = new Map();
		for (const f of flows.values()) {
			if (f.channelId && (f.state || f.restored)) {
				rows.set(`tap/channel/v1/last/${f.channelId}`, stringify(lastSeen(f)));
				rows.set(`tap/channel/v1/channel/${f.channelId}`, f.pendingChannelId);
				if (f.recovery !== 'none') rows.set(`tap/recovery/v1/channel/${f.channelId}`, stringify({ status: f.recovery }));
			}
			if (!f.restored && f.phase !== 'active') rows.set(`tap/funding/v1/flow/${f.pendingChannelId}`, stringify({ phase: f.phase, signed: f.signed }));
		}
		for (const q of quotes.keys()) rows.set(`tap/quotes/${q}`, '1');
		for (const i of invoices.keys()) rows.set(`lightning/invoice/${i}`, '1');
		for (const [hash, p] of payments) rows.set(`tap/channel/v1/sent/${hash}`, stringify({ status: p.status }));
		store.transaction((tx) => {
			for (const key of tx.keys('')) if (key !== RESTORED && !rows.has(key)) tx.remove(key);
			for (const [key, value] of rows) if (tx.get(key) !== value) tx.put(key, value);
		});
	};
	/** The channels a restored store knows of: listed, and not held by the engine. */
	const load = (store) => {
		store.transaction((tx) => {
			for (const key of tx.keys('tap/channel/v1/last/')) {
				const channelId = key.slice('tap/channel/v1/last/'.length);
				const seen = JSON.parse(tx.get(key));
				const status = tx.get(`tap/recovery/v1/channel/${channelId}`);
				const over = CLOSING_STATES.includes(seen.state) || !!status;
				const assets = seen.assets.map((a) => ({ assetId: a.assetId, amount: BigInt(a.amount) }));
				flows.set(seen.pendingChannelId, {
					pendingChannelId: seen.pendingChannelId,
					channelId,
					peerPubkey: seen.peer,
					initiator: !!seen.initiator,
					phase: 'active',
					engine: over ? 'absent' : 'missing',
					signed: true,
					committed: true,
					confirmed: true,
					fundingTxid: seen.fundingTxid || null,
					state: over ? (seen.state === 'FORCE_CLOSED' ? 'FORCE_CLOSED' : 'CLOSED') : null,
					lastState: seen.state,
					assetId: assets[0].assetId,
					groupKey: seen.groupKey || null,
					assets,
					decimalDisplay: seen.decimalDisplay || 0,
					local: BigInt(seen.local),
					remote: BigInt(seen.remote),
					reserved: 0n,
					fundingSats: Number(seen.fundingSatoshis),
					reserveSats: null,
					recovery: over ? (status ? JSON.parse(status).status : BigInt(seen.local) > 0n ? 'pending' : 'complete') : 'none',
					error: null,
					reserving: false,
					restored: true
				});
			}
		});
	};

	/* --------------------------------------------------------------- the node */

	const dialed = new Set();
	const node = {
		async connectPeer(pubkey, host, port) {
			if (held()) violations.push("connect with the host's lock held");
			stored('connect');
			log('connect', { pubkey, host, port });
			if (opts.connectGate) await opts.connectGate;
			if (opts.connectFails) throw new Error('connection refused');
			dialed.add(pubkey);
		},
		// Every peer of a channel, and every peer that was dialed, unless a test says it is away.
		listPeers() {
			if (opts.peerOffline) return [];
			const all = new Set([...dialed, ...[...flows.values()].map((f) => f.peerPubkey)]);
			return [...all].filter((pubkey) => !opts.offlinePeers.includes(pubkey)).map((pubkey) => ({ pubkey, host: 'peer.example.com', port: 9735, state: 'ready', remoteInit: {} }));
		},
		// What the node itself holds: the channels the service lists with a state, and what a test adds.
		listChannels() {
			const held = [...flows.values()].filter((f) => f.state && f.engine !== 'missing' && f.engine !== 'absent');
			return [
				...held.map((f) => ({ channelId: bytes(f.channelId || f.pendingChannelId), temporaryChannelId: bytes(f.pendingChannelId), peerPubkey: f.peerPubkey, state: f.state })),
				...opts.engineChannels.map((c) => ({ channelId: bytes(c.channelId || c.temporaryChannelId), temporaryChannelId: bytes(c.temporaryChannelId || c.channelId), peerPubkey: c.peerPubkey || '', state: c.state || 'SENT_FUNDING_CREATED' }))
			];
		}
	};

	/* ------------------------------------------------------------ the service */

	const emit = (event) => {
		if (state.started && state.options && typeof state.options.onEvent === 'function') state.options.onEvent(event);
	};
	const view = (f) => {
		const stateWord = f.state || undefined;
		const one = f.assets.length === 1;
		const name = f.reserving ? nameOf(f) : undefined;
		const inputs = new Map();
		if (name) for (const r of reservedBy(name)) inputs.set(r.assetId, (inputs.get(r.assetId) || 0n) + BigInt(r.amount));
		return {
			pendingChannelId: bytes(f.pendingChannelId),
			...(f.channelId ? { channelId: bytes(f.channelId) } : {}),
			peer: bytes(f.peerPubkey),
			initiator: f.initiator,
			phase: f.phase,
			engine: f.engine || (stateWord ? 'held' : f.phase === 'negotiated' || FUNDING_PHASES.includes(f.phase) ? 'missing' : 'absent'),
			signed: f.signed,
			committed: !!f.committed,
			confirmed: f.confirmed,
			...(f.fundingTxid ? { fundingTxid: f.fundingTxid } : {}),
			...(stateWord ? { state: stateWord } : {}),
			fundingSatoshis: BigInt(f.fundingSats),
			...(f.reserveSats === null || f.reserveSats === undefined ? {} : { reserveSatoshis: BigInt(f.reserveSats) }),
			assets: f.assets.map((a) => ({ assetId: bytes(a.assetId), amount: BigInt(a.amount), ...(one ? { local: f.local, remote: f.remote } : {}) })),
			...(f.groupKey ? { groupKey: bytes(f.groupKey) } : {}),
			decimalDisplay: f.decimalDisplay || 0,
			localAssetBalance: f.local,
			remoteAssetBalance: f.remote,
			reserved: f.reserved,
			...(name ? { fundingReservation: name, fundingInputs: [...inputs].map(([assetId, amount]) => ({ assetId: bytes(assetId), amount })) } : {}),
			recovery: f.recovery,
			// As the library: the count is on the view only while above zero.
			...(Number.isInteger(f.undeliveredOutcomes) && f.undeliveredOutcomes > 0 ? { undeliveredOutcomes: f.undeliveredOutcomes } : {}),
			// As the library: set while the engine holds the channel open and says.
			...(Number.isInteger(f.sendablePayments) ? { sendablePayments: f.sendablePayments } : {}),
			...(Number.isInteger(f.receivablePayments) ? { receivablePayments: f.receivablePayments } : {}),
			...(f.error ? { error: f.error } : {}),
			...(f.reasonCode ? { reasonCode: f.reasonCode } : {})
		};
	};

	function makeService(me, adapter, options) {
		let closed = false;
		const active = () => {
			if (closed || !me.node) throw refuse('NOT_READY', 'asset channels have not started on this wallet');
		};
		// What can reach the node, and be called back by it, is never called
		// with the host's lock held.
		const reaches = (name) => {
			if (held()) violations.push(`${name} with the host's lock held`);
			stored(name);
			active();
		};
		// What only reads the service's records still needs the service: after a
		// stop, or before the node is bound, it throws as the real one does.
		const reads = (name) => {
			stored(name);
			active();
		};
		const refusePaid = (hash) => {
			const own = payments.get(hash);
			if (own && own.status !== 'failed') throw refuse('ALREADY_PAID', 'this wallet has paid the invoice, or is paying it');
		};
		const paymentView = (p) => ({
			paymentHash: bytes(p.paymentHash),
			assetAmount: p.assetAmount,
			status: p.status,
			// Which try the record stands for, and the circuit it left on.
			attempt: p.attempt || 1,
			channelId: bytes(p.channelId || '00'.repeat(32)),
			htlcId: BigInt((p.attempt || 1) - 1),
			...(p.status === 'pending' && p.engineHasNoRecord ? { engineHasNoRecord: true } : {}),
			...(p.assetRecordsUnconfirmed ? { assetRecordsUnconfirmed: true } : {}),
			...(p.status === 'pending' || p.feeMsat === undefined || p.feeMsat === null ? {} : { feeMsat: p.feeMsat }),
			...(p.status === 'failed' ? { failure: p.failure || 'the payment failed' } : {}),
			...(p.status === 'failed' && p.neverSent ? { neverSent: true } : {})
		});
		const service = {
			channels() {
				reads('channels');
				return [...flows.values()].map(view);
			},
			peerSupports(peer) {
				reads('peerSupports');
				log('peerSupports', hexOf(peer));
				return !!opts.supports;
			},
			// Whose refusal it is: the peer's (away, or no asset channels), or this node's own.
			peerRefusal(peer) {
				reads('peerRefusal');
				log('peerRefusal', hexOf(peer));
				if (opts.peerRefusal) return { ...opts.peerRefusal };
				return opts.supports ? undefined : { code: `${LN}PEER_UNSUPPORTED`, message: 'the peer does not take asset channels' };
			},
			async quoteFunding(request) {
				reaches('quoteFunding');
				only('quoteFunding', request, ['assets', 'groupKey', 'fundingSatoshis', 'feeRate']);
				log('quoteFunding', {
					assets: request.assets.map((a) => ({ assetId: hexOf(a.assetId), amount: a.amount })),
					groupKey: request.groupKey ? hexOf(request.groupKey) : null,
					fundingSats: Number(request.fundingSatoshis),
					feeRate: request.feeRate
				});
				// One asset ID a channel, as the library has it.
				if (request.assets.length !== 1) throw tapError(`${LN}CHANNEL_ASSETS`, 'units of more than one asset ID cannot be one channel');
				if (opts.fundingInputs) throw Object.assign(tapError(`${LN}FUNDING_INPUTS`, 'native witness coins do not hold the funding'), { details: opts.fundingInputs });
				if (opts.fundFails) throw tapError('ERR_BEIGNET_FUNDING', 'wallet has no spendable fee input');
				return { feeSatoshis: BigInt(opts.fundingFee), vsize: 210, reserveSatoshis: BigInt(opts.reserveSats === undefined ? 1000 : opts.reserveSats) };
			},
			async openChannel(request) {
				reaches('openChannel');
				only('openChannel', request, ['peer', 'pendingChannelId', 'assets', 'fundingSatoshis', 'feeRate', 'maxFee', 'pushMsat', 'decimalDisplay', 'groupKey', 'timeoutMs']);
				const pending = hexOf(request.pendingChannelId);
				if (request.assets.length !== 1) throw tapError(`${LN}CHANNEL_ASSETS`, 'units of more than one asset ID cannot be one channel');
				const plain = {
					pendingChannelId: pending,
					peerPubkey: hexOf(request.peer),
					assets: request.assets.map((a) => ({ assetId: hexOf(a.assetId), amount: BigInt(a.amount) })),
					groupKey: request.groupKey ? hexOf(request.groupKey) : null,
					decimalDisplay: request.decimalDisplay,
					fundingSats: Number(request.fundingSatoshis),
					pushSats: Number((request.pushMsat || 0n) / 1000n),
					feeRate: request.feeRate,
					maxFeeSats: request.maxFee === undefined ? undefined : Number(request.maxFee)
				};
				log('openChannel', pending, storage ? storage.list('h/').map((r) => r.key) : []);
				const live = () => {
					if (cancelled.has(pending)) throw refuse('CANCELLED', 'the channel open was cancelled');
				};
				live();
				if (opts.openHangs) return new Promise((_, reject) => hung.set(pending, reject));
				// Asked to open, and not yet anything the service has a record of.
				if (opts.openGate) {
					await opts.openGate;
					live();
				}
				const known = flows.get(pending);
				if (known && known.signed && known.channelId) return { pendingChannelId: request.pendingChannelId, channelId: bytes(known.channelId) };
				const flow = known || {
					pendingChannelId: pending,
					channelId: null,
					peerPubkey: plain.peerPubkey,
					initiator: true,
					phase: 'accepted',
					signed: false,
					committed: false,
					confirmed: false,
					fundingTxid: null,
					state: null,
					assetId: plain.assets[0].assetId,
					groupKey: plain.groupKey,
					assets: plain.assets,
					decimalDisplay: plain.decimalDisplay || 0,
					local: total(plain.assets),
					remote: 0n,
					reserved: 0n,
					fundingSats: plain.fundingSats,
					reserveSats: null,
					recovery: 'none',
					error: null,
					reserving: false,
					request: plain
				};
				flows.set(pending, flow);
				try {
					// Its inputs are selected, and set aside in the on-chain records.
					reserve(flow);
					if (opts.openFails) {
						Object.assign(flow, { phase: 'rejected', error: 'the peer said no' });
						release(flow);
						cancelled.add(pending);
						throw tapError(opts.openFails, 'the channel was turned down: the peer said no');
					}
					// No answer in time: the flow is kept, for resume to carry on.
					if (opts.openTimesOut) throw refuse('TIMEOUT', 'the peer did not answer in time');
					// The transaction built costs more than the open may pay: refused before anything is signed.
					const fee = opts.openFee === null ? opts.fundingFee : opts.openFee;
					if (plain.maxFeeSats !== undefined && fee > plain.maxFeeSats) {
						flow.phase = 'cancelled';
						release(flow);
						cancelled.add(pending);
						throw refuse('FEE_BOUND', 'the funding fee is above the bound: 99000 > 250000 at input 3');
					}
					// This wallet signs the funding transaction. That binds nothing:
					// the peer is shown it without its witnesses, so the open can
					// still be given up and its inputs released.
					Object.assign(flow, { fundingTxid: id('funding'), phase: 'funding-created', state: 'SENT_FUNDING' });
					if (opts.openFailsUnsigned) {
						Object.assign(flow, { phase: 'failed', error: 'the peer hung up before it signed', state: null });
						release(flow);
						cancelled.add(pending);
						throw tapError(opts.openFailsUnsigned, 'the open ended before the peer signed: the peer hung up');
					}
					// Answered as the real service answers: once the funding is negotiated,
					// a moment before the peer's signature on the first commitment.
					if (opts.openAnswersUnsigned) {
						flow.channelId = flow.channelId || id('channel');
						return { pendingChannelId: request.pendingChannelId, channelId: bytes(flow.channelId) };
					}
					// No word on the peer's signature in time: kept, for resume to carry on.
					if (opts.openStopsUnsigned) throw refuse('TIMEOUT', 'the peer did not sign in time');
					// The point of no return: the engine holds the peer's signature on the first commitment.
					Object.assign(flow, { signed: true, committed: true, phase: 'committed' });
					if (opts.openFailsSigned) throw tapError(opts.openFailsSigned, 'the network did not take the transaction');
					Object.assign(flow, { phase: 'broadcast', channelId: id('channel'), state: 'AWAITING_FUNDING_CONFIRMED' });
					return { pendingChannelId: request.pendingChannelId, channelId: bytes(flow.channelId) };
				} finally {
					persist();
				}
			},
			async cancelChannel(pendingChannelId) {
				reaches('cancelFlow');
				const pending = hexOf(pendingChannelId);
				log('cancelFlow', pending);
				if (opts.cancelFails) throw new Error('the database is busy');
				const flow = flows.get(pending);
				if (flow && flow.signed) return false;
				// The engine holds the funding transaction and waits for the peer's
				// signature: it would publish the moment the peer signs.
				if (flow && flow.fundingTxid && !ENDED_PHASES.includes(flow.phase) && opts.engineHoldsFunding) return false;
				if (!flow && opts.cancelMissed) return true;
				cancelled.add(pending);
				if (flow && !ENDED_PHASES.includes(flow.phase)) {
					release(flow);
					// Listed as cancelled only when the channel was negotiated by
					// then. Before that it reads as failed, with the reason. The
					// engine lets go of the channel it held for the open.
					if (opts.cancelNegotiated) Object.assign(flow, { phase: 'cancelled', state: null });
					else Object.assign(flow, { phase: 'failed', error: 'cancelled', state: null });
					persist();
					emit({ type: 'channel', pendingChannelId: bytes(pending), phase: 'cancelled' });
				}
				const stop = hung.get(pending);
				hung.delete(pending);
				if (stop) stop(refuse('CANCELLED', 'the channel open was cancelled'));
				return true;
			},
			async closeChannel(request) {
				reaches('closeChannel');
				only('closeChannel', request, ['channelId', 'force']);
				const { channelId, force } = request;
				const wanted = hexOf(channelId);
				log('closeChannel', wanted, !!force);
				const flow = byChannel(wanted);
				if (!flow || !flow.state || flow.engine === 'missing' || flow.engine === 'absent') throw refuse('UNKNOWN_CHANNEL', 'no asset channel has this channel ID');
				if (opts.closeFails) throw tapError(opts.closeFails, 'commitment 41 has 2 htlcs in flight');
				flow.state = force ? 'FORCE_CLOSED' : 'CLOSED';
				flow.recovery = 'pending';
				persist();
			},
			forgetChannel(wanted) {
				reads('forgetChannel');
				const key = hexOf(wanted);
				const flow = [...flows.values()].find((f) => f.channelId === key || f.pendingChannelId === key);
				log('forgetChannel', key);
				if (!flow) return false;
				// Not while the engine holds it, or while assets of it are coming back.
				if (view(flow).engine === 'held' || flow.recovery === 'pending') return false;
				// Not a signed funding that may still confirm: only one given up, or a channel that is lost.
				if (flow.signed && !flow.restored && !(flow.phase === 'failed' && !flow.reserving)) return false;
				// Not an open still under way.
				if (!flow.signed && !ENDED_PHASES.includes(flow.phase)) return false;
				flows.delete(flow.pendingChannelId);
				persist();
				return true;
			},
			async resume() {
				reaches('resume');
				log('resume');
				if (opts.resumeFails) throw Object.assign(tapError(`${LN}CHANNEL`, 'the engine would not bump the anchor of channel 03aa'), { cause: tapError(opts.resumeFails, 'pool 0 of 40000') });
			},
			recovery: {
				async resume() {
					reaches('resumeRecovery');
					log('resumeRecovery');
					// It never rejects: what went wrong is in each report.
					return [...flows.values()]
						.filter((f) => f.channelId && f.recovery === 'pending')
						.map((f) => ({ channelId: f.channelId, completed: [], pending: ['a sweep'], superseded: [], errors: opts.recoveryErrors.map((message) => ({ message })) }));
				}
			},
			// The way out of an open whose funding will not confirm: a spend of
			// the funding's Bitcoin inputs back to the wallet. Nothing is released.
			async reclaimFundingInputs(request) {
				reaches('reclaimFunding');
				only('reclaimFundingInputs', request, ['pendingChannelId', 'feeRate']);
				const pending = hexOf(request.pendingChannelId);
				log('reclaimFunding', pending, request.feeRate);
				const flow = flows.get(pending);
				if (!flow || !flow.initiator || flow.restored) throw refuse('UNKNOWN_CHANNEL', 'no channel open of this wallet has this pending channel ID');
				if (!flow.fundingTxid) throw refuse('FUNDING', 'the funding transaction is not signed: cancelChannel gives the open up');
				if (ENDED_PHASES.includes(flow.phase)) throw refuse('FUNDING', 'the open has ended, and its inputs are released');
				if (flow.confirmed) throw refuse('FUNDING', 'the funding transaction is confirmed: the channel is open');
				if (opts.reclaimFails) throw tapError(opts.reclaimFails, 'the wallet made no spend: 1 sat/vB is not above the 2 of input 4f2a:0');
				const txid = id('reclaim');
				flow.reclaimed = txid;
				// As the wire has it: the reverse of what a person is shown.
				return { txid: Buffer.from(txid, 'hex').reverse(), transaction: { txIn: [], txOut: [] }, feeSat: BigInt(opts.reclaimFee) };
			},
			advertisement() {
				reads('advertisement');
				return opts.advertisement ? { ...opts.advertisement } : undefined;
			},
			async settleFundingReservations() {
				reaches('settleFundingReservations');
				log('settleFundingReservations');
				const owners = new Set(tap.records.filter((r) => !r.spent && /^funding:[0-9a-f]{64}$/.test(r.reservedBy || '')).map((r) => r.reservedBy));
				const reports = [];
				for (const owner of owners) {
					const pending = owner.slice('funding:'.length);
					const flow = flows.get(pending);
					// One whose flow this wallet still has is left to that flow.
					if (flow && !flow.restored) continue;
					const records = reservedBy(owner);
					const sums = new Map();
					for (const r of records) sums.set(r.assetId, (sums.get(r.assetId) || 0n) + BigInt(r.amount));
					const report = {
						reservation: owner,
						pendingChannelId: bytes(pending),
						assets: [...sums].map(([assetId, amount]) => ({ assetId: bytes(assetId), amount })),
						...(flow ? { channelId: bytes(flow.channelId) } : {}),
						...(flow && flow.fundingTxid ? { fundingTxid: flow.fundingTxid } : {})
					};
					if (opts.settleKeeps) {
						reports.push({ ...report, outcome: 'kept', reason: opts.settleKeeps });
					} else if (flow && flow.fundingTxid) {
						// The funding transaction on record spent them: the units are the channel's.
						for (const r of records) Object.assign(r, { spent: true, reservedBy: undefined });
						const change = [...sums]
							.map(([assetId, amount]) => ({ assetId: bytes(assetId), amount: amount - (flow.assets.find((a) => a.assetId === assetId) || { amount: 0n }).amount }))
							.filter((c) => c.amount > 0n);
						// The outputs of that transaction that are the wallet's come back
						// with it, when the backup carried what rebuilds them.
						const restored = change.length === 0 || !!opts.changeRestorable;
						if (restored) {
							for (const c of change) {
								const assetId = hexOf(c.assetId);
								tap.records.push({ ...records[0], spent: false, reservedBy: undefined, assetId, amount: c.amount.toString(), anchorOutPoint: `${flow.fundingTxid}:1`, scriptKey: `02${sha256Hex(`change:${flow.fundingTxid}:${assetId}`)}` });
							}
						}
						reports.push({ ...report, outcome: 'moved', changeRestored: restored, ...(change.length ? { change } : {}) });
					} else {
						for (const r of records) r.reservedBy = undefined;
						reports.push({ ...report, outcome: 'released' });
					}
				}
				return reports;
			},

			async quoteInvoice(request) {
				reaches('quoteInvoice');
				only('quoteInvoice', request, ['asset', 'amount', 'peer', 'expirySeconds']);
				const { asset, amount, peer, expirySeconds } = request;
				const assetId = asset.assetId ? hexOf(asset.assetId) : null;
				const groupKey = asset.groupKey ? hexOf(asset.groupKey) : null;
				const peerPubkey = peer ? hexOf(peer) : null;
				log('quoteInvoice', { assetId, groupKey, amount, peerPubkey, expirySeconds });
				if (opts.quoteFails) throw tapError(opts.quoteFails, 'the peer gave no price');
				const quoteId = id('quote');
				// The quote stands as long as it was asked to, and no longer than the peer gives.
				const lasts = Math.min(opts.quoteMs, (expirySeconds || 3600) * 1000);
				const expiresAt = seconds(now() + lasts);
				quotes.set(quoteId, { kind: 'receive', assetId, groupKey, amount: BigInt(amount), peerPubkey, expiresAt });
				persist();
				return { quoteId: bytes(quoteId), peer: bytes(peerPubkey), assetAmount: BigInt(amount), milliSatoshi: msatOf(amount), assetRate: { ...opts.rate }, expiresAt, priced: priced() };
			},
			async createInvoice(request) {
				reaches('createInvoice');
				only('createInvoice', request, ['quoteId', 'description', 'expirySeconds']);
				const { quoteId, description, expirySeconds } = request;
				const wanted = hexOf(quoteId);
				log('createInvoice', { quoteId: wanted, description, expirySeconds });
				// A refusal of the library's own, before the price is used: a code, or a function that gives one.
				if (opts.invoiceFails) throw tapError(typeof opts.invoiceFails === 'function' ? opts.invoiceFails() : opts.invoiceFails, 'the invoice could not be made');
				const quote = quotes.get(wanted);
				if (!quote || quote.kind !== 'receive' || quote.expiresAt <= seconds(now())) throw refuse('QUOTE_EXPIRED', 'the invoice quote is used up or too old: ask for a new one');
				quotes.delete(wanted);
				const paymentHash = id('hash');
				const amountMsat = msatOf(quote.amount);
				// It lives as long as asked, or as long as its quote when that is shorter.
				const asked = seconds(now()) + BigInt(expirySeconds === undefined ? 3600 : expirySeconds);
				const expiresAt = asked < quote.expiresAt ? asked : quote.expiresAt;
				invoices.set(paymentHash, { paymentHash, assetAmount: quote.amount, amountMsat, status: 'open', peerPubkey: quote.peerPubkey, expiresAt });
				persist();
				return { bolt11: fakeInvoice({ msat: amountMsat, hash: paymentHash }), paymentHash: bytes(paymentHash), assetAmount: quote.amount, milliSatoshi: amountMsat, expiresAt };
			},
			invoices() {
				reads('invoices');
				// What was invoiced, and beside it what arrived: nothing while no HTLC has settled it.
				return [...invoices.values()].map((i) => ({
					paymentHash: bytes(i.paymentHash),
					assetAmount: i.assetAmount,
					receivedAssetAmount: i.received === undefined ? 0n : i.received,
					milliSatoshi: i.amountMsat,
					expiresAt: i.expiresAt,
					status: i.status
				}));
			},

			async quotePayment(request) {
				reaches('quotePayment');
				only('quotePayment', request, ['invoice', 'asset', 'amountMsat', 'channelId']);
				const { invoice: bolt11, asset, amountMsat } = request;
				const assetId = asset.assetId ? hexOf(asset.assetId) : null;
				const groupKey = asset.groupKey ? hexOf(asset.groupKey) : null;
				log('quotePayment', { bolt11, assetId, groupKey, amountMsat: amountMsat === undefined ? null : amountMsat });
				const m = /^lnbcrt1([0-9a-f]+)$/.exec(String(bolt11));
				let invoice = null;
				try {
					invoice = m ? JSON.parse(Buffer.from(m[1], 'hex').toString('utf8')) : null;
				} catch (_) {
					invoice = null;
				}
				if (!invoice || !invoice.hash) throw refuse('BAD_INVOICE', 'not an invoice');
				refusePaid(invoice.hash);
				const msat = invoice.msat !== null ? BigInt(invoice.msat) : amountMsat === undefined || amountMsat === null ? null : BigInt(amountMsat);
				if (msat === null) throw refuse('AMOUNT_REQUIRED', 'the invoice names no amount');
				if (opts.quoteFails) throw tapError(opts.quoteFails, 'the peer gave no price');
				const flow = [...flows.values()].find((f) => f.state === 'NORMAL' && f.confirmed && (groupKey ? f.groupKey === groupKey : f.assetId === assetId));
				if (!flow) throw refuse('INSUFFICIENT_OUTBOUND', 'no open asset channel carries this asset');
				const quoteId = id('quote');
				const assetAmount = unitsOf(msat);
				quotes.set(quoteId, { kind: 'pay', paymentHash: invoice.hash, assetAmount, channelId: flow.channelId, expiresAt: seconds(now() + opts.quoteMs) });
				persist();
				return {
					quoteId: bytes(quoteId),
					paymentHash: bytes(invoice.hash),
					peer: bytes(flow.peerPubkey),
					channelId: bytes(flow.channelId),
					assetAmount,
					milliSatoshi: msat,
					feeMsat: opts.payFeeMsat,
					assetRate: { ...opts.rate },
					expiresAt: seconds(now() + opts.quoteMs),
					priced: priced()
				};
			},
			async payInvoice(request) {
				reaches('payInvoice');
				only('payInvoice', request, ['quoteId', 'maxAssetAmount']);
				const { quoteId, maxAssetAmount } = request;
				const wanted = hexOf(quoteId);
				log('payInvoice', wanted, maxAssetAmount, storage ? storage.list('h/').map((r) => r.key) : []);
				const quote = quotes.get(wanted);
				if (!quote || quote.kind !== 'pay') throw refuse('QUOTE_EXPIRED', 'the payment quote is used up or too old: ask for a new one');
				refusePaid(quote.paymentHash);
				quotes.delete(wanted);
				// Refused while nothing has left: the record of an earlier try, if any, stands.
				if (opts.payMoved || quote.assetAmount > BigInt(maxAssetAmount)) throw refuse('PRICE_BOUND', 'the price is past the bound');
				if (opts.payFails) throw Object.assign(tapError(opts.payFails, 'the payment was not sent: no usable route'), opts.payCause ? { cause: opts.payCause } : {});
				// The node has the payment from here on. The record is written in
				// the one write before it is handed over, and stands for this try.
				const before = payments.get(quote.paymentHash);
				const status = opts.payThrowsAfter ? 'pending' : opts.payStatus;
				const payment = {
					paymentHash: quote.paymentHash,
					assetAmount: quote.assetAmount,
					status,
					attempt: (before ? before.attempt || 1 : 0) + 1,
					feeMsat: opts.payFeeMsat,
					failure: status === 'failed' ? opts.payFailure : null,
					neverSent: status === 'failed' && !!opts.payNeverSent,
					channelId: quote.channelId,
					// Taken by the engine, and not confirmed to carry the asset records.
					...(opts.payThrowsAfter === `${LN}RECORDS_UNCONFIRMED` ? { assetRecordsUnconfirmed: true } : {})
				};
				payments.set(payment.paymentHash, payment);
				persist();
				if (opts.payThrowsAfter) throw tapError(opts.payThrowsAfter, 'no word from the node in time');
				if (payment.status === 'complete') ln.move(payment.channelId, -payment.assetAmount);
				return paymentView(payment);
			},
			payment(paymentHash) {
				reads('payment');
				const p = payments.get(hexOf(paymentHash));
				return p ? paymentView(p) : undefined;
			},
			paymentLimits() {
				reads('paymentLimits');
				const limits = new Map();
				for (const f of flows.values()) {
					if (f.state !== 'NORMAL' || !f.confirmed || opts.peerOffline) continue;
					const name = f.groupKey ? `group:${f.groupKey}` : `asset:${f.assetId}`;
					const limit = limits.get(name) || { ...(f.groupKey ? { groupKey: bytes(f.groupKey) } : { assetId: bytes(f.assetId) }), maxSend: 0n, maxReceive: 0n };
					const send = f.local > f.reserved ? f.local - f.reserved : 0n;
					if (send > limit.maxSend) Object.assign(limit, { maxSend: send, sendChannelId: bytes(f.channelId) });
					if (f.remote > limit.maxReceive) Object.assign(limit, { maxReceive: f.remote, receiveChannelId: bytes(f.channelId) });
					limits.set(name, limit);
				}
				return [...limits.values()];
			},
			close() {
				if (closed) return;
				closed = true;
				log('stop');
				if (me.service === service) me.service = null;
				if (state.host === me) state.started = false;
			}
		};
		return service;
	}

	/* -------------------------------------------------------------- the entry */

	const entry = {
		ASSET_PAYMENT_REFUSALS,
		NOMINAL_ASSET_RATE: Object.freeze({ coefficient: 100_000_000n, scale: 0 }),
		// Read from what the engine states of itself, and from nothing else.
		assetLightningSupport: () => ({
			supported: !!opts.supported,
			engineVersion: '0.43.0',
			...(opts.supported ? { apiVersion: 1 } : {}),
			missing: opts.supported ? [] : ['channel.AUXILIARY_CHANNELS_API']
		}),
		lightningStore(backend, prefix = 'ln/') {
			if (typeof prefix !== 'string' || !/^[a-z0-9][a-z0-9._/-]{0,62}\/$/.test(prefix)) throw tapError('ERR_LIGHTNING_STORAGE', 'the store prefix must be lowercase segments ending in "/"');
			const tx = {
				get: (key) => {
					const value = backend.get(prefix + key);
					return value === null ? undefined : value;
				},
				put: (key, value) => backend.set(prefix + key, value),
				remove: (key) => backend.delete(prefix + key),
				keys: (scope) => backend.list(prefix + scope).map((row) => row.key.slice(prefix.length))
			};
			// One transaction of the backend, and never one inside another.
			let open = false;
			const transaction = (fn) => {
				if (open) throw tapError('ERR_LIGHTNING_STORAGE', 'nested transactions are not supported');
				open = true;
				try {
					return backend.transaction(() => fn(tx));
				} finally {
					open = false;
				}
			};
			return { backend, prefix, transaction };
		},
		createAssetLightningHost(given) {
			if (!opts.supported) throw refuse('UNSUPPORTED', 'this Beignet (0.42.0) has no asset channels');
			only('createAssetLightningHost', given, ['store', 'hrp', 'fixedOutputFees', 'invoiceRetentionSeconds', 'allowLegacyHtlcSignatures', 'assumeNegotiatedChannelConfig', 'legacyCsvDelay', 'now', 'onError']);
			for (const name of ['allowLegacyHtlcSignatures', 'assumeNegotiatedChannelConfig']) if (given && given[name] !== undefined && typeof given[name] !== 'function') throw refuse('INVALID', `${name} must be a function`);
			if (!given || !given.store || typeof given.store.transaction !== 'function') throw refuse('INVALID', 'store must be the store lightningStore() returns');
			own(given.store);
			const me = { node: null, service: null };
			Object.assign(state, { host: me, made: given, store: given.store, started: false, bound: false, options: null, adapter: null, node: null });
			return {
				// As the library has it: a call of this object, answered from
				// the node once it is bound, whether or not the service runs.
				fixedOutputFeeStatus() {
					return me.node ? opts.feeStatus || undefined : undefined;
				},
				attachment: {
					auxiliaryChannels: { name: 'the fake provider' },
					fixedOutputFees: given.fixedOutputFees,
					bind(bound) {
						if (me.node && me.node !== bound) throw refuse('INVALID', 'the asset Lightning host is bound to another node');
						if (!bound || typeof bound.connectPeer !== 'function') throw refuse('UNSUPPORTED', 'this is not a node that carries asset channels');
						me.node = bound;
						if (state.host === me) Object.assign(state, { bound: true, node: bound });
					}
				},
				start(adapter, options) {
					if (!me.node) throw refuse('NOT_READY', 'the engine has not bound its node yet');
					if (me.service) throw refuse('INVALID', 'the asset Lightning service is already running');
					if (!options || typeof options.fetchProvenance !== 'function') throw refuse('INVALID', 'fetchProvenance is required');
					if (options.forwarding) throw refuse('INVALID', 'this entry forwards no payments');
					only('start', options, ['fetchProvenance', 'groupProofResolver', 'confirmationDepth', 'acceptIncoming', 'validateAcceptedChannel', 'price', 'forwarding', 'now', 'onError', 'onEvent']);
					if (opts.startFails) throw new Error(opts.startFails);
					log('start', { quiet: typeof options.price === 'function' });
					cancelled.clear();
					hung.clear();
					me.service = makeService(me, adapter, options);
					if (state.host === me) Object.assign(state, { started: true, options, adapter });
					return me.service;
				},
				service: () => me.service || undefined,
				close() {
					if (me.service) me.service.close();
					me.node = null;
					if (state.host === me) state.bound = false;
				}
			};
		},
		assetLightningBackup: (store) =>
			own(store).transaction((tx) => ({ version: 1, rows: CARRIED.flatMap((scope) => tx.keys(scope).map((key) => ({ key, value: tx.get(key) }))) })),
		restoreAssetLightningBackup(store, backup) {
			own(store);
			const invalid = (message) => refuse('INVALID', message);
			if (!backup || backup.version !== 1 || !Array.isArray(backup.rows)) throw invalid('this is not a backup of asset channels');
			const seen = new Set();
			for (const row of backup.rows) {
				const carried = row && typeof row.key === 'string' && typeof row.value === 'string' && CARRIED.some((scope) => row.key.startsWith(scope) && row.key.length > scope.length);
				if (!carried) throw invalid('the backup holds a row that a backup may not carry');
				if (seen.has(row.key)) throw invalid('the backup holds a row twice');
				seen.add(row.key);
			}
			const written = store.transaction((tx) => {
				if (tx.keys('').length) throw invalid('the store already holds Lightning rows: a backup goes into an empty one');
				for (const row of backup.rows) tx.put(row.key, row.value);
				tx.put(RESTORED, JSON.stringify({ version: 1, at: seconds(now()).toString() }));
				return backup.rows.length;
			});
			load(store);
			return written;
		}
	};

	const ln = { calls, violations, opts, flows, quotes, invoices, payments, state, entry, node };

	/* What a test does to the world. */
	ln.flow = (pendingChannelId) => flows.get(pendingChannelId);
	ln.persist = persist;
	ln.move = (channelId, units) => {
		const flow = byChannel(channelId);
		if (!flow) return;
		flow.local += BigInt(units);
		flow.remote -= BigInt(units);
		persist();
	};
	/** The funding is buried and its proofs stored: the channel is open. */
	ln.confirm = (pendingChannelId) => {
		const flow = flows.get(pendingChannelId);
		bury(flow);
		Object.assign(flow, { state: 'NORMAL', confirmed: true, committed: true, phase: 'active' });
		persist();
		return flow;
	};
	ln.set = (pendingChannelId, fields) => {
		const flow = Object.assign(flows.get(pendingChannelId), fields);
		persist();
		return flow;
	};
	/** A signed funding is proven unable to confirm: given up, its inputs released, and said once. */
	ln.abandon = (pendingChannelId, reason = 'the funding transaction cannot confirm: its input 4f2a:0 was spent by 77c1', { silent = false } = {}) => {
		const flow = flows.get(pendingChannelId);
		release(flow);
		Object.assign(flow, { phase: 'failed', error: reason });
		persist();
		if (!silent) emit({ type: 'channel', pendingChannelId: bytes(pendingChannelId), error: reason });
		return flow;
	};
	/** A flow the library holds, put there by hand: an open of this wallet's that has signed nothing, unless `fields` say otherwise. */
	ln.plant = (pendingChannelId, fields = {}) => {
		const assets = fields.assets || [{ assetId: fields.assetId, amount: BigInt(fields.local || 0) + BigInt(fields.remote || 0) }];
		const flow = {
			pendingChannelId,
			channelId: null,
			peerPubkey: `02${'ab'.repeat(32)}`,
			initiator: true,
			phase: 'accepted',
			signed: false,
			committed: false,
			confirmed: false,
			fundingTxid: null,
			state: null,
			assetId: assets[0].assetId,
			groupKey: null,
			assets,
			decimalDisplay: 0,
			local: 0n,
			remote: 0n,
			reserved: 0n,
			fundingSats: 100000,
			reserveSats: null,
			recovery: 'none',
			error: null,
			reserving: false,
			...fields
		};
		flows.set(pendingChannelId, flow);
		persist();
		return flow;
	};
	/** The library loses every record of an open: its flow, and what the flow had set aside. */
	ln.lose = (pendingChannelId, { reserved = false } = {}) => {
		const flow = flows.get(pendingChannelId);
		// `reserved`: its inputs stay set aside in the on-chain records, under its name.
		if (flow && !reserved) release(flow);
		flows.delete(pendingChannelId);
		persist();
	};
	/** A channel a peer opened to this wallet, already the library's. */
	ln.inbound = ({ assetId, amount, peerPubkey = `03${'cd'.repeat(32)}`, state: word = 'NORMAL' }) =>
		ln.plant(id('pending'), {
			channelId: id('channel'),
			peerPubkey,
			initiator: false,
			phase: word === 'NORMAL' ? 'active' : 'broadcast',
			signed: true,
			committed: true,
			confirmed: word === 'NORMAL',
			fundingTxid: id('funding'),
			state: word,
			assetId,
			remote: BigInt(amount)
		});
	/** A closed channel's assets are back in the wallet's on-chain records. */
	ln.recover = (pendingChannelId) => {
		const flow = flows.get(pendingChannelId);
		flow.recovery = 'complete';
		const like = tap.records.find((r) => r.assetId === flow.assetId) || { name: 'recovered', type: 0 };
		if (flow.local > 0n) {
			tap.records.push({ assetId: flow.assetId, scriptKey: `02${sha256Hex(`back:${pendingChannelId}`)}`, name: like.name, type: like.type, amount: flow.local.toString(), anchorOutPoint: `${id('sweep')}:0` });
		}
		persist();
		emit({ type: 'recovery', channelId: bytes(flow.channelId), status: 'complete' });
	};
	/** An invoice is paid. `received` is what arrived, when that is not what was invoiced. */
	ln.settle = (paymentHash, received) => {
		const invoice = invoices.get(paymentHash);
		invoice.status = 'paid';
		invoice.received = received === undefined ? invoice.assetAmount : BigInt(received);
		const flow = [...flows.values()].find((f) => f.peerPubkey === invoice.peerPubkey && f.state === 'NORMAL');
		if (flow) ln.move(flow.channelId, invoice.received);
		persist();
		emit({
			type: 'invoice',
			paymentHash: bytes(paymentHash),
			status: 'paid',
			assetAmount: invoice.assetAmount,
			receivedAssetAmount: invoice.received,
			channelId: bytes(flow ? flow.channelId : '00'.repeat(32))
		});
	};
	/** The engine forgets a payment it once had: the record of it stays pending, and says so. */
	ln.forget = (paymentHash) => {
		payments.get(paymentHash).engineHasNoRecord = true;
		persist();
	};
	ln.finish = (paymentHash, status, failure = null) => {
		const payment = payments.get(paymentHash);
		Object.assign(payment, { status, failure });
		if (status === 'complete') ln.move(payment.channelId, -payment.assetAmount);
		persist();
		emit({ type: 'payment', paymentHash: bytes(paymentHash), attempt: payment.attempt || 1, status, assetAmount: payment.assetAmount, channelId: bytes(payment.channelId), ...(failure ? { failure } : {}) });
	};
	/** A peer offers a channel: what the service asks the wallet, in the library's own values. */
	ln.offer = async ({ pendingChannelId, peerPubkey = `03${'cd'.repeat(32)}`, assets = [], groupKey = null }) => {
		// The peer's assets are verified before the wallet is asked. An asset
		// of a group this wallet has never held, issued after the group was
		// made, needs the issuance that made the group: asked of the
		// resolver, and an open without one is refused there.
		if (groupKey && !opts.knowsGroups) {
			// Not accepted, and said to onError with the library's code for it.
			const turnedDown = (why) => {
				if (typeof state.options.onError === 'function') state.options.onError(tapError(`${LN}GROUP_PROOF`, why));
				return false;
			};
			if (typeof state.options.groupProofResolver !== 'function') return turnedDown('unknown asset group');
			let file = null;
			try {
				file = await state.options.groupProofResolver(groupKey);
			} catch (err) {
				return turnedDown(`the group proof could not be fetched: ${err.message}`);
			}
			if (!Buffer.isBuffer(file) || !file.toString().includes(groupKey)) return turnedDown('supporting group history does not reveal the requested group');
			log('groupProof', groupKey);
		}
		return state.options.acceptIncoming({
			peer: bytes(peerPubkey),
			pendingChannelId: bytes(pendingChannelId),
			expiresAt: seconds(now()) + 1800n,
			assets: assets.map((a) => ({ assetId: /^[0-9a-f]*$/.test(a.assetId) ? bytes(a.assetId) : a.assetId, amount: a.amount })),
			inputProofs: [],
			outputs: [],
			...(groupKey ? { groupKey: bytes(groupKey) } : {})
		});
	};
	return ln;
}

/**
 * A host over fakes. `boot()` runs the start sequence; `restart()` gives a
 * new harness over the same storage, library records and clock. The host
 * starts no timers of its own unless `timers` is set.
 *
 * `lightning: true` gives the wallet asset channels and, unless `env` says
 * otherwise, asks for them (BEIGNET_ASSETS_LIGHTNING). The host is handed
 * the real facade (adapter.js createLightning) over the fake entry, a new
 * one for each generation as a restarted daemon builds; `ln` is the fake
 * itself, which is what a test switches and reads. `lightning: 'unbound'`
 * is the same before the engine has handed over its node. Left out, the
 * wallet is one that cannot have any.
 */
function harness({ env = {}, network = 'regtest', shared, timers = false, chainCheck = null, lightning = false, paymentRefusals = null } = {}) {
	const world = shared || { clock: { t: 1_700_000_000_000 }, mem: memoryStorage(), events: [], delivered: [], fetched: [], net: { down: false } };
	const now = () => world.clock.t;
	const cfg = parseConfig(network, {
		BEIGNET_ASSETS_MODULES: MODULES,
		BEIGNET_ASSETS_UNIVERSES: JSON.stringify(UNIVERSES),
		...(lightning ? { BEIGNET_ASSETS_LIGHTNING: 'full' } : {}),
		...env
	});
	const wallet =
		world.wallet ||
		(world.wallet = {
			data: { header: { height: 100 } },
			getBalanceBreakdown: () => ({ total: 500000, spendable: 500000, frozen: 0 }),
			getFeeEstimates: async () => ({ normal: 3 })
		});
	const tap = world.tap || (world.tap = fakeTap({ now, wallet }));
	const lib = fakeLib();
	lib.makeCourier = (uri) => ({
		async deliverProof(locator) {
			if (world.net.down) throw Object.assign(new Error('Could not reach universe.example.com'), { code: 'PROOF_SERVER_UNREACHABLE' });
			world.delivered.push({ uri, locator });
		},
		async receiveProof(locator) {
			if (tap.opts.proofMissing) throw tapError('ERR_COURIER_PROOF_NOT_FOUND');
			world.fetched.push({ uri, locator });
			return fakeProof({ ...locator });
		},
		// The issuance that created a group, as the universe keeps it.
		async receiveGroupProof(groupKey) {
			if (world.net.down) throw Object.assign(new Error('Could not reach universe.example.com'), { code: 'PROOF_SERVER_UNREACHABLE' });
			if (tap.opts.groupMissing) throw tapError('ERR_COURIER_PROOF_NOT_FOUND');
			world.fetched.push({ uri, groupKey });
			return Buffer.from(`group anchor of ${tap.opts.groupWrong ? 'another group' : groupKey}`);
		}
	});
	const net = {
		courierFetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
		test: async () => (world.net.down ? { reachable: false, network: null, ms: null, error: 'Could not reach universe.example.com' } : { reachable: true, network: null, ms: 1, error: null }),
		viaTor: () => false
	};
	const events = world.events;
	// What the fake channels check the lock of: the host of this generation.
	const lockOf = world.lockOf || (world.lockOf = { held: () => false });
	const ln = lightning ? world.ln || (world.ln = fakeLightning({ now, tap, storage: world.mem.storage, held: () => lockOf.held() })) : null;
	// A library that lists more of its rejections as ones made before anything is sent.
	if (ln && paymentRefusals) ln.entry.ASSET_PAYMENT_REFUSALS = Object.freeze([...new Set([...ln.entry.ASSET_PAYMENT_REFUSALS, ...paymentRefusals])]);
	const logs = world.logs || (world.logs = []);
	const logger = { info: (text) => logs.push(['info', text]), warn: (text) => logs.push(['warn', text]), error: (text) => logs.push(['error', text]) };
	const host = createHost({
		cfg,
		storage: world.mem.storage,
		wallet,
		lib,
		net,
		emit: (name, data) => events.push([name, data]),
		logger,
		tap,
		ln: ln ? createLightning({ entry: ln.entry, storage: world.mem.storage, cfg, now }) : null,
		chainCheck,
		now,
		timers
	});
	lockOf.held = host.lock.held;
	tap.proofPublisher = host.proofPublisher;
	tap.courierFor = host.courierFor;
	const handlers = bind(host);
	const call = (route, body, key) => handlers[route]({ body: body || {}, query: new URLSearchParams(), idempotencyKey: key });
	const get = (route, query) => handlers[`GET ${route}`]({ body: {}, query: new URLSearchParams(query || '') });
	return {
		world,
		cfg,
		host,
		tap,
		ln,
		wallet,
		events,
		logs,
		handlers,
		call,
		get,
		clock: world.clock,
		storage: world.mem.storage,
		fence: world.mem.fence,
		// In the order the engine and index.js do it: a backup left for the
		// wallet is restored, the adapter is handed to the Lightning service,
		// the engine builds its node and binds it, and the host starts.
		boot: async () => {
			await host.attach();
			await host.startLightning();
			if (host.ln && lightning !== 'unbound') host.ln.attachment.bind(ln.node);
			await host.startup();
		},
		// The daemon stops, node and all, and a new one starts over what it left.
		restart: () => {
			host.shutdown();
			if (host.ln) host.ln.close();
			return harness({ env, network, shared: world, timers, lightning });
		},
		/** Put a fake transaction in a block and run a pass of the loop. */
		confirm: async (txid, height = wallet.data.header.height + 1) => {
			tap.chain.confirm(txid, height);
			await host.pass({ block: true });
		}
	};
}

/** Await a refusal and return it. */
async function refused(promise) {
	try {
		await promise;
	} catch (err) {
		return err;
	}
	throw new Error('expected a refusal');
}

module.exports = { MODULES, UNIVERSES, tapError, encodeFake, fakeProof, fakeInvoice, fakeLib, fakeTap, fakeLightning, harness, refused };
