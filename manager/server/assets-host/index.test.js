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
const fs = require('fs');
const os = require('os');
const path = require('path');
const { beignetExtension, attach, pending, lightningFor, VERSION } = require('./index');
const { ROUTES, EVENTS, bind, failedHandlers, routeKey } = require('./routes');
const { buildAdapter } = require('./adapter');
const { parseConfig } = require('./config');
const { memoryStorage, createHostLock } = require('./store');
const { harness, MODULES } = require('./test-fakes');

const MONEY = ['POST /mint', 'POST /send/prepare', 'POST /send/commit', 'POST /burn/prepare', 'POST /burn/commit', 'POST /channels/open', 'POST /channels/reclaim', 'POST /pay'];
const LIGHTNING = [
	'GET /channels',
	'POST /channels/quote',
	'POST /channels/open',
	'POST /channels/close',
	'POST /channels/reclaim',
	'POST /invoices/quote',
	'POST /invoices',
	'GET /invoices',
	'POST /pay/quote',
	'POST /pay'
];

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
		'GET /proofs/export',
		'POST /proofs/import',
		'POST /proofs/handed-over',
		'POST /send/prepare',
		'POST /send/commit',
		'POST /send/cancel',
		'POST /burn/prepare',
		'POST /burn/commit',
		'POST /burn/cancel',
		'POST /transfers/rebroadcast',
		'POST /proof-server/test',
		'POST /backup/export',
		'POST /backup/import',
		...LIGHTNING
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
	assert.deepEqual(sized.map(routeKey), ['POST /proofs/import', 'POST /backup/import']);
	// A proof file of up to 4 MB as base64, and a whole backup.
	assert.ok(sized[0].maxBodyBytes > (4 * 1024 * 1024 * 4) / 3 && sized[0].maxBodyBytes < 6 * 1024 * 1024);
	assert.ok(sized[1].maxBodyBytes <= 32 * 1024 * 1024);
});

