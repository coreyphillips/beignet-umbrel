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
 * `fakeLightning` stands in for the wallet's asset channels: the facade
 * adapter.js builds over the library's Lightning service. It also keeps the
 * two rules that service needs kept: it notes every call made to it with
 * the host's lock held that could have reached the node, and every call
 * made inside a storage transaction, in `violations`.
 */
const { memoryStorage, sha256Hex } = require('./store');
const { parseConfig } = require('./config');
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
			b.seedlings.push({ name: s.name, type: s.type, amount: String(s.amount), decimalDisplay: (s.meta && s.meta.decimalDisplay) || 0, newGroup: !!s.newGroup });
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
							return { assetId, name: s.name, type: s.type, amount: BigInt(s.amount), groupKey: s.newGroup ? `03${sha256Hex(`group:${assetId}`)}` : null, genesis: `g:${assetId}` };
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
 * The fake asset channels: adapter.js `createLightning`, kept in memory.
 *
 * `opts` switches behaviour: supports (the peer takes asset channels),
 * connectFails, fundFails, fundingFee, reserveSats, openHangs (the open
 * never answers), openFails (a code the open rejects with, nothing signed),
 * openFailsSigned (the same, after the funding transaction is signed),
 * rate, quoteMs, quoteFails, payStatus, payFails, payMoved (the peer's
 * price is past the bound), payFeeMsat.
 *
 * A test moves a channel on by hand: `confirm(id)` makes it NORMAL,
 * `set(id, fields)` changes its balances, `recover(id)` brings a closed
 * channel's assets home, `settle(paymentHash)` pays an invoice, and
 * `finish(paymentHash, status)` ends a payment that was left pending.
 */
