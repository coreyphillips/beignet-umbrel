'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * The manager's side of Taproot Assets: what a wallet record may hold, which
 * universe servers its host is told about, and the one contract that
 * matters most, the environment that makes a daemon load the host at all.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assets = require('./assets');
const { PUBLIC_UNIVERSE_SERVERS, publicUniverseServers, SUPPORTED_NETWORKS } = require('./config');

const refusal = (fn) => {
	try {
		fn();
	} catch (err) {
		return err;
	}
	throw new Error('expected a refusal');
};

test('every public universe pairs a courier address with an https gateway, for a chain this app runs', () => {
	const ids = new Set();
	for (const s of PUBLIC_UNIVERSE_SERVERS) {
		assert.ok(!ids.has(s.id), `${s.id} is listed once`);
		ids.add(s.id);
		assert.ok(assets.parseCourier(s.courier), `${s.id} has a courier address`);
		assert.equal(assets.canonicalCourier(s.courier), s.courier, `${s.id} is written in the stored spelling`);
		assert.equal(new URL(s.rest).protocol, 'https:', `${s.id} is https`);
		assert.ok(!s.rest.endsWith('/'), `${s.id} has no trailing slash`);
		assert.ok(s.label && s.note, `${s.id} has a label and a note`);
		for (const n of s.networks) assert.ok(SUPPORTED_NETWORKS.includes(n), `${s.id}: ${n} is a chain this app runs`);
	}
	assert.deepEqual(publicUniverseServers('mainnet', {}).map((s) => s.id), ['lightning-labs']);
	// Testnet is two chains, each with a universe of its own, and every
	// testnet server says which one it is for.
	assert.deepEqual(publicUniverseServers('testnet', {}).map((s) => [s.id, s.chain]), [
		['lightning-labs-testnet', 'testnet3'],
		['lightning-labs-testnet4', 'testnet4']
	]);
	assert.equal(publicUniverseServers('mainnet', {})[0].chain, undefined);
	// The courier addresses are the ones Lightning Labs' own daemon ships as its defaults.
	assert.deepEqual(PUBLIC_UNIVERSE_SERVERS.map((s) => s.courier), [
		'universerpc://universe.lightning.finance:10029',
		'universerpc://testnet.universe.lightning.finance:10029',
		'universerpc://testnet4.universe.lightning.finance:443'
	]);
});

test('regtest has a universe only when the operator names both halves of one', () => {
	assert.deepEqual(publicUniverseServers('regtest', {}), []);
	assert.deepEqual(publicUniverseServers('regtest', { ASSETS_REGTEST_UNIVERSE_COURIER: 'universerpc://127.0.0.1:10029' }), []);
	const [local] = publicUniverseServers('regtest', {
		ASSETS_REGTEST_UNIVERSE_COURIER: 'universerpc://127.0.0.1:10029',
		ASSETS_REGTEST_UNIVERSE_REST: 'https://127.0.0.1:8089'
	});
	assert.equal(local.courier, 'universerpc://127.0.0.1:10029');
	assert.equal(local.rest, 'https://127.0.0.1:8089');
	// And never on another chain.
	assert.deepEqual(
		publicUniverseServers('mainnet', {
			ASSETS_REGTEST_UNIVERSE_COURIER: 'universerpc://127.0.0.1:10029',
			ASSETS_REGTEST_UNIVERSE_REST: 'https://127.0.0.1:8089'
		}).map((s) => s.id),
		['lightning-labs']
	);
});

test('a courier address is read with its default port and stored in one spelling', () => {
	assert.deepEqual(assets.parseCourier('universerpc://Universe.Example.com'), {
		scheme: 'universerpc',
		host: 'universe.example.com',
		port: 10029
	});
	assert.equal(assets.canonicalCourier(' universerpc://u.example.com:443 '), 'universerpc://u.example.com:443');
	assert.equal(assets.canonicalCourier('authmailbox+universerpc://u.example.com:10029'), 'authmailbox+universerpc://u.example.com:10029');
	assert.equal(assets.canonicalCourier('universerpc://[::1]:10029'), 'universerpc://[::1]:10029');
	for (const bad of ['', 'https://u.example.com', 'hashmail://u.example.com:443', 'universerpc://u.example.com:0', 'universerpc://u.example.com:70000', 'universerpc://u example.com', 'universerpc://u.example.com/path']) {
		assert.equal(assets.parseCourier(bad), null, bad);
	}
});

