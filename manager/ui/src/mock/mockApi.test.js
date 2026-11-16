/**
 * Run with: npm test (from manager/ui).
 *
 * The demo answers in the manager's shapes. Every page reads a wallet's
 * assets from its record and the app's config, so a demo that left a field
 * out would show a page the real app never does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockDownload, mockRequest } from './mockApi.js';

test('the config says assets are available and which universe servers the app knows', async () => {
	const config = await mockRequest('/api/config');
	assert.equal(config.assetsAvailable, true);
	assert.equal(config.assetChannelsAvailable, true);
	assert.ok(config.universeServers.length >= 2);
	for (const server of config.universeServers) {
		assert.deepEqual(Object.keys(server).sort(), ['chain', 'courier', 'id', 'label', 'networks', 'note', 'rest']);
		assert.match(server.courier, /^universerpc:\/\//);
		assert.match(server.rest, /^https:\/\//);
		assert.ok(Array.isArray(server.networks) && server.networks.length > 0);
	}
	assert.ok(config.universeServers.some((s) => s.networks.includes('mainnet')));
	// Testnet is two chains with a server each, and each says which it is for.
	assert.deepEqual(config.universeServers.filter((s) => s.networks.includes('testnet')).map((s) => s.chain), ['testnet3', 'testnet4']);
	assert.equal(config.universeServers.find((s) => s.networks.includes('mainnet')).chain, null);
});

test("every wallet record carries the manager's whole assets block", async () => {
	const wallets = await mockRequest('/api/wallets');
	assert.ok(wallets.length > 0);
	for (const w of wallets) {
		assert.deepEqual(
			Object.keys(w.assets).sort(),
			['backupFile', 'enabled', 'error', 'holdsAssets', 'notArchived', 'phase', 'universe'],
			w.id
		);
		assert.equal(typeof w.assets.holdsAssets, 'boolean');
		// Whether the file exists is only a question for a wallet with assets.
		assert.equal(w.assets.backupFile, w.assets.holdsAssets ? true : null, w.id);
		assert.equal(w.assets.notArchived, null, 'nothing is left out of an archive not yet made');
		assert.equal(w.assets.error, null);
	}
	assert.ok(wallets.some((w) => w.assets.holdsAssets), 'the demo has a wallet with assets to show');
});

test('a backup made while a wallet with assets is stopped leaves its assets out, and says so on its record', async () => {
	const holder = (await mockRequest('/api/wallets')).find((w) => w.assets.holdsAssets && w.status === 'running');
	assert.ok(holder);
	await mockRequest(`/api/wallets/${holder.id}/stop`, { method: 'POST' });
	try {
		await mockDownload('/api/backup/export', { passphrase: 'correct horse battery' });
		const stopped = (await mockRequest('/api/wallets')).find((w) => w.id === holder.id);
		assert.equal(stopped.assets.notArchived, 'no-file');
		assert.equal(stopped.assets.phase, null, 'a stopped wallet has no host to report on');
	} finally {
		await mockRequest(`/api/wallets/${holder.id}/start`, { method: 'POST' });
	}
	// Started again and backed up again, as the note asks: it is in this one.
	await mockDownload('/api/backup/export', { passphrase: 'correct horse battery' });
	const again = (await mockRequest('/api/wallets')).find((w) => w.id === holder.id);
	assert.equal(again.assets.notArchived, null);
});

test("a wallet's history has the transactions its asset operations made, and its daemon would bump the pending ones", async () => {
	const holder = (await mockRequest('/api/wallets')).find((w) => w.assets.holdsAssets && w.status === 'running');
	const base = `/wallets/${holder.id}/api`;
	const { rows } = await mockRequest(`${base}/x/assets/activity?limit=200`);
	const onChain = rows.filter((r) => r.txid && !r.kind.startsWith('ln-') && !r.failed);
	assert.ok(onChain.length > 0, 'the demo wallet has asset transactions to show');

	const txs = await mockRequest(`${base}/transactions`);
	const byId = new Map(txs.map((t) => [t.txid, t]));
	for (const row of onChain) {
		const tx = byId.get(row.txid);
		assert.ok(tx, `${row.kind} ${row.txid.slice(0, 8)} is in the history`);
		assert.equal(tx.type, row.kind === 'receive' ? 'received' : 'sent');
		assert.equal(tx.confirmed, !!row.at.confirmed);
	}
	assert.equal(new Set(txs.map((t) => t.txid)).size, txs.length, 'each transaction once');
	for (let i = 1; i < txs.length; i++) {
		if (byId.get(txs[i].txid) && onChain.some((r) => r.txid === txs[i].txid)) {
			assert.ok(txs[i - 1].timestamp >= txs[i].timestamp, 'an asset transaction sits where its time puts it');
		}
	}

	// The daemon cannot tell an asset transaction from a payment, so an
	// unconfirmed one is in its boostable list: the page is what withholds it.
	const boostable = await mockRequest(`${base}/transactions/boostable`);
	const offered = new Set([...boostable.rbf, ...boostable.cpfp].map((t) => t.txid));
	for (const row of onChain.filter((r) => !r.at.confirmed)) assert.ok(offered.has(row.txid));
});

test("the demo daemon lists a wallet's asset channel beside its bitcoin ones, marked auxiliary, and counts it in no bitcoin figure", async () => {
	const { channels: assetChannels } = await mockRequest('/wallets/demo-main/api/x/assets/channels');
	assert.ok(assetChannels.length >= 1);
	const listed = await mockRequest('/wallets/demo-main/api/channels');
	const marked = listed.filter((c) => c.auxiliary === true);
	assert.deepEqual(marked.map((c) => c.channelId).sort(), assetChannels.map((c) => c.channelId).sort());
	for (const c of marked) {
		assert.equal(c.maxSendableSats, 0);
		assert.equal(c.localBalanceSats + c.remoteBalanceSats, c.capacitySats);
	}
	// No other row carries the key at all, as on a daemon.
	for (const c of listed.filter((x) => x.auxiliary !== true)) assert.equal('auxiliary' in c, false);
	// What the wallet can send as bitcoin is what its bitcoin channels can send.
	const liquidity = await mockRequest('/wallets/demo-main/api/liquidity');
	const bitcoinSendable = listed.filter((c) => c.auxiliary !== true).reduce((sum, c) => sum + (c.maxSendableSats || 0), 0);
	assert.equal(liquidity.maxSendableSats, bitcoinSendable);
	// A wallet with no asset channel lists no such row.
	const none = await mockRequest('/wallets/demo-testnet/api/channels');
	assert.equal(none.some((c) => c.auxiliary === true), false);
});
