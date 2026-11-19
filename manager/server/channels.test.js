'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * An asset channel is listed by the daemon beside the bitcoin channels,
 * marked `auxiliary`. Nothing the manager does with bitcoin channels may
 * pick one up: the move away from a previous primary closes channels, and
 * it must never close one that carries an asset.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { isAssetChannel, bitcoinChannels } = require('./channels');
const { WalletManager } = require('./wallet-manager');

const PK_OLD = '03' + '11'.repeat(32);
const PK_NEW = '03' + '22'.repeat(32);

const oldOpen = { channelId: 'old1', peerPubkey: PK_OLD, state: 'NORMAL', htlcUsable: true, localBalanceSats: 120000 };
const home = { channelId: 'home', peerPubkey: PK_NEW, state: 'NORMAL', htlcUsable: true, localBalanceSats: 200000 };
const assetWithOld = { channelId: 'asset1', peerPubkey: PK_OLD, state: 'NORMAL', htlcUsable: true, localBalanceSats: 98000, auxiliary: true };

function harness(channels) {
	const rec = {
		id: 'w1',
		name: 'child',
		network: 'regtest',
		port: 3902,
		nodeId: '02' + '99'.repeat(32),
		electrum: { host: 'h', port: 1, tls: false },
		lfbw: {
			enabled: true,
			mode: 'internal',
			primaryWalletId: 'p2',
			primaryPubkey: PK_NEW,
			trusted: true,
			setup: 'ready',
			previousPrimary: { pubkey: PK_OLD, walletId: 'p1', at: 1 }
		}
	};
	const m = Object.create(WalletManager.prototype);
	const store = { w1: rec };
	m.upserts = [];
	m.registry = { get: (id) => store[id], list: () => Object.values(store), upsert: (r) => m.upserts.push({ ...r }) };
	m.runtime = new Map();
	m.runtimeState('w1').proc = { pid: 1 };
	m.runtimeState('w1').healthy = true;
	m._log = () => {};
	m.calls = [];
	m._daemonCall = async (r, method, path, body) => {
		m.calls.push({ method, path, body });
		if (method === 'GET' && path === '/channels') {
			if (channels instanceof Error) throw channels;
			return channels;
		}
		return {};
	};
	return { m, rec };
}

test('only a channel the daemon marks auxiliary is an asset channel', () => {
	assert.equal(isAssetChannel({ channelId: 'a', auxiliary: true }), true);
	assert.equal(isAssetChannel({ channelId: 'a' }), false);
	assert.equal(isAssetChannel({ channelId: 'a', auxiliary: false }), false);
	assert.equal(isAssetChannel({ channelId: 'a', auxiliary: 'true' }), false);
	assert.equal(isAssetChannel(null), false);
});

test('the bitcoin channels of a list are the rows that are not asset channels, in the order they came', () => {
	assert.deepEqual(bitcoinChannels([oldOpen, assetWithOld, home]), [oldOpen, home]);
	assert.deepEqual(bitcoinChannels([]), []);
});

test('an answer that is not a list is handed back as it came, so an unread list still reads as unread', () => {
	assert.equal(bitcoinChannels(null), null);
	assert.equal(bitcoinChannels(undefined), undefined);
});

test('the manager reads a wallet without its asset channels, and fails as the daemon call fails', async () => {
	const { m, rec } = harness([oldOpen, assetWithOld, home]);
	assert.deepEqual(await m._bitcoinChannels(rec), [oldOpen, home]);
	const down = harness(new Error('down'));
	await assert.rejects(() => down.m._bitcoinChannels(down.rec), /down/);
});

test('moving away from a previous primary closes its bitcoin channels and leaves an asset channel with it open', async () => {
	const { m } = harness([oldOpen, assetWithOld, home]);
	const r = await m.moveHome('w1');
	assert.deepEqual(r, { closed: ['old1'], pubkey: PK_OLD });
	const closes = m.calls.filter((c) => c.path === '/channel/close').map((c) => c.body.channelId);
	assert.deepEqual(closes, ['old1']);
});

test('a previous primary with only an asset channel left has nothing to move, and nothing is closed', async () => {
	const { m, rec } = harness([assetWithOld, home]);
	await assert.rejects(() => m.moveHome('w1'), (e) => e.code === 'NO_PREVIOUS_CHANNEL');
	assert.equal(m.calls.some((c) => c.path === '/channel/close'), false);
	assert.equal(rec.lfbw.previousPrimary, null);
});
