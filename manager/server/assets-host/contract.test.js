'use strict';

/**
 * The host against the real packages: the engine's own loader, the real
 * Taproot Assets library, and a real daemon with a real wallet.
 *
 * Skipped unless ASSETS_ENGINE_PREFIX names a directory whose node_modules
 * holds the engine (beignet) and the assets packages (ts-tap and
 * @ts-tap/beignet). On an engine from before the host extension contract the
 * tests that need the engine to load the host are skipped too. Nothing here needs a network: the daemons are pointed at
 * an Electrum port nothing listens on, and are given no proof server. So the
 * host never hears which chain it is on, which is the state these daemons
 * are checked in: up, serving, and spending nothing.
 *
 * Run: cd manager && ASSETS_ENGINE_PREFIX=/path/to/prefix node --test server/assets-host/contract.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const { createRequire } = require('module');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { ROUTES, routeKey } = require('./routes');
const { STATES, loadLibrary, createLib, buildAdapter, loadLightning, createLightning } = require('./adapter');
const { parseConfig } = require('./config');
const { mapError } = require('./errors');
const { memoryStorage, createHostLock } = require('./store');
const { extensionsAvailable, assetChannelsAvailable } = require('../engine');

const PREFIX = process.env.ASSETS_ENGINE_PREFIX ? path.resolve(process.env.ASSETS_ENGINE_PREFIX) : null;
const MODULES = PREFIX ? path.join(PREFIX, 'node_modules') : null;
const HOST = path.join(__dirname, 'index.js');
const skip = PREFIX ? false : 'set ASSETS_ENGINE_PREFIX to run this against the real packages';
// An engine from before the host extension contract cannot load a host at
// all. The manager leaves assets off on it (engine.js), so the tests that
// need the engine to load this one have nothing to check there; the ones
// that only need the library still run.
const ENGINE_BIN = MODULES ? path.join(MODULES, 'beignet', 'dist', 'cli', 'cli.js') : null;
const skipEngine = skip || (extensionsAvailable(ENGINE_BIN) ? false : 'the engine in this prefix predates the host extension contract');
// Whether this engine and this adapter can carry assets in channels, as the
// manager asks before it turns asset Lightning on for a wallet (engine.js).
const CHANNELS = !skip && assetChannelsAvailable(ENGINE_BIN);
// The well-known test phrase. It holds nothing, on a chain of its own.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const STATUS_KEYS = [
	'phase', 'ready', 'error', 'network', 'hrp', 'chain', 'pending', 'holdsAssets', 'assetChannels', 'lockedSats', 'anchorCount', 'startup', 'lightning', 'proofServer',
	'backup', 'limits'
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () =>
	new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});

function call(port, method, route, body) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? null : JSON.stringify(body);
		const req = http.request(
			{ host: '127.0.0.1', port, path: route, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
			(res) => {
				let text = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => (text += chunk));
				res.on('end', () => {
					try {
						resolve({ status: res.statusCode, json: JSON.parse(text) });
					} catch (_) {
						resolve({ status: res.statusCode, json: null, text });
					}
				});
			}
		);
		req.on('error', reject);
		if (data) req.write(data);
		req.end();
	});
}

test('the engine\'s own loader takes the module as it is on disk', { skip: skipEngine }, async () => {
	const { loadExtensions } = createRequire(path.join(MODULES, 'noop.js'))('beignet/daemon');
	const loaded = await loadExtensions([HOST], { network: 'regtest', env: { BEIGNET_ASSETS_MODULES: MODULES } });
	assert.equal(loaded.length, 1);
	const [ext] = loaded;
	assert.deepEqual([ext.id, ext.api], ['assets', 1]);
	assert.deepEqual(ext.routes.map(routeKey), ROUTES.map(routeKey));
	assert.equal(typeof ext.attach, 'function');
	// It still loads, to say why, on a network that has no assets.
	const signet = await loadExtensions([HOST], { network: 'signet', env: {} });
	assert.equal(signet[0].id, 'assets');
});

test('the installed library is the version this host was written for', { skip }, () => {
	const { tap, bridge } = loadLibrary(MODULES);
	assert.equal(typeof bridge.createBeignetAdapter, 'function');
	// The numbered states this host stores and compares are the library's own.
	assert.deepEqual({ ...STATES.Batch }, Object.fromEntries(Object.keys(STATES.Batch).map((name) => [name, tap.tapgarden.BatchState[name]])));
	assert.deepEqual({ ...STATES.Send }, Object.fromEntries(Object.keys(STATES.Send).map((name) => [name, tap.tapfreighter.SendState[name]])));
	assert.deepEqual({ ...STATES.Receive }, Object.fromEntries(Object.keys(STATES.Receive).map((name) => [name, tap.tapfreighter.ReceiveState[name]])));
	const lib = createLib(tap);
	assert.equal(lib.canLookup, true, 'the library can look an asset up on a proof server');
	assert.deepEqual([lib.AssetType.Normal, lib.AssetType.Collectible], [0, 1]);
	assert.deepEqual([lib.AddressVersion.V1, lib.AddressVersion.V2], [1, 2]);
});

test('the library\'s own errors come out in the dashboard\'s codes', { skip }, () => {
	const lib = createLib(loadLibrary(MODULES).tap);
	for (const text of ['not an address', 'taprt1qqqsqq', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4']) {
		let thrown = null;
		try {
			lib.decodeAddress(text);
		} catch (err) {
			thrown = err;
		}
		assert.ok(thrown, `"${text}" is not an address`);
		assert.match(String(thrown.code), /^ERR_/, text);
		assert.match(mapError(thrown).extensionCode || '', /^(BAD_ADDRESS|WRONG_NETWORK)$/, `${text}: ${thrown.code}`);
	}
});

test('the library\'s stores are the ones the host reads, kept in the node\'s database', { skip }, async () => {
	const { tap } = loadLibrary(MODULES);
	const cfg = parseConfig('regtest', { BEIGNET_ASSETS_MODULES: MODULES });
	const mem = memoryStorage();
	let options = null;
	const bridge = {
		createBeignetAdapter: (_wallet, given) => {
			options = given;
			return {};
		}
	};
	buildAdapter({ tap, bridge, wallet: {}, storage: mem.storage, cfg, lock: createHostLock().flowLock, courierFor: () => null, proofPublisher: {} });
	const { stores, keyIndexes } = options;
	assert.ok(keyIndexes);
	assert.deepEqual(await stores.assets.listAssets(), []);
	assert.deepEqual(await stores.batches.listBatches(), []);
	assert.deepEqual(await stores.parcels.listParcels(), []);
	assert.deepEqual(await stores.receives.listReceives(), []);
	assert.equal(await stores.receives.getReceive('taprt1nothing'), undefined);
	assert.equal(typeof stores.proofs.getProofFile, 'function');
	assert.equal(typeof stores.assets.getGroup, 'function');
});

test('the Lightning entry of the installed adapter is one this host can use, or is not there', { skip }, () => {
	const entry = loadLightning(MODULES);
	const cfg = parseConfig('regtest', { BEIGNET_ASSETS_MODULES: MODULES });
	if (!entry) {
		// An adapter from before asset channels: the host has no Lightning side, and nothing was loaded for one.
		assert.equal(fs.existsSync(path.join(MODULES, '@ts-tap', 'beignet', 'dist', 'lightning.js')), false);
		assert.equal(createLightning({ entry, storage: memoryStorage().storage, cfg }), null);
		assert.equal(CHANNELS, false);
		return;
	}
	const support = entry.assetLightningSupport();
	assert.equal(typeof support.supported, 'boolean');
	assert.ok(Array.isArray(support.missing));
	// The provider is there exactly when the engine can carry asset channels, and writes only under its own prefix.
	const mem = memoryStorage();
	const ln = createLightning({ entry, storage: mem.storage, cfg });
	assert.equal(!!ln, support.supported);
	if (!ln) return;
	assert.deepEqual(['auxiliaryChannels', 'bind', 'fixedOutputFees'].filter((name) => !(name in ln.attachment)), []);
	assert.equal(ln.ready(), false);
	assert.deepEqual([...mem.data.keys()].filter((key) => !key.startsWith('l/')), []);
});

/** Run `fn({ port, backupFile })` against a real daemon of a wallet on `network`, with the host loaded. */
async function withDaemon(network, fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-contract-'));
	const port = await freePort();
	const backupFile = path.join(dir, 'assets', 'backup.json');
	const cli = fs.realpathSync(path.join(MODULES, '.bin', 'beignet'));
	const child = spawn(process.execPath, [cli, 'start'], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			PATH: process.env.PATH,
			HOME: dir,
			BEIGNET_MNEMONIC: MNEMONIC,
			BEIGNET_NETWORK: network,
			BEIGNET_DATA_DIR: path.join(dir, 'data'),
			BEIGNET_ELECTRUM_HOST: '127.0.0.1',
			BEIGNET_ELECTRUM_PORT: '65529',
			BEIGNET_ELECTRUM_TLS: 'false',
			BEIGNET_DAEMON_PORT: String(port),
			BEIGNET_EXTENSIONS: HOST,
			BEIGNET_ASSETS_MODULES: MODULES,
			BEIGNET_ASSETS_NETWORK_MODE: 'clearnet',
			BEIGNET_ASSETS_BACKUP_FILE: backupFile,
			// Asked for, as the manager asks for a wallet that can have them.
			// A wallet that cannot says off all the same.
			BEIGNET_ASSETS_LIGHTNING: 'full'
		}
	});
	let out = '';
	let err = '';
	child.stdout.on('data', (chunk) => (out += chunk));
	child.stderr.on('data', (chunk) => (err += chunk));
	const exited = new Promise((resolve) => child.once('close', resolve));
	try {
		const deadline = Date.now() + 120000;
		while (!/Node started/.test(out) && child.exitCode === null && Date.now() < deadline) await sleep(100);
		assert.match(out, /Node started/, `the daemon did not start:\n${out.slice(-800)}\n${err.slice(-800)}`);
		await fn({ port, backupFile });
	} finally {
		child.kill('SIGTERM');
		const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
		await exited;
		clearTimeout(timer);
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** The host's status once `settled(status)` says it has got as far as it will. */
async function statusWhen(port, settled) {
	let status = null;
	for (let i = 0; i < 150; i += 1) {
		const res = await call(port, 'GET', '/x/assets/status');
		assert.equal(res.status, 200);
		assert.equal(res.json.ok, true);
		status = res.json.result;
		if (settled(status)) break;
		await sleep(200);
	}
	return status;
}

test('a real daemon loads the host, lists it and serves its routes', { skip: skipEngine, timeout: 180000 }, async () => {
	await withDaemon('regtest', async ({ port, backupFile }) => {
		const listing = await call(port, 'GET', '/extensions');
		assert.equal(listing.status, 200);
		const listed = listing.json.result || listing.json;
		assert.equal(listed.api, 'beignet-extension-api/1');
		const mine = listed.extensions.find((e) => e.id === 'assets');
		assert.ok(mine, 'the daemon lists the assets extension');
		assert.equal(mine.state, 'ready');
		assert.deepEqual(mine.routes.map((r) => `${r.method} ${r.path}`), ROUTES.map((r) => `${r.method} /x/assets${r.path}`));
		assert.deepEqual(mine.routes.filter((r) => r.idempotent).map((r) => r.path.slice('/x/assets'.length)), ROUTES.filter((r) => r.idempotent).map((r) => r.path));
		for (const r of mine.routes) assert.equal(r.scopes.includes('readonly'), r.method === 'GET', `${r.method} ${r.path}`);

		// No Electrum server answers, so nothing has said this is regtest. The
		// host is up on the only chain its network can be, and waits to hear.
		const status = await statusWhen(port, (s) => s.startup && s.startup.waiting);
		assert.deepEqual(Object.keys(status), STATUS_KEYS);
		assert.deepEqual([status.phase, status.ready, status.error, status.network, status.hrp], ['starting', false, null, 'regtest', 'taprt']);
		assert.deepEqual([status.chain.name, status.chain.minConfirmations], ['regtest', 1]);
		assert.equal(status.startup.waiting, "The wallet's Electrum server has not said which chain it is on");
		// With asset channels the node has taken the fee settings this host
		// gives it, and says so of its fee coin pool: the whole regtest budget
		// is left, and a wallet nobody has paid has no coin to prepare one from.
		const { feeCoins, ...lightning } = status.lightning;
		assert.deepEqual(lightning, { mode: CHANNELS ? 'full' : 'off', usableChannels: 0 });
		if (CHANNELS) {
			assert.match(feeCoins.neededSats, /^[1-9][0-9]*$/);
			assert.deepEqual({ ...feeCoins, neededSats: null }, { possible: false, neededSats: null, largestConfirmedSats: '0', ready: 0, budgetRemainingSats: '100000000', reason: 'FEE_FUNDS_UNAVAILABLE' });
		} else assert.equal(feeCoins, null);
		if (!CHANNELS) {
			// An engine or an adapter without asset channels: no channels, said
			// plainly to the manager that counts them, and nothing to open.
			const channels = await call(port, 'GET', '/x/assets/channels');
			assert.deepEqual([channels.status, channels.json.result], [200, { channels: [] }]);
			const quote = await call(port, 'POST', '/x/assets/channels/quote', {});
			assert.deepEqual([quote.status, quote.json.error.extension.code], [409, 'LIGHTNING_UNAVAILABLE']);
		}
		assert.deepEqual(status.limits, { maxFeeRate: 500, maxFeeSats: 250000 });
		assert.deepEqual([status.holdsAssets, status.anchorCount, status.lockedSats], [false, 0, 0]);

		const balances = await call(port, 'GET', '/x/assets/balances');
		assert.deepEqual(balances.json.result.assets, []);
		assert.deepEqual(Object.keys(balances.json.result.btc), ['anchorSats', 'anchorCount', 'spendableSats']);
		assert.deepEqual((await call(port, 'GET', '/x/assets/activity')).json.result, { rows: [], nextBefore: null });

		// A refusal travels as the engine's extension error, with the host's code inside.
		const bad = await call(port, 'POST', '/x/assets/addresses/decode', { address: 'not an address' });
		assert.equal(bad.status, 400);
		assert.deepEqual([bad.json.ok, bad.json.error.code, bad.json.error.extension.id, bad.json.error.extension.code], [false, 'EXTENSION_ERROR', 'assets', 'BAD_ADDRESS']);
		// Nothing that spends is served until the chain is known to be the wallet's.
		const late = await call(port, 'POST', '/x/assets/send/commit', { previewId: 'nothing' });
		assert.deepEqual([late.status, late.json.error.extension.code], [503, 'ASSETS_STARTING']);
		assert.match(late.json.error.extension.message || late.json.error.message, /has not said which chain it is on/);

		// The real wallet derives the fingerprint the backup is tied to.
		const first = await call(port, 'POST', '/x/assets/backup/export', {});
		assert.equal(first.status, 200, JSON.stringify(first.json));
		assert.equal(first.json.result.changed, true);
		assert.equal(fs.statSync(backupFile).mode & 0o777, 0o600);
		const written = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
		assert.deepEqual([written.format, written.network, written.chain], ['beignet-assets-backup', 'regtest', 'regtest']);
		assert.match(written.wallet, /^[0-9a-f]{64}$/);
		const second = await call(port, 'POST', '/x/assets/backup/export', {});
		assert.deepEqual(second.json.result, { ...first.json.result, changed: false });
	});
});

test('a real testnet daemon whose server is silent waits to hear which testnet it is on', { skip: skipEngine, timeout: 180000 }, async () => {
	await withDaemon('testnet', async ({ port }) => {
		const listing = await call(port, 'GET', '/extensions');
		const listed = listing.json.result || listing.json;
		assert.equal(listed.extensions.find((e) => e.id === 'assets').state, 'ready');
		const status = await statusWhen(port, (s) => s.startup && s.startup.waiting);
		assert.deepEqual(Object.keys(status), STATUS_KEYS);
		assert.deepEqual([status.phase, status.ready, status.error, status.network, status.hrp, status.chain.name], ['starting', false, null, 'testnet', 'taptb', null]);
		assert.equal(status.startup.waiting, "Waiting for the wallet's Electrum server to say which testnet it is on.");
		// The library is not built yet, so every other route asks to be tried again.
		for (const [method, route, body] of [
			['GET', '/balances'],
			['GET', '/activity'],
			['POST', '/addresses/decode', { address: 'not an address' }],
			['POST', '/mint', { seedlings: [] }],
			['POST', '/backup/export', {}]
		]) {
			const res = await call(port, method, `/x/assets${route}`, body);
			assert.deepEqual([res.status, res.json.error.code, res.json.error.extension.code], [503, 'EXTENSION_ERROR', 'ASSETS_STARTING'], route);
		}
	});
});
