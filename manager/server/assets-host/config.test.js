'use strict';

/**
 * What the assets host reads from the daemon's environment, and how a
 * courier address is matched to the REST address of the same proof server.
 *
 * Run: cd manager && npm test
 * Or:  cd manager && node --test server/assets-host/config.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseConfig, parseCourier, courierHost, restFor, DEFAULT_LIMITS, DEFAULT_COURIER_PORT, onChain } = require('./config');

const MODULES = '/opt/engine/node_modules';
const base = (extra = {}) => ({ BEIGNET_ASSETS_MODULES: MODULES, ...extra });

test('regtest: one confirmation, the regtest prefix and the default fee ceilings', () => {
	const cfg = parseConfig('regtest', base());
	assert.equal(cfg.problem, null);
	assert.equal(cfg.tapNetwork, 'regtest');
	assert.equal(cfg.hrp, 'taprt');
	assert.equal(cfg.minConfirmations, 1);
	assert.deepEqual(cfg.limits, { maxFeeRate: 500, maxFeeSats: 250000 });
	assert.deepEqual(cfg.limits, { ...DEFAULT_LIMITS });
	assert.equal(cfg.mode, 'clearnet');
	assert.equal(cfg.lightning, 'off');
	assert.equal(cfg.previewTtlMs, 3 * 60 * 1000);
	assert.equal(cfg.stuckAfterBlocks, 3);
	assert.equal(cfg.receiveSetMax, 50);
	assert.equal(cfg.defaultUniverse, null);
});

test('mainnet and testnet: six confirmations and their own prefixes', () => {
	const main = parseConfig('mainnet', base());
	assert.equal(main.problem, null);
	assert.deepEqual([main.tapNetwork, main.hrp, main.minConfirmations], ['mainnet', 'tapbc', 6]);
	assert.equal(main.stuckAfterBlocks, null);
	assert.deepEqual(main.chains, ['mainnet']);
	// Testnet is one of two chains, and which is not something a setting says.
	const testnet = parseConfig('testnet', base());
	assert.equal(testnet.problem, null);
	assert.deepEqual([testnet.tapNetwork, testnet.hrp, testnet.minConfirmations], [null, 'taptb', 6]);
	assert.deepEqual(testnet.chains, ['testnet3', 'testnet4']);
	assert.deepEqual(parseConfig('regtest', base()).chains, ['regtest']);
	assert.deepEqual(parseConfig('signet', base()).chains, []);
});

test('a testnet wallet on a known chain: the library is told which, and uses that chain\'s proof servers', () => {
	const cfg = parseConfig(
		'testnet',
		base({
			BEIGNET_ASSETS_UNIVERSES: JSON.stringify([
				{ courier: 'universerpc://mine.example.com:10029', rest: 'https://mine.example.com' },
				{ courier: 'universerpc://three.example.com:10029', rest: 'https://three.example.com', isDefault: true, chain: 'testnet3' },
				{ courier: 'universerpc://four.example.com:443', rest: 'https://four.example.com', isDefault: true, chain: 'testnet4' }
			])
		})
	);
	assert.deepEqual(cfg.universes.map((u) => [u.host, u.chain]), [
		['mine.example.com:10029', null],
		['three.example.com:10029', 'testnet3'],
		['four.example.com:443', 'testnet4']
	]);
	const four = onChain(cfg, 'testnet4');
	assert.equal(four.tapNetwork, 'testnet4');
	assert.deepEqual(four.universes.map((u) => u.host), ['mine.example.com:10029', 'four.example.com:443']);
	assert.equal(four.defaultUniverse.host, 'mine.example.com:10029');
	assert.equal(restFor(four, 'universerpc://four.example.com:443'), 'https://four.example.com');
	assert.equal(restFor(four, 'universerpc://three.example.com:10029'), null);
	const three = onChain(cfg, 'testnet3');
	assert.deepEqual(three.universes.map((u) => u.host), ['mine.example.com:10029', 'three.example.com:10029']);
	// Without a server of the wallet's own, the chain's server is the default.
	const plain = onChain({ ...cfg, universes: cfg.universes.slice(1) }, 'testnet4');
	assert.equal(plain.defaultUniverse.host, 'four.example.com:443');
	// The settings it was made from are untouched, for the next attach.
	assert.equal(cfg.tapNetwork, null);
	assert.equal(cfg.universes.length, 3);
	// A network that is one chain keeps every server it was given.
	const main = parseConfig('mainnet', base({ BEIGNET_ASSETS_UNIVERSES: JSON.stringify([{ courier: 'universerpc://u.example.com:10029', rest: 'https://u.example.com', isDefault: true }]) }));
	assert.deepEqual(onChain(main, 'mainnet').universes, main.universes);
});

test('a network without assets attaches with a sentence saying so', () => {
	assert.equal(parseConfig('signet', base()).problem, 'Assets are not available on signet in this app.');
	assert.equal(parseConfig('testnet4', base()).problem, 'Assets are not available on the testnet4 network in this app.');
	assert.equal(parseConfig('signet', base()).hrp, null);
});

test('the packages directory has to be named, and absolute', () => {
	const sentence = 'The assets packages are not installed beside the wallet engine, so assets cannot start.';
	assert.equal(parseConfig('regtest', {}).problem, sentence);
	assert.equal(parseConfig('regtest', { BEIGNET_ASSETS_MODULES: 'node_modules' }).problem, sentence);
	assert.equal(parseConfig('regtest', { BEIGNET_ASSETS_MODULES: '  ' }).problem, sentence);
	assert.equal(parseConfig('regtest').problem, sentence);
});

test('fee ceilings come from the environment, and nonsense falls back to the defaults', () => {
	const set = parseConfig('mainnet', base({ BEIGNET_ASSETS_MAX_FEE_RATE: '80', BEIGNET_ASSETS_MAX_FEE_SATS: '40000.9' }));
	assert.deepEqual(set.limits, { maxFeeRate: 80, maxFeeSats: 40000 });
	for (const bad of ['0', '-5', 'lots', '', 'NaN']) {
		const cfg = parseConfig('mainnet', base({ BEIGNET_ASSETS_MAX_FEE_RATE: bad, BEIGNET_ASSETS_MAX_FEE_SATS: bad }));
		assert.deepEqual(cfg.limits, { maxFeeRate: 500, maxFeeSats: 250000 }, `value ${JSON.stringify(bad)}`);
	}
});

test('the way out: tor, clearnet or hybrid, clearnet when unreadable', () => {
	assert.equal(parseConfig('mainnet', base({ BEIGNET_ASSETS_NETWORK_MODE: 'TOR' })).mode, 'tor');
	assert.equal(parseConfig('mainnet', base({ BEIGNET_ASSETS_NETWORK_MODE: 'hybrid' })).mode, 'hybrid');
	assert.equal(parseConfig('mainnet', base({ BEIGNET_ASSETS_NETWORK_MODE: 'carrier pigeon' })).mode, 'clearnet');
	assert.equal(parseConfig('mainnet', base({ BEIGNET_ASSETS_TOR_PROXY: ' socks5h://127.0.0.1:9050 ' })).torProxy, 'socks5h://127.0.0.1:9050');
	assert.equal(parseConfig('mainnet', base()).torProxy, null);
});

test('only a regtest wallet may reach private addresses or trust a named certificate', () => {
	const env = base({ BEIGNET_ASSETS_ALLOW_PRIVATE: 'true', BEIGNET_ASSETS_CA_FILE: '/certs/tapd.cert' });
	const regtest = parseConfig('regtest', env);
	assert.equal(regtest.allowPrivate, true);
	assert.equal(regtest.caFile, '/certs/tapd.cert');
	const main = parseConfig('mainnet', env);
	assert.equal(main.allowPrivate, false);
	assert.equal(main.caFile, null);
	assert.equal(parseConfig('regtest', base({ BEIGNET_ASSETS_ALLOW_PRIVATE: 'yes' })).allowPrivate, false);
});

test('backup and import files are used only when their paths are absolute', () => {
	const cfg = parseConfig('regtest', base({ BEIGNET_ASSETS_BACKUP_FILE: '/data/w1/assets/backup.json', BEIGNET_ASSETS_IMPORT_FILE: 'pending.json' }));
	assert.equal(cfg.backupFile, '/data/w1/assets/backup.json');
	assert.equal(cfg.importFile, null);
	assert.equal(parseConfig('regtest', base()).backupFile, null);
});

test('proof servers: one entry per machine, the first is the default', () => {
	const cfg = parseConfig(
		'mainnet',
		base({
			BEIGNET_ASSETS_UNIVERSES: JSON.stringify([
				{ courier: 'universerpc://Universe.Example.com:10029', rest: 'https://universe.example.com/', isDefault: true },
				{ courier: 'authmailbox+universerpc://universe.example.com:10029', rest: 'https://elsewhere.example.com' },
				{ courier: 'universerpc://other.example.org', rest: 'https://other.example.org:8443/api//' },
				{ courier: 'ftp://nope.example.com:1', rest: 'https://nope.example.com' },
				{ courier: 'universerpc://norest.example.com:10029', rest: 'file:///etc/passwd' },
				{ courier: 'universerpc://junk.example.com:10029' },
				null
			])
		})
	);
	assert.equal(cfg.problem, null);
	assert.deepEqual(cfg.universes, [
		{ courier: 'universerpc://universe.example.com:10029', host: 'universe.example.com:10029', rest: 'https://universe.example.com', isDefault: true, chain: null },
		{ courier: 'universerpc://other.example.org:10029', host: 'other.example.org:10029', rest: 'https://other.example.org:8443/api', isDefault: false, chain: null }
	]);
	assert.equal(cfg.defaultUniverse, cfg.universes[0]);
});

test('a list of proof servers that cannot be read stops assets with a sentence', () => {
	assert.equal(
		parseConfig('mainnet', base({ BEIGNET_ASSETS_UNIVERSES: '[{' })).problem,
		'The list of proof servers this wallet was started with could not be read.'
	);
	assert.equal(
		parseConfig('mainnet', base({ BEIGNET_ASSETS_UNIVERSES: '{"courier":"x"}' })).problem,
		'The list of proof servers this wallet was started with is not a list.'
	);
	assert.deepEqual(parseConfig('mainnet', base({ BEIGNET_ASSETS_UNIVERSES: '' })).universes, []);
});

test('a courier address is a scheme, a host and a port', () => {
	assert.deepEqual(parseCourier('universerpc://Universe.Example.com:10029'), {
		scheme: 'universerpc',
		host: 'universe.example.com',
		port: 10029,
		hostPort: 'universe.example.com:10029'
	});
	assert.equal(parseCourier('universerpc://universe.example.com').port, DEFAULT_COURIER_PORT);
	assert.equal(parseCourier('authmailbox+universerpc://universe.example.com:443/').scheme, 'authmailbox+universerpc');
	assert.equal(parseCourier('hashmail://mail.example.com:8443').hostPort, 'mail.example.com:8443');
	assert.equal(parseCourier('universerpc://[2001:db8::1]:10029').hostPort, '[2001:db8::1]:10029');
	for (const bad of ['', null, 'https://universe.example.com', 'universerpc://', 'universerpc://host:0', 'universerpc://host:70000', 'universerpc://host/path', 'universerpc://user@host:1']) {
		assert.equal(parseCourier(bad), null, `value ${JSON.stringify(bad)}`);
	}
	assert.equal(courierHost('universerpc://universe.example.com'), 'universe.example.com:10029');
	assert.equal(courierHost('nonsense'), null);
});

test('a courier address finds the REST address of the same proof server', () => {
	const cfg = parseConfig(
		'mainnet',
		base({
			BEIGNET_ASSETS_UNIVERSES: JSON.stringify([
				{ courier: 'universerpc://universe.example.com:10029', rest: 'https://universe.example.com/', isDefault: true },
				{ courier: 'universerpc://other.example.org:10029', rest: 'https://other.example.org:8443' }
			])
		})
	);
	assert.equal(restFor(cfg, 'universerpc://universe.example.com:10029'), 'https://universe.example.com');
	assert.equal(restFor(cfg, 'universerpc://UNIVERSE.example.com'), 'https://universe.example.com');
	assert.equal(restFor(cfg, 'authmailbox+universerpc://other.example.org:10029'), 'https://other.example.org:8443');
	assert.equal(restFor(cfg, 'other.example.org:10029'), 'https://other.example.org:8443');
	assert.equal(restFor(cfg, 'universerpc://other.example.org:10030'), null);
	assert.equal(restFor(cfg, 'universerpc://stranger.example.net:10029'), null);
	assert.equal(restFor(cfg, ''), null);
});