test('the ten lightning routes are declared for every wallet, and one without asset channels says lightning is off', async () => {
	assert.deepEqual(ROUTES.filter((r) => /channel|invoice|pay|lightning/.test(r.path)).map(routeKey), LIGHTNING);
	const h = harness();
	await h.boot();
	assert.deepEqual((await h.get('/status')).lightning, { mode: 'off', usableChannels: 0 });
	// What the manager counts before it lets a wallet be changed: none, said plainly.
	assert.deepEqual(await h.get('/channels'), { channels: [] });
	const err = await refusedBy(() => h.call('POST /channels/quote', {}));
	assert.deepEqual([err.extensionCode, err.status], ['LIGHTNING_UNAVAILABLE', 409]);
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

/* ---------------------------------------------------- the channel provider */

/** The members of an attachment that the engine reads for its node, as this one names them. */
const handed = (attachment) => Object.fromEntries(['auxiliaryChannels', 'fixedOutputFees', 'bind', 'lightning'].filter((name) => name in attachment).map((name) => [name, attachment[name]]));

/** A stand-in for adapter.js createLightning: what the engine is handed, and what was done to it. */
function provider() {
	const seen = { started: 0, stopped: 0, closed: 0, bound: [] };
	const ln = {
		seen,
		attachment: { auxiliaryChannels: { the: 'hooks' }, fixedOutputFees: { feeCoinCount: 4 }, bind: (node) => seen.bound.push(node) },
		start: () => {
			seen.started += 1;
		},
		stop: () => {
			seen.stopped += 1;
		},
		close: () => {
			seen.closed += 1;
		},
		ready: () => false
	};
	return ln;
}

test('a wallet that cannot have asset channels hands the engine no provider, on any path', async () => {
	// Packages that are not there, a network without assets, and no entry beside the engine.
	const none = await beignetExtension({ network: 'regtest', env: {} }).attach(context());
	assert.deepEqual(handed(none), {});
	const signet = await beignetExtension({ network: 'signet', env: { BEIGNET_ASSETS_MODULES: MODULES, BEIGNET_ASSETS_LIGHTNING: 'full' } }).attach(context({ network: 'signet' }));
	assert.deepEqual(handed(signet), {});
	const missing = await beignetExtension({ network: 'regtest', env: { BEIGNET_ASSETS_MODULES: MODULES, BEIGNET_ASSETS_LIGHTNING: 'full' } }).attach(context());
	assert.deepEqual(Object.keys(missing).sort(), ['handlers', 'start', 'status', 'stop']);
	assert.equal(lightningFor(parseConfig('regtest', { BEIGNET_ASSETS_MODULES: MODULES }), context()), null);
	assert.equal(lightningFor(parseConfig('regtest', {}), context()), null);
});

test('a wallet that can have asset channels hands the engine its provider though the host cannot run', async () => {
	// The library will not load, so the host only refuses. The channel still has its provider.
	const ln = provider();
	const cfg = parseConfig('regtest', { BEIGNET_ASSETS_MODULES: '/nonexistent/engine/node_modules' });
	const attachment = await attach(cfg, context(), { lightningFor: () => ln });
	assert.equal(attachment.status().phase, 'failed');
	// On the attachment itself, where the engine reads them, and the hooks as the library made them.
	assert.deepEqual(Object.keys(handed(attachment)).sort(), ['auxiliaryChannels', 'bind', 'fixedOutputFees']);
	assert.equal(attachment.auxiliaryChannels, ln.attachment.auxiliaryChannels);
	assert.equal(attachment.fixedOutputFees, ln.attachment.fixedOutputFees);
	// The engine binds its node before anything is started, and the provider hears of it.
	const node = { the: 'node' };
	attachment.bind(node);
	assert.deepEqual(ln.seen.bound, [node]);
	const err = await refusedBy(() => attachment.handlers['GET /channels']({ body: {}, query: new URLSearchParams() }));
	assert.equal(err.extensionCode, 'ASSETS_UNAVAILABLE');
	// Nothing could be handed to it, so it was never started. It is still closed with the daemon.
	assert.equal(ln.seen.started, 0);
	await attachment.start();
	await attachment.stop('shutdown');
	assert.equal(ln.seen.closed, 1);

	// The same whatever the wallet was asked: the wish is not what makes a channel enforceable.
	for (const wish of ['off', 'full']) {
		const again = provider();
		const asked = await attach(parseConfig('regtest', { BEIGNET_ASSETS_MODULES: '/nonexistent/engine/node_modules', BEIGNET_ASSETS_LIGHTNING: wish }), context(), { lightningFor: () => again });
		assert.equal(asked.auxiliaryChannels, again.attachment.auxiliaryChannels);
	}
});

/**
 * A node_modules directory with packages thin enough to write here and whole
 * enough to build a host on. `fn(modulesDir)` runs with it, and it is removed.
 */
async function withPackages(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-index-'));
	const modules = path.join(dir, 'node_modules');
	const states = require('./adapter').STATES;
	const write = (file, text) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	};
	write(
		path.join(modules, 'ts-tap', 'index.js'),
		`module.exports = {
	asset: { AssetType: { Normal: 0, Collectible: 1 } },
	address: { AddressVersion: { V1: 1, V2: 2 } },
	tapgarden: { BatchState: ${JSON.stringify(states.Batch)} },
	tapfreighter: { SendState: ${JSON.stringify(states.Send)}, ReceiveState: ${JSON.stringify(states.Receive)}, Freighter: class { lookupAsset() {} } },
	store: { keyValueStores: () => ({ stores: {}, keyIndexes: {} }) }
};`
	);
	write(path.join(modules, 'ts-tap', 'package.json'), '{"name":"ts-tap","main":"index.js"}');
	write(path.join(modules, '@ts-tap', 'beignet', 'index.js'), 'module.exports = { createBeignetAdapter: () => ({ the: "adapter" }) };');
	write(path.join(modules, '@ts-tap', 'beignet', 'package.json'), '{"name":"@ts-tap/beignet","main":"index.js"}');
	try {
		return await fn(modules);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test('a testnet wallet still waiting to hear its chain hands the engine its provider meanwhile', async () => {
	await withPackages(async (modules) => {
		const ln = provider();
		const cfg = parseConfig('testnet', { BEIGNET_ASSETS_MODULES: modules });
		const attachment = await attach(cfg, context({ network: 'testnet' }), {
			lightningFor: () => ln,
			ask: async () => ({ answered: false, genesis: null, chain: null })
		});
		assert.equal(attachment.status().phase, 'starting');
		assert.match(attachment.status().startup.waiting, /which testnet it is on\.$/);
		assert.equal(attachment.auxiliaryChannels, ln.attachment.auxiliaryChannels);
		// There is no adapter to hand it yet, so its hooks still refuse.
		assert.equal(ln.seen.started, 0);
		await attachment.stop('shutdown');
		assert.equal(ln.seen.closed, 1);
	});
});

test('a host that runs is handed its provider, starts it once the library is built, and stops it', async () => {
	await withPackages(async (modules) => {
		for (const [wish, quiet] of [
			['full', false],
			['off', true]
		]) {
			const ln = provider();
			const options = [];
			ln.start = (given) => {
				ln.seen.started += 1;
				options.push(given);
			};
			const cfg = parseConfig('regtest', { BEIGNET_ASSETS_MODULES: modules, BEIGNET_ASSETS_LIGHTNING: wish });
			const attachment = await attach(cfg, context(), { lightningFor: () => ln, ask: async () => ({ answered: true, genesis: null, chain: 'regtest' }) });
			assert.equal(attachment.status().phase, 'starting', wish);
			assert.equal(attachment.auxiliaryChannels, ln.attachment.auxiliaryChannels);
			// Handed the adapter the library built as soon as there is one. The
			// service itself starts once the engine has bound its node as well
			// (adapter.test.js), whichever of the two comes first.
			assert.equal(ln.seen.started, 1);
			assert.deepEqual(Object.keys(options[0]).sort(), ['acceptIncoming', 'adapter', 'confirmations', 'fetchProof', 'lib', 'onError', 'onEvent', 'onStartError', 'quiet']);
			assert.deepEqual(options[0].adapter, { the: 'adapter' });
			// How deep a transaction is buried for good is the wallet's own measure.
			assert.equal(options[0].confirmations, cfg.minConfirmations);
			// A wallet that was not asked for asset channels gives nobody a price.
			assert.equal(options[0].quiet, quiet);
			assert.deepEqual(attachment.status().lightning, { mode: wish, usableChannels: 0 });
			await attachment.stop('shutdown');
			// The host closes its service, and the node's stop lets go of the rest.
			assert.deepEqual([ln.seen.stopped, ln.seen.closed], [1, 1]);
		}
	});
});

test('a provider that will not start leaves a host that runs, with lightning off', async () => {
	await withPackages(async (modules) => {
		// It may say so when it is handed the adapter, or later, when the engine binds its node.
		for (const when of ['at once', 'at the bind']) {
			const ln = provider();
			let later = null;
			ln.start = (given) => {
				if (when === 'at once') throw new Error('this engine is older than the package');
				later = given.onStartError;
			};
			const ctx = context();
			const cfg = parseConfig('regtest', { BEIGNET_ASSETS_MODULES: modules, BEIGNET_ASSETS_LIGHTNING: 'full' });
			const attachment = await attach(cfg, ctx, { lightningFor: () => ln, ask: async () => ({ answered: true, genesis: null, chain: 'regtest' }) });
			assert.equal(attachment.status().phase, 'starting', when);
			if (later) {
				assert.deepEqual(attachment.status().lightning, { mode: 'full', usableChannels: 0 });
				later(new Error('this engine is older than the package'));
			}
			assert.deepEqual(attachment.status().lightning, { mode: 'off', usableChannels: 0 }, when);
			// The engine is still handed it: a channel it holds is not this failure's to give up.
			assert.equal(attachment.auxiliaryChannels, ln.attachment.auxiliaryChannels);
			assert.ok(ctx.logged.some((line) => /^assets: asset channels could not start: This engine is older than the package/.test(line)), when);
			await attachment.stop('shutdown');
		}
	});
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
