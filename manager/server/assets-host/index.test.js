'use strict';

/**
 * The extension as the engine sees it: what it declares, what a wallet gets
 * when assets cannot run, and what the library is told when it is built.
 *
 * Run: cd manager && npm test
 * Or:  cd manager && node --test server/assets-host/index.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { beignetExtension, pending, VERSION } = require('./index');
const { ROUTES, EVENTS, bind, failedHandlers, routeKey } = require('./routes');
const { buildAdapter } = require('./adapter');
const { parseConfig } = require('./config');
const { memoryStorage, createHostLock } = require('./store');
const { harness, MODULES } = require('./test-fakes');

const MONEY = ['POST /mint', 'POST /send/prepare', 'POST /send/commit', 'POST /burn/prepare', 'POST /burn/commit'];

async function refusedBy(fn) {
	try {
		await fn();
	} catch (err) {
		return err;
	}
	throw new Error('expected a refusal');
}

function context(extra = {}) {
	const events = [];
	const logged = [];
	return {
		events,
		logged,
		generation: 1,
		network: 'regtest',
		dataDir: '/nowhere',
		engineVersion: '0.0.0',
		wallet: {},
		storage: memoryStorage().storage,
		logger: { error: (m) => logged.push(m), warn: (m) => logged.push(m), info: () => {}, debug: () => {} },
		emit: (name, data) => events.push([name, data]),
		...extra
	};
}

test('the declaration: an id, a version, the extension API it was written for', () => {
	const ext = beignetExtension({ network: 'regtest', env: { BEIGNET_ASSETS_MODULES: MODULES } });
	assert.equal(ext.id, 'assets');
	assert.equal(ext.api, 1);
	assert.equal(ext.version, VERSION);
	assert.match(ext.version, /^\d+\.\d+\.\d+$/);
	assert.equal(ext.routes, ROUTES);
	assert.equal(ext.events, EVENTS);
	assert.equal(typeof ext.attach, 'function');
	// Nonsense from the engine is not a reason to throw while it is loading.
	assert.equal(beignetExtension().id, 'assets');
	assert.equal(beignetExtension({ network: undefined, env: null }).id, 'assets');
});

test('the routes: these and no others', () => {
	assert.deepEqual(ROUTES.map(routeKey), [
		'GET /status',
		'GET /balances',
		'GET /asset',
		'GET /activity',
		'POST /lookup',
		'POST /mint/quote',
		'POST /mint',
		'POST /addresses',
		'POST /addresses/decode',
		'POST /addresses/check',
		'POST /proofs/retry',
		'POST /send/prepare',
		'POST /send/commit',
		'POST /send/cancel',
		'POST /burn/prepare',
		'POST /burn/commit',
		'POST /burn/cancel',
		'POST /transfers/rebroadcast',
		'POST /proof-server/test',
		'POST /backup/export',
		'POST /backup/import'
	]);
	assert.equal(new Set(ROUTES.map(routeKey)).size, ROUTES.length);
});

test('the routes: reading is for a read-only key, everything else for the admin key alone', () => {
	for (const route of ROUTES) {
		const name = routeKey(route);
		assert.match(route.path, /^\/[a-z/-]+$/, name);
		assert.ok(typeof route.summary === 'string' && route.summary.length > 10, name);
		assert.equal(route.summary.includes(String.fromCharCode(0x2014)), false, name);
		if (route.method === 'GET') assert.deepEqual(route.scopes, ['readonly'], name);
		else assert.equal('scopes' in route, false, name);
	}
});

test('the routes: every one that moves money takes a request key, and only those', () => {
	assert.deepEqual(ROUTES.filter((r) => r.idempotent).map(routeKey), MONEY);
	const sized = ROUTES.filter((r) => r.maxBodyBytes !== undefined);
	assert.deepEqual(sized.map(routeKey), ['POST /backup/import']);
	assert.ok(sized[0].maxBodyBytes <= 32 * 1024 * 1024);
});

test('no lightning route is declared, and the status says lightning is off', async () => {
	assert.deepEqual(ROUTES.filter((r) => /channel|invoice|pay|lightning/.test(r.path)), []);
	const h = harness();
	await h.boot();
	assert.deepEqual((await h.get('/status')).lightning, { mode: 'off', usableChannels: 0 });
	assert.deepEqual(EVENTS, ['status', 'mint', 'transfer', 'receive', 'proof-delivery', 'balance', 'backup', 'error', 'channel', 'invoice', 'payment']);
});

test('every declared route has a handler, whether the host runs or not', () => {
	const declared = ROUTES.map(routeKey).sort();
	assert.deepEqual(Object.keys(bind(harness().host)).sort(), declared);
	assert.deepEqual(Object.keys(failedHandlers(() => ({}), 'No.')).sort(), declared);
});

test('a network without assets: the extension attaches, says why, and refuses the rest', async () => {
	const sentence = 'Assets are not available on signet in this app.';
	const ctx = context({ network: 'signet' });
	const attachment = await beignetExtension({ network: 'signet', env: {} }).attach(ctx);
	const status = attachment.status();
	assert.deepEqual([status.phase, status.ready, status.error, status.network], ['failed', false, sentence, 'signet']);
	assert.deepEqual(await attachment.handlers['GET /status']({}), status);
	for (const route of ROUTES.map(routeKey).filter((name) => name !== 'GET /status')) {
		const err = await refusedBy(() => attachment.handlers[route]({ body: {}, query: new URLSearchParams() }));
		assert.deepEqual([err.extensionCode, err.status, err.message], ['ASSETS_UNAVAILABLE', 503, sentence], route);
	}
	await attachment.start();
	assert.deepEqual(ctx.events, [['status', status]]);
	await attachment.stop('shutdown');
});

test('packages that are not installed: attach does not throw, and the status says so', async () => {
	const none = await beignetExtension({ network: 'regtest', env: {} }).attach(context());
	assert.equal(none.status().phase, 'failed');
	assert.equal(none.status().error, 'The assets packages are not installed beside the wallet engine, so assets cannot start.');

	const ctx = context();
	const missing = await beignetExtension({ network: 'regtest', env: { BEIGNET_ASSETS_MODULES: '/nonexistent/engine/node_modules' } }).attach(ctx);
	assert.equal(missing.status().phase, 'failed');
	assert.match(missing.status().error, /^The assets packages could not be loaded from beside the wallet engine/);
	assert.equal(ctx.logged.length, 1);
	assert.match(ctx.logged[0], /^assets: /);
	const err = await refusedBy(() => missing.handlers['POST /mint']({ body: {} }));
	assert.equal(err.extensionCode, 'ASSETS_UNAVAILABLE');
});

test('a host that cannot run survives an engine that will not listen', async () => {
	const ctx = context({
		logger: null,
		emit: () => {
			throw new Error('nobody is listening');
		}
	});
	const attachment = await beignetExtension({ network: 'regtest', env: { BEIGNET_ASSETS_MODULES: '/nonexistent/engine/node_modules' } }).attach(ctx);
	await attachment.start();
	await attachment.stop('rebuild');
	assert.equal(attachment.status().phase, 'failed');
});

/** What `pending` is given: a server that answers when told to, and a build that records what it was asked. */
function waitingRoom({ network = 'testnet' } = {}) {
	const cfg = parseConfig(network, { BEIGNET_ASSETS_MODULES: MODULES });
	const ctx = context({ network });
	const world = { answer: { answered: false, genesis: null, chain: null }, asks: 0, built: [], started: 0, stopped: [] };
	const real = {
		handlers: Object.fromEntries(ROUTES.map((r) => [routeKey(r), async () => ({ from: 'the host', route: routeKey(r) })])),
		start: async () => {
			world.started += 1;
		},
		stop: async (reason) => {
			world.stopped.push(reason);
		},
		status: () => ({ phase: 'ready', ready: true })
	};
	const attachment = pending(
		cfg,
		ctx,
		async (asked) => {
			world.built.push(asked);
			return real;
		},
		{
			ask: async () => {
				world.asks += 1;
				return world.answer;
			},
			firstDelayMs: 5,
			maxDelayMs: 10
		}
	);
	return { cfg, ctx, world, attachment };
}