test('a wallet universe must be a universerpc courier and an https gateway', () => {
	assert.deepEqual(assets.normalizeUniverse({ courier: 'universerpc://u.example.com', rest: 'https://u.example.com/' }, { network: 'mainnet' }), {
		courier: 'universerpc://u.example.com:10029',
		rest: 'https://u.example.com'
	});
	assert.deepEqual(assets.normalizeUniverse({ courier: 'universerpc://u.example.com:10029', rest: 'https://u.example.com:8443/tap/' }, { network: 'mainnet' }).rest, 'https://u.example.com:8443/tap');
	for (const cleared of [null, undefined, '']) assert.equal(assets.normalizeUniverse(cleared, { network: 'mainnet' }), null);
	const cases = [
		['a string', 'universerpc://u.example.com'],
		['a mailbox courier', { courier: 'authmailbox+universerpc://u.example.com', rest: 'https://u.example.com' }],
		['no courier', { rest: 'https://u.example.com' }],
		['plain http', { courier: 'universerpc://u.example.com', rest: 'http://u.example.com' }],
		['another scheme', { courier: 'universerpc://u.example.com', rest: 'ftp://u.example.com' }],
		['a password', { courier: 'universerpc://u.example.com', rest: 'https://a:b@u.example.com' }],
		['a query', { courier: 'universerpc://u.example.com', rest: 'https://u.example.com/?x=1' }],
		['not a URL', { courier: 'universerpc://u.example.com', rest: 'u.example.com' }]
	];
	for (const [label, input] of cases) {
		const err = refusal(() => assets.normalizeUniverse(input, { network: 'mainnet' }));
		assert.equal(err.code, 'BAD_UNIVERSE', label);
		assert.equal(err.statusCode, 400, label);
	}
	// Plain http is for an onion, where Tor carries it, and for regtest.
	assert.equal(assets.normalizeUniverse({ courier: 'universerpc://abc.onion:10029', rest: 'http://abc.onion:8089' }, { network: 'mainnet' }).rest, 'http://abc.onion:8089');
	assert.equal(assets.normalizeUniverse({ courier: 'universerpc://127.0.0.1:10029', rest: 'http://127.0.0.1:8089' }, { network: 'regtest' }).rest, 'http://127.0.0.1:8089');
});

test('assets are on for a wallet that never said, and an edit changes only what it names', () => {
	assert.deepEqual(assets.normalizeAssets(undefined, undefined, { network: 'mainnet' }), { enabled: true, universe: null });
	assert.deepEqual(assets.normalizeAssets({ enabled: false }, undefined, { network: 'mainnet' }), { enabled: false, universe: null });
	const own = { courier: 'universerpc://u.example.com:10029', rest: 'https://u.example.com' };
	const withUniverse = assets.normalizeAssets({ universe: own }, { enabled: false, universe: null }, { network: 'mainnet' });
	assert.deepEqual(withUniverse, { enabled: false, universe: own });
	assert.deepEqual(assets.normalizeAssets({ enabled: true }, withUniverse, { network: 'mainnet' }), { enabled: true, universe: own });
	assert.deepEqual(assets.normalizeAssets({ universe: null }, { enabled: true, universe: own }, { network: 'mainnet' }), { enabled: true, universe: null });
	// A record edited by hand into nonsense reads as the defaults.
	assert.deepEqual(assets.normalizeAssets(undefined, { enabled: 'yes', universe: { courier: 'x' } }, { network: 'mainnet' }), { enabled: true, universe: null });
	assert.equal(refusal(() => assets.normalizeAssets({ enabled: 'yes' }, undefined, {})).code, 'BAD_ASSETS');
	assert.equal(refusal(() => assets.normalizeAssets('on', undefined, {})).code, 'BAD_ASSETS');
});

test("a wallet's own universe comes first, and the public one stays so a send to it can deliver", () => {
	const rec = {
		network: 'mainnet',
		assets: { enabled: true, universe: { courier: 'universerpc://u.example.com:10029', rest: 'https://u.example.com' } }
	};
	assert.deepEqual(assets.universesFor(rec, {}), [
		{ courier: 'universerpc://u.example.com:10029', rest: 'https://u.example.com', isDefault: false },
		{ courier: 'universerpc://universe.lightning.finance:10029', rest: 'https://universe.lightning.finance', isDefault: true }
	]);
	assert.deepEqual(assets.universesFor({ network: 'mainnet' }, {}), [
		{ courier: 'universerpc://universe.lightning.finance:10029', rest: 'https://universe.lightning.finance', isDefault: true }
	]);
	// A wallet that names the public one as its own gets one entry, its own.
	const same = { network: 'testnet', assets: { universe: { courier: 'universerpc://testnet.universe.lightning.finance:10029', rest: 'https://mirror.example.com' } } };
	assert.deepEqual(assets.universesFor(same, {}), [
		{ courier: 'universerpc://testnet.universe.lightning.finance:10029', rest: 'https://mirror.example.com', isDefault: false, chain: 'testnet3' },
		{ courier: 'universerpc://testnet4.universe.lightning.finance:443', rest: 'https://testnet4.universe.lightning.finance', isDefault: true, chain: 'testnet4' }
	]);
	// A testnet wallet is handed both testnets' servers, each marked, and
	// its own first. Its host keeps the ones for the chain it is on.
	const own = { network: 'testnet', assets: { universe: { courier: 'universerpc://u.example.com:10029', rest: 'https://u.example.com' } } };
	assert.deepEqual(assets.universesFor(own, {}), [
		{ courier: 'universerpc://u.example.com:10029', rest: 'https://u.example.com', isDefault: false },
		{ courier: 'universerpc://testnet.universe.lightning.finance:10029', rest: 'https://testnet.universe.lightning.finance', isDefault: true, chain: 'testnet3' },
		{ courier: 'universerpc://testnet4.universe.lightning.finance:443', rest: 'https://testnet4.universe.lightning.finance', isDefault: true, chain: 'testnet4' }
	]);
	assert.deepEqual(assets.universesFor({ network: 'regtest' }, {}), []);
});

