'use strict';

/**
 * The seam to the library's Lightning entry: when it is loaded, and what the
 * rest of the host is given in its place.
 *
 * The entry stood in for here is the one adapter.js was written to (the
 * numbered list at the top of its Lightning section): each call below is
 * that list, as a check. Against a real entry, see contract.test.js.
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
const { mapError } = require('./errors');

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

/** The entry as adapter.js assumes it, recording what it is asked. */
function fakeEntry({ supported = true } = {}) {
	const seen = { calls: [], made: null, started: null, bound: [], closed: 0 };
	const note = (name, arg) => {
		seen.calls.push([name, arg]);
	};
	const channel = {
		pendingChannelId: buf(0xaa),
		channelId: buf(0xbb),
		peer: PEER,
		initiator: true,
		phase: 'active',
		signed: true,
		confirmed: true,
		state: 'NORMAL',
		fundingSatoshis: 100000n,
		reserveSatoshis: 1000n,
		assets: [
			{ assetId: ASSET, local: 400n, remote: 100n },
			{ assetId: buf(0x12), local: 50n, remote: 0n }
		],
		reserved: 25n,
		recovery: 'none'
	};
	const service = {
		channels: () => [channel, { pendingChannelId: buf(0xcc), peer: PEER, phase: 'accepted', fundingSatoshis: 100000n, assets: [{ assetId: ASSET, local: 600n, remote: 0n }] }],
		peerSupports: (peer) => {
			note('peerSupports', peer);
			return 1;
		},
		quoteFunding: async (request) => {
			note('quoteFunding', request);
			return { feeSatoshis: 420n, vsize: 210 };
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
		resume: async () => {
			note('resume');
		},
		recovery: {
			resume: async () => {
				note('recovery.resume');
				return [{ channelId: buf(0xbb), completed: [1, 2], pending: [3], superseded: [], errors: [{ txid: 'ab', message: 'not yet mature' }] }];
			}
		},
		quoteInvoice: async (request) => {
			note('quoteInvoice', request);
			return { quoteId: buf(0x01), peer: PEER, assetAmount: 150n, milliSatoshi: 150000n, assetRate: { coefficient: 100000000n, scale: 0 }, expiresAt: 1700000060 };
		},
		createInvoice: async (request) => {
			note('createInvoice', request);
			return { bolt11: 'lnbcrt1invoice', paymentHash: buf(0x02), assetAmount: 150n, milliSatoshi: 150000n, expiresAt: 1700003600n };
		},
		invoices: () => [
			{ paymentHash: buf(0x02), assetAmount: 150n, status: 'paid' },
			{ paymentHash: buf(0x03), assetAmount: 5n, status: 'something new' }
		],
		quotePayment: async (request) => {
			note('quotePayment', request);
			return { quoteId: buf(0x04), paymentHash: buf(0x05), peer: PEER, channelId: buf(0xbb), assetAmount: 50n, milliSatoshi: 50000n, assetRate: { coefficient: '4000000', scale: 0 }, expiresAt: 1700000060 };
		},
		payInvoice: async (request) => {
			note('payInvoice', request);
			return { paymentHash: buf(0x05), assetAmount: 50n, status: 'complete', feeMsat: 2000n };
		},
		payment: (hash) => (hash.equals(buf(0x05)) ? { paymentHash: hash, assetAmount: 50n, status: 'failed', failure: 'no route' } : undefined),
		close: () => {
			seen.closed += 1;
			return Promise.reject(new Error('already closing'));
		}
	};
	const entry = {
		seen,
		service,
		assetLightningSupport: () => ({ supported, missing: supported ? [] : ['auxiliaryChannels'] }),
		lightningStore: (backend, prefix) => ({ backend, prefix }),
		createAssetLightningHost: (given) => {
			seen.made = given;
			return {
				attachment: { auxiliaryChannels: { the: 'hooks' }, fixedOutputFees: given.fixedOutputFees, bind: (node) => seen.bound.push(node) },
				start: async (adapter, options) => {
					seen.started = { adapter, options };
					return service;
				}
			};
		}
	};
	return entry;
}

const NODE = {
	connected: [],
	connectPeer: async (...args) => {
		NODE.connected.push(args);
	}
};
const lib = { decodeProofFile: (bytes) => ({ decoded: bytes }), proofLocator: (p) => ({ locatorOf: p }) };

/** A started facade over a fake entry, with its node bound. */
async function started(options = {}) {
	const entry = fakeEntry();
	const storage = memoryStorage().storage;
	const ln = createLightning({ entry, storage, cfg });
	const given = {
		adapter: { the: 'adapter' },
		lib,
		fetchProof: async (locator) => ({ fileFor: locator }),
		acceptIncoming: async () => true,
		onEvent: () => undefined,
		...options
	};
	await ln.start(given);
	ln.attachment.bind(NODE);
	return { entry, ln, storage, seen: entry.seen };
}

test('the Lightning entry is loaded only when the adapter beside the engine ships it', () => {
	// No adapter there at all, and one from before asset channels: nothing is asked to load.
	assert.equal(loadLightning('/nonexistent/engine/node_modules'), null);
	withModules({ 'package.json': PACKAGE, 'dist/index.js': 'throw new Error("never loaded");' }, (modules) => {
		assert.equal(loadLightning(modules), null);
	});
	// One that ships it.
	withModules(
		{
			'package.json': PACKAGE,
			'dist/lightning.js': 'module.exports = { assetLightningSupport: () => ({ supported: true, missing: [] }), lightningStore: () => ({}), createAssetLightningHost: () => ({}) };'
		},
		(modules) => {
			const entry = loadLightning(modules);
			assert.deepEqual(Object.keys(entry).sort(), ['assetLightningSupport', 'createAssetLightningHost', 'lightningStore']);
		}
	);
	// One that ships something else under the name, or that will not load: said in a sentence.
	withModules({ 'package.json': PACKAGE, 'dist/lightning.js': 'module.exports = { assetLightningSupport: () => ({ supported: true }) };' }, (modules) => {
		assert.throws(() => loadLightning(modules), { message: 'The asset channels package beside the wallet engine is not a version this app was built for.' });
	});
	withModules({ 'package.json': PACKAGE, 'dist/lightning.js': 'throw new Error("needs a newer engine");' }, (modules) => {
		assert.throws(() => loadLightning(modules), { message: 'The asset channels package beside the wallet engine could not be loaded (needs a newer engine).' });
	});
});

test('no entry, or an engine that cannot carry asset channels: there is no Lightning side', () => {
	const storage = memoryStorage().storage;
	assert.equal(createLightning({ entry: null, storage, cfg }), null);
	const old = fakeEntry({ supported: false });
	assert.equal(createLightning({ entry: old, storage, cfg }), null);
	// Nothing was built over the wallet's storage for it.
	assert.equal(old.seen.made, null);
	assert.equal(createLightning({ entry: { ...old, assetLightningSupport: () => null }, storage, cfg }), null);
});

test('the provider is built over its own rows before there is an adapter or a node', () => {
	const entry = fakeEntry();
	const storage = memoryStorage().storage;
	const ln = createLightning({ entry, storage, cfg });
	// The library's Lightning rows sit under l/ in the wallet's own storage.
	assert.equal(entry.seen.made.store.backend, storage);
	assert.equal(entry.seen.made.store.prefix, 'l/');
	assert.equal(entry.seen.made.hrp, 'taprt');
	assert.deepEqual(entry.seen.made.fixedOutputFees, { maxFeeSatoshis: 10000n, maxTotalFeeSatoshis: 250000n, maxPreparationFeeSatoshis: 10000n, feeCoinCount: 4 });
	// What the engine is handed is the library's own, with the node noted on its way through.
	assert.deepEqual(Object.keys(ln.attachment).sort(), ['auxiliaryChannels', 'bind', 'fixedOutputFees']);
	assert.deepEqual(ln.attachment.auxiliaryChannels, { the: 'hooks' });
	assert.equal(ln.attachment.fixedOutputFees, entry.seen.made.fixedOutputFees);
	assert.equal(entry.seen.started, null);
	assert.equal(ln.ready(), false);
	// Until it is started and bound, everything else says so.
	assert.throws(() => ln.channels(), { code: 'ERR_BEIGNET_LN_NOT_READY' });
	assert.equal(mapError(Object.assign(new Error('x'), { code: 'ERR_BEIGNET_LN_NOT_READY' })).extensionCode, 'ASSETS_STARTING');
	ln.attachment.bind(NODE);
	assert.deepEqual(entry.seen.bound, [NODE]);
	assert.equal(ln.ready(), false);
	assert.throws(() => ln.peerSupports(hexOf(PEER)), { code: 'ERR_BEIGNET_LN_NOT_READY' });
});

test('neither one transaction of a channel nor all of them pay more than the wallet lets an asset transaction pay', () => {
	// The wallet's ceiling is 250,000 sats unless it was given another.
	assert.deepEqual(fixedOutputFees(cfg), { maxFeeSatoshis: 10000n, maxTotalFeeSatoshis: 250000n, maxPreparationFeeSatoshis: 10000n, feeCoinCount: 4 });
	const tight = parseConfig('regtest', { BEIGNET_ASSETS_MODULES: '/opt/engine/node_modules', BEIGNET_ASSETS_MAX_FEE_SATS: '4000' });
	assert.deepEqual(fixedOutputFees(tight), { maxFeeSatoshis: 4000n, maxTotalFeeSatoshis: 4000n, maxPreparationFeeSatoshis: 4000n, feeCoinCount: 4 });
	const loose = parseConfig('regtest', { BEIGNET_ASSETS_MODULES: '/opt/engine/node_modules', BEIGNET_ASSETS_MAX_FEE_SATS: '5000000' });
	assert.deepEqual([fixedOutputFees(loose).maxFeeSatoshis, fixedOutputFees(loose).maxTotalFeeSatoshis], [10000n, 1000000n]);
	assert.deepEqual([CHANNEL_SATS, CARRIER_SATS, { ...NOMINAL_RATE }], [100000, 354, { coefficient: 100000000n, scale: 0 }]);
});

test('starting: the library is handed the adapter, its callbacks in its own values, and no forwarding', async () => {
	const accepted = [];
	const events = [];
	const { ln, seen } = await started({
		acceptIncoming: async (p) => {
			accepted.push(p);
			return true;
		},
		onEvent: (e) => {
			events.push(e);
			if (e.type === 'recovery') throw new Error('the host is stopping');
		}
	});
	assert.equal(ln.ready(), true);
	const { adapter, options } = seen.started;
	assert.deepEqual(adapter, { the: 'adapter' });
	assert.deepEqual(Object.keys(options).sort(), ['acceptIncoming', 'fetchProvenance', 'forwarding', 'onEvent']);
	assert.equal(options.forwarding, false);
	// A decoded proof in, its decoded file out, by way of the host's proof server.
	assert.deepEqual(await options.fetchProvenance({ a: 'proof' }), { decoded: { fileFor: { locatorOf: { a: 'proof' } } } });
	// A peer's offer reaches the host in plain values.
	assert.equal(await options.acceptIncoming({ pendingChannelId: buf(0xaa), peer: PEER, assets: [{ assetId: ASSET, amount: 10n }] }), true);
	assert.deepEqual(accepted, [{ pendingChannelId: 'aa'.repeat(32), peerPubkey: hexOf(PEER), assets: [{ assetId: '11'.repeat(32), amount: 10n }], groupKey: null }]);
	// So does an event, and a host that throws on one is not the library's problem.
	options.onEvent({ type: 'invoice', paymentHash: buf(0x02), status: 'paid', assetAmount: 150n });
	options.onEvent({ type: 'channel', pendingChannelId: buf(0xaa), channelId: buf(0xbb), phase: 'active' });
	options.onEvent({ type: 'recovery', channelId: buf(0xbb), status: 'complete' });
	options.onEvent(null);
	assert.deepEqual(events, [
		{ type: 'invoice', paymentHash: '02'.repeat(32), status: 'paid' },
		{ type: 'channel', pendingChannelId: 'aa'.repeat(32), channelId: 'bb'.repeat(32), phase: 'active' },
		{ type: 'recovery', channelId: 'bb'.repeat(32), status: 'complete' },
		{ type: '' }
	]);
});

test('a wallet whose Lightning side is off gives nobody a price', async () => {
	const { seen } = await started({ quiet: true });
	assert.equal(typeof seen.started.options.price, 'function');
	assert.throws(() => seen.started.options.price({ any: 'request' }), { message: 'This wallet is not taking asset payments.' });
	// One that is on leaves the pricing to the library's own plain-wallet rule.
	assert.equal('price' in (await started()).seen.started.options, false);
});

test('channels: every one and every unfinished open, in plain values', async () => {
	const { ln } = await started();
	assert.deepEqual(ln.channels(), [
		{
			pendingChannelId: 'aa'.repeat(32),
			channelId: 'bb'.repeat(32),
			peerPubkey: hexOf(PEER),
			initiator: true,
			phase: 'active',
			signed: true,
			confirmed: true,
			state: 'NORMAL',
			// A channel of several issuances is one figure a side, named by the first.
			assetId: '11'.repeat(32),
			groupKey: null,
			local: 450n,
			remote: 100n,
			reserved: 25n,
			fundingSats: 100000,
			reserveSats: 1000,
			recovery: 'none'
		},
		{
			pendingChannelId: 'cc'.repeat(32),
			channelId: null,
			peerPubkey: hexOf(PEER),
			initiator: false,
			phase: 'accepted',
			signed: false,
			confirmed: false,
			state: null,
			assetId: '11'.repeat(32),
			groupKey: null,
			local: 600n,
			remote: 0n,
			reserved: 0n,
			fundingSats: 100000,
			reserveSats: null,
			recovery: 'none'
		}
	]);
});

test('opening and closing: hex and sats in, the library\'s buffers and bigints out', async () => {
	const { ln, seen } = await started();
	const calls = (name) => seen.calls.filter((c) => c[0] === name).map((c) => c[1]);

	await ln.connect({ pubkey: hexOf(PEER), host: 'peer.example.com', port: 9735 });
	assert.deepEqual(NODE.connected.pop(), [hexOf(PEER), 'peer.example.com', 9735]);
	assert.equal(ln.peerSupports(hexOf(PEER)), true);
	assert.deepEqual(calls('peerSupports'), [PEER]);

	const assets = [{ assetId: '11'.repeat(32), amount: 600n }];
	// The library names no reserve here, so the host works one out.
	assert.deepEqual(await ln.quoteFunding({ assets, groupKey: null, fundingSats: 100000, feeRate: 2 }), { feeSats: 420, vbytes: 210, reserveSats: null });
	assert.deepEqual(calls('quoteFunding'), [{ assets: [{ assetId: ASSET, amount: 600n }], fundingSatoshis: 100000n, feeRate: 2 }]);

	const opened = await ln.openChannel({ pendingChannelId: 'aa'.repeat(32), peerPubkey: hexOf(PEER), assets, groupKey: null, decimalDisplay: 2, fundingSats: 100000, pushSats: 1708, feeRate: 2, maxFeeSats: 250000 });
	assert.deepEqual(opened, { channelId: 'bb'.repeat(32) });
	// The most the funding transaction may pay goes with the open itself.
	assert.deepEqual(calls('openChannel'), [
		{ peer: PEER, assets: [{ assetId: ASSET, amount: 600n }], decimalDisplay: 2, fundingSatoshis: 100000n, pushMsat: 1708000n, feeRate: 2, maxFee: 250000n, pendingChannelId: buf(0xaa) }
	]);
	// A grouped asset is opened by its group key as well.
	const group = `03${'cd'.repeat(32)}`;
	await ln.openChannel({ pendingChannelId: 'aa'.repeat(32), peerPubkey: hexOf(PEER), assets, groupKey: group, decimalDisplay: null, fundingSats: 100000, pushSats: 0, feeRate: 1 });
	const grouped = calls('openChannel')[1];
	assert.deepEqual([hexOf(grouped.groupKey), 'decimalDisplay' in grouped, grouped.pushMsat], [group, false, 0n]);

	assert.equal(await ln.cancelFlow('aa'.repeat(32)), true);
	assert.deepEqual(calls('cancelChannel'), [buf(0xaa)]);
	await ln.closeChannel({ channelId: 'bb'.repeat(32), force: 1 });
	assert.deepEqual(calls('closeChannel'), [{ channelId: buf(0xbb), force: true }]);

	await ln.resume();
	assert.deepEqual(await ln.resumeRecovery(), [{ channelId: 'bb'.repeat(32), completed: 2, pending: 1, errors: ['not yet mature'] }]);
	assert.deepEqual(seen.calls.slice(-2).map((c) => c[0]), ['resume', 'recovery.resume']);
});

test('invoices and payments: amounts as bigint, times in milliseconds, a status the host knows', async () => {
	const { ln, seen } = await started();
	const calls = (name) => seen.calls.filter((c) => c[0] === name).map((c) => c[1]);

	const quote = await ln.quoteInvoice({ assetId: '11'.repeat(32), groupKey: null, amount: 150n, peerPubkey: hexOf(PEER) });
	assert.deepEqual(quote, {
		quoteId: '01'.repeat(32),
		peerPubkey: hexOf(PEER),
		assetAmount: 150n,
		amountMsat: 150000n,
		unitsPerBtc: { coefficient: 100000000n, scale: 0 },
		expiresAt: 1700000060000
	});
	assert.deepEqual(calls('quoteInvoice'), [{ asset: { assetId: ASSET }, amount: 150n, peer: PEER }]);
	// By its group, and from whichever peer the library picks.
	const group = `03${'cd'.repeat(32)}`;
	await ln.quoteInvoice({ assetId: '11'.repeat(32), groupKey: group, amount: 1n, peerPubkey: null });
	assert.deepEqual(Object.keys(calls('quoteInvoice')[1]), ['asset', 'amount']);
	assert.equal(hexOf(calls('quoteInvoice')[1].asset.groupKey), group);

	const invoice = await ln.createInvoice({ quoteId: quote.quoteId, description: 'tea', expirySeconds: 3600 });
	assert.deepEqual(invoice, { bolt11: 'lnbcrt1invoice', paymentHash: '02'.repeat(32), assetAmount: 150n, amountMsat: 150000n, expiresAt: 1700003600000 });
	assert.deepEqual(calls('createInvoice'), [{ quoteId: buf(0x01), description: 'tea', expirySeconds: 3600 }]);
	await ln.createInvoice({ quoteId: quote.quoteId, description: '', expirySeconds: 60 });
	assert.equal('description' in calls('createInvoice')[1], false);
	// A status this host has no word for is an open invoice until it is paid or expired.
	assert.deepEqual(ln.invoices(), [
		{ paymentHash: '02'.repeat(32), assetAmount: 150n, status: 'paid' },
		{ paymentHash: '03'.repeat(32), assetAmount: 5n, status: 'open' }
	]);

	const pay = await ln.quotePayment({ bolt11: 'lnbcrt1other', assetId: '11'.repeat(32), groupKey: null, amountMsat: null });
	assert.deepEqual(pay, {
		quoteId: '04'.repeat(32),
		paymentHash: '05'.repeat(32),
		peerPubkey: hexOf(PEER),
		channelId: 'bb'.repeat(32),
		assetAmount: 50n,
		amountMsat: 50000n,
		unitsPerBtc: { coefficient: 4000000n, scale: 0 },
		expiresAt: 1700000060000
	});
	assert.deepEqual(calls('quotePayment'), [{ invoice: 'lnbcrt1other', asset: { assetId: ASSET } }]);
	await ln.quotePayment({ bolt11: 'lnbcrt1other', assetId: '11'.repeat(32), groupKey: null, amountMsat: 75000n });
	assert.equal(calls('quotePayment')[1].amountMsat, 75000n);

	assert.deepEqual(await ln.payInvoice({ quoteId: pay.quoteId, maxAssetAmount: 50n }), { paymentHash: '05'.repeat(32), assetAmount: 50n, status: 'complete', feeMsat: 2000n, failure: null });
	assert.deepEqual(calls('payInvoice'), [{ quoteId: buf(0x04), maxAssetAmount: 50n }]);
	assert.deepEqual(ln.payment('05'.repeat(32)), { paymentHash: '05'.repeat(32), assetAmount: 50n, status: 'failed', feeMsat: null, failure: 'no route' });
	assert.equal(ln.payment('06'.repeat(32)), null);
});

test('stopping closes the service once, waits for nothing, and leaves a wallet that says it is not ready', async () => {
	const { ln, seen } = await started();
	ln.stop();
	ln.stop();
	assert.equal(seen.closed, 1);
	assert.equal(ln.ready(), false);
	assert.throws(() => ln.channels(), { code: 'ERR_BEIGNET_LN_NOT_READY' });
	await assert.rejects(ln.resume(), { code: 'ERR_BEIGNET_LN_NOT_READY' });
	// Let the rejected close settle: nothing here listens for it but the facade.
	await new Promise((resolve) => setImmediate(resolve));
});
