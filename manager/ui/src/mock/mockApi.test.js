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
	// One the manager starts again: a wallet on a guardian backup with an asset channel is refused (the last test here).
	const holder = (await mockRequest('/api/wallets')).find((w) => w.assets.holdsAssets && w.status === 'running' && !['quorum', 'async-remote'].includes(w.recovery?.mode));
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

test('the demo daemon lists the payments and invoices an asset channel carried beside the bitcoin ones, marked auxiliary', async () => {
	const base = '/wallets/demo-main/api';
	const { rows } = await mockRequest(`${base}/x/assets/activity?limit=200`);
	const carried = rows.filter((r) => (r.kind === 'ln-send' || r.kind === 'ln-receive') && r.state === 'complete');
	assert.ok(carried.length >= 2, 'the demo wallet has paid and been paid in an asset');
	const payments = await mockRequest(`${base}/payments`);
	const marked = payments.filter((p) => p.auxiliary === true);
	assert.deepEqual(marked.map((p) => p.paymentHash).sort(), carried.map((r) => r.paymentHash).sort());
	// One out counts the sats that carried it, never a bitcoin amount.
	for (const p of marked.filter((x) => x.direction === 'OUTGOING')) assert.equal(p.amountSats, 354);
	assert.ok(marked.some((p) => p.direction === 'INCOMING') && marked.some((p) => p.direction === 'OUTGOING'));
	// No bitcoin payment carries the key at all, as on a daemon.
	for (const p of payments.filter((x) => x.auxiliary !== true)) assert.equal('auxiliary' in p, false);

	// An asset invoice is listed by the daemon too, and marked.
	const before = (await mockRequest(`${base}/invoices`)).filter((i) => i.auxiliary === true).length;
	const { assets } = await mockRequest(`${base}/x/assets/balances`);
	const busd = assets.find((a) => BigInt(a.balance.lightningReceivable || '0') > 0n);
	const quote = await mockRequest(`${base}/x/assets/invoices/quote`, { method: 'POST', body: { key: busd.key, amount: '1000' } });
	const made = await mockRequest(`${base}/x/assets/invoices`, { method: 'POST', body: { key: busd.key, amount: '1000', quoteId: quote.quoteId } });
	const invoices = await mockRequest(`${base}/invoices`);
	const listed = invoices.filter((i) => i.auxiliary === true);
	assert.equal(listed.length, before + 1);
	const mine = listed.find((i) => i.paymentHash === made.paymentHash);
	assert.equal(mine.bolt11, made.bolt11);
	assert.equal(mine.status, 'PENDING');
	for (const i of invoices.filter((x) => x.auxiliary !== true)) assert.equal('auxiliary' in i, false);

	// A wallet with no asset channel lists neither.
	assert.equal((await mockRequest('/wallets/demo-testnet/api/payments')).some((p) => p.auxiliary === true), false);
	assert.equal((await mockRequest('/wallets/demo-testnet/api/invoices')).some((i) => i.auxiliary === true), false);
});


// Last in this file: it leaves demo-main stopped, as the manager would.
test('a wallet on a guardian backup that still has an asset channel is not started, and its record says why while it is stopped', async () => {
	const before = (await mockRequest('/api/wallets')).find((w) => w.id === 'demo-main');
	assert.deepEqual([before.status, before.recovery.mode, before.lastStartError], ['running', 'quorum', null]);
	await mockRequest('/api/wallets/demo-main/stop', { method: 'POST' });
	const said = 'This wallet has an asset channel open and is on a channel backup kept by guardians, which does not cover asset channels, so it was not started. Take it off the guardian backup, start it, and close the channel on the Channels tab. Once the assets are back on-chain it can go back on a guardian backup.';
	await assert.rejects(mockRequest('/api/wallets/demo-main/start', { method: 'POST' }), (e) => e.code === 'ASSET_CHANNELS_OPEN' && e.message === said);
	const after = (await mockRequest('/api/wallets')).find((w) => w.id === 'demo-main');
	assert.equal(after.status, 'stopped');
	assert.deepEqual([after.lastStartError.code, after.lastStartError.message], ['ASSET_CHANNELS_OPEN', said]);
	assert.match(after.lastStartError.at, /^\d{4}-\d\d-\d\dT/);
});
