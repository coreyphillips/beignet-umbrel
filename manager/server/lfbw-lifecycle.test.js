'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * What the record model refuses: a primary in use cannot be deleted, made
 * on-chain only, or stop providing liquidity; a lightning-first block is
 * validated on create and on edit; and the public record carries what the
 * dashboard needs to name siblings and advertise a reachable address.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');

const PK_P = '03' + '22'.repeat(32);

function managerWith(records) {
	const m = Object.create(WalletManager.prototype);
	const store = { ...records };
	m.registry = {
		get: (id) => store[id],
		list: () => Object.values(store),
		upsert: (r) => {
			store[r.id] = r;
		},
		remove: (id) => {
			delete store[id];
		}
	};
	m.runtime = new Map();
	m.channelLogs = new Map();
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	m.lfbwSupported = true;
	m.engineVersion = '0.10.0';
	m.settings = { get: () => ({ defaultNetwork: 'regtest', defaultElectrum: null, recoveryGuardians: [] }) };
	m.onion = null;
	m.onionAddress = () => null;
	m.torCircuitOk = null;
	m._restartWallet = async () => {};
	m.stopWallet = async () => {};
	m.paths = () => ({ base: '/nonexistent' });
	return { m, store };
}

const primary = () => ({
	id: 'p1',
	name: 'Primary',
	network: 'regtest',
	port: 3901,
	electrum: { host: 'h', port: 1, tls: false },
	onchainOnly: false,
	liquidityProvider: true,
	nodeId: PK_P,
	recovery: { mode: 'off', guardians: [] }
});
const dependent = () => ({
	id: 'w1',
	name: 'Spending',
	network: 'regtest',
	port: 3902,
	electrum: { host: 'h', port: 1, tls: false },
	onchainOnly: false,
	recovery: { mode: 'off', guardians: [] },
	lfbw: { enabled: true, mode: 'internal', primaryWalletId: 'p1', primaryUri: null, setup: 'ready' }
});

const refused = (p, code) => assert.rejects(p, (err) => err.code === code && err.statusCode === 409);

test('a primary in use cannot be deleted, and the refusal names its dependents', async () => {
	const { m } = managerWith({ p1: primary(), w1: dependent() });
	await assert.rejects(m.deleteWallet('p1'), (err) => {
		assert.equal(err.code, 'PRIMARY_IN_USE');
		assert.equal(err.statusCode, 409);
		assert.deepEqual(err.details, { dependents: [{ id: 'w1', name: 'Spending' }] });
		assert.match(err.message, /"Spending"/);
		return true;
	});
});

test('once its dependents are gone the primary can go too', async () => {
	const { m, store } = managerWith({ p1: primary(), w1: dependent() });
	await m.deleteWallet('w1');
	await m.deleteWallet('p1');
	assert.deepEqual(Object.keys(store), []);
});

test('a primary in use cannot be made on-chain only or stop providing liquidity', async () => {
	const { m } = managerWith({ p1: primary(), w1: dependent() });
	await refused(m.updateWallet('p1', { onchainOnly: true }), 'PRIMARY_IN_USE');
	await refused(m.updateWallet('p1', { liquidityProvider: false }), 'PRIMARY_IN_USE');
	// Other edits are fine.
	const out = await m.updateWallet('p1', { name: 'Hub', jit: { flatFeeSat: 50 } });
	assert.equal(out.name, 'Hub');
	assert.equal(out.jit.flatFeeSat, 50);
});

test('a wallet with no dependents may drop the provider role, and the env follows', async () => {
	const { m, store } = managerWith({ p1: primary() });
	await m.updateWallet('p1', { liquidityProvider: false });
	assert.equal(store.p1.liquidityProvider, false);
	const env = m._daemonEnv(store.p1, { home: '/h', data: '/d' }, 's', 't');
	assert.equal(env.BEIGNET_JIT_RECEIVE, undefined);
});

test('an edit can make an ordinary wallet lightning-first, and an on-chain only one cannot be', async () => {
	const { m, store } = managerWith({ p1: primary(), w2: { ...dependent(), id: 'w2', lfbw: null } });
	const out = await m.updateWallet('w2', { lfbw: { enabled: true, primaryWalletId: 'p1' } });
	assert.equal(out.lfbw.mode, 'internal');
	assert.equal(out.lfbw.primaryPubkey, PK_P, 'the primary has reported its node id already');
	assert.equal(out.lfbw.setup, 'pending');
	await assert.rejects(
		m.updateWallet('w2', { onchainOnly: true, lfbw: { enabled: true, primaryWalletId: 'p1' } }),
		(err) => err.code === 'BAD_LFBW_PEER'
	);
	// Turning it off clears the block; the wallet keeps its channels.
	await m.updateWallet('w2', { lfbw: { enabled: false } });
	assert.equal(store.w2.lfbw, null);
	// Going on-chain only clears it too.
	await m.updateWallet('w2', { lfbw: { enabled: true, primaryWalletId: 'p1' } });
	await m.updateWallet('w2', { onchainOnly: true });
	assert.equal(store.w2.lfbw, null);
});

test('an edit that keeps the primary keeps the setup state; a bad primary leaves the record untouched', async () => {
	const { m, store } = managerWith({ p1: primary(), w1: dependent() });
	store.w1.lfbw.initialChannelOpened = true;
	await m.updateWallet('w1', { lfbw: { enabled: true, primaryWalletId: 'p1', trusted: false } });
	assert.equal(store.w1.lfbw.setup, 'ready');
	assert.equal(store.w1.lfbw.initialChannelOpened, true);
	assert.equal(store.w1.lfbw.trusted, false);
	await assert.rejects(
		m.updateWallet('w1', { name: 'Renamed', lfbw: { enabled: true, primaryWalletId: 'nope' } }),
		(err) => err.code === 'BAD_LFBW_PEER'
	);
	assert.equal(store.w1.name, 'Spending');
});

test('the public record names the node, the listen port, the reach, and who depends on whom', () => {
	const { m } = managerWith({ p1: primary(), w1: dependent() });
	const p = m.publicRecord('p1');
	assert.equal(p.nodeId, PK_P);
	assert.equal(p.listenPort, 3901 + 6000);
	assert.equal(p.reach, null, 'no onion, no PUBLIC_HOST: nothing to advertise');
	assert.equal(p.liquidityProvider, true);
	assert.deepEqual(p.jit, { flatFeeSat: 0, feePpm: 0, maxClientFundingSats: 1000000, maxConcurrentFundings: 3, maxTotalFundingSats: null });
	assert.deepEqual(p.lfbwDependents, [{ id: 'w1', name: 'Spending' }]);
	const w = m.publicRecord('w1');
	assert.equal(w.lfbw.primaryWalletId, 'p1');
	assert.deepEqual(w.lfbwDependents, []);
	m.onionAddress = () => 'abcd.onion:9902';
	assert.deepEqual(m.publicRecord('w1').reach, { host: 'abcd.onion', port: 9902 });
});

test('an on-chain only wallet advertises no Lightning at all', () => {
	const { m } = managerWith({ p1: { ...primary(), onchainOnly: true } });
	const p = m.publicRecord('p1');
	assert.equal(p.listenPort, null);
	assert.equal(p.reach, null);
	assert.equal(p.liquidityProvider, false);
});
