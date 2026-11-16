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
				scriptKey: '02' + 'ab'.repeat(32),
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
		makeCourier: () => {
			throw new Error('the fake host is given couriers by its harness');
		}
	};
}

/**
 * The fake adapter. `opts` switches failures on: mintFee, parcelFee,
 * fundFails, mintBroadcastFails, storeFails, sendBroadcastFails,
 * courierDown, courierRefuses (the server's words), proofMissing.
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
		async receive(raw) {
			log('freighter.receive', raw.encoded);
			const r = receives.get(raw.encoded);
			if (!r) throw tapError('ERR_TAPFREIGHTER_ADDRESS_NOT_FOUND');
			if (r.state === 0) {
				if (!paid.has(raw.encoded)) throw tapError('ERR_BEIGNET_TIMEOUT', 'confirmation wait timed out');
				r.locator = { anchorOutPoint: `${paid.get(raw.encoded)}:0` };
				r.state = 1;
			}
			if (r.state === 1) {
				if (opts.proofMissing) throw tapError('ERR_COURIER_PROOF_NOT_FOUND');
				r.state = 2;
			}
			if (r.state === 2) {
				records.push({ assetId: raw.assetId, scriptKey: `02${sha256Hex(`rk:${raw.encoded}`)}`, name: 'received', type: 0, amount: String(raw.amount), anchorOutPoint: r.locator.anchorOutPoint });
				r.state = 3;
			}
			return r;
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

/**
 * A host over fakes. `boot()` runs the start sequence; `restart()` gives a
 * new harness over the same storage, library records and clock. The host
 * starts no timers of its own unless `timers` is set.
 */
function harness({ env = {}, network = 'regtest', shared, timers = false, chainCheck = null } = {}) {
	const world = shared || { clock: { t: 1_700_000_000_000 }, mem: memoryStorage(), events: [], delivered: [], net: { down: false } };
	const now = () => world.clock.t;
	const cfg = parseConfig(network, { BEIGNET_ASSETS_MODULES: MODULES, BEIGNET_ASSETS_UNIVERSES: JSON.stringify(UNIVERSES), ...env });
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
		}
	});
	const net = {
		courierFetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
		test: async () => (world.net.down ? { reachable: false, network: null, ms: null, error: 'Could not reach universe.example.com' } : { reachable: true, network: null, ms: 1, error: null }),
		viaTor: () => false
	};
	const events = world.events;
	const host = createHost({ cfg, storage: world.mem.storage, wallet, lib, net, emit: (name, data) => events.push([name, data]), logger: null, tap, chainCheck, now, timers });
	tap.proofPublisher = host.proofPublisher;
	const handlers = bind(host);
	const call = (route, body, key) => handlers[route]({ body: body || {}, query: new URLSearchParams(), idempotencyKey: key });
	const get = (route, query) => handlers[`GET ${route}`]({ body: {}, query: new URLSearchParams(query || '') });
	return {
		world,
		cfg,
		host,
		tap,
		wallet,
		events,
		handlers,
		call,
		get,
		clock: world.clock,
		storage: world.mem.storage,
		fence: world.mem.fence,
		boot: async () => {
			await host.attach();
			await host.startup();
		},
		restart: () => {
			host.shutdown();
			return harness({ env, network, shared: world, timers });
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

module.exports = { MODULES, UNIVERSES, tapError, encodeFake, fakeLib, fakeTap, harness, refused };