function fakeLightning({ now = () => Date.now(), tap, storage, held = () => false } = {}) {
	const calls = [];
	const violations = [];
	const opts = {
		supports: true,
		connectFails: false,
		fundFails: false,
		fundingFee: 420,
		reserveSats: undefined,
		openHangs: false,
		openFails: null,
		openFailsSigned: null,
		rate: { coefficient: 100_000_000n, scale: 0 },
		quoteMs: 60_000,
		quoteFails: null,
		payStatus: 'complete',
		payFails: null,
		payMoved: false,
		payFeeMsat: 2000n
	};
	const flows = new Map();
	const quotes = new Map();
	const invoices = new Map();
	const payments = new Map();
	const state = { started: false, bound: false, options: null, node: null };
	let n = 0;
	const id = (what) => sha256Hex(`ln:${what}:${(n += 1)}`);
	const log = (...entry) => calls.push(entry);
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
	// What can reach the node, and be called back by it, is never called
	// with the host's lock held.
	const reaches = (name) => {
		if (held()) violations.push(`${name} with the host's lock held`);
		stored(name);
		if (!state.started || !state.bound) throw tapError('ERR_BEIGNET_LN_NOT_READY', 'asset channels have not started');
	};
	const msatOf = (units) => (BigInt(units) * 100_000_000n * 1000n * 10n ** BigInt(opts.rate.scale)) / BigInt(opts.rate.coefficient);
	const unitsOf = (msat) => {
		const units = (BigInt(msat) * BigInt(opts.rate.coefficient)) / (100_000_000n * 1000n * 10n ** BigInt(opts.rate.scale));
		return units > 0n ? units : 1n;
	};
	/** Take `amount` units of an asset off the chain, as a funding transaction does. */
	const spend = (assetId, amount, txid) => {
		let left = BigInt(amount);
		for (const r of tap.records.filter((x) => x.assetId === assetId && !x.spent && !x.reservedBy)) {
			if (left === 0n) break;
			const have = BigInt(r.amount);
			const take = have < left ? have : left;
			r.spent = true;
			if (have > take) tap.records.push({ ...r, spent: false, amount: (have - take).toString(), anchorOutPoint: `${txid}:1` });
			left -= take;
		}
		if (left > 0n) throw tapError('ERR_TAPFREIGHTER_INSUFFICIENT_BALANCE', 'not enough of the asset');
	};
	const byChannel = (channelId) => [...flows.values()].find((f) => f.channelId === channelId) || null;
	const ln = { calls, violations, opts, flows, quotes, invoices, payments, state };

	ln.attachment = {
		auxiliaryChannels: { name: 'the fake provider' },
		fixedOutputFees: { feeCoinCount: 4 },
		bind(node) {
			state.bound = true;
			state.node = node;
		}
	};
	ln.start = async (options) => {
		log('start', { quiet: !!options.quiet });
		state.options = options;
		state.started = true;
	};
	ln.stop = () => {
		log('stop');
		state.started = false;
	};
	ln.ready = () => state.started && state.bound;

	ln.channels = () => {
		stored('channels');
		if (!ln.ready()) throw tapError('ERR_BEIGNET_LN_NOT_READY', 'asset channels have not started');
		return [...flows.values()].map((f) => ({ ...f }));
	};
	ln.connect = async (peer) => {
		reaches('connect');
		log('connect', peer);
		if (opts.connectFails) throw new Error('connection refused');
	};
	ln.peerSupports = (pubkey) => {
		stored('peerSupports');
		log('peerSupports', pubkey);
		return !!opts.supports;
	};
	ln.quoteFunding = async (request) => {
		reaches('quoteFunding');
		log('quoteFunding', request);
		if (opts.fundFails) throw tapError('ERR_BEIGNET_FUNDING', 'wallet has no spendable fee input');
		return { feeSats: opts.fundingFee, vbytes: 210, reserveSats: opts.reserveSats === undefined ? null : opts.reserveSats };
	};
	ln.openChannel = async (request) => {
		reaches('openChannel');
		log('openChannel', request.pendingChannelId, storage ? storage.list('h/').map((r) => r.key) : []);
		if (opts.openHangs) return new Promise(() => undefined);
		const known = flows.get(request.pendingChannelId);
		if (known && known.channelId) return { channelId: known.channelId };
		const flow = known || {
			pendingChannelId: request.pendingChannelId,
			channelId: null,
			peerPubkey: request.peerPubkey,
			initiator: true,
			phase: 'accepted',
			signed: false,
			confirmed: false,
			state: null,
			assetId: request.assets[0].assetId,
			groupKey: request.groupKey || null,
			local: request.assets.reduce((sum, a) => sum + BigInt(a.amount), 0n),
			remote: 0n,
			reserved: 0n,
			fundingSats: request.fundingSats,
			reserveSats: null,
			recovery: 'none',
			request
		};
		flows.set(flow.pendingChannelId, flow);
		if (opts.openFails) {
			flow.phase = 'rejected';
			throw tapError(opts.openFails, 'the peer said no');
		}
		const txid = id('funding');
		for (const a of request.assets) spend(a.assetId, a.amount, txid);
		flow.signed = true;
		if (opts.openFailsSigned) throw tapError(opts.openFailsSigned, 'the network did not take the transaction');
		flow.phase = 'broadcast';
		flow.channelId = id('channel');
		flow.state = 'AWAITING_FUNDING_CONFIRMED';
		return { channelId: flow.channelId };
	};
	ln.cancelFlow = async (pendingChannelId) => {
		reaches('cancelFlow');
		log('cancelFlow', pendingChannelId);
		const flow = flows.get(pendingChannelId);
		if (!flow) return true;
		if (flow.signed) return false;
		flows.delete(pendingChannelId);
		return true;
	};
	ln.closeChannel = async ({ channelId, force }) => {
		reaches('closeChannel');
		log('closeChannel', channelId, !!force);
		const flow = byChannel(channelId);
		if (!flow) throw tapError('ERR_BEIGNET_LN_UNKNOWN_CHANNEL', 'no such channel');
		flow.state = force ? 'FORCE_CLOSED' : 'CLOSED';
		flow.recovery = 'pending';
	};
	ln.resume = async () => {
		reaches('resume');
		log('resume');
	};
	ln.resumeRecovery = async () => {
		reaches('resumeRecovery');
		log('resumeRecovery');
		return [];
	};

	ln.quoteInvoice = async ({ assetId, groupKey, amount, peerPubkey }) => {
		reaches('quoteInvoice');
		log('quoteInvoice', { assetId, groupKey, amount, peerPubkey });
		if (opts.quoteFails) throw tapError(opts.quoteFails, 'the peer gave no price');
		const quoteId = id('quote');
		quotes.set(quoteId, { kind: 'receive', assetId, amount: BigInt(amount), peerPubkey });
		return { quoteId, peerPubkey, assetAmount: BigInt(amount), amountMsat: msatOf(amount), unitsPerBtc: { ...opts.rate }, expiresAt: now() + opts.quoteMs };
	};
	ln.createInvoice = async ({ quoteId, description, expirySeconds }) => {
		reaches('createInvoice');
		log('createInvoice', { quoteId, description, expirySeconds });
		const quote = quotes.get(quoteId);
		if (!quote || quote.kind !== 'receive') throw tapError('ERR_BEIGNET_LN_QUOTE_EXPIRED', 'no such quote');
		quotes.delete(quoteId);
		const paymentHash = id('hash');
		const amountMsat = msatOf(quote.amount);
		invoices.set(paymentHash, { paymentHash, assetAmount: quote.amount, status: 'open', peerPubkey: quote.peerPubkey });
		return { bolt11: fakeInvoice({ msat: amountMsat, hash: paymentHash }), paymentHash, assetAmount: quote.amount, amountMsat, expiresAt: now() + expirySeconds * 1000 };
	};
	ln.invoices = () => {
		stored('invoices');
		return [...invoices.values()].map((i) => ({ paymentHash: i.paymentHash, assetAmount: i.assetAmount, status: i.status }));
	};

	ln.quotePayment = async ({ bolt11, assetId, groupKey, amountMsat }) => {
		reaches('quotePayment');
		log('quotePayment', { bolt11, assetId, groupKey, amountMsat });
		const m = /^lnbcrt1([0-9a-f]+)$/.exec(String(bolt11));
		let invoice = null;
		try {
			invoice = m ? JSON.parse(Buffer.from(m[1], 'hex').toString('utf8')) : null;
		} catch (_) {
			invoice = null;
		}
		if (!invoice || !invoice.hash) throw tapError('ERR_BEIGNET_LN_BAD_INVOICE', 'not an invoice');
		const msat = invoice.msat !== null ? BigInt(invoice.msat) : amountMsat === undefined || amountMsat === null ? null : BigInt(amountMsat);
		if (msat === null) throw tapError('ERR_BEIGNET_LN_AMOUNT_REQUIRED', 'the invoice names no amount');
		if (opts.quoteFails) throw tapError(opts.quoteFails, 'the peer gave no price');
		const flow = [...flows.values()].find((f) => f.state === 'NORMAL' && f.confirmed && (f.assetId === assetId || (groupKey && f.groupKey === groupKey)));
		if (!flow) throw tapError('ERR_BEIGNET_LN_INSUFFICIENT_OUTBOUND', 'no channel');
		const quoteId = id('quote');
		const assetAmount = unitsOf(msat);
		quotes.set(quoteId, { kind: 'pay', paymentHash: invoice.hash, assetAmount, channelId: flow.channelId });
		return { quoteId, paymentHash: invoice.hash, peerPubkey: flow.peerPubkey, channelId: flow.channelId, assetAmount, amountMsat: msat, unitsPerBtc: { ...opts.rate }, expiresAt: now() + opts.quoteMs };
	};
	ln.payInvoice = async ({ quoteId, maxAssetAmount }) => {
		reaches('payInvoice');
		log('payInvoice', quoteId, maxAssetAmount, storage ? storage.list('h/').map((r) => r.key) : []);
		const quote = quotes.get(quoteId);
		if (!quote || quote.kind !== 'pay') throw tapError('ERR_BEIGNET_LN_QUOTE_EXPIRED', 'no such quote');
		quotes.delete(quoteId);
		if (opts.payMoved || quote.assetAmount > BigInt(maxAssetAmount)) throw tapError('ERR_BEIGNET_LN_PRICE_BOUND', 'the price is past the bound');
		if (opts.payFails) throw tapError(opts.payFails, 'the payment could not be sent');
		const payment = { paymentHash: quote.paymentHash, assetAmount: quote.assetAmount, status: opts.payStatus, feeMsat: opts.payFeeMsat, failure: opts.payStatus === 'failed' ? 'no route to the recipient' : null, channelId: quote.channelId };
		payments.set(payment.paymentHash, payment);
		if (payment.status === 'complete') ln.move(payment.channelId, -payment.assetAmount);
		return { ...payment };
	};
	ln.payment = (paymentHash) => {
		stored('payment');
		const p = payments.get(paymentHash);
		return p ? { ...p } : null;
	};

	/* What a test does to the world. */
	ln.flow = (pendingChannelId) => flows.get(pendingChannelId);
	ln.move = (channelId, units) => {
		const flow = byChannel(channelId);
		if (!flow) return;
		flow.local += BigInt(units);
		flow.remote -= BigInt(units);
	};
	ln.confirm = (pendingChannelId) => Object.assign(flows.get(pendingChannelId), { state: 'NORMAL', confirmed: true, phase: 'active' });
	ln.set = (pendingChannelId, fields) => Object.assign(flows.get(pendingChannelId), fields);
	/** A channel a peer opened to this wallet, already the library's. */
	ln.inbound = ({ assetId, amount, peerPubkey = `03${'cd'.repeat(32)}`, state: word = 'NORMAL' }) => {
		const flow = {
			pendingChannelId: id('pending'),
			channelId: id('channel'),
			peerPubkey,
			initiator: false,
			phase: word === 'NORMAL' ? 'active' : 'broadcast',
			signed: true,
			confirmed: word === 'NORMAL',
			state: word,
			assetId,
			groupKey: null,
			local: 0n,
			remote: BigInt(amount),
			reserved: 0n,
			fundingSats: 100000,
			reserveSats: null,
			recovery: 'none'
		};
		flows.set(flow.pendingChannelId, flow);
		return flow;
	};
	/** A closed channel's assets are back in the wallet's on-chain records. */
	ln.recover = (pendingChannelId) => {
		const flow = flows.get(pendingChannelId);
		flow.recovery = 'complete';
		const like = tap.records.find((r) => r.assetId === flow.assetId) || { name: 'recovered', type: 0 };
		if (flow.local > 0n) {
			tap.records.push({ assetId: flow.assetId, scriptKey: `02${sha256Hex(`back:${pendingChannelId}`)}`, name: like.name, type: like.type, amount: flow.local.toString(), anchorOutPoint: `${id('sweep')}:0` });
		}
	};
	ln.settle = (paymentHash) => {
		const invoice = invoices.get(paymentHash);
		invoice.status = 'paid';
		const flow = [...flows.values()].find((f) => f.peerPubkey === invoice.peerPubkey && f.state === 'NORMAL');
		if (flow) ln.move(flow.channelId, invoice.assetAmount);
		if (state.options) state.options.onEvent({ type: 'invoice', paymentHash, status: 'paid' });
	};
	ln.finish = (paymentHash, status, failure = null) => {
		const payment = payments.get(paymentHash);
		Object.assign(payment, { status, failure });
		if (status === 'complete') ln.move(payment.channelId, -payment.assetAmount);
		if (state.options) state.options.onEvent({ type: 'payment', paymentHash, status });
	};
	return ln;
}

