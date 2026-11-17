'use strict';

/**
 * The seam to the library's Lightning entry: when it is loaded, and what the
 * rest of the host is given in its place.
 *
 * The entry stood in for here has the names and shapes the library ships
 * (ts-tap 2df9663), which is what adapter.js was written to (the numbered
 * list at the top of its Lightning section): each call below is that list,
 * as a check. The last test loads the real entry when it is given a path.
 *
 * Run: cd manager && npm test
 * Or:  cd manager && node --test server/assets-host/adapter.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLightning, createLightning, fixedOutputFees, CHANNEL_SATS, CARRIER_SATS, NOMINAL_RATE } = require('./adapter');
const { parseConfig } = require('./config');
const { memoryStorage } = require('./store');
const { mapError, LIGHTNING_REFUSALS } = require('./errors');

const cfg = parseConfig('regtest', { BEIGNET_ASSETS_MODULES: '/opt/engine/node_modules' });
const buf = (byte, length = 32) => Buffer.alloc(length, byte);
const PEER = Buffer.concat([Buffer.from([2]), buf(0xab)]);
const ASSET = buf(0x11);
const hexOf = (b) => b.toString('hex');

/** A node_modules directory holding an adapter package made of `files`. */
function withModules(files, fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-adapter-'));
	const modules = path.join(dir, 'node_modules');
	const root = path.join(modules, '@ts-tap', 'beignet');
	try {
		for (const [name, text] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
			fs.writeFileSync(path.join(root, name), text);
		}
		return fn(modules);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const PACKAGE = JSON.stringify({ name: '@ts-tap/beignet', main: 'dist/index.js', exports: { '.': './dist/index.js', './lightning': './dist/lightning.js' } });
const REFUSALS = ['ERR_BEIGNET_LN_NO_QUOTE', 'ERR_BEIGNET_LN_QUOTE_EXPIRED', 'ERR_BEIGNET_LN_PAYMENT'];
const GROUP = Buffer.concat([Buffer.from([3]), buf(0xcd)]);

/** The entry in the names and shapes the library ships (ts-tap 2df9663), recording what it is asked. */
function fakeEntry({ supported = true, startFails = null } = {}) {
	const seen = { calls: [], made: null, started: null, bound: [], closed: 0, hostClosed: 0, backedUp: [], restored: [] };
	const note = (name, arg) => {
		seen.calls.push([name, arg]);
	};
	const channel = {
		pendingChannelId: buf(0xaa),
		channelId: buf(0xbb),
		peer: PEER,
		initiator: true,
		phase: 'active',
		engine: 'held',
		signed: true,
		committed: true,
		confirmed: true,
		fundingTxid: 'f1'.repeat(32),
		state: 'NORMAL',
		fundingSatoshis: 100000n,
		reserveSatoshis: 1000n,
		assets: [
			{ assetId: ASSET, amount: 500n },
			{ assetId: buf(0x12), amount: 50n }
		],
		localAssetBalance: 450n,
		remoteAssetBalance: 100n,
		reserved: 25n,
		recovery: 'none'
	};
	// An open that has signed its funding and not confirmed it: its inputs are still in the on-chain records.
	const opening = {
		pendingChannelId: buf(0xcc),
		peer: PEER,
		initiator: true,
		phase: 'funding-created',
		engine: 'missing',
		signed: true,
		committed: true,
		fundingTxid: 'f2'.repeat(32),
		fundingSatoshis: 100000n,
		assets: [{ assetId: ASSET, amount: 600n }],
		localAssetBalance: 600n,
		remoteAssetBalance: 0n,
		fundingReservation: `funding:${'cc'.repeat(32)}`,
		fundingInputs: [{ assetId: ASSET, amount: 1000n }],
		recovery: 'a word this host has not met'
	};
	// One this wallet gave up before the channel was negotiated, and one a peer's offer came to.
	const cancelled = { pendingChannelId: buf(0xdd), peer: PEER, initiator: true, phase: 'failed', engine: 'absent', error: 'cancelled', fundingSatoshis: 100000n, assets: [], recovery: 'none' };
	const offered = { pendingChannelId: buf(0xee), peer: PEER, phase: 'accepted', engine: 'somewhere new', state: 'SENT_ACCEPT', groupKey: GROUP, fundingSatoshis: 100000n, assets: [{ assetId: ASSET, amount: 5n }], recovery: 'none' };
	const service = {
		channels: () => [channel, opening, cancelled, offered],
		peerSupports: (peer) => {
			note('peerSupports', peer);
			return 1;
		},
		quoteFunding: async (request) => {
			note('quoteFunding', request);
			return { feeSatoshis: 420n, vsize: 210, reserveSatoshis: 1062n };
		},
		openChannel: async (request) => {
			note('openChannel', request);
			return { pendingChannelId: request.pendingChannelId, channelId: buf(0xbb) };
		},
		cancelChannel: async (id) => {
			note('cancelChannel', id);
			return true;
		},
		closeChannel: async (request) => {
			note('closeChannel', request);
		},
		forgetChannel: (id) => {
			note('forgetChannel', id);
			return id.equals(buf(0xdd)) ? 1 : 0;
		},
		paymentLimits: () => [
			{ assetId: buf(0x11), maxSend: 450n, maxReceive: 200n, sendChannelId: buf(0xbb), receiveChannelId: buf(0xbc) },
			{ groupKey: GROUP, maxSend: 0n, maxReceive: 7n, receiveChannelId: buf(0xbd) }
		],
		resume: async () => {
			note('resume');
		},
		recovery: {
			resume: async () => {
				note('recovery.resume');
				// Its errors come back as data, and its channel id as hex.
				return [{ channelId: 'BB'.repeat(32), completed: [1, 2], pending: [3], superseded: [], errors: [{ txid: 'ab', message: 'not yet mature' }, 'a plain word'] }];
			}
		},
		settleFundingReservations: async () => {
			note('settleFundingReservations');
			return [
				{ reservation: `funding:${'c1'.repeat(32)}`, pendingChannelId: buf(0xc1), outcome: 'released', assets: [{ assetId: ASSET, amount: 70n }] },
				{
					reservation: `funding:${'c2'.repeat(32)}`,
					pendingChannelId: buf(0xc2),
					outcome: 'moved',
					assets: [{ assetId: ASSET, amount: 1000n }],
					channelId: buf(0xbb),
					fundingTxid: 'f1'.repeat(32),
					changeRestored: true,
					change: [{ assetId: ASSET, amount: 400n }]
				},
				// Only a plain true says the change came back.
				{ reservation: `funding:${'c5'.repeat(32)}`, pendingChannelId: buf(0xc5), outcome: 'moved', assets: [], changeRestored: 'yes', change: [{ assetId: ASSET, amount: 9n }] },
				{ reservation: `funding:${'c3'.repeat(32)}`, pendingChannelId: buf(0xc3), outcome: 'kept', assets: [], reason: 'the funding transaction is not buried yet' },
				{ reservation: `funding:${'c4'.repeat(32)}`, outcome: 'a word this host has not met' }
			];
		},
		quoteInvoice: async (request) => {
			note('quoteInvoice', request);
			return { quoteId: buf(0x01), peer: PEER, assetAmount: 150n, milliSatoshi: 150000n, assetRate: { coefficient: 100000000n, scale: 0 }, expiresAt: 1700000060n, priced: false };
		},
		createInvoice: async (request) => {
			note('createInvoice', request);
			return { bolt11: 'lnbcrt1invoice', paymentHash: buf(0x02), assetAmount: 150n, milliSatoshi: 150000n, expiresAt: 1700003600n };
		},
		invoices: () => [
			{ paymentHash: buf(0x02), assetAmount: 150n, receivedAssetAmount: 149n, status: 'paid', bolt11: 'lnbcrt1invoice', description: 'tea' },
			{ paymentHash: buf(0x03), assetAmount: 5n, receivedAssetAmount: 0n, status: 'something new' },
			// An entry that does not say what arrived.
			{ paymentHash: buf(0x08), assetAmount: 5n, status: 'expired' }
		],
		quotePayment: async (request) => {
			note('quotePayment', request);
			return {
				quoteId: buf(0x04),
				paymentHash: buf(0x05),
				peer: PEER,
				channelId: buf(0xbb),
				assetAmount: 50n,
				milliSatoshi: 50000n,
				feeMsat: 1000n,
				assetRate: { coefficient: '4000000', scale: 0 },
				expiresAt: 1700000060n,
				priced: true
			};
		},
		payInvoice: async (request) => {
			note('payInvoice', request);
			return { paymentHash: buf(0x05), assetAmount: 50n, status: 'complete', attempt: 2, channelId: buf(0xbb), htlcId: 1n, feeMsat: 2000n, preimage: buf(0x99) };
		},
		payment: (hash) => {
			if (hash.equals(buf(0x05))) return { paymentHash: hash, assetAmount: 50n, status: 'failed', attempt: 1, channelId: buf(0xbb), htlcId: 0n, failure: 'no route' };
			// One the engine forgot, and one it never confirmed as an asset payment.
			if (hash.equals(buf(0x07))) return { paymentHash: hash, assetAmount: 9n, status: 'pending', attempt: 3, channelId: buf(0xbb), engineHasNoRecord: true, assetRecordsUnconfirmed: true };
			// What only looks like the library's words is not taken for them.
			if (hash.equals(buf(0x09))) return { paymentHash: hash, assetAmount: 9n, status: 'pending', attempt: '2', channelId: buf(0xbb), engineHasNoRecord: 'no', assetRecordsUnconfirmed: 1 };
			return undefined;
		},
		reclaimFundingInputs: async (request) => {
			note('reclaimFundingInputs', request);
			return { txid: Buffer.from(`${'00'.repeat(31)}ab`, 'hex'), transaction: { txIn: [], txOut: [] }, feeSat: 321n };
		},
		advertisement: () => seen.advertisement,
		fixedOutputFeeStatus: () => seen.feeStatus,
		close: () => {
			seen.closed += 1;
			return Promise.reject(new Error('already closing'));
		}
	};
	const entry = {
		seen,
		service,
		ASSET_PAYMENT_REFUSALS: REFUSALS,
		assetLightningSupport: () => ({ supported, ...(supported ? { engineVersion: '0.43.0', apiVersion: 1 } : {}), missing: supported ? [] : ['channel.AUXILIARY_CHANNELS_API'] }),
		lightningStore: (backend, prefix) => ({ backend, prefix }),
		createAssetLightningHost: (given) => {
			seen.made = given;
			let bound = null;
			let running = null;
			return {
				attachment: {
					auxiliaryChannels: { the: 'hooks' },
					fixedOutputFees: given.fixedOutputFees,
					bind: (node) => {
						bound = node;
						seen.bound.push(node);
					}
				},
				// Synchronous, and only once the engine has bound its node.
				start: (adapter, options) => {
					if (!bound) throw Object.assign(new Error('ERR_BEIGNET_LN_NOT_READY: bind the node first'), { code: 'ERR_BEIGNET_LN_NOT_READY' });
					if (options.forwarding) throw Object.assign(new Error('ERR_BEIGNET_LN_UNSUPPORTED: forwarding'), { code: 'ERR_BEIGNET_LN_UNSUPPORTED' });
					if (startFails) throw new Error(startFails);
					seen.started = { adapter, options };
					running = service;
					return service;
				},
				service: () => running,
				close: () => {
					seen.hostClosed += 1;
				}
			};
		},
		assetLightningBackup: (store) => {
			seen.backedUp.push(store);
			return { version: 1, rows: [{ key: 'tap/channel/v1/last/bb', value: 'a row' }] };
		},
		restoreAssetLightningBackup: (store, backup, options) => {
			seen.restored.push([store, backup, options]);
			return backup.rows.length;
		}
	};
	return entry;
}

const NODE = {
	connected: [],
	peers: [],
	channels: [],
	listPeers: () => NODE.peers,
	listChannels: () => NODE.channels,
	connectPeer: async (...args) => {
		NODE.connected.push(args);
	}
};
const lib = { decodeProofFile: (bytes) => ({ decoded: bytes }), proofLocator: (p) => ({ locatorOf: p }) };

/** A started facade over a fake entry, with its node bound. */
function started(options = {}, { entry = fakeEntry(), now = null } = {}) {
	const storage = memoryStorage().storage;
	const ln = createLightning({ entry, storage, cfg, now });
	const given = {
		adapter: { the: 'adapter' },
		lib,
		fetchProof: async (locator) => ({ fileFor: locator }),
		fetchGroupProof: async (groupKey) => `the issuance of ${groupKey}`,
		acceptIncoming: async () => true,
		onEvent: () => undefined,
		...options
	};
	ln.start(given);
	ln.attachment.bind(NODE);
	return { entry, ln, storage, seen: entry.seen };
}

test('the Lightning entry is loaded only when the adapter beside the engine ships it', () => {
	// No adapter there at all, and one from before asset channels: nothing is asked to load.
	assert.equal(loadLightning('/nonexistent/engine/node_modules'), null);
	withModules({ 'package.json': PACKAGE, 'dist/index.js': 'throw new Error("never loaded");' }, (modules) => {
		assert.equal(loadLightning(modules), null);
	});
	// One that ships it: the five functions this app calls, and the list of refusals that mean nothing was sent.
	const whole =
		'const f = () => ({}); module.exports = { ASSET_PAYMENT_REFUSALS: ["ERR_BEIGNET_LN_NO_QUOTE"], assetLightningSupport: () => ({ supported: true, missing: [] }), lightningStore: f, createAssetLightningHost: f, assetLightningBackup: f, restoreAssetLightningBackup: f };';
	withModules({ 'package.json': PACKAGE, 'dist/lightning.js': whole }, (modules) => {
		const entry = loadLightning(modules);
		assert.deepEqual(Object.keys(entry).sort(), ['ASSET_PAYMENT_REFUSALS', 'assetLightningBackup', 'assetLightningSupport', 'createAssetLightningHost', 'lightningStore', 'restoreAssetLightningBackup']);
	});
	// One that ships something else under the name, an older one without the
	// backup calls or without the list, or one that will not load: said in a sentence.
	const older = [
		'module.exports = { assetLightningSupport: () => ({ supported: true }) };',
		whole.replace('assetLightningBackup: f, ', ''),
		whole.replace('ASSET_PAYMENT_REFUSALS: ["ERR_BEIGNET_LN_NO_QUOTE"], ', '')
	];
	for (const text of older) {
		withModules({ 'package.json': PACKAGE, 'dist/lightning.js': text }, (modules) => {
			assert.throws(() => loadLightning(modules), { message: 'The asset channels package beside the wallet engine is not a version this app was built for.' });
		});
	}
	withModules({ 'package.json': PACKAGE, 'dist/lightning.js': 'throw new Error("needs a newer engine");' }, (modules) => {
		assert.throws(() => loadLightning(modules), { message: 'The asset channels package beside the wallet engine could not be loaded (needs a newer engine).' });
	});
});

test('no entry, or an engine that cannot carry asset channels: there is no Lightning side', () => {
	const map = new Map();
	const { storage } = memoryStorage(map);
	assert.equal(createLightning({ entry: null, storage, cfg }), null);
	const old = fakeEntry({ supported: false });
	assert.equal(createLightning({ entry: old, storage, cfg }), null);
	// Nothing was built over the wallet's storage for it.
	assert.equal(old.seen.made, null);
	assert.equal(createLightning({ entry: { ...old, assetLightningSupport: () => null }, storage, cfg }), null);
	assert.equal(map.size, 0);
});

test('the provider is built over its own rows before there is an adapter or a node', () => {
	const entry = fakeEntry();
	const storage = memoryStorage().storage;
	const ln = createLightning({ entry, storage, cfg });
	// The library's Lightning rows sit under l/ in the wallet's own storage.
	assert.deepEqual(Object.keys(entry.seen.made).sort(), ['fixedOutputFees', 'hrp', 'onError', 'store']);
	assert.equal(entry.seen.made.store.backend, storage);
	assert.equal(entry.seen.made.store.prefix, 'l/');
	assert.equal(entry.seen.made.hrp, 'taprt');
	assert.deepEqual(entry.seen.made.fixedOutputFees, { maxFeeSatoshis: 10000n, maxTotalFeeSatoshis: 100000000n, maxPreparationFeeSatoshis: 10000n, feeCoinCount: 4, preparationFeeRatePerVbyte: 1 });
	// What the engine is handed is the library's own, with the node noted on its way through.
	assert.deepEqual(Object.keys(ln.attachment).sort(), ['auxiliaryChannels', 'bind', 'fixedOutputFees']);
	assert.deepEqual(ln.attachment.auxiliaryChannels, { the: 'hooks' });
	assert.equal(ln.attachment.fixedOutputFees, entry.seen.made.fixedOutputFees);
	assert.equal(entry.seen.started, null);
	assert.equal(ln.ready(), false);
	// The codes that mean nothing left the wallet are the library's own list.
	assert.deepEqual([...ln.refusals], REFUSALS);
	assert.equal(Object.isFrozen(ln.refusals), true);
	// Until it is started and bound, everything else says so.
	assert.throws(() => ln.channels(), { code: 'ERR_BEIGNET_LN_NOT_READY' });
	assert.equal(mapError(Object.assign(new Error('x'), { code: 'ERR_BEIGNET_LN_NOT_READY' })).extensionCode, 'ASSETS_STARTING');
	ln.attachment.bind(NODE);
	assert.deepEqual(entry.seen.bound, [NODE]);
	assert.equal(ln.ready(), false);
	assert.throws(() => ln.peerSupports(hexOf(PEER)), { code: 'ERR_BEIGNET_LN_NOT_READY' });
	// What goes wrong in the library where nobody waits has nowhere to go yet, and throws at nobody.
	entry.seen.made.onError(new Error('nobody is listening'));
});

test('no one transaction of a channel pays more than the wallet lets an asset transaction pay, and the budget for all of them is many transactions deep', () => {
	// The wallet's ceiling is 250,000 sats unless it was given another.
	assert.deepEqual(fixedOutputFees(cfg), { maxFeeSatoshis: 10000n, maxTotalFeeSatoshis: 100000000n, maxPreparationFeeSatoshis: 10000n, feeCoinCount: 4, preparationFeeRatePerVbyte: 1 });
	// A lower ceiling lowers what one transaction and one split may pay. The
	// budget for all of them stays: held to the ceiling for one, it would be
	// spent after a handful of claims.
	const tight = parseConfig('regtest', { BEIGNET_ASSETS_MODULES: '/opt/engine/node_modules', BEIGNET_ASSETS_MAX_FEE_SATS: '4000' });
	assert.deepEqual(fixedOutputFees(tight), { maxFeeSatoshis: 4000n, maxTotalFeeSatoshis: 100000000n, maxPreparationFeeSatoshis: 4000n, feeCoinCount: 4, preparationFeeRatePerVbyte: 1 });
	const loose = parseConfig('regtest', { BEIGNET_ASSETS_MODULES: '/opt/engine/node_modules', BEIGNET_ASSETS_MAX_FEE_SATS: '5000000' });
	assert.deepEqual([fixedOutputFees(loose).maxFeeSatoshis, fixedOutputFees(loose).maxTotalFeeSatoshis], [10000n, 100000000n]);
	// Each chain has its own figures: mainnet pays for a block soon, and budgets about a hundred claims.
	const mainnet = parseConfig('mainnet', { BEIGNET_ASSETS_MODULES: '/opt/engine/node_modules' });
	assert.deepEqual(fixedOutputFees(mainnet), { maxFeeSatoshis: 25000n, maxTotalFeeSatoshis: 2500000n, maxPreparationFeeSatoshis: 10000n, feeCoinCount: 4, preparationFeeRatePerVbyte: 10 });
	const testnet = parseConfig('testnet', { BEIGNET_ASSETS_MODULES: '/opt/engine/node_modules' });
	assert.deepEqual(fixedOutputFees(testnet), { maxFeeSatoshis: 10000n, maxTotalFeeSatoshis: 1000000n, maxPreparationFeeSatoshis: 10000n, feeCoinCount: 4, preparationFeeRatePerVbyte: 1 });
	assert.deepEqual([CHANNEL_SATS, CARRIER_SATS, { ...NOMINAL_RATE }], [100000, 354, { coefficient: 100000000n, scale: 0 }]);
});

test('starting: the service starts once there is both an adapter and a node, whichever comes first', () => {
	// The adapter first, as at attach: nothing starts until the engine binds its node.
	const first = fakeEntry();
	const a = createLightning({ entry: first, storage: memoryStorage().storage, cfg });
	a.start({ adapter: { the: 'adapter' }, lib, fetchProof: async () => null, acceptIncoming: async () => true, onEvent: () => undefined });
	assert.equal(first.seen.started, null);
	assert.equal(a.ready(), false);
	a.attachment.bind(NODE);
	assert.deepEqual(first.seen.started.adapter, { the: 'adapter' });
	assert.equal(a.ready(), true);
	// The node first, as for a wallet that hears its chain late.
	const second = fakeEntry();
	const b = createLightning({ entry: second, storage: memoryStorage().storage, cfg });
	b.attachment.bind(NODE);
	assert.equal(second.seen.started, null);
	b.start({ adapter: { the: 'adapter' }, lib, fetchProof: async () => null, acceptIncoming: async () => true, onEvent: () => undefined });
	assert.equal(b.ready(), true);
	// Started once: a second bind does not start a second service.
	b.attachment.bind(NODE);
	assert.equal(second.seen.bound.length, 2);
	assert.equal(b.ready(), true);

	// A service that will not start is said to whoever asked for it, whenever
	// that turns out, and the engine's bind does not throw for it.
	const failing = fakeEntry({ startFails: 'this engine is older than the package' });
	const c = createLightning({ entry: failing, storage: memoryStorage().storage, cfg });
	const said = [];
	c.start({ adapter: {}, lib, fetchProof: async () => null, acceptIncoming: async () => true, onEvent: () => undefined, onStartError: (err) => said.push(err.message) });
	c.attachment.bind(NODE);
	assert.deepEqual(said, ['this engine is older than the package']);
	assert.equal(c.ready(), false);
	assert.throws(() => c.channels(), { code: 'ERR_BEIGNET_LN_NOT_READY' });
});

test('starting: the library is handed the adapter, its callbacks in its own values, and no forwarding', async () => {
	const accepted = [];
	const events = [];
	const errors = [];
	const { ln, seen } = started({
		confirmations: 3,
		acceptIncoming: async (p) => {
			accepted.push(p);
			return true;
		},
		onEvent: (e) => {
			events.push(e);
			if (e.type === 'recovery') throw new Error('the host is stopping');
		},
		onError: (err) => {
			errors.push(err.message);
			throw new Error('the host is stopping');
		}
	});
	assert.equal(ln.ready(), true);
	const { adapter, options } = seen.started;
	assert.deepEqual(adapter, { the: 'adapter' });
	// Forwarding is never asked for: the library refuses it, and this wallet is no routing node.
	assert.deepEqual(Object.keys(options).sort(), ['acceptIncoming', 'confirmationDepth', 'fetchProvenance', 'groupProofResolver', 'onError', 'onEvent']);
	// The issuance that created a group: its key as hex in, the encoded file out, as bytes.
	const groupFile = await options.groupProofResolver('02'.repeat(33));
	assert.equal(Buffer.isBuffer(groupFile), true);
	assert.equal(groupFile.toString(), `the issuance of ${'02'.repeat(33)}`);
	// How deep a transaction is buried for good is the wallet's own measure.
	assert.equal(options.confirmationDepth, 3);
	// A decoded proof in, its decoded file out, by way of the host's proof server.
	assert.deepEqual(await options.fetchProvenance({ a: 'proof' }), { decoded: { fileFor: { locatorOf: { a: 'proof' } } } });
	// A peer's offer reaches the host in plain values.
	assert.equal(await options.acceptIncoming({ pendingChannelId: buf(0xaa), peer: PEER, assets: [{ assetId: ASSET, amount: 10n }] }), true);
	await options.acceptIncoming({ pendingChannelId: buf(0xab), peer: PEER, assets: [], groupKey: GROUP });
	assert.deepEqual(accepted, [
		{ pendingChannelId: 'aa'.repeat(32), peerPubkey: hexOf(PEER), assets: [{ assetId: '11'.repeat(32), amount: 10n }], groupKey: null },
		{ pendingChannelId: 'ab'.repeat(32), peerPubkey: hexOf(PEER), assets: [], groupKey: hexOf(GROUP) }
	]);
	// So does an event, and a host that throws on one is not the library's problem.
	options.onEvent({ type: 'invoice', paymentHash: buf(0x02), status: 'paid', assetAmount: 150n });
	options.onEvent({ type: 'channel', pendingChannelId: buf(0xaa), channelId: buf(0xbb), phase: 'active' });
	options.onEvent({ type: 'channel', pendingChannelId: buf(0xdd), phase: 'rejected', error: 'the peer said no' });
	options.onEvent({ type: 'payment', paymentHash: buf(0x05), status: 'failed', failure: 'no route' });
	options.onEvent({ type: 'recovery', channelId: buf(0xbb), status: 'complete' });
	options.onEvent(null);
	assert.deepEqual(events, [
		{ type: 'invoice', paymentHash: '02'.repeat(32), status: 'paid' },
		{ type: 'channel', pendingChannelId: 'aa'.repeat(32), channelId: 'bb'.repeat(32), phase: 'active' },
		{ type: 'channel', pendingChannelId: 'dd'.repeat(32), phase: 'rejected', error: 'the peer said no' },
		{ type: 'payment', paymentHash: '05'.repeat(32), status: 'failed', failure: 'no route' },
		{ type: 'recovery', channelId: 'bb'.repeat(32), status: 'complete' },
		{ type: '' }
	]);
	// What goes wrong where nobody waits reaches the host, from the start options and from the provider alike.
	options.onError(new Error('one'));
	seen.made.onError(new Error('two'));
	assert.deepEqual(errors, ['one', 'two']);

	// Without a measure of its own the library keeps its default, and the host's clock is handed on in seconds when there is one.
	const plain = started().seen;
	assert.deepEqual(Object.keys(plain.started.options).sort(), ['acceptIncoming', 'fetchProvenance', 'groupProofResolver', 'onError', 'onEvent']);
	const timed = started({}, { now: () => 1700000000999 }).seen;
	assert.equal(timed.made.now(), 1700000000n);
	assert.equal(timed.started.options.now(), 1700000000n);
});

test('a wallet whose Lightning side is off gives nobody a price', () => {
	const { seen } = started({ quiet: true });
	assert.equal(typeof seen.started.options.price, 'function');
	assert.throws(() => seen.started.options.price({ any: 'request' }), { message: 'This wallet is not taking asset payments.' });
	// One that is on leaves the pricing to the library's own plain-wallet rule.
	assert.equal('price' in started().seen.started.options, false);
});

test('channels: every one and every open that ended, in plain values', () => {
	const { ln } = started();
	const [channel, opening, cancelled, offered] = ln.channels();
	assert.deepEqual(channel, {
		pendingChannelId: 'aa'.repeat(32),
		channelId: 'bb'.repeat(32),
		peerPubkey: hexOf(PEER),
		initiator: true,
		phase: 'active',
		engine: 'held',
		signed: true,
		committed: true,
		confirmed: true,
		fundingTxid: 'f1'.repeat(32),
		state: 'NORMAL',
		// A channel of several issuances is one figure a side, named by the first.
		assetId: '11'.repeat(32),
		groupKey: null,
		assets: [
			{ assetId: '11'.repeat(32), amount: 500n },
			{ assetId: '12'.repeat(32), amount: 50n }
		],
		local: 450n,
		remote: 100n,
		// What its quotes hold back, not what its funding set aside.
		reserved: 25n,
		fundingSats: 100000,
		reserveSats: 1000,
		fundingReservation: null,
		fundingInputs: [],
		recovery: 'none',
		cancelled: false,
		error: null
	});
	// A signed funding the node holds no channel for: the name its inputs sit
	// under in the on-chain records, and what they hold, which is more than the channel takes.
	assert.deepEqual(
		{ ...opening, pendingChannelId: undefined, peerPubkey: undefined },
		{
			pendingChannelId: undefined,
			channelId: null,
			peerPubkey: undefined,
			initiator: true,
			phase: 'funding-created',
			engine: 'missing',
			signed: true,
			committed: true,
			confirmed: false,
			fundingTxid: 'f2'.repeat(32),
			state: null,
			assetId: '11'.repeat(32),
			groupKey: null,
			assets: [{ assetId: '11'.repeat(32), amount: 600n }],
			local: 600n,
			remote: 0n,
			reserved: 0n,
			fundingSats: 100000,
			reserveSats: null,
			fundingReservation: `funding:${'cc'.repeat(32)}`,
			fundingInputs: [{ assetId: '11'.repeat(32), amount: 1000n }],
			// A word for its recovery this host has not met is not "nothing owed".
			recovery: 'pending',
			cancelled: false,
			error: null
		}
	);
	// An open this wallet gave up, listed as failed with that for a reason.
	assert.deepEqual([cancelled.phase, cancelled.engine, cancelled.signed, cancelled.cancelled, cancelled.error, cancelled.assetId], ['failed', 'absent', false, true, 'cancelled', null]);
	// Whether the node holds one is read from its state when the library's word for it is new.
	assert.deepEqual([offered.initiator, offered.engine, offered.state, offered.groupKey, offered.cancelled], [false, 'held', 'SENT_ACCEPT', hexOf(GROUP), false]);
});

test('opening and closing: hex and sats in, the library\'s buffers and bigints out', async () => {
	const entry = fakeEntry();
	const { ln, seen } = started({}, { entry });
	const calls = (name) => seen.calls.filter((c) => c[0] === name).map((c) => c[1]);

	await ln.connect({ pubkey: hexOf(PEER), host: 'peer.example.com', port: 9735 });
	assert.deepEqual(NODE.connected.pop(), [hexOf(PEER), 'peer.example.com', 9735]);
	assert.equal(ln.peerSupports(hexOf(PEER)), true);
	assert.deepEqual(calls('peerSupports'), [PEER]);

	const assets = [{ assetId: '11'.repeat(32), amount: 600n }];
	assert.deepEqual(await ln.quoteFunding({ assets, groupKey: null, fundingSats: 100000, feeRate: 2 }), { feeSats: 420, vbytes: 210, reserveSats: 1062 });
	assert.deepEqual(calls('quoteFunding'), [{ assets: [{ assetId: ASSET, amount: 600n }], fundingSatoshis: 100000n, feeRate: 2 }]);

	const opened = await ln.openChannel({ pendingChannelId: 'aa'.repeat(32), peerPubkey: hexOf(PEER), assets, groupKey: null, decimalDisplay: 2, fundingSats: 100000, pushSats: 1708, feeRate: 2, maxFeeSats: 250000 });
	assert.deepEqual(opened, { channelId: 'bb'.repeat(32) });
	// The most the funding transaction may pay goes with the open itself, and how long a phase may take is the library's own.
	assert.deepEqual(calls('openChannel'), [
		{ peer: PEER, assets: [{ assetId: ASSET, amount: 600n }], decimalDisplay: 2, fundingSatoshis: 100000n, pushMsat: 1708000n, feeRate: 2, maxFee: 250000n, pendingChannelId: buf(0xaa) }
	]);
	// A grouped asset is opened by its group key as well.
	const group = hexOf(GROUP);
	await ln.openChannel({ pendingChannelId: 'aa'.repeat(32), peerPubkey: hexOf(PEER), assets, groupKey: group, decimalDisplay: null, fundingSats: 100000, pushSats: 0, feeRate: 1 });
	const grouped = calls('openChannel')[1];
	assert.deepEqual([hexOf(grouped.groupKey), 'decimalDisplay' in grouped, 'maxFee' in grouped, grouped.pushMsat], [group, false, false, 0n]);

	assert.equal(await ln.cancelFlow('aa'.repeat(32)), true);
	assert.deepEqual(calls('cancelChannel'), [buf(0xaa)]);
	await ln.closeChannel({ channelId: 'bb'.repeat(32), force: 1 });
	assert.deepEqual(calls('closeChannel'), [{ channelId: buf(0xbb), force: true }]);
	// An open that ended is taken off the library's list, by either of its ids.
	assert.deepEqual([ln.forgetChannel('dd'.repeat(32)), ln.forgetChannel('aa'.repeat(32))], [true, false]);
	assert.deepEqual(calls('forgetChannel'), [buf(0xdd), buf(0xaa)]);

	// What one payment can move, by asset or by group.
	assert.deepEqual(ln.paymentLimits(), [
		{ assetId: '11'.repeat(32), groupKey: null, maxSend: 450n, maxReceive: 200n, sendChannelId: 'bb'.repeat(32), receiveChannelId: 'bc'.repeat(32) },
		{ assetId: null, groupKey: group, maxSend: 0n, maxReceive: 7n, sendChannelId: null, receiveChannelId: 'bd'.repeat(32) }
	]);

	await ln.resume();
	assert.deepEqual(await ln.resumeRecovery(), [{ channelId: 'bb'.repeat(32), completed: 2, pending: 1, errors: ['not yet mature', 'a plain word'] }]);
	assert.deepEqual(seen.calls.slice(-2).map((c) => c[0]), ['resume', 'recovery.resume']);

	// What became of what a funding had set aside. A word this host has not met is one to ask about again.
	const unit = (amount) => [{ assetId: '11'.repeat(32), amount }];
	assert.deepEqual(await ln.settleFundingReservations(), [
		{ reservation: `funding:${'c1'.repeat(32)}`, pendingChannelId: 'c1'.repeat(32), outcome: 'released', assets: unit(70n), channelId: null, fundingTxid: null, change: [], changeRestored: false, reason: null },
		{ reservation: `funding:${'c2'.repeat(32)}`, pendingChannelId: 'c2'.repeat(32), outcome: 'moved', assets: unit(1000n), channelId: 'bb'.repeat(32), fundingTxid: 'f1'.repeat(32), change: unit(400n), changeRestored: true, reason: null },
		{ reservation: `funding:${'c5'.repeat(32)}`, pendingChannelId: 'c5'.repeat(32), outcome: 'moved', assets: [], channelId: null, fundingTxid: null, change: unit(9n), changeRestored: false, reason: null },
		{ reservation: `funding:${'c3'.repeat(32)}`, pendingChannelId: 'c3'.repeat(32), outcome: 'kept', assets: [], channelId: null, fundingTxid: null, change: [], changeRestored: false, reason: 'the funding transaction is not buried yet' },
		{ reservation: `funding:${'c4'.repeat(32)}`, pendingChannelId: null, outcome: 'kept', assets: [], channelId: null, fundingTxid: null, change: [], changeRestored: false, reason: null }
	]);
	// The way out of a funding that will not confirm: the id as the library
	// takes it, and the txid of the spend as a person is shown it.
	assert.deepEqual(await ln.reclaimFunding({ pendingChannelId: 'cc'.repeat(32), feeRate: 7 }), { txid: `ab${'00'.repeat(31)}`, feeSats: 321 });
	assert.deepEqual(calls('reclaimFundingInputs'), [{ pendingChannelId: buf(0xcc), feeRate: 7 }]);
	// Whether the node offers asset channels to its peers, in its own word for why not.
	seen.advertisement = { advertised: true };
	assert.deepEqual(ln.advertisement(), { advertised: true, reason: null });
	seen.advertisement = { advertised: false, reason: 'the node does not signal option_simple_taproot' };
	assert.deepEqual(ln.advertisement(), { advertised: false, reason: 'the node does not signal option_simple_taproot' });
	// Only a plain true says it does. An engine that cannot say, or a library with no such call, says nothing.
	seen.advertisement = { advertised: 'yes' };
	assert.deepEqual(ln.advertisement(), { advertised: false, reason: null });
	seen.advertisement = undefined;
	assert.equal(ln.advertisement(), null);
	delete entry.service.advertisement;
	assert.equal(ln.advertisement(), null);

	// The fee coin pool, as the engine says it, in plain values.
	assert.equal(ln.feeStatus(), null, 'a node with no fee policy says nothing');
	seen.feeStatus = {
		available: true,
		budget: { totalSatoshis: 25000n, reservedSatoshis: 1000n, spentSatoshis: 2000n, remainingSatoshis: 22000n },
		feeCoins: { ready: 2, readySatoshis: 2000n, unconfirmed: 1 },
		actions: [{}],
		splits: [{}, {}],
		preparation: { possible: false, forFeeSatoshis: 1000n, neededSatoshis: 1500n, largestConfirmedSatoshis: 0n, reason: 'FEE_FUNDS_UNAVAILABLE' },
		lastRefusal: { code: 'FEE_FUNDS_UNAVAILABLE', remedy: 'fund', at: 1700000000000 }
	};
	assert.deepEqual(ln.feeStatus(), {
		available: true,
		budget: { totalSats: '25000', reservedSats: '1000', spentSats: '2000', remainingSats: '22000' },
		feeCoins: { ready: 2, readySats: '2000', unconfirmed: 1 },
		actions: 1,
		splits: 2,
		preparation: { possible: false, forFeeSats: '1000', neededSats: '1500', largestConfirmedSats: '0', reason: 'FEE_FUNDS_UNAVAILABLE' },
		lastRefusal: { code: 'FEE_FUNDS_UNAVAILABLE', remedy: 'fund', at: 1700000000000 }
	});
	// A pool that can prepare a fee coin has no reason and no refusal to say.
	seen.feeStatus = { ...seen.feeStatus, preparation: { possible: true, forFeeSatoshis: 1000n, neededSatoshis: 1500n, largestConfirmedSatoshis: 90000n }, lastRefusal: undefined };
	assert.deepEqual([ln.feeStatus().preparation, ln.feeStatus().lastRefusal], [{ possible: true, forFeeSats: '1000', neededSats: '1500', largestConfirmedSats: '90000', reason: null }, null]);
	// A policy the engine refused is said as it is.
	seen.feeStatus = { available: false, error: { code: 'FEE_POLICY_REFUSED', remedy: 'operator', message: 'the fee coin value is below dust' } };
	assert.deepEqual(ln.feeStatus(), { available: false, error: { code: 'FEE_POLICY_REFUSED', remedy: 'operator', message: 'the fee coin value is below dust' } });
	// A library with no such call says nothing.
	delete entry.service.fixedOutputFeeStatus;
	assert.equal(ln.feeStatus(), null);

	// A peer is there once the node lists it with its greeting, which is the library's own rule.
	NODE.peers = [{ pubkey: hexOf(PEER), remoteInit: null }];
	assert.equal(ln.peerConnected(hexOf(PEER)), false);
	NODE.peers = [{ pubkey: hexOf(PEER).toUpperCase(), remoteInit: {} }];
	assert.deepEqual([ln.peerConnected(hexOf(PEER)), ln.peerConnected(`03${'ee'.repeat(32)}`)], [true, false]);
	// What the node itself holds under an id, the open's or the channel's own, whatever kind of channel it is.
	NODE.channels = [{ channelId: buf(0x51), temporaryChannelId: buf(0x52) }, { channelId: 'AB'.repeat(32) }];
	assert.deepEqual([[hexOf(buf(0x51))], [hexOf(buf(0x52))], ['ab'.repeat(32)], [null, hexOf(buf(0x53))], []].map((ids) => ln.engineHolds(ids)), [true, true, true, false, false]);
	// A node that cannot be asked says neither yes nor no.
	const { listPeers, listChannels } = NODE;
	delete NODE.listPeers;
	delete NODE.listChannels;
	assert.deepEqual([ln.peerConnected(hexOf(PEER)), ln.engineHolds([hexOf(buf(0x51))])], [null, null]);
	Object.assign(NODE, { listPeers, listChannels, peers: [], channels: [] });

	// Whose refusal it is that no channel can be opened with a peer: the library's code, and the engine's reason on one line.
	assert.equal(ln.peerRefusal(hexOf(PEER)), null);
	entry.service.peerRefusal = () => ({ code: 'ERR_BEIGNET_LN_MODE_UNAVAILABLE', message: 'this node opens no asset channel with the peer: no mode', reason: 'no mode\n in common' });
	assert.deepEqual(ln.peerRefusal(hexOf(PEER)), { code: 'ERR_BEIGNET_LN_MODE_UNAVAILABLE', reason: 'no mode in common' });
	entry.service.peerRefusal = () => ({ code: 'ERR_BEIGNET_LN_PEER_OFFLINE', message: 'the peer is not connected' });
	assert.deepEqual(ln.peerRefusal(hexOf(PEER)), { code: 'ERR_BEIGNET_LN_PEER_OFFLINE', reason: null });
	// A library that only says yes or no: a no is the peer's.
	delete entry.service.peerRefusal;
	assert.equal(ln.peerRefusal(hexOf(PEER)), null);
	entry.service.peerSupports = () => false;
	assert.deepEqual(ln.peerRefusal(hexOf(PEER)), { code: 'ERR_BEIGNET_LN_PEER_UNSUPPORTED', reason: null });
});

test('invoices and payments: amounts as bigint, times in milliseconds, a status the host knows', async () => {
	const { ln, seen } = started();
	const calls = (name) => seen.calls.filter((c) => c[0] === name).map((c) => c[1]);

	const quote = await ln.quoteInvoice({ assetId: '11'.repeat(32), groupKey: null, amount: 150n, peerPubkey: hexOf(PEER), expirySeconds: 3600 });
	assert.deepEqual(quote, {
		quoteId: '01'.repeat(32),
		peerPubkey: hexOf(PEER),
		assetAmount: 150n,
		amountMsat: 150000n,
		unitsPerBtc: { coefficient: 100000000n, scale: 0 },
		expiresAt: 1700000060000,
		// Whether the rate is a price or the plain wallet's stand-in is the library's to say.
		priced: false
	});
	assert.deepEqual(calls('quoteInvoice'), [{ asset: { assetId: ASSET }, amount: 150n, peer: PEER, expirySeconds: 3600 }]);
	// By its group, from whichever peer the library picks, for as long as the library gives.
	const group = hexOf(GROUP);
	await ln.quoteInvoice({ assetId: '11'.repeat(32), groupKey: group, amount: 1n, peerPubkey: null });
	assert.deepEqual(Object.keys(calls('quoteInvoice')[1]), ['asset', 'amount']);
	assert.equal(hexOf(calls('quoteInvoice')[1].asset.groupKey), group);

	const invoice = await ln.createInvoice({ quoteId: quote.quoteId, description: 'tea', expirySeconds: 3600 });
	assert.deepEqual(invoice, { bolt11: 'lnbcrt1invoice', paymentHash: '02'.repeat(32), assetAmount: 150n, amountMsat: 150000n, expiresAt: 1700003600000 });
	assert.deepEqual(calls('createInvoice'), [{ quoteId: buf(0x01), description: 'tea', expirySeconds: 3600 }]);
	await ln.createInvoice({ quoteId: quote.quoteId, description: '', expirySeconds: 60 });
	assert.equal('description' in calls('createInvoice')[1], false);
	// A status this host has no word for is an open invoice until it is paid
	// or expired. What the engine still keeps of an invoice is not read: the
	// host has its own row. What arrived stands beside what was invoiced.
	assert.deepEqual(ln.invoices(), [
		{ paymentHash: '02'.repeat(32), assetAmount: 150n, received: 149n, status: 'paid' },
		{ paymentHash: '03'.repeat(32), assetAmount: 5n, received: 0n, status: 'open' },
		{ paymentHash: '08'.repeat(32), assetAmount: 5n, received: null, status: 'expired' }
	]);

	const pay = await ln.quotePayment({ bolt11: 'lnbcrt1other', assetId: '11'.repeat(32), groupKey: null, amountMsat: null });
	assert.deepEqual(pay, {
		quoteId: '04'.repeat(32),
		paymentHash: '05'.repeat(32),
		peerPubkey: hexOf(PEER),
		channelId: 'bb'.repeat(32),
		assetAmount: 50n,
		amountMsat: 50000n,
		feeMsat: 1000n,
		unitsPerBtc: { coefficient: 4000000n, scale: 0 },
		expiresAt: 1700000060000,
		priced: true
	});
	assert.deepEqual(calls('quotePayment'), [{ invoice: 'lnbcrt1other', asset: { assetId: ASSET } }]);
	await ln.quotePayment({ bolt11: 'lnbcrt1other', assetId: '11'.repeat(32), groupKey: null, amountMsat: 75000n });
	assert.equal(calls('quotePayment')[1].amountMsat, 75000n);

	const paid = await ln.payInvoice({ quoteId: pay.quoteId, maxAssetAmount: 50n });
	// Which try the record stands for travels with it. The preimage does not.
	assert.deepEqual(paid, { paymentHash: '05'.repeat(32), assetAmount: 50n, status: 'complete', feeMsat: 2000n, failure: null, attempt: 2, lost: false, unconfirmed: false });
	assert.deepEqual(calls('payInvoice'), [{ quoteId: buf(0x04), maxAssetAmount: 50n }]);
	assert.deepEqual(ln.payment('05'.repeat(32)), { paymentHash: '05'.repeat(32), assetAmount: 50n, status: 'failed', feeMsat: null, failure: 'no route', attempt: 1, lost: false, unconfirmed: false });
	// A payment the engine forgot, and one it never confirmed as an asset payment, say so.
	assert.deepEqual(ln.payment('07'.repeat(32)), { paymentHash: '07'.repeat(32), assetAmount: 9n, status: 'pending', feeMsat: null, failure: null, attempt: 3, lost: true, unconfirmed: true });
	assert.deepEqual(ln.payment('09'.repeat(32)), { paymentHash: '09'.repeat(32), assetAmount: 9n, status: 'pending', feeMsat: null, failure: null, attempt: null, lost: false, unconfirmed: false });
	// No record is the library's `undefined`, and the host's null.
	assert.equal(ln.payment('06'.repeat(32)), null);
});

test('a backup of asset channels is the library\'s to make and to read, over the store alone', () => {
	const entry = fakeEntry();
	const ln = createLightning({ entry, storage: memoryStorage().storage, cfg, now: () => 1700000000999 });
	// Neither needs a service or a node: a wallet that cannot start still backs up and restores.
	assert.equal(ln.ready(), false);
	const made = ln.backup();
	assert.deepEqual(made, { version: 1, rows: [{ key: 'tap/channel/v1/last/bb', value: 'a row' }] });
	assert.equal(entry.seen.backedUp[0], entry.seen.made.store);
	assert.equal(ln.restore(made), 1);
	const [store, given, options] = entry.seen.restored[0];
	assert.equal(store, entry.seen.made.store);
	assert.equal(given, made);
	assert.equal(options.now(), 1700000000n);
	// What the library refuses is the caller's to word.
	entry.restoreAssetLightningBackup = () => {
		throw Object.assign(new Error('ERR_BEIGNET_LN_INVALID: the store is not empty'), { code: 'ERR_BEIGNET_LN_INVALID' });
	};
	assert.throws(() => ln.restore(made), { code: 'ERR_BEIGNET_LN_INVALID' });
});

test('stopping closes the service once and leaves the provider; closing lets go of the library\'s host as well', async () => {
	const { ln, seen } = started();
	ln.stop();
	ln.stop();
	assert.equal(seen.closed, 1);
	assert.equal(seen.hostClosed, 0);
	assert.equal(ln.ready(), false);
	assert.throws(() => ln.channels(), { code: 'ERR_BEIGNET_LN_NOT_READY' });
	await assert.rejects(ln.resume(), { code: 'ERR_BEIGNET_LN_NOT_READY' });
	// Stopped is not started again by a bind: it starts when it is asked to.
	ln.attachment.bind(NODE);
	assert.equal(ln.ready(), false);
	ln.start({ adapter: { the: 'adapter' }, lib, fetchProof: async () => null, acceptIncoming: async () => true, onEvent: () => undefined });
	assert.equal(ln.ready(), true);
	// When the node stops, everything goes.
	ln.close();
	assert.equal(seen.closed, 2);
	assert.equal(seen.hostClosed, 1);
	assert.equal(ln.ready(), false);
	// Let the rejected closes settle: nothing here listens for them but the facade.
	await new Promise((resolve) => setImmediate(resolve));
});

/*
 * The real entry, when a path to its built dist/lightning.js is given. On an
 * engine that cannot carry asset channels (Beignet 0.42.0) it must say so,
 * and the host must then be the host it was before there was an entry.
 *
 * Run: cd manager && ASSETS_LIGHTNING_ENTRY=/path/to/node_modules/@ts-tap/beignet/dist/lightning.js \
 *        node --test server/assets-host/adapter.test.js
 */
const REAL_ENTRY = process.env.ASSETS_LIGHTNING_ENTRY ? path.resolve(process.env.ASSETS_LIGHTNING_ENTRY) : null;

test(
	'the real entry beside an engine that cannot carry asset channels: no Lightning side, and a host that is as it was',
	{ skip: REAL_ENTRY ? false : 'set ASSETS_LIGHTNING_ENTRY to a built dist/lightning.js to run this against the real entry' },
	async () => {
		const entry = require(REAL_ENTRY);
		// It is the entry this app was written to.
		for (const name of ['assetLightningSupport', 'lightningStore', 'createAssetLightningHost', 'assetLightningBackup', 'restoreAssetLightningBackup']) assert.equal(typeof entry[name], 'function', name);
		assert.equal(Array.isArray(entry.ASSET_PAYMENT_REFUSALS) && entry.ASSET_PAYMENT_REFUSALS.length > 0, true);
		// The codes the host words by name are codes this library has, and the
		// two refusals of a payment that record nothing are in its list of them.
		const codes = Object.values(entry.BeignetLightningErrorCode || {});
		for (const code of Object.keys(LIGHTNING_REFUSALS)) assert.equal(codes.includes(code), true, code);
		for (const code of ['ERR_BEIGNET_LN_PEER_OFFLINE', 'ERR_BEIGNET_LN_MODE_UNAVAILABLE', 'ERR_BEIGNET_LN_FEE_POLICY_REFUSED']) assert.equal(codes.includes(code), true, code);
		for (const code of ['ERR_BEIGNET_LN_PAYMENT_UNSUPPORTED', 'ERR_BEIGNET_LN_OUTCOMES_UNDELIVERED']) assert.equal(entry.ASSET_PAYMENT_REFUSALS.includes(code), true, code);
		const support = entry.assetLightningSupport();
		assert.equal(support.supported, false, 'this engine carries asset channels: run this against Beignet 0.42.0');
		assert.equal(Array.isArray(support.missing) && support.missing.length > 0, true);
		// No Lightning side, and nothing written to the wallet's storage for one.
		const map = new Map();
		const { storage } = memoryStorage(map);
		assert.equal(createLightning({ entry, storage, cfg }), null);
		assert.equal(map.size, 0);

		// The same through the host's own way in, when the entry sits in a node_modules directory.
		const modules = path.resolve(path.dirname(REAL_ENTRY), '..', '..', '..');
		if (path.basename(modules) !== 'node_modules' || !fs.existsSync(path.join(modules, 'ts-tap'))) return;
		const { attach, lightningFor } = require('./index');
		const context = () => ({ storage: memoryStorage().storage, network: 'regtest', wallet: {}, logger: { info: () => undefined, warn: () => undefined, error: () => undefined } });
		const wished = parseConfig('regtest', { BEIGNET_ASSETS_MODULES: modules, BEIGNET_ASSETS_LIGHTNING: 'full' });
		assert.equal(loadLightning(modules), entry);
		assert.equal(lightningFor(wished, context()), null);
		const ask = async () => ({ answered: true, genesis: null, chain: 'regtest' });
		const attachment = await attach(wished, context(), { ask });
		// What a wallet with no entry at all is handed, key for key.
		const without = await attach(wished, context(), { ask, lightningFor: () => null });
		try {
			for (const name of ['auxiliaryChannels', 'fixedOutputFees', 'bind']) assert.equal(name in attachment, false, name);
			assert.deepEqual(Object.keys(attachment).sort(), Object.keys(without).sort());
			assert.deepEqual(Object.keys(attachment.handlers).sort(), Object.keys(without.handlers).sort());
			assert.deepEqual(attachment.status().lightning, { mode: 'off', usableChannels: 0, feeCoins: null });
			assert.deepEqual({ ...attachment.status(), startup: null }, { ...without.status(), startup: null });
		} finally {
			await attachment.stop('shutdown');
			await without.stop('shutdown');
		}
	}
);