const ENV_ARGS = Object.freeze({
	available: true,
	modulesDir: '/opt/beignet/node_modules',
	hostModule: '/app/manager/server/assets-host/index.js',
	mode: 'hybrid',
	torProxy: '10.21.21.11:9050',
	walletDir: '/data/wallets/w1',
	env: {}
});

test('a daemon is told to load the host only when assets are available and on', () => {
	const rec = { network: 'mainnet' };
	const env = assets.assetsEnv(rec, ENV_ARGS);
	assert.deepEqual(env, {
		BEIGNET_EXTENSIONS: '/app/manager/server/assets-host/index.js',
		BEIGNET_ASSETS_MODULES: '/opt/beignet/node_modules',
		BEIGNET_ASSETS_UNIVERSES: JSON.stringify([
			{ courier: 'universerpc://universe.lightning.finance:10029', rest: 'https://universe.lightning.finance', isDefault: true }
		]),
		BEIGNET_ASSETS_NETWORK_MODE: 'hybrid',
		BEIGNET_ASSETS_BACKUP_FILE: path.join('/data/wallets/w1', 'assets', 'backup.json'),
		BEIGNET_ASSETS_IMPORT_FILE: path.join('/data/wallets/w1', 'assets', 'pending-import.json'),
		BEIGNET_ASSETS_LIGHTNING: 'off',
		BEIGNET_ASSETS_TOR_PROXY: '10.21.21.11:9050'
	});
	// Each of these leaves the daemon's environment exactly as it was.
	assert.deepEqual(assets.assetsEnv(rec, { ...ENV_ARGS, available: false }), {});
	assert.deepEqual(assets.assetsEnv(rec, { ...ENV_ARGS, modulesDir: null }), {});
	assert.deepEqual(assets.assetsEnv(rec, { ...ENV_ARGS, walletDir: undefined }), {});
	assert.deepEqual(assets.assetsEnv({ network: 'mainnet', assets: { enabled: false } }, ENV_ARGS), {});
	for (const off of ['off', 'OFF', 'Off']) {
		assert.deepEqual(assets.assetsEnv(rec, { ...ENV_ARGS, env: { BEIGNET_ASSETS: off } }), {});
	}
	// Anything but the exact word leaves assets on: a typo must not hide them.
	assert.ok(assets.assetsEnv(rec, { ...ENV_ARGS, env: { BEIGNET_ASSETS: 'false' } }).BEIGNET_EXTENSIONS);
});