/**
 * A host over fakes. `boot()` runs the start sequence; `restart()` gives a
 * new harness over the same storage, library records and clock. The host
 * starts no timers of its own unless `timers` is set.
 *
 * `lightning: true` gives the wallet asset channels (fakeLightning) and,
 * unless `env` says otherwise, asks for them (BEIGNET_ASSETS_LIGHTNING).
 * `lightning: 'unbound'` is the same before the engine has handed over its
 * node. Left out, the wallet is one that cannot have any.
 */
function harness({ env = {}, network = 'regtest', shared, timers = false, chainCheck = null, lightning = false } = {}) {
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
		}
	});
	const net = {
		courierFetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
		test: async () => (world.net.down ? { reachable: false, network: null, ms: null, error: 'Could not reach universe.example.com' } : { reachable: true, network: null, ms: 1, error: null }),
		viaTor: () => false
	};
	const events = world.events;
	// What the fake channels check the lock of: the host of this generation.
	const lockOf = { held: () => false };
	const ln = lightning ? world.ln || (world.ln = fakeLightning({ now, tap, storage: world.mem.storage, held: () => lockOf.held() })) : null;
	const host = createHost({ cfg, storage: world.mem.storage, wallet, lib, net, emit: (name, data) => events.push([name, data]), logger: null, tap, ln, chainCheck, now, timers });
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
		handlers,
		call,
		get,
		clock: world.clock,
		storage: world.mem.storage,
		fence: world.mem.fence,
		// In the order the engine and index.js do it: the adapter is handed to
		// the Lightning service, a backup left for the wallet is restored, the
		// engine builds its node and binds it, and the host starts.
		boot: async () => {
			await host.startLightning();
			await host.attach();
			if (ln && lightning !== 'unbound') ln.attachment.bind({ the: 'node' });
			await host.startup();
		},
		restart: () => {
			host.shutdown();
			if (ln) ln.state.bound = false;
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