const until = async (fn) => {
	for (let i = 0; i < 400 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 5));
	assert.ok(fn(), 'waited long enough');
};

test('a testnet wallet whose server is silent: the status says what is waited for, and the rest asks to be tried again', async () => {
	const { ctx, world, attachment } = waitingRoom();
	assert.deepEqual(Object.keys(attachment.handlers), ROUTES.map(routeKey));
	const status = attachment.status();
	assert.deepEqual([status.phase, status.ready, status.error, status.network, status.chain.name], ['starting', false, null, 'testnet', null]);
	assert.equal(status.startup.waiting, "Waiting for the wallet's Electrum server to say which testnet it is on.");
	assert.deepEqual(await attachment.handlers['GET /status']({}), status);
	for (const route of ROUTES.map(routeKey).filter((k) => k !== 'GET /status')) {
		const err = await refusedBy(() => attachment.handlers[route]({ body: {} }));
		assert.deepEqual([err.extensionCode, err.status], ['ASSETS_STARTING', 503], route);
		assert.match(err.message, /which testnet it is on\)\. Try again in a moment\.$/);
		assert.ok(!err.message.includes('\u2014'));
	}
	await attachment.start();
	assert.deepEqual(ctx.events, [['status', status]]);
	// It keeps asking, and builds nothing on no answer.
	await until(() => world.asks >= 3);
	assert.deepEqual(world.built, []);
	await attachment.stop('shutdown');
});