test('the host environment follows the wallet: no Tor proxy without Tor, no Lightning for an on-chain only wallet', () => {
	const noTor = assets.assetsEnv({ network: 'testnet' }, { ...ENV_ARGS, torProxy: '', mode: 'clearnet' });
	assert.equal('BEIGNET_ASSETS_TOR_PROXY' in noTor, false);
	assert.equal(noTor.BEIGNET_ASSETS_NETWORK_MODE, 'clearnet');
	assert.match(noTor.BEIGNET_ASSETS_UNIVERSES, /testnet\.universe\.lightning\.finance/);
	assert.equal(assets.assetsEnv({ network: 'mainnet' }, { ...ENV_ARGS, lightning: 'full' }).BEIGNET_ASSETS_LIGHTNING, 'full');
	assert.equal(assets.assetsEnv({ network: 'mainnet', onchainOnly: true }, { ...ENV_ARGS, lightning: 'full' }).BEIGNET_ASSETS_LIGHTNING, 'off');
	// Only regtest may reach a private address, or trust a named certificate.
	const regtestEnv = {
		ASSETS_REGTEST_UNIVERSE_COURIER: 'universerpc://127.0.0.1:10029',
		ASSETS_REGTEST_UNIVERSE_REST: 'https://127.0.0.1:8089',
		ASSETS_REGTEST_UNIVERSE_CA: '/certs/tapd.cert'
	};
	const local = assets.assetsEnv({ network: 'regtest' }, { ...ENV_ARGS, env: regtestEnv });
	assert.equal(local.BEIGNET_ASSETS_ALLOW_PRIVATE, 'true');
	assert.equal(local.BEIGNET_ASSETS_CA_FILE, '/certs/tapd.cert');
	assert.deepEqual(JSON.parse(local.BEIGNET_ASSETS_UNIVERSES), [
		{ courier: 'universerpc://127.0.0.1:10029', rest: 'https://127.0.0.1:8089', isDefault: true }
	]);
	const main = assets.assetsEnv({ network: 'mainnet' }, { ...ENV_ARGS, env: regtestEnv });
	assert.equal('BEIGNET_ASSETS_ALLOW_PRIVATE' in main, false);
	assert.equal('BEIGNET_ASSETS_CA_FILE' in main, false);
	const capped = assets.assetsEnv({ network: 'mainnet' }, { ...ENV_ARGS, env: { BEIGNET_ASSETS_MAX_FEE_RATE: '80', BEIGNET_ASSETS_MAX_FEE_SATS: '20000', OTHER: 'x' } });
	assert.equal(capped.BEIGNET_ASSETS_MAX_FEE_RATE, '80');
	assert.equal(capped.BEIGNET_ASSETS_MAX_FEE_SATS, '20000');
	assert.equal('OTHER' in capped, false);
});

test('the host module the daemon is pointed at exists and is one the engine will load', () => {
	assert.ok(fs.existsSync(assets.HOST_MODULE), 'assets-host/index.js is in the tree');
	assert.equal(path.isAbsolute(assets.HOST_MODULE), true);
});

test('a host module another user could write is reported before the daemon refuses to start on it', { skip: process.platform === 'win32' }, () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'assets-host-')));
	try {
		const file = path.join(dir, 'index.js');
		fs.writeFileSync(file, '', { mode: 0o644 });
		fs.chmodSync(file, 0o644);
		fs.chmodSync(dir, 0o755);
		assert.equal(assets.hostProblem(file), null);
		assert.equal(assets.hostProblem(path.join(dir, 'missing.js')), 'the assets host is not installed');
		fs.chmodSync(file, 0o664);
		assert.match(assets.hostProblem(file), /index\.js is writable by its group or by everyone/);
		fs.chmodSync(file, 0o644);
		fs.chmodSync(dir, 0o777);
		assert.match(assets.hostProblem(file), /is writable by its group or by everyone/);
		fs.chmodSync(dir, 0o755);
		assert.match(assets.hostProblem(file, { uid: process.getuid() + 1 }), /belongs to another user/);
		// Nothing to check where there are no such bits.
		fs.chmodSync(file, 0o666);
		assert.equal(assets.hostProblem(file, { platform: 'win32' }), null);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a wallet's public record says whether it holds assets, from the host or from what was last saved", () => {
	assert.deepEqual(assets.publicAssets({ network: 'mainnet' }, {}), {
		enabled: true,
		universe: null,
		holdsAssets: false,
		phase: null,
		error: null
	});
	assert.equal(assets.publicAssets({ network: 'mainnet', assetsHeld: true }, {}).holdsAssets, true);
	const live = assets.publicAssets({ network: 'mainnet', assetsHeld: true }, { assets: { phase: 'ready', holdsAssets: false } });
	assert.equal(live.holdsAssets, false);
	assert.equal(live.phase, 'ready');
	assert.equal(assets.publicAssets({ network: 'mainnet' }, { assets: { phase: 'failed', error: 'no universe' } }).error, 'no universe');
});

test('only the events worth keeping reach the log, each as one line', () => {
	const row = {
		kind: 'send',
		state: 'broadcast',
		txid: 'ab'.repeat(32),
		assets: [{ name: 'BUSD', assetId: 'cd'.repeat(32), amount: '100.00' }]
	};
	assert.equal(assets.describeAssetEvent('assets:transfer', { row }), `assets:transfer send broadcast (100.00 BUSD) ${'ab'.repeat(32)}`);
	assert.equal(assets.describeAssetEvent('assets:error', { scope: 'courier', code: 'COURIER_UNREACHABLE', message: 'Could not reach it' }), 'assets error [COURIER_UNREACHABLE] Could not reach it');
	assert.equal(assets.describeAssetEvent('assets:status', { phase: 'ready' }), null);
	assert.equal(assets.describeAssetEvent('assets:balance', { key: 'x' }), null);
	assert.equal(assets.describeAssetEvent('assets:mint', {}), null);
	for (const name of assets.LOGGED_EVENTS) assert.ok(assets.ASSET_EVENTS.includes(name));
});