test('a testnet wallet whose server answers late: the host is built on that answer and takes over', async () => {
	const { world, attachment } = waitingRoom();
	await attachment.start();
	await until(() => world.asks >= 2);
	world.answer = { answered: true, genesis: 'ab'.repeat(32), chain: 'testnet4' };
	await until(() => world.started === 1);
	assert.deepEqual(world.built, [world.answer]);
	assert.deepEqual(attachment.status(), { phase: 'ready', ready: true });
	assert.deepEqual(await attachment.handlers['POST /mint']({ body: {} }), { from: 'the host', route: 'POST /mint' });
	assert.deepEqual(await attachment.handlers['GET /status']({}), { from: 'the host', route: 'GET /status' });
	// It is built once, and asks no more.
	const asks = world.asks;
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(world.asks, asks);
	assert.equal(world.built.length, 1);
	await attachment.stop('rebuild');
	assert.deepEqual(world.stopped, ['rebuild']);
});

test('a wallet stopped while it waits asks no more, and a host built after the stop is stopped at once', async () => {
	const quiet = waitingRoom();
	await quiet.attachment.start();
	await until(() => quiet.world.asks >= 1);
	await quiet.attachment.stop('shutdown');
	const asks = quiet.world.asks;
	quiet.world.answer = { answered: true, genesis: 'ab'.repeat(32), chain: 'testnet3' };
	await new Promise((r) => setTimeout(r, 40));
	assert.equal(quiet.world.asks, asks);
	assert.deepEqual(quiet.world.built, []);

	// The answer arrives, and the wallet stops while the host is being built.
	const cfg = parseConfig('testnet', { BEIGNET_ASSETS_MODULES: MODULES });
	const stopped = [];
	let release;
	const building = new Promise((resolve) => (release = resolve));
	let started = 0;
	const late = pending(
		cfg,
		context({ network: 'testnet' }),
		async () => {
			await building;
			return {
				handlers: {},
				start: async () => {
					started += 1;
				},
				stop: async (reason) => {
					stopped.push(reason);
				},
				status: () => ({ phase: 'ready' })
			};
		},
		{ ask: async () => ({ answered: true, genesis: 'ab'.repeat(32), chain: 'testnet3' }), firstDelayMs: 5 }
	);
	await late.start();
	await new Promise((r) => setTimeout(r, 10));
	await late.stop('shutdown');
	release();
	await until(() => stopped.length === 1);
	assert.equal(started, 0);
	assert.equal(late.status().phase, 'starting');
});

test('the library is built with single chain probes, the fee ceilings and the host\'s own lock', () => {
	const cfg = parseConfig('mainnet', { BEIGNET_ASSETS_MODULES: MODULES, BEIGNET_ASSETS_MAX_FEE_RATE: '80', BEIGNET_ASSETS_MAX_FEE_SATS: '40000' });
	const lock = createHostLock();
	const wallet = { the: 'wallet' };
	const courierFor = () => null;
	const proofPublisher = { deliverProof: async () => {} };
	const seen = {};
	const tap = {
		store: {
			keyValueStores: (backend) => {
				seen.backend = backend;
				return { stores: { name: 'stores' }, keyIndexes: { name: 'key indexes' } };
			}
		}
	};
	const bridge = {
		createBeignetAdapter: (w, options) => {
			seen.wallet = w;
			seen.options = options;
			return { built: true };
		}
	};
	const mem = memoryStorage();
	const out = buildAdapter({ tap, bridge, wallet, storage: mem.storage, cfg, lock: lock.flowLock, courierFor, proofPublisher });
	assert.deepEqual(out, { built: true });
	assert.equal(seen.wallet, wallet);
	assert.deepEqual(Object.keys(seen.options).sort(), [
		'courier', 'keyIndexes', 'lock', 'maxFee', 'maxFeeRate', 'minConfirmations', 'pollIntervalMs', 'proofPublisher', 'stores', 'tapNetwork', 'timeoutMs'
	]);
	// One look at the chain per call: nothing waits a block interval.
	assert.deepEqual([seen.options.pollIntervalMs, seen.options.timeoutMs], [50, 1]);
	assert.deepEqual([seen.options.maxFeeRate, seen.options.maxFee], [80, 40000]);
	assert.deepEqual([seen.options.tapNetwork, seen.options.minConfirmations], ['mainnet', 6]);
	assert.equal(seen.options.lock, lock.flowLock);
	assert.equal(seen.options.courier, courierFor);
	assert.equal(seen.options.proofPublisher, proofPublisher);
	assert.deepEqual([seen.options.stores, seen.options.keyIndexes], [{ name: 'stores' }, { name: 'key indexes' }]);
	// The library's rows go into the node's own database.
	return seen.backend.write([{ key: 'asset/one', value: 'v' }]).then(() => {
		assert.equal(mem.storage.get('t/asset/one'), 'v');
	});
});
