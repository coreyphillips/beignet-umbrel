'use strict';

/**
 * Asset channels over a stand-in wallet and library, and a stand-in for the
 * library's Lightning entry with its exported names and shapes
 * (test-fakes.js). The host is given the real glue over that entry
 * (adapter.js createLightning), so every test here runs through it. `h.ln`
 * is the stand-in, which a test switches and reads; `h.host.ln` is what the
 * host works against. The ten routes, and the rules that protect funds in
 * them.
 *
 *   - a wallet that cannot have asset channels, or was not asked to, says
 *     so and refuses, and still lists and closes a channel it has
 *   - the peer is asked before anything is written, and the marker, the
 *     request key and the note are written in one step before the library
 *     is told to open
 *   - the same request key opens once and pays once, also after a restart
 *   - an open a restart interrupted is opened again under the same id, and
 *     a funding flow nobody confirmed is cancelled
 *   - nothing that can reach the node is called with the host's lock held,
 *     or inside a storage transaction (checked after every test)
 *
 * Run: cd manager && npm test
 * Or:  cd manager && node --test server/assets-host/lightning.test.js
 */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { harness, refused, fakeInvoice } = require('./test-fakes');
const lightning = require('./lightning');
const backup = require('./backup');

const COIN = { name: 'coin', type: 'normal', amount: '1000', decimalDisplay: 2, meta: null, group: { mode: 'none' } };
const PEER = { pubkey: `02${'ab'.repeat(32)}`, host: 'peer.example.com', port: 9735, alias: 'edge' };
const LIGHTNING_ROUTES = [
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

const made = [];
const world = (opts = {}) => {
	const h = harness(opts);
	made.push(h);
	return h;
};

// The two rules the Lightning service needs kept, whatever a test was about.
afterEach(() => {
	for (const h of made.splice(0)) if (h.ln) assert.deepEqual(h.ln.violations, []);
});

const openBody = (asset, amount = '600', extra = {}) => ({ peer: PEER, key: asset.key, amount, feeRate: 2, ...extra });
const keys = (h, prefix) => h.storage.list(`h/${prefix}`).map((r) => r.key);
const named = (h, name) => h.ln.calls.filter((c) => c[0] === name);
const events = (h, name) => h.events.filter(([n]) => n === name).map(([, data]) => data);
const ask = (h, route, body, key) => (route.startsWith('GET ') ? h.get(route.slice(4)) : h.call(route, body, key));
const codeOf = async (promise) => {
	const err = await refused(promise);
	return [err.extensionCode, err.status];
};

/** A wallet with asset channels that minted 1000 coin, confirmed. */
async function funded(opts = {}) {
	const h = world({ lightning: true, ...opts });
	await h.boot();
	const mint = await h.call('POST /mint', { seedlings: [COIN], feeRate: 2 }, 'mint-key');
	await h.confirm(mint.row.txid);
	const asset = (await h.get('/balances')).assets[0];
	return { h, asset };
}

/** The same, with a channel of 600 coin open, `remote` of them on the peer's side. */
async function channelled({ remote = 0n } = {}, opts) {
	const ctx = await funded(opts);
	const open = await ctx.h.call('POST /channels/open', openBody(ctx.asset), 'open-key');
	const id = open.pendingChannelId;
	ctx.h.ln.confirm(id);
	if (remote) ctx.h.ln.move(ctx.h.ln.flow(id).channelId, -remote);
	await ctx.h.host.pass({ block: true });
	const channel = (await ctx.h.get('/channels')).channels[0];
	return { ...ctx, open, id, channel };
}

/* -------------------------------------------------------------------- mode */

test('a wallet that cannot have asset channels says lightning is off, whatever it was asked', async () => {
	const h = world({ env: { BEIGNET_ASSETS_LIGHTNING: 'full' } });
	await h.boot();
	assert.equal(h.cfg.lightning, 'full');
	assert.deepEqual((await h.get('/status')).lightning, { mode: 'off', usableChannels: 0 });
	// It has none, and says so: the manager counts what this lists.
	assert.deepEqual(await h.get('/channels'), { channels: [] });
	for (const route of LIGHTNING_ROUTES.filter((r) => r !== 'GET /channels')) {
		const err = await refused(ask(h, route, {}, undefined));
		assert.deepEqual([err.extensionCode, err.status], ['LIGHTNING_UNAVAILABLE', 409], route);
		assert.equal(err.message, 'This wallet has no Lightning for its assets, so it has no asset channels to use.');
	}
});

test('a wallet that can have asset channels and was asked for them says full', async () => {
	const h = world({ lightning: true });
	await h.boot();
	assert.deepEqual((await h.get('/status')).lightning, { mode: 'full', usableChannels: 0 });
	assert.deepEqual(named(h, 'start'), [['start', { quiet: false }]]);
	assert.deepEqual(await h.get('/channels'), { channels: [] });
	assert.deepEqual(await h.get('/invoices'), { invoices: [] });
});

test('one that was not asked says off and refuses, with its provider started all the same', async () => {
	const h = world({ lightning: true, env: { BEIGNET_ASSETS_LIGHTNING: 'off' } });
	await h.boot();
	assert.deepEqual((await h.get('/status')).lightning, { mode: 'off', usableChannels: 0 });
	// Started, and told to give nobody a price.
	assert.deepEqual(named(h, 'start'), [['start', { quiet: true }]]);
	assert.deepEqual(await h.get('/channels'), { channels: [] });
	for (const route of LIGHTNING_ROUTES.filter((r) => !['GET /channels', 'POST /channels/close', 'POST /channels/reclaim'].includes(r))) {
		assert.deepEqual(await codeOf(ask(h, route, {}, undefined)), ['LIGHTNING_UNAVAILABLE', 409], route);
	}
	// Closing, and taking a funding back, work on what there is, and here there is nothing.
	assert.deepEqual(await codeOf(h.call('POST /channels/close', { channelId: 'ab'.repeat(32) })), ['CHANNEL_NOT_FOUND', 404]);
	assert.deepEqual(await codeOf(h.call('POST /channels/reclaim', { channelId: 'ab'.repeat(32) }, 'a-key')), ['CHANNEL_NOT_FOUND', 404]);
});

test('a Lightning service that will not start leaves the wallet its assets and no Lightning', async () => {
	const h = world({ lightning: true });
	h.ln.opts.startFails = 'the node is too old for this';
	// The service starts as the engine binds its node, and its failure is the
	// host's to hear: the engine's bind does not throw.
	await h.boot();
	assert.deepEqual((await h.get('/status')).lightning, { mode: 'off', usableChannels: 0 });
	assert.equal(h.logs.some(([level, text]) => level === 'warn' && /asset channels could not start: the node is too old for this/i.test(text)), true);
	assert.deepEqual(await codeOf(h.call('POST /channels/quote', {})), ['LIGHTNING_UNAVAILABLE', 409]);
	const mint = await h.call('POST /mint', { seedlings: [COIN], feeRate: 2 }, 'mint-key');
	assert.equal(mint.row.kind, 'mint');
});

test('before the engine has handed over its node, nothing is read as "no channels"', async () => {
	const h = world({ lightning: 'unbound' });
	await h.boot();
	assert.deepEqual((await h.get('/status')).lightning, { mode: 'full', usableChannels: 0 });
	for (const route of ['GET /channels', 'POST /channels/quote', 'POST /channels/close', 'POST /channels/reclaim', 'POST /invoices/quote', 'POST /pay/quote']) {
		const err = await refused(ask(h, route, {}, undefined));
		assert.deepEqual([err.extensionCode, err.status, err.message], ['ASSETS_STARTING', 503, 'Lightning is still starting. Try again in a moment.'], route);
	}
	// The node arrives: the next pass settles what a restart left, and the routes answer.
	assert.deepEqual(named(h, 'start'), []);
	h.host.ln.attachment.bind(h.ln.node);
	assert.deepEqual(named(h, 'start'), [['start', { quiet: false }]]);
	await h.host.pass();
	assert.deepEqual(await h.get('/channels'), { channels: [] });
});

/* ------------------------------------------------------------------- quote */

test('a channel quote: 100,000 sats, the fee, and what starts on the peer side', async () => {
	const { h, asset } = await funded();
	const quote = await h.call('POST /channels/quote', { key: asset.key, amount: '600', feeRate: 2 });
	// The reserve is 1 percent of the channel when nobody says, and two 354 sat carriers go with it.
	assert.deepEqual(quote, { channelSats: 100000, pushSats: 1708, feeSats: 420, totalSats: 100420, spendableSats: 500000, sufficient: true });
	assert.deepEqual(named(h, 'quoteFunding')[0][1], { assets: [{ assetId: asset.assetId, amount: 600n }], groupKey: null, fundingSats: 100000, feeRate: 2 });
	// A library that names the reserve is believed.
	h.ln.opts.reserveSats = 2500;
	assert.equal((await h.call('POST /channels/quote', { key: asset.key, amount: '600', feeRate: 2 })).pushSats, 3208);
	// Nothing was written and nothing opened.
	assert.deepEqual(keys(h, 'chan/'), []);
	assert.deepEqual(named(h, 'openChannel'), []);
});

test('a channel quote for a wallet short of bitcoin says so in figures, and does not refuse', async () => {
	const { h, asset } = await funded();
	h.ln.opts.fundFails = true;
	const quote = await h.call('POST /channels/quote', { key: asset.key, amount: '600', feeRate: 2 });
	assert.equal(quote.sufficient, false);
	assert.deepEqual([quote.channelSats, quote.feeSats, quote.totalSats], [100000, 600, 100600]);
	h.ln.opts.fundFails = false;
	h.wallet.getBalanceBreakdown = () => ({ total: 90000, spendable: 90000, frozen: 0 });
	const poor = await h.call('POST /channels/quote', { key: asset.key, amount: '600', feeRate: 2 });
	assert.deepEqual([poor.sufficient, poor.spendableSats, poor.totalSats], [false, 90000, 100420]);
});

test('a channel quote refuses what cannot be opened', async () => {
	const { h, asset } = await funded();
	const q = (body) => codeOf(h.call('POST /channels/quote', { key: asset.key, amount: '600', feeRate: 2, ...body }));
	assert.deepEqual(await q({ amount: '0' }), ['BAD_AMOUNT', 400]);
	assert.deepEqual(await q({ amount: '1.5' }), ['BAD_AMOUNT', 400]);
	assert.deepEqual(await q({ key: 'cd'.repeat(32) }), ['ASSET_NOT_FOUND', 404]);
	assert.deepEqual(await q({ key: '' }), ['ASSET_NOT_FOUND', 404]);
	assert.deepEqual(await q({ feeRate: 100000 }), ['FEE_TOO_HIGH', 400]);
	const short = await refused(h.call('POST /channels/quote', { key: asset.key, amount: '1001', feeRate: 2 }));
	assert.deepEqual([short.extensionCode, short.status, short.details], ['INSUFFICIENT_ASSET_BALANCE', 409, { needed: '1001', available: '1000' }]);
	// A fee the library quotes above the wallet's ceiling stops it before anything is signed.
	h.ln.opts.fundingFee = 300000;
	const dear = await refused(h.call('POST /channels/quote', { key: asset.key, amount: '600', feeRate: 2 }));
	assert.deepEqual([dear.extensionCode, dear.details], ['FEE_TOO_HIGH', { feeSats: 300000, maxFeeSats: 250000 }]);
});

test('a collectible cannot go into a channel', async () => {
	const h = world({ lightning: true });
	await h.boot();
	const mint = await h.call('POST /mint', { seedlings: [{ name: 'one', type: 'collectible', amount: '1', meta: null, group: { mode: 'none' } }], feeRate: 2 }, 'mint-key');
	await h.confirm(mint.row.txid);
	const asset = (await h.get('/balances')).assets[0];
	const err = await refused(h.call('POST /channels/quote', { key: asset.key, amount: '1', feeRate: 2 }));
	assert.deepEqual([err.extensionCode, err.status], ['INVALID_PARAMS', 400]);
	assert.match(err.message, /^A collectible cannot go into a channel/);
});

/* -------------------------------------------------------------------- open */

test('opening: the peer is asked, the proofs are published, one write, and only then the library', async () => {
	const { h, asset } = await funded();
	const delivered = h.world.delivered.length;
	const answer = await h.call('POST /channels/open', openBody(asset), 'open-key');
	const id = answer.pendingChannelId;
	assert.deepEqual(answer, { pendingChannelId: id, phase: 'funding' });
	assert.match(id, /^[0-9a-f]{64}$/);

	// In order: connect, ask its features, publish, open.
	const order = h.ln.calls.map((c) => c[0]).filter((n) => ['connect', 'peerSupports', 'openChannel'].includes(n));
	assert.deepEqual(order, ['connect', 'peerSupports', 'openChannel']);
	assert.deepEqual(named(h, 'connect')[0][1], { pubkey: PEER.pubkey, host: 'peer.example.com', port: 9735 });
	// The proof of the asset the channel is funded with is on the proof server.
	const published = h.world.delivered.slice(delivered);
	assert.equal(published.length, 1);
	assert.equal(published[0].locator.assetId, asset.assetId);

	// When the library was told to open, the marker, the answer and the note were already stored.
	const [, opened, stored] = named(h, 'openChannel')[0];
	assert.equal(opened, id);
	assert.ok(stored.includes(`h/committed/funding:${id}`));
	assert.ok(stored.includes(`h/chan/${id}`));
	assert.equal(stored.filter((k) => k.startsWith('h/idem/channels/open/')).length, 1);

	// 100,000 sats, with the peer's reserve and two carriers pushed to it.
	const flow = h.ln.flow(id);
	assert.deepEqual(
		[flow.request.fundingSats, flow.request.pushSats, flow.request.feeRate, flow.request.decimalDisplay, flow.request.peerPubkey],
		[100000, 1708, 2, 2, PEER.pubkey]
	);
	assert.deepEqual(flow.request.assets, [{ assetId: asset.assetId, amount: 600n }]);

	// Listed, opening, with the engine's id once there is one.
	const { channels } = await h.get('/channels');
	assert.equal(channels.length, 1);
	assert.deepEqual(channels[0], {
		channelId: flow.channelId,
		pendingChannelId: id,
		peerPubkey: PEER.pubkey,
		peerAlias: 'edge',
		state: 'OPENING',
		asset: { key: asset.key, assetId: asset.assetId, name: 'coin', type: 'normal', decimalDisplay: 2 },
		capacity: '600',
		localBalance: '600',
		remoteBalance: '0',
		sendable: '0',
		receivable: '0',
		channelSats: 100000,
		// Its funding is made and not confirmed: should it never confirm, its bitcoin can be taken back.
		fundingTxid: flow.fundingTxid,
		reclaimable: true,
		reclaimTxid: null
	});
	// Still opening once the engine has it, and told again under the engine's id.
	assert.deepEqual(events(h, 'channel'), [
		{ channelId: id, state: 'OPENING' },
		{ channelId: flow.channelId, state: 'OPENING' }
	]);
	// The funding is signed and not confirmed: its input, all 1000 of the
	// asset, is still in the on-chain records, set aside under its name.
	assert.deepEqual(h.tap.records.filter((r) => !r.spent).map((r) => [r.amount, r.reservedBy]), [['1000', `funding:${id}`]]);
	// The 600 are the channel's and counted there once. The rest is the
	// funding's change, and stays on-chain: the same total, held two ways.
	const balance = { total: '1000', onchain: '400', pendingIn: '0', pendingOut: '0', channelLocal: '600', lightningSendable: '0', lightningReceivable: '0' };
	assert.deepEqual((await h.get('/balances')).assets[0].balance, balance);
	assert.deepEqual((await h.get('/status')).lightning, { mode: 'full', usableChannels: 0 });
	// It confirms: the input is spent, the change is a record of its own, and the books read the same.
	h.ln.confirm(id);
	await h.host.pass({ block: true });
	assert.deepEqual(h.tap.records.filter((r) => !r.spent).map((r) => [r.amount, r.reservedBy]), [['400', undefined]]);
	assert.deepEqual((await h.get('/balances')).assets[0].balance, { ...balance, lightningSendable: '600' });
});

test('a channel is OPENING until the library has confirmed it, and usable from then', async () => {
	const { h, asset } = await funded();
	const { pendingChannelId: id } = await h.call('POST /channels/open', openBody(asset), 'open-key');
	const state = async () => (await h.get('/channels')).channels[0].state;
	// The engine calls it NORMAL before the library has checked the funding: not usable yet.
	h.ln.set(id, { state: 'NORMAL', confirmed: false });
	assert.equal(await state(), 'OPENING');
	assert.equal((await h.get('/status')).lightning.usableChannels, 0);
	h.ln.confirm(id);
	await h.host.pass({ block: true });
	assert.equal(await state(), 'NORMAL');
	const channel = (await h.get('/channels')).channels[0];
	assert.deepEqual([channel.sendable, channel.receivable], ['600', '0']);
	assert.deepEqual((await h.get('/status')).lightning, { mode: 'full', usableChannels: 1 });
	assert.deepEqual((await h.get('/balances')).assets[0].balance.lightningSendable, '600');
	// What a live quote or payment holds is not sendable.
	h.ln.set(id, { reserved: 150n });
	assert.equal((await h.get('/channels')).channels[0].sendable, '450');
	// The loop carried it on each pass, and never under the lock (checked after the test).
	assert.ok(named(h, 'resume').length >= 1);
	assert.ok(named(h, 'resumeRecovery').length >= 1);
});

test('opening refuses before anything is written or spent', async () => {
	const { h, asset } = await funded();
	const open = (extra, key) => refused(h.call('POST /channels/open', openBody(asset, '600', extra), key));
	const nothing = () => {
		assert.deepEqual(keys(h, 'chan/'), []);
		assert.deepEqual(keys(h, 'committed/funding:'), []);
		assert.deepEqual(keys(h, 'idem/channels/'), []);
		assert.deepEqual(named(h, 'openChannel'), []);
	};
	for (const [extra, code, status] of [
		[{ peer: { ...PEER, pubkey: 'nonsense' } }, 'INVALID_PARAMS', 400],
		[{ peer: null }, 'INVALID_PARAMS', 400],
		[{ peer: { ...PEER, port: 70000 } }, 'INVALID_PARAMS', 400],
		[{ amount: '0' }, 'BAD_AMOUNT', 400],
		[{ key: 'cd'.repeat(32) }, 'ASSET_NOT_FOUND', 404],
		[{ amount: '1001' }, 'INSUFFICIENT_ASSET_BALANCE', 409],
		[{ feeRate: 100000 }, 'FEE_TOO_HIGH', 400]
	]) {
		const err = await open(extra, 'k');
		assert.deepEqual([err.extensionCode, err.status], [code, status], JSON.stringify(extra));
		nothing();
	}
	assert.deepEqual(named(h, 'connect'), []);

	// Short of bitcoin: the figures the dashboard words.
	h.wallet.getBalanceBreakdown = () => ({ total: 90000, spendable: 90000, frozen: 0 });
	const poor = await open({}, 'k');
	assert.deepEqual([poor.extensionCode, poor.status, poor.details], ['INSUFFICIENT_BTC', 409, { needed: 100420, spendable: 90000, feeSats: 420 }]);
	nothing();
	assert.deepEqual(named(h, 'connect'), []);
	h.wallet.getBalanceBreakdown = () => ({ total: 500000, spendable: 500000, frozen: 0 });

	// A peer that cannot be reached.
	h.ln.opts.connectFails = true;
	const away = await open({}, 'k');
	assert.deepEqual([away.extensionCode, away.status], ['PEER_UNREACHABLE', 502]);
	nothing();
	h.ln.opts.connectFails = false;

	// A peer that does not take asset channels: found out before anything is published or written.
	h.ln.opts.supports = false;
	const delivered = h.world.delivered.length;
	const plain = await open({}, 'k');
	assert.deepEqual([plain.extensionCode, plain.status], ['PEER_NO_ASSET_CHANNELS', 409]);
	assert.equal(plain.message, 'That peer does not open asset channels, so nothing was opened and nothing was spent.');
	assert.equal(h.world.delivered.length, delivered);
	nothing();
	h.ln.opts.supports = true;

	// A proof server that will not take the proof: the peer could not check the asset.
	h.world.net.down = true;
	const dark = await open({}, 'k');
	assert.deepEqual([dark.extensionCode, dark.status], ['PROOF_SERVER_UNREACHABLE', 502]);
	nothing();
	h.world.net.down = false;

	// And after all of that the same key opens.
	const answer = await h.call('POST /channels/open', openBody(asset), 'k');
	assert.equal(answer.phase, 'funding');
});

test('a peer already connected is named by its key alone', async () => {
	const { h, asset } = await funded();
	await h.call('POST /channels/open', openBody(asset, '600', { peer: { pubkey: PEER.pubkey, host: null, port: null } }), 'open-key');
	assert.deepEqual(named(h, 'connect')[0][1], { pubkey: PEER.pubkey, host: undefined, port: undefined });
	assert.equal((await h.get('/channels')).channels[0].peerAlias, null);
});

test('a peer that turns the channel down: the open is undone, and the same key can try again', async () => {
	const { h, asset } = await funded();
	h.ln.opts.openFails = 'ERR_BEIGNET_LN_FUNDING_REJECTED';
	const err = await refused(h.call('POST /channels/open', openBody(asset), 'open-key'));
	assert.deepEqual([err.extensionCode, err.status], ['PEER_NO_ASSET_CHANNELS', 409]);
	assert.equal(err.message, 'The peer turned the channel down, so nothing was opened and nothing was spent.');
	// The library's flow is cancelled, and nothing of the open is left.
	assert.equal(named(h, 'cancelFlow').length, 1);
	assert.equal(h.ln.flows.size, 0);
	assert.deepEqual(keys(h, 'chan/'), []);
	assert.deepEqual(keys(h, 'committed/funding:'), []);
	assert.deepEqual(keys(h, 'idem/channels/'), []);
	assert.deepEqual(await h.get('/channels'), { channels: [] });
	assert.deepEqual((await h.get('/balances')).assets[0].balance.onchain, '1000');
	// It was listed for a moment, and that is taken back.
	assert.deepEqual(events(h, 'channel').map((e) => e.state), ['OPENING', 'CLOSED']);
	assert.deepEqual(events(h, 'error').map((e) => e.code), ['PEER_NO_ASSET_CHANNELS']);

	h.ln.opts.openFails = null;
	const answer = await h.call('POST /channels/open', openBody(asset), 'open-key');
	assert.equal(answer.phase, 'funding');
	assert.equal(named(h, 'openChannel').length, 2);
});

test('an open that fails after its funding transaction is signed is kept, for the loop to carry on', async () => {
	const { h, asset } = await funded();
	h.ln.opts.openFailsSigned = 'ERR_BEIGNET_WALLET';
	const answer = await h.call('POST /channels/open', openBody(asset), 'open-key');
	const id = answer.pendingChannelId;
	assert.equal(answer.phase, 'funding');
	// Asked to cancel, the library said the transaction is signed: nothing is undone.
	assert.equal(named(h, 'cancelFlow').length, 1);
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${id}`]);
	assert.deepEqual(keys(h, 'chan/'), [`h/chan/${id}`]);
	assert.equal((await h.get('/channels')).channels[0].state, 'OPENING');
	assert.deepEqual(events(h, 'error'), []);
	// Its units are set aside for the channel, and are in the books there.
	const total = async (w) => {
		const { balance } = (await w.get('/balances')).assets[0];
		return [balance.total, balance.onchain, balance.channelLocal];
	};
	assert.deepEqual(await total(h), ['1000', '400', '600']);

	// A signed funding transaction is a channel in being for as long as what
	// it set aside is set aside, whatever its phase says meanwhile.
	h.ln.set(id, { phase: 'failed' });
	await h.host.pass({ block: true });
	assert.deepEqual((await h.get('/channels')).channels.map((c) => [c.pendingChannelId, c.state, c.localBalance]), [[id, 'OPENING', '600']]);
	assert.deepEqual(await total(h), ['1000', '400', '600']);
	assert.equal(h.host.mem.summary.channels, 1);
	assert.equal((await h.get('/status')).holdsAssets, true);
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${id}`]);
	assert.deepEqual(events(h, 'error'), []);
	// It cannot be closed yet, and a backup is not restored over it.
	const close = await refused(h.call('POST /channels/close', { channelId: id }));
	assert.deepEqual([close.extensionCode, close.status], ['CHANNEL_OPENING', 409]);
	assert.equal(close.message, 'This channel is still being opened, and its funding transaction is already signed. It can be closed once it is on the chain. If that transaction will not confirm, its bitcoin can be taken back instead, which ends the open.');
	assert.deepEqual(named(h, 'cancelFlow').length, 1);
	const file = { format: backup.FORMAT, version: backup.VERSION, network: 'regtest', chain: 'regtest', wallet: await h.host.fingerprint(), exportedAt: 1, rows: backup.collectRows(h.storage) };
	file.rowsHash = backup.hashRows(file.rows);
	assert.deepEqual(await codeOf(h.call('POST /backup/import', { backup: file })), ['ASSET_CHANNELS_OPEN', 409]);

	// And a restart does not open it a second time: the library has it.
	const again = h.restart();
	made.push(again);
	await again.boot();
	await again.host.pass({ block: true });
	assert.equal(named(again, 'openChannel').length, 1);
	assert.deepEqual(await total(again), ['1000', '400', '600']);
	assert.deepEqual(keys(again, 'committed/funding:'), [`h/committed/funding:${id}`]);
});

test('the same request key opens one channel, also after a restart', async () => {
	const { h, asset } = await funded();
	const first = await h.call('POST /channels/open', openBody(asset), 'open-key');
	const second = await h.call('POST /channels/open', openBody(asset), 'open-key');
	assert.deepEqual(second, first);
	assert.equal(named(h, 'openChannel').length, 1);
	assert.equal(named(h, 'connect').length, 1);
	const other = await refused(h.call('POST /channels/open', openBody(asset, '100'), 'open-key'));
	assert.deepEqual([other.extensionCode, other.status], ['IDEMPOTENCY_KEY_REUSED', 409]);

	const again = h.restart();
	made.push(again);
	await again.boot();
	assert.deepEqual(await again.call('POST /channels/open', openBody(asset), 'open-key'), first);
	assert.equal(named(again, 'openChannel').length, 1);
	assert.equal(keys(again, 'chan/').length, 1);
});

test('a crash between the marker and the open: the next start opens it under the same id', async () => {
	const { h, asset } = await funded();
	// The library is told to open and the process dies before it does anything.
	h.ln.opts.openHangs = true;
	h.cfg.openWaitMs = 10;
	const answer = await h.call('POST /channels/open', openBody(asset), 'open-key');
	const id = answer.pendingChannelId;
	assert.equal(h.ln.flows.size, 0);
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${id}`]);
	// Until then it is listed as what it is: asked for, and on its way.
	const listed = (await h.get('/channels')).channels[0];
	assert.deepEqual([listed.channelId, listed.state, listed.localBalance, listed.sendable], [id, 'OPENING', '600', '0']);
	// Its units are still on the chain, so they are not counted twice.
	assert.deepEqual((await h.get('/balances')).assets[0].balance, {
		total: '1000',
		onchain: '1000',
		pendingIn: '0',
		pendingOut: '0',
		channelLocal: '0',
		lightningSendable: '0',
		lightningReceivable: '0'
	});

	h.ln.opts.openHangs = false;
	const again = h.restart();
	made.push(again);
	await again.boot();
	for (let i = 0; i < 50 && again.ln.flows.size === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
	const opens = named(again, 'openChannel');
	assert.equal(opens.length, 2);
	assert.deepEqual([opens[0][1], opens[1][1]], [id, id]);
	// The peer is connected to again first: a restart dropped it.
	assert.deepEqual(named(again, 'connect').pop()[1], { pubkey: PEER.pubkey, host: 'peer.example.com', port: 9735 });
	assert.equal(again.ln.flows.size, 1);
	assert.deepEqual(keys(again, 'chan/'), [`h/chan/${id}`]);
	// The same key still answers with the first answer, and opens nothing more.
	assert.deepEqual(await again.call('POST /channels/open', openBody(asset), 'open-key'), answer);
	assert.equal(named(again, 'openChannel').length, 2);
});

test('at start, a funding flow nobody confirmed is cancelled, and a signed one is left alone', async () => {
	const { h, asset } = await funded();
	const flow = (id, extra) => h.ln.plant(id, { assetId: asset.assetId, local: 100n, ...extra });
	flow('aa'.repeat(32), {});
	// One the node already holds a channel for, with nothing signed yet, is cancelled all the same.
	flow('dd'.repeat(32), { phase: 'negotiated', state: 'SENT_OPEN' });
	flow('bb'.repeat(32), { signed: true, phase: 'broadcasting', state: 'AWAITING_FUNDING_CONFIRMED' });
	// One a peer began is not this wallet's to cancel.
	flow('cc'.repeat(32), { initiator: false });
	const again = h.restart();
	made.push(again);
	await again.boot();
	assert.deepEqual(named(again, 'cancelFlow').map((c) => c[1]).sort(), ['aa'.repeat(32), 'dd'.repeat(32)]);
	// What was cancelled is taken off the library's list as well, and nobody is told of an error.
	assert.deepEqual([...again.ln.flows.keys()].sort(), ['bb'.repeat(32), 'cc'.repeat(32)]);
	assert.deepEqual(events(again, 'error'), []);
});

test('a channel the library has let go of is over, and is never opened a second time', async () => {
	const { h, id, channel } = await channelled();
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${id}`]);
	// The library forgets it, as it may once a channel is long closed.
	h.ln.flows.delete(id);
	// A start before the loop has looked: the marker is still there, and nothing is opened on it.
	const again = h.restart();
	made.push(again);
	await again.boot();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(named(again, 'openChannel').length, 1);
	assert.deepEqual(named(again, 'cancelFlow'), []);
	// The loop notes it as over: not listed, not counted, nothing left to carry on.
	await again.host.pass({ block: true });
	assert.deepEqual(await again.get('/channels'), { channels: [] });
	assert.deepEqual(keys(again, 'committed/funding:'), []);
	assert.equal(again.storage.get(`h/chan/${id}`) !== null && JSON.parse(again.storage.get(`h/chan/${id}`)).closedAt, again.clock.t);
	assert.deepEqual((await again.get('/balances')).assets[0].balance.channelLocal, '0');
	assert.deepEqual(await codeOf(again.call('POST /channels/close', { channelId: channel.channelId })), ['CHANNEL_NOT_FOUND', 404]);
	// Its note is kept a while, and then goes.
	again.clock.t += 31 * 24 * 60 * 60 * 1000;
	await again.host.pass();
	assert.deepEqual(keys(again, 'chan/'), []);
	// And a later start still opens nothing.
	const later = again.restart();
	made.push(later);
	await later.boot();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(named(later, 'openChannel').length, 1);
});

test('the note of a channel that is over is kept for as long as the library lists the channel', async () => {
	const { h, id, channel } = await channelled();
	await h.call('POST /channels/close', { channelId: channel.channelId, force: true });
	h.ln.recover(id);
	await h.host.pass({ block: true });
	const closedAt = JSON.parse(h.storage.get(`h/chan/${id}`)).closedAt;
	h.clock.t += 31 * 24 * 60 * 60 * 1000;
	await h.host.pass();
	// Still the library's, so still noted: it is not shown as newly closed a month on.
	assert.equal(JSON.parse(h.storage.get(`h/chan/${id}`)).closedAt, closedAt);
	assert.deepEqual(await h.get('/channels'), { channels: [] });
});

test('an open that was confirmed is undone at start when asset channels are off by then', async () => {
	const { h, asset } = await funded();
	h.ln.opts.openHangs = true;
	h.cfg.openWaitMs = 10;
	const { pendingChannelId: id } = await h.call('POST /channels/open', openBody(asset), 'open-key');
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${id}`]);
	h.host.shutdown();
	h.host.ln.close();
	h.ln.opts.openHangs = false;
	const off = world({ lightning: true, shared: h.world, env: { BEIGNET_ASSETS_LIGHTNING: 'off' } });
	await off.boot();
	assert.equal(named(off, 'openChannel').length, 1);
	assert.deepEqual(keys(off, 'committed/funding:'), []);
	assert.deepEqual(keys(off, 'chan/'), []);
	assert.deepEqual(await off.get('/channels'), { channels: [] });
});

test('an open cancelled while a restart is starting it again opens nothing, and its key then opens one channel', async () => {
	const { h, asset } = await funded();
	h.ln.opts.openHangs = true;
	h.cfg.openWaitMs = 10;
	const first = await h.call('POST /channels/open', openBody(asset), 'open-key');
	const id = first.pendingChannelId;
	h.ln.opts.openHangs = false;
	// The next start finds the marker, and the peer takes its time to connect.
	let release;
	h.ln.opts.connectGate = new Promise((resolve) => (release = resolve));
	const again = h.restart();
	made.push(again);
	await again.boot();
	for (let i = 0; i < 100 && named(again, 'connect').length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
	assert.equal(named(again, 'connect').length, 2);
	// Cancelled during the reconnect: the close waits for the start to be over.
	const closing = again.call('POST /channels/close', { channelId: id });
	await new Promise((r) => setTimeout(r, 20));
	again.ln.opts.connectGate = null;
	release();
	assert.deepEqual(await closing, { channelId: id, closing: true, force: false });
	await new Promise((r) => setTimeout(r, 20));
	// Nothing was opened for it, and nothing of it is left.
	assert.equal(named(again, 'openChannel').length, 1);
	assert.equal(again.ln.flows.size, 0);
	assert.deepEqual([keys(again, 'committed/funding:'), keys(again, 'chan/'), keys(again, 'idem/channels/')], [[], [], []]);
	assert.deepEqual(events(again, 'error'), []);

	// The same key again is a new open: one channel, and never two.
	const second = await again.call('POST /channels/open', openBody(asset), 'open-key');
	assert.notEqual(second.pendingChannelId, id);
	assert.deepEqual([...again.ln.flows.keys()], [second.pendingChannelId]);
	await again.host.pass({ block: true });
	const later = again.restart();
	made.push(later);
	await later.boot();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(later.ln.flows.size, 1);
	assert.deepEqual(await later.call('POST /channels/open', openBody(asset), 'open-key'), second);
});

test('a cancel that the library answers for an open it has not heard of yet is not believed while that open is being started', async () => {
	const { h, asset } = await funded();
	let release;
	h.ln.opts.openGate = new Promise((resolve) => (release = resolve));
	// The worst a library could do: say yes to the cancel, and open all the same.
	h.ln.opts.cancelMissed = true;
	const opening = h.call('POST /channels/open', openBody(asset), 'open-key');
	for (let i = 0; i < 100 && named(h, 'openChannel').length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
	const id = keys(h, 'chan/')[0].slice('h/chan/'.length);
	const closing = refused(h.call('POST /channels/close', { channelId: id }));
	await new Promise((r) => setTimeout(r, 20));
	// Nothing is forgotten while the open is out.
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${id}`]);
	assert.equal(keys(h, 'idem/channels/').length, 1);
	release();
	const err = await closing;
	assert.deepEqual([err.extensionCode, err.status], ['CHANNEL_OPENING', 409]);
	assert.equal(err.message, 'This channel is still being opened, and its funding transaction is already signed. It can be closed once it is on the chain. If that transaction will not confirm, its bitcoin can be taken back instead, which ends the open.');
	const answer = await opening;
	assert.deepEqual(answer, { pendingChannelId: id, phase: 'funding' });
	// One channel, with its marker and the answer to its key.
	assert.deepEqual([...h.ln.flows.keys()], [id]);
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${id}`]);
	assert.deepEqual(await h.call('POST /channels/open', openBody(asset), 'open-key'), answer);
	assert.equal(named(h, 'openChannel').length, 1);
	assert.deepEqual(events(h, 'error'), []);
	// The wish to drop it does not outlive the answer: the channel stays.
	await h.host.pass({ block: true });
	assert.equal((await h.get('/channels')).channels.length, 1);
});

test('an open cancelled while the library works on it: the request is told so, and nothing is left', async () => {
	const { h, asset } = await funded();
	let release;
	h.ln.opts.openGate = new Promise((resolve) => (release = resolve));
	const opening = refused(h.call('POST /channels/open', openBody(asset), 'open-key'));
	for (let i = 0; i < 100 && named(h, 'openChannel').length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
	const id = keys(h, 'chan/')[0].slice('h/chan/'.length);
	const closing = h.call('POST /channels/close', { channelId: id });
	await new Promise((r) => setTimeout(r, 20));
	release();
	assert.deepEqual(await closing, { channelId: id, closing: true, force: false });
	const err = await opening;
	assert.deepEqual([err.extensionCode, err.status], ['CHANNEL_CANCELLED', 409]);
	assert.equal(err.message, 'This channel open was cancelled before anything was signed, so nothing was opened and nothing was spent.');
	assert.equal(h.ln.flows.size, 0);
	assert.deepEqual([keys(h, 'committed/funding:'), keys(h, 'chan/'), keys(h, 'idem/channels/')], [[], [], []]);
	// Dropped because it was asked for: that is no error.
	assert.deepEqual(events(h, 'error'), []);
	assert.deepEqual(events(h, 'channel').map((e) => e.state), ['OPENING', 'CLOSED']);
	assert.equal((await h.get('/balances')).assets[0].balance.onchain, '1000');
});

test('an open that cannot be stopped in time is not forgotten, and is dropped or kept once it is over', async () => {
	const { h, asset } = await funded();
	let release;
	h.ln.opts.openGate = new Promise((resolve) => (release = resolve));
	h.ln.opts.cancelMissed = true;
	h.cfg.openWaitMs = 30;
	const answer = await h.call('POST /channels/open', openBody(asset), 'open-key');
	const id = answer.pendingChannelId;
	const err = await refused(h.call('POST /channels/close', { channelId: id }));
	assert.deepEqual([err.extensionCode, err.status], ['CHANNEL_OPENING', 409]);
	assert.equal(err.message, 'This channel is still being opened, and the open could not be stopped yet. Try again in a moment.');
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${id}`]);
	assert.equal(keys(h, 'idem/channels/').length, 1);
	// The loop does not undo an open that is still out, however often it looks.
	h.clock.t += 60000;
	await h.host.pass({ block: true });
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${id}`]);
	release();
	for (let i = 0; i < 100 && h.ln.flows.size === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
	await h.host.pass({ block: true });
	// It signed: one channel, kept.
	assert.deepEqual([...h.ln.flows.keys()], [id]);
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${id}`]);
	assert.equal((await h.get('/channels')).channels[0].pendingChannelId, id);
	assert.deepEqual(events(h, 'error'), []);
});

test('an open kept after no answer in time is settled by the loop, and not only by the next start', async () => {
	const { h, asset } = await funded();
	h.ln.opts.openTimesOut = true;
	const answer = await h.call('POST /channels/open', openBody(asset), 'open-key');
	const id = answer.pendingChannelId;
	assert.equal(answer.phase, 'funding');
	// No answer is not a no: the flow is the library's to carry on.
	assert.deepEqual(named(h, 'cancelFlow'), []);
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${id}`]);
	h.clock.t += 60000;
	await h.host.pass({ block: true });
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${id}`]);
	assert.deepEqual(events(h, 'error'), []);

	// Then the peer turns it down, with nobody waiting on the open.
	h.ln.set(id, { phase: 'rejected' });
	await h.host.pass({ block: true });
	assert.deepEqual(named(h, 'cancelFlow').map((c) => c[1]), [id]);
	assert.deepEqual([keys(h, 'committed/funding:'), keys(h, 'chan/'), keys(h, 'idem/channels/')], [[], [], []]);
	assert.deepEqual(events(h, 'error'), [
		{ code: 'CHANNEL_OPEN_FAILED', message: 'The channel could not be opened, and nothing was spent.', channelId: id }
	]);
	assert.deepEqual(events(h, 'channel').map((e) => e.state), ['OPENING', 'CLOSED']);
	assert.deepEqual(await h.get('/channels'), { channels: [] });
	assert.equal(named(h, 'openChannel').length, 1);
});

test('an open the library has lost all record of is undone once it has had its time, and one that signed is kept', async () => {
	const { h, asset } = await funded();
	h.ln.opts.openTimesOut = true;
	const lost = (await h.call('POST /channels/open', openBody(asset, '100'), 'lost-key')).pendingChannelId;
	h.ln.lose(lost);
	const kept = (await h.call('POST /channels/open', openBody(asset, '100'), 'kept-key')).pendingChannelId;
	h.ln.opts.openTimesOut = false;
	h.ln.set(kept, { signed: true, phase: 'funding-created', state: 'SENT_FUNDING' });
	await h.host.pass({ block: true });
	// Not at once: an open is given the time it takes to be told to the library.
	assert.deepEqual(keys(h, 'committed/funding:').sort(), [`h/committed/funding:${kept}`, `h/committed/funding:${lost}`].sort());
	h.clock.t += 31000;
	await h.host.pass({ block: true });
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${kept}`]);
	assert.deepEqual(events(h, 'error').map((e) => [e.code, e.channelId]), [['CHANNEL_OPEN_FAILED', lost]]);
	assert.deepEqual((await h.get('/channels')).channels.map((c) => [c.pendingChannelId, c.state]), [[kept, 'OPENING']]);
	// And never opened a second time, by the loop or by a start.
	assert.equal(named(h, 'openChannel').length, 2);
});

test('the open itself is bound to the fee the wallet allows, and one that would pay more is refused before it is signed', async () => {
	const { h, asset } = await funded();
	h.ln.opts.openFee = 300000;
	const err = await refused(h.call('POST /channels/open', openBody(asset), 'open-key'));
	assert.deepEqual([err.extensionCode, err.status], ['FEE_TOO_HIGH', 400]);
	assert.equal(err.message, 'Opening would pay more to miners than this wallet allows for an asset transaction, so nothing was opened and nothing was spent.');
	assert.deepEqual([keys(h, 'committed/funding:'), keys(h, 'chan/'), keys(h, 'idem/channels/')], [[], [], []]);
	assert.equal((await h.get('/balances')).assets[0].balance.onchain, '1000');
	h.ln.opts.openFee = null;
	const { pendingChannelId: id } = await h.call('POST /channels/open', openBody(asset), 'open-key');
	assert.equal(h.ln.flow(id).request.maxFeeSats, h.cfg.limits.maxFeeSats);
});

test('what the library says of a failed open or close goes to the log, and the caller gets a sentence of the host', async () => {
	const { h, asset } = await funded();
	const logged = [];
	h.host.say = (level, text) => logged.push(text);
	h.ln.opts.openFails = 'ERR_SOMETHING_NEW';
	const open = await refused(h.call('POST /channels/open', openBody(asset), 'open-key'));
	assert.deepEqual([open.extensionCode, open.status, open.message], ['CHANNEL_OPEN_FAILED', 502, 'The channel could not be opened, and nothing was spent.']);
	assert.deepEqual(events(h, 'error'), [{ code: 'CHANNEL_OPEN_FAILED', message: 'The channel could not be opened, and nothing was spent.', channelId: events(h, 'error')[0].channelId }]);
	assert.equal(logged.some((line) => /the peer said no/i.test(line)), true);

	h.ln.opts.openFails = null;
	const { pendingChannelId: id } = await h.call('POST /channels/open', openBody(asset), 'open-key');
	h.ln.confirm(id);
	await h.host.pass({ block: true });
	h.ln.opts.closeFails = 'ERR_BEIGNET_LN_CHANNEL';
	const close = await refused(h.call('POST /channels/close', { channelId: id }));
	assert.deepEqual([close.extensionCode, close.status, close.message], ['CHANNEL_CLOSE_FAILED', 502, 'The channel could not be closed. Try again in a moment.']);
	assert.equal(logged.some((line) => line.includes('2 htlcs in flight')), true);
	assert.equal(JSON.stringify([open.message, close.message, h.events]).includes('htlcs'), false);
});

test('a funding flow nobody confirmed that cannot be cancelled at start is not carried on in that pass', async () => {
	const { h, asset } = await funded();
	const id = 'aa'.repeat(32);
	h.ln.plant(id, { assetId: asset.assetId, local: 100n });
	h.ln.opts.cancelFails = true;
	const again = h.restart();
	made.push(again);
	const before = named(again, 'resume').length;
	await again.boot();
	await again.host.pass({ block: true });
	// It could sign if it were carried on, so nothing is, and nothing new is begun.
	assert.equal(named(again, 'resume').length, before);
	assert.deepEqual(await codeOf(again.call('POST /channels/quote', openBody(asset))), ['ASSETS_STARTING', 503]);
	again.ln.opts.cancelFails = false;
	await again.host.pass({ block: true });
	assert.equal(again.ln.flows.has(id), false);
	assert.equal(named(again, 'resume').length > before, true);
	assert.equal((await again.call('POST /channels/quote', openBody(asset))).channelSats, 100000);
});

/* ------------------------------------------------------------------- close */

test('closing with the peer: CLOSING until the assets are back on-chain, then gone from the list', async () => {
	const { h, id, channel } = await channelled();
	const answer = await h.call('POST /channels/close', { channelId: channel.channelId, force: false });
	assert.deepEqual(answer, { channelId: channel.channelId, closing: true, force: false });
	assert.deepEqual(named(h, 'closeChannel'), [['closeChannel', channel.channelId, false]]);
	// Closed for the engine, and not over: its assets are not home yet.
	assert.equal((await h.get('/channels')).channels[0].state, 'CLOSING');
	assert.deepEqual((await h.get('/balances')).assets[0].balance, {
		total: '1000',
		onchain: '400',
		pendingIn: '0',
		pendingOut: '0',
		channelLocal: '600',
		lightningSendable: '0',
		lightningReceivable: '0'
	});
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${id}`]);
	// A second close of it is still found: it is not over.
	assert.equal((await h.call('POST /channels/close', { channelId: id, force: false })).closing, true);

	h.ln.recover(id);
	await h.host.pass({ block: true });
	assert.deepEqual(await h.get('/channels'), { channels: [] });
	assert.deepEqual((await h.get('/balances')).assets[0].balance.onchain, '1000');
	assert.deepEqual((await h.get('/balances')).assets[0].balance.channelLocal, '0');
	// Nothing is left for a restart to carry on, and it is no longer a channel to close.
	assert.deepEqual(keys(h, 'committed/funding:'), []);
	assert.deepEqual(await codeOf(h.call('POST /channels/close', { channelId: channel.channelId })), ['CHANNEL_NOT_FOUND', 404]);
	assert.deepEqual(events(h, 'channel').map((e) => e.state).slice(-2), ['CLOSING', 'CLOSED']);
});

test('closing without the peer: FORCE_CLOSING, then FORCE_CLOSED for a day', async () => {
	const { h, id, channel } = await channelled();
	const answer = await h.call('POST /channels/close', { channelId: channel.channelId, force: true });
	assert.deepEqual(answer, { channelId: channel.channelId, closing: true, force: true });
	assert.equal((await h.get('/channels')).channels[0].state, 'FORCE_CLOSING');
	h.ln.recover(id);
	await h.host.pass({ block: true });
	const listed = (await h.get('/channels')).channels[0];
	assert.deepEqual([listed.state, listed.sendable, listed.receivable], ['FORCE_CLOSED', '0', '0']);
	assert.deepEqual((await h.get('/balances')).assets[0].balance.channelLocal, '0');
	h.clock.t += lightning.FORCE_CLOSED_SHOWN_MS + 1;
	assert.deepEqual(await h.get('/channels'), { channels: [] });
});

test('closing: an id this wallet does not know, and an open that has signed nothing', async () => {
	const { h, asset } = await funded();
	for (const channelId of ['ab'.repeat(32), 'nonsense', '', undefined]) {
		const err = await refused(h.call('POST /channels/close', { channelId }));
		assert.deepEqual([err.extensionCode, err.status, err.message], ['CHANNEL_NOT_FOUND', 404, 'This wallet has no asset channel with that id.']);
	}
	// An open still waiting for the peer is dropped, and nothing is spent.
	h.ln.opts.openHangs = true;
	h.cfg.openWaitMs = 10;
	const { pendingChannelId: id } = await h.call('POST /channels/open', openBody(asset), 'open-key');
	const dropped = await h.call('POST /channels/close', { channelId: id, force: false });
	assert.deepEqual(dropped, { channelId: id, closing: true, force: false });
	assert.deepEqual(named(h, 'closeChannel'), []);
	assert.deepEqual(keys(h, 'chan/'), []);
	assert.deepEqual(keys(h, 'committed/funding:'), []);
	assert.deepEqual(await h.get('/channels'), { channels: [] });
	assert.deepEqual(events(h, 'channel').map((e) => e.state), ['OPENING', 'CLOSED']);
});

test('a wallet whose asset channels are off still lists, closes and recovers a channel it has', async () => {
	const { h, id, channel } = await channelled();
	h.host.shutdown();
	h.host.ln.close();
	const off = world({ lightning: true, shared: h.world, env: { BEIGNET_ASSETS_LIGHTNING: 'off' } });
	await off.boot();
	assert.deepEqual((await off.get('/status')).lightning, { mode: 'off', usableChannels: 1 });
	const listed = (await off.get('/channels')).channels;
	assert.deepEqual(listed.map((c) => [c.channelId, c.state]), [[channel.channelId, 'NORMAL']]);
	// Nothing new: no invoice, no payment, no open.
	assert.deepEqual(await codeOf(off.call('POST /invoices/quote', { key: channel.asset.key, amount: '1' })), ['LIGHTNING_UNAVAILABLE', 409]);
	assert.deepEqual(await codeOf(off.call('POST /pay/quote', { bolt11: fakeInvoice({ msat: 1000 }), key: channel.asset.key })), ['LIGHTNING_UNAVAILABLE', 409]);
	assert.deepEqual(await codeOf(off.call('POST /channels/open', openBody(channel.asset, '100'), 'another')), ['LIGHTNING_UNAVAILABLE', 409]);
	// But it closes, and the loop brings the assets home.
	assert.equal((await off.call('POST /channels/close', { channelId: channel.channelId, force: false })).closing, true);
	assert.ok(named(off, 'resumeRecovery').length >= 1);
	off.ln.recover(id);
	await off.host.pass({ block: true });
	assert.deepEqual(await off.get('/channels'), { channels: [] });
	assert.equal((await off.get('/balances')).assets[0].balance.onchain, '1000');
});

/* ---------------------------------------------------------------- invoices */

test('an invoice quote from a peer that sets no price: one unit to the sat, and no rate', async () => {
	const { h, asset, channel } = await channelled({ remote: 200n });
	const quote = await h.call('POST /invoices/quote', { key: asset.key, amount: '150' });
	assert.match(quote.quoteId, /^[0-9a-f]{64}$/);
	assert.deepEqual(quote, {
		quoteId: quote.quoteId,
		peerPubkey: PEER.pubkey,
		peerAlias: 'edge',
		assetAmount: '150',
		amountSats: 150,
		rateText: '',
		priced: false,
		expiresAt: h.clock.t + 60000,
		maxReceivable: '200'
	});
	// The price is asked to stand for as long as an invoice may live. The peer gives a minute.
	assert.deepEqual(named(h, 'quoteInvoice')[0][1], { assetId: asset.assetId, groupKey: null, amount: 150n, peerPubkey: channel.peerPubkey, expirySeconds: 3600 });
	assert.deepEqual(keys(h, 'l-quote/'), [`h/l-quote/${quote.quoteId}`]);
});

test('an invoice quote from a peer that prices: the sats and the rate as a sentence', async () => {
	const { h, asset } = await channelled({ remote: 200n });
	// 4,000,000 units a bitcoin: with two decimals, a coin is 2,500 sats.
	h.ln.opts.rate = { coefficient: 4_000_000n, scale: 0 };
	const quote = await h.call('POST /invoices/quote', { key: asset.key, amount: '150' });
	assert.deepEqual([quote.priced, quote.rateText, quote.amountSats], [true, '1 coin = 2,500 sats', 3750]);
});

test('an invoice quote refuses what no channel can receive', async () => {
	const { h, asset } = await channelled({ remote: 200n });
	const short = await refused(h.call('POST /invoices/quote', { key: asset.key, amount: '201' }));
	assert.deepEqual([short.extensionCode, short.status, short.details], ['INSUFFICIENT_INBOUND', 409, { maxReceivable: '200' }]);
	assert.deepEqual(named(h, 'quoteInvoice'), []);
	assert.deepEqual(await codeOf(h.call('POST /invoices/quote', { key: asset.key, amount: 'many' })), ['BAD_AMOUNT', 400]);
	assert.deepEqual(await codeOf(h.call('POST /invoices/quote', { key: 'cd'.repeat(32), amount: '1' })), ['ASSET_NOT_FOUND', 404]);
	// A peer that answers with no price.
	h.ln.opts.quoteFails = 'ERR_BEIGNET_LN_NO_QUOTE';
	const silent = await refused(h.call('POST /invoices/quote', { key: asset.key, amount: '150' }));
	assert.deepEqual([silent.extensionCode, silent.status], ['PEER_GAVE_NO_PRICE', 502]);
	assert.equal('details' in silent, false);
	// A channel that is not open yet receives nothing.
	const fresh = await funded();
	await fresh.h.call('POST /channels/open', openBody(fresh.asset), 'open-key');
	const none = await refused(fresh.h.call('POST /invoices/quote', { key: fresh.asset.key, amount: '1' }));
	assert.deepEqual([none.extensionCode, none.details], ['INSUFFICIENT_INBOUND', { maxReceivable: '0' }]);
});

test('an invoice: made at the quoted price, listed, and a row that waits to be paid', async () => {
	const { h, asset } = await channelled({ remote: 200n });
	const quote = await h.call('POST /invoices/quote', { key: asset.key, amount: '150' });
	const invoice = await h.call('POST /invoices', { key: asset.key, amount: '150', description: ' tea ', quoteId: quote.quoteId });
	const { row, ...rest } = invoice;
	assert.deepEqual(rest, {
		bolt11: invoice.bolt11,
		paymentHash: invoice.paymentHash,
		assetAmount: '150',
		amountSats: 150,
		rateText: '',
		priced: false,
		expiresAt: quote.expiresAt,
		invoiceExpiresAt: h.clock.t + 60000,
		description: 'tea',
		asset: { key: asset.key, assetId: asset.assetId, name: 'coin', type: 'normal', decimalDisplay: 2 },
		status: 'OPEN',
		receivedAmount: null,
		createdAt: h.clock.t
	});
	assert.match(invoice.bolt11, /^lnbcrt1/);
	assert.deepEqual(
		[row.id, row.kind, row.state, row.failed, row.paymentHash, row.assets],
		[`ln-receive-${invoice.paymentHash}`, 'ln-receive', 'waiting', false, invoice.paymentHash, [{ key: asset.key, assetId: asset.assetId, name: 'coin', type: 'normal', decimalDisplay: 2, amount: '150' }]]
	);
	// The invoice is given the time its price has left, and no more.
	assert.deepEqual(named(h, 'createInvoice')[0][1], { quoteId: quote.quoteId, description: 'tea', expirySeconds: 60 });
	assert.deepEqual(await h.get('/invoices'), { invoices: [rest] });
	assert.deepEqual(events(h, 'invoice').map((e) => [e.row.id, e.row.state]), [[row.id, 'waiting']]);
	// It is in the activity, and found by its id like any other row.
	assert.deepEqual((await h.get('/activity', 'kind=ln-receive')).rows.map((r) => r.id), [row.id]);
	assert.equal(h.host.findRow(row.id).kind, 'ln-receive');
	// A price is used once.
	assert.deepEqual(keys(h, 'l-quote/'), []);
	assert.deepEqual(await codeOf(h.call('POST /invoices', { key: asset.key, amount: '150', quoteId: quote.quoteId })), ['QUOTE_EXPIRED', 410]);
});

test('an invoice is refused when its price has run out, or was given for something else', async () => {
	const { h, asset } = await channelled({ remote: 200n });
	const make = (body) => refused(h.call('POST /invoices', { key: asset.key, amount: '150', ...body }));
	const expired = (err) => assert.deepEqual([err.extensionCode, err.status, err.message], ['QUOTE_EXPIRED', 410, 'That price has expired. Ask for a new one.']);
	expired(await make({ quoteId: 'ab'.repeat(32) }));
	expired(await make({ quoteId: undefined }));
	const quote = await h.call('POST /invoices/quote', { key: asset.key, amount: '150' });
	expired(await make({ quoteId: quote.quoteId, amount: '160' }));
	expired(await make({ quoteId: quote.quoteId, key: 'cd'.repeat(32) }));
	const long = await make({ quoteId: quote.quoteId, description: 'x'.repeat(201) });
	assert.deepEqual([long.extensionCode, long.status], ['INVALID_PARAMS', 400]);
	h.clock.t += 60001;
	expired(await make({ quoteId: quote.quoteId }));
	assert.deepEqual(named(h, 'createInvoice'), []);
	assert.deepEqual(await h.get('/invoices'), { invoices: [] });
});

test('an invoice that is paid: the row completes, the list says PAID, and the balance moves', async () => {
	const { h, asset } = await channelled({ remote: 200n });
	const quote = await h.call('POST /invoices/quote', { key: asset.key, amount: '150' });
	const invoice = await h.call('POST /invoices', { key: asset.key, amount: '150', quoteId: quote.quoteId });
	const before = events(h, 'balance').length;
	h.ln.settle(invoice.paymentHash);
	await h.host.pass();
	const row = (await h.get('/activity', 'kind=ln-receive')).rows[0];
	assert.deepEqual([row.state, row.failed, row.at.completed], ['complete', false, h.clock.t]);
	assert.equal((await h.get('/invoices')).invoices[0].status, 'PAID');
	assert.deepEqual(events(h, 'invoice').map((e) => e.row.state), ['waiting', 'complete']);
	assert.deepEqual(events(h, 'balance').slice(before), [{ key: asset.key }]);
	const channel = (await h.get('/channels')).channels[0];
	assert.deepEqual([channel.localBalance, channel.remoteBalance], ['550', '50']);
	assert.deepEqual((await h.get('/balances')).assets[0].balance, {
		total: '950',
		onchain: '400',
		pendingIn: '0',
		pendingOut: '0',
		channelLocal: '550',
		lightningSendable: '550',
		lightningReceivable: '50'
	});
	// Looking again changes nothing and says nothing.
	const said = h.events.length;
	await h.host.pass();
	assert.equal(h.events.length, said);
});

test('an invoice nobody paid runs out with its price', async () => {
	const { h, asset } = await channelled({ remote: 200n });
	const quote = await h.call('POST /invoices/quote', { key: asset.key, amount: '150' });
	await h.call('POST /invoices', { key: asset.key, amount: '150', quoteId: quote.quoteId });
	h.clock.t = quote.expiresAt + 1;
	assert.equal((await h.get('/invoices')).invoices[0].status, 'EXPIRED');
	await h.host.pass();
	const row = (await h.get('/activity', 'kind=ln-receive')).rows[0];
	assert.deepEqual([row.state, row.failed, row.failure], ['failed', true, { code: 'INVOICE_EXPIRED', message: 'Nobody paid this invoice before it ran out.' }]);
});

test('an invoice lives no longer than the price it was made on', async () => {
	const { h, asset } = await channelled({ remote: 200n });
	const quote = await h.call('POST /invoices/quote', { key: asset.key, amount: '150' });
	// Twenty and a half seconds of the price's sixty are gone.
	h.clock.t += 20500;
	const invoice = await h.call('POST /invoices', { key: asset.key, amount: '150', quoteId: quote.quoteId });
	assert.equal(named(h, 'createInvoice')[0][1].expirySeconds, 40);
	assert.ok(invoice.invoiceExpiresAt <= quote.expiresAt + 1000);
	// With a moment left it still gets one second, never none.
	const late = await h.call('POST /invoices/quote', { key: asset.key, amount: '10' });
	h.clock.t = late.expiresAt - 1;
	await h.call('POST /invoices', { key: asset.key, amount: '10', quoteId: late.quoteId });
	assert.equal(named(h, 'createInvoice')[1][1].expirySeconds, 1);
});

test('an invoice the node says was paid is paid, also after it was written down as run out', async () => {
	const { h, asset } = await channelled({ remote: 200n });
	const quote = await h.call('POST /invoices/quote', { key: asset.key, amount: '150' });
	const invoice = await h.call('POST /invoices', { key: asset.key, amount: '150', quoteId: quote.quoteId });
	h.clock.t = quote.expiresAt + 1;
	await h.host.pass();
	assert.equal((await h.get('/activity', 'kind=ln-receive')).rows[0].state, 'failed');
	// The payment had arrived as the invoice ran out, and the node says so a moment later.
	h.ln.settle(invoice.paymentHash);
	await h.host.pass();
	const row = (await h.get('/activity', 'kind=ln-receive')).rows[0];
	assert.deepEqual([row.state, row.failed, row.failure, row.at.completed], ['complete', false, null, h.clock.t]);
	assert.equal((await h.get('/invoices')).invoices[0].status, 'PAID');
	assert.deepEqual(events(h, 'invoice').map((e) => e.row.state), ['waiting', 'failed', 'complete']);
	assert.deepEqual((await h.get('/channels')).channels[0].localBalance, '550');
	// And it stays paid.
	const said = h.events.length;
	await h.host.pass();
	assert.equal(h.events.length, said);
});

test('a wallet takes only so many channels from peers at a time, wherever the engine says each one is', async () => {
	const { h, asset } = await funded();
	const offer = (id) => h.ln.offer({ pendingChannelId: id, assets: [{ assetId: asset.assetId, amount: 10n }] });
	// Four that peers opened and that cannot carry a payment yet, each at another step.
	const waiting = h.ln.inbound({ assetId: asset.assetId, amount: 10n, state: 'AWAITING_FUNDING_CONFIRMED' });
	h.ln.inbound({ assetId: asset.assetId, amount: 10n, state: 'AWAITING_CHANNEL_READY' });
	h.ln.set(h.ln.inbound({ assetId: asset.assetId, amount: 10n }).pendingChannelId, { confirmed: false });
	h.ln.set(h.ln.inbound({ assetId: asset.assetId, amount: 10n, state: 'SENT_ACCEPT' }).pendingChannelId, { channelId: null, signed: false });
	await h.host.pass({ block: true });
	// Each reads as opening, to the dashboard and to the count.
	assert.deepEqual((await h.get('/channels')).channels.map((c) => c.state), ['OPENING', 'OPENING', 'OPENING', 'OPENING']);
	assert.equal(await offer('01'.repeat(32)), false);
	// One of the wallet's own opens, one that is closing and one that is over do not count.
	h.ln.confirm(waiting.pendingChannelId);
	assert.equal(await offer('02'.repeat(32)), true);
	assert.equal(await offer('03'.repeat(32)), false);
	h.host.mem.accepted.clear();
	await h.call('POST /channels/open', openBody(asset, '100'), 'open-key');
	h.ln.set(h.ln.inbound({ assetId: asset.assetId, amount: 10n }).pendingChannelId, { state: 'SHUTTING_DOWN', recovery: 'pending' });
	h.ln.set(h.ln.inbound({ assetId: asset.assetId, amount: 10n }).pendingChannelId, { state: 'CLOSED', recovery: 'complete' });
	assert.equal(await offer('04'.repeat(32)), true);
	assert.equal(await offer('05'.repeat(32)), false);
});

test('a closed channel is over only once its recovery is complete', async () => {
	const { h, asset, id, channel } = await channelled();
	await h.call('POST /channels/close', { channelId: channel.channelId, force: false });
	// A library that says nothing of the recovery of a closed channel has not said it is done.
	h.ln.set(id, { state: 'CLOSED', recovery: 'none' });
	await h.host.pass({ block: true });
	assert.deepEqual((await h.get('/channels')).channels.map((c) => [c.state, c.localBalance]), [['CLOSING', '600']]);
	const { balance } = (await h.get('/balances')).assets[0];
	assert.deepEqual([balance.total, balance.onchain, balance.channelLocal], ['1000', '400', '600']);
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${id}`]);
	assert.equal(h.host.mem.summary.channels, 1);
	h.ln.set(id, { state: 'FORCE_CLOSED', recovery: 'none' });
	await h.host.pass({ block: true });
	assert.equal((await h.get('/channels')).channels[0].state, 'FORCE_CLOSING');
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${id}`]);
	// Its assets come home: now it is over.
	h.ln.recover(id);
	await h.host.pass({ block: true });
	assert.equal((await h.get('/channels')).channels[0].state, 'FORCE_CLOSED');
	assert.deepEqual(keys(h, 'committed/funding:'), []);
	assert.equal((await h.get('/balances')).assets[0].balance.total, '1000');
	assert.equal(asset.key.length > 0, true);
});

test('a recovery that keeps failing is logged, and after a while the status says so in a sentence', async () => {
	const { h, id, channel } = await channelled();
	const logged = [];
	h.host.say = (level, text) => logged.push(text);
	await h.call('POST /channels/close', { channelId: channel.channelId, force: true });
	h.ln.opts.recoveryErrors = ['sweep 4f2a of commitment 19: bad-txns-inputs-missingorspent'];
	await h.host.pass({ block: true });
	const said = logged.filter((line) => line.includes('bad-txns-inputs-missingorspent'));
	assert.equal(said.length, 1);
	assert.equal(said[0].includes(channel.channelId), true);
	// Said once, not on every look, and not yet a warning.
	await h.host.pass({ block: true });
	assert.equal(logged.filter((line) => line.includes('bad-txns-inputs-missingorspent')).length, 1);
	assert.deepEqual((await h.get('/status')).lightning, { mode: 'full', usableChannels: 0 });

	// Three blocks on (an hour, where blocks are not mined by hand) it is stuck.
	h.wallet.data.header.height += 3;
	await h.host.pass({ block: true });
	const status = await h.get('/status');
	assert.deepEqual(status.lightning, {
		mode: 'full',
		usableChannels: 0,
		warning: 'The assets of a closed channel have not come back on-chain yet. The wallet keeps trying, and its log says why.',
		// The same said with its code, so the dashboard can tell a wait from a loss.
		warnings: [{ code: 'RECOVERY_STUCK', text: 'The assets of a closed channel have not come back on-chain yet. The wallet keeps trying, and its log says why.' }]
	});
	assert.equal(JSON.stringify(status).includes('missingorspent'), false);
	assert.equal(h.events.some(([name, data]) => name === 'status' && data.lightning && data.lightning.warning), true);
	// A new reason is logged as it comes.
	h.ln.opts.recoveryErrors = ['the proof courier did not answer'];
	await h.host.pass({ block: true });
	assert.equal(logged.filter((line) => /the proof courier did not answer/i.test(line)).length, 1);

	// It gets through: the warning goes.
	h.ln.opts.recoveryErrors = [];
	h.ln.recover(id);
	await h.host.pass({ block: true });
	assert.deepEqual((await h.get('/status')).lightning, { mode: 'full', usableChannels: 0 });
});

test('what one payment can move is the most one channel can, never the sum of several', async () => {
	const { h, asset } = await channelled({ remote: 200n });
	// A second channel of the same asset: 300 on this side, 100 on the peer's.
	const second = await h.call('POST /channels/open', openBody(asset, '400'), 'second-key');
	h.ln.confirm(second.pendingChannelId);
	h.ln.move(h.ln.flow(second.pendingChannelId).channelId, -100n);
	await h.host.pass({ block: true });
	assert.deepEqual((await h.get('/channels')).channels.map((c) => [c.sendable, c.receivable]).sort(), [['300', '100'], ['400', '200']]);
	const { balance } = (await h.get('/balances')).assets[0];
	// 700 of it is in channels, and one payment can send 400 of that or receive 200.
	assert.deepEqual([balance.channelLocal, balance.lightningSendable, balance.lightningReceivable], ['700', '400', '200']);

	const tooMuchIn = await refused(h.call('POST /invoices/quote', { key: asset.key, amount: '250' }));
	assert.deepEqual([tooMuchIn.extensionCode, tooMuchIn.details], ['INSUFFICIENT_INBOUND', { maxReceivable: '200' }]);
	assert.equal((await h.call('POST /invoices/quote', { key: asset.key, amount: '150' })).maxReceivable, '200');
	const tooMuchOut = await refused(h.call('POST /pay/quote', { bolt11: fakeInvoice({ msat: 500000 }), key: asset.key }));
	assert.deepEqual([tooMuchOut.extensionCode, tooMuchOut.details], ['INSUFFICIENT_OUTBOUND', { sendable: '400' }]);
	// The price names what one payment can send, whichever channel it goes through.
	assert.equal((await h.call('POST /pay/quote', { bolt11: fakeInvoice({ msat: 50000 }), key: asset.key })).sendable, '400');
	// What a payment under way holds is not there for the next one.
	h.ln.set(h.ln.flows.keys().next().value, { reserved: 150n });
	assert.equal((await h.get('/balances')).assets[0].balance.lightningSendable, '300');
});

/* ------------------------------------------------------------------ paying */

test('a pay quote: how much of the asset the invoice takes, and what the channel can send', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const quote = await h.call('POST /pay/quote', { bolt11: `lightning:${bolt11}`, key: asset.key });
	assert.deepEqual(quote, { quoteId: quote.quoteId, assetAmount: '50', amountSats: 50, rateText: '', priced: false, peerAlias: 'edge', expiresAt: h.clock.t + 60000, sendable: '600' });
	assert.deepEqual(named(h, 'quotePayment')[0][1], { bolt11, assetId: asset.assetId, groupKey: null, amountMsat: null });
	// A peer that prices.
	h.ln.opts.rate = { coefficient: 4_000_000n, scale: 0 };
	const priced = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	assert.deepEqual([priced.assetAmount, priced.amountSats, priced.rateText, priced.priced], ['2', 50, '1 coin = 2,500 sats', true]);
	// Nothing was paid.
	assert.deepEqual(named(h, 'payInvoice'), []);
	assert.deepEqual((await h.get('/activity', 'kind=ln-send')).rows, []);
});

test('a pay quote refuses an invoice it cannot read, one with no amount, and more than a channel can send', async () => {
	const { h, asset } = await channelled();
	const q = (body) => refused(h.call('POST /pay/quote', { key: asset.key, ...body }));
	assert.deepEqual([(await q({ bolt11: '' })).extensionCode, (await q({ bolt11: 'lnbc1nonsense' })).extensionCode], ['BAD_INVOICE', 'BAD_INVOICE']);
	const blank = await q({ bolt11: fakeInvoice({}) });
	assert.deepEqual([blank.extensionCode, blank.status, blank.message], ['AMOUNT_REQUIRED', 400, 'This invoice names no amount, so one is needed.']);
	// With an amount given, it is priced.
	const given = await h.call('POST /pay/quote', { bolt11: fakeInvoice({}), key: asset.key, amountSats: 75 });
	assert.deepEqual([given.assetAmount, given.amountSats], ['75', 75]);
	assert.deepEqual((await q({ bolt11: fakeInvoice({}), amountSats: -1 })).extensionCode, 'INVALID_PARAMS');
	const big = await q({ bolt11: fakeInvoice({ msat: 601000 }) });
	assert.deepEqual([big.extensionCode, big.status, big.details], ['INSUFFICIENT_OUTBOUND', 409, { sendable: '600' }]);
	assert.deepEqual((await q({ bolt11: fakeInvoice({ msat: 1000 }), key: 'cd'.repeat(32) })).extensionCode, 'ASSET_NOT_FOUND');
	// A wallet with no usable channel for the asset is not asked for a price at all.
	const fresh = await funded();
	const none = await refused(fresh.h.call('POST /pay/quote', { bolt11: fakeInvoice({ msat: 1000 }), key: fresh.asset.key }));
	assert.deepEqual([none.extensionCode, none.details], ['INSUFFICIENT_OUTBOUND', { sendable: '0' }]);
	assert.deepEqual(named(fresh.h, 'quotePayment'), []);
});

test('paying: the key and the row are written before the library pays, and the answer says how it ended', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const quote = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	const before = events(h, 'balance').length;
	const answer = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: quote.assetAmount }, 'pay-key');
	assert.deepEqual(answer, { status: 'COMPLETED', paymentHash: answer.paymentHash, assetAmount: '50', feeSats: 2, failureDescription: null });
	const rowId = `ln-send-${answer.paymentHash}`;
	const [, paidQuote, bound, stored] = named(h, 'payInvoice')[0];
	assert.deepEqual([paidQuote, bound], [quote.quoteId, 50n]);
	assert.ok(stored.includes(`h/row/${rowId}`));
	assert.equal(stored.filter((k) => k.startsWith('h/idem/pay/')).length, 1);
	// The row the dashboard finds a lost answer by.
	const row = (await h.get('/activity', 'limit=20&kind=ln-send')).rows.find((r) => r.clientRef === 'pay-key');
	assert.deepEqual(
		[row.id, row.state, row.failed, row.paymentHash, row.feeSats, row.assets[0].amount, row.at.completed],
		[rowId, 'complete', false, answer.paymentHash, 2, '50', h.clock.t]
	);
	assert.deepEqual(events(h, 'payment').map((e) => e.row.state), ['complete']);
	assert.deepEqual(events(h, 'balance').slice(before), [{ key: asset.key }]);
	const channel = (await h.get('/channels')).channels[0];
	assert.deepEqual([channel.localBalance, channel.remoteBalance, channel.sendable, channel.receivable], ['550', '50', '550', '50']);
	// The price was used.
	assert.deepEqual(keys(h, 'l-quote/'), []);
});

test('the same request key pays once, also after a restart', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const quote = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	// A second price for the same invoice, given before it was paid.
	const spare = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	const body = { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: quote.assetAmount };
	const first = await h.call('POST /pay', body, 'pay-key');
	assert.deepEqual(await h.call('POST /pay', body, 'pay-key'), first);
	assert.equal(named(h, 'payInvoice').length, 1);
	assert.deepEqual(await codeOf(h.call('POST /pay', { ...body, maxAssetAmount: '51' }, 'pay-key')), ['IDEMPOTENCY_KEY_REUSED', 409]);
	const again = h.restart();
	made.push(again);
	await again.boot();
	assert.deepEqual(await again.call('POST /pay', body, 'pay-key'), first);
	assert.equal(named(again, 'payInvoice').length, 1);
	// Another key for an invoice already paid is refused: at the price it
	// was given before, by the library's own record of the payment, which a
	// restart did not lose. And no new price is given for it.
	const paid = await refused(again.call('POST /pay', { ...body, quoteId: spare.quoteId }, 'other-key'));
	assert.deepEqual([paid.extensionCode, paid.status, paid.message], ['ALREADY_PAID', 409, 'This wallet has already paid that invoice.']);
	const priced = await refused(again.call('POST /pay/quote', { bolt11, key: asset.key }));
	assert.deepEqual([priced.extensionCode, priced.status, priced.message], ['ALREADY_PAID', 409, 'This wallet has already paid that invoice, or is paying it now.']);
	assert.equal(named(again, 'payInvoice').length, 1);
});

test('a price that ran out or moved: nothing is paid, and the new price comes back', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const quote = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	const body = { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: quote.assetAmount };
	const nothingPaid = async () => {
		assert.deepEqual(named(h, 'payInvoice').filter((c) => c[1] !== 'moved'), []);
		assert.deepEqual((await h.get('/activity', 'kind=ln-send')).rows, []);
		assert.deepEqual(keys(h, 'idem/pay/'), []);
	};

	// More of the asset than the user agreed to: the price still stands, and is shown.
	const over = await refused(h.call('POST /pay', { ...body, maxAssetAmount: '49' }, 'pay-key'));
	assert.deepEqual([over.extensionCode, over.status, over.message], ['QUOTE_CHANGED', 409, 'The price moved before the payment was made, so nothing was paid.']);
	assert.deepEqual(over.details.quote, quote);
	await nothingPaid();

	// Run out: a new one is asked for, and comes back with its own id.
	h.clock.t += 61000;
	const late = await refused(h.call('POST /pay', body, 'pay-key'));
	assert.equal(late.extensionCode, 'QUOTE_CHANGED');
	assert.notEqual(late.details.quote.quoteId, quote.quoteId);
	assert.deepEqual(
		[late.details.quote.assetAmount, late.details.quote.amountSats, late.details.quote.expiresAt, late.details.quote.sendable],
		['50', 50, h.clock.t + 60000, '600']
	);
	await nothingPaid();

	// A quote this wallet never gave.
	const unknown = await refused(h.call('POST /pay', { ...body, quoteId: 'ab'.repeat(32) }, 'pay-key'));
	assert.equal(unknown.extensionCode, 'QUOTE_CHANGED');
	assert.match(unknown.details.quote.quoteId, /^[0-9a-f]{64}$/);
	await nothingPaid();
});

test('a peer whose price moved as the payment was made: the row and the key are taken back', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const quote = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	const body = { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: quote.assetAmount };
	h.ln.opts.payMoved = true;
	const err = await refused(h.call('POST /pay', body, 'pay-key'));
	assert.equal(err.extensionCode, 'QUOTE_CHANGED');
	assert.notEqual(err.details.quote.quoteId, quote.quoteId);
	assert.equal(named(h, 'payInvoice').length, 1);
	assert.deepEqual((await h.get('/activity', 'kind=ln-send')).rows, []);
	assert.deepEqual(keys(h, 'idem/pay/'), []);
	assert.deepEqual(events(h, 'payment'), []);
	// The same key pays at the new price.
	h.ln.opts.payMoved = false;
	const paid = await h.call('POST /pay', { ...body, quoteId: err.details.quote.quoteId }, 'pay-key');
	assert.equal(paid.status, 'COMPLETED');
});

test('a payment the node says failed is worded by the host, and can be tried again with a new key', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const quote = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	h.ln.opts.payStatus = 'failed';
	// The engine gave no reason, and the library's record says so in its own words.
	h.ln.opts.payFailure = null;
	const answer = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: '50' }, 'pay-key');
	const said = 'The payment did not go through, so nothing was paid.';
	assert.deepEqual(answer, { status: 'FAILED', paymentHash: answer.paymentHash, assetAmount: '50', feeSats: null, failureDescription: said });
	const row = (await h.get('/activity', 'kind=ln-send')).rows[0];
	assert.deepEqual([row.state, row.failed, row.failure], ['failed', true, { code: 'PAYMENT_FAILED', message: said }]);
	assert.equal(h.logs.some(([, text]) => /a Lightning payment failed/.test(text)), false);
	// Nothing left the channel.
	assert.equal((await h.get('/channels')).channels[0].localBalance, '600');

	// A reason the engine wrote is not passed on: it is logged, and the caller gets the host's sentence.
	h.ln.opts.payFailure = 'htlc 7 failed at 03aa: temporary_channel_failure (0x1007)';
	const second = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	const odd = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: second.quoteId, maxAssetAmount: '50' }, 'second-key');
	assert.deepEqual([odd.status, odd.failureDescription], ['FAILED', said]);
	assert.equal(JSON.stringify(await h.get('/activity', 'kind=ln-send')).includes('temporary_channel_failure'), false);
	assert.equal(h.logs.some(([, text]) => /a Lightning payment failed: .*temporary_channel_failure/.test(text)), true);

	h.ln.opts.payStatus = 'complete';
	const third = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	const paid = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: third.quoteId, maxAssetAmount: '50' }, 'third-key');
	assert.equal(paid.status, 'COMPLETED');
	assert.equal((await h.get('/activity', 'kind=ln-send')).rows.length, 1);
});

test('a payment the node took, though the call that made it gave up, ends as the node says', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const quote = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	const other = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	const body = { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: '50' };
	// The node has the payment, and the call that handed it over throws all
	// the same, with a code that is not one of the library's refusals. The
	// library says it never does that. The host does not lean on it.
	h.ln.opts.payThrowsAfter = 'ERR_BEIGNET_LN_TIMEOUT';
	h.cfg.payWaitMs = 10;
	const answer = await h.call('POST /pay', body, 'pay-key');
	assert.deepEqual([answer.status, answer.failureDescription], ['PENDING', null]);
	await h.host.pass();
	assert.equal((await h.get('/activity', 'kind=ln-send')).rows[0].state, 'pending');
	// It is in flight: the same invoice is not paid a second time, at a
	// price given before, and no new price is given for it.
	assert.deepEqual(await codeOf(h.call('POST /pay', { ...body, quoteId: other.quoteId }, 'other-key')), ['PAYMENT_IN_FLIGHT', 409]);
	assert.deepEqual(await codeOf(h.call('POST /pay/quote', { bolt11, key: asset.key })), ['ALREADY_PAID', 409]);

	h.ln.finish(answer.paymentHash, 'complete');
	await h.host.pass();
	const row = (await h.get('/activity', 'kind=ln-send')).rows[0];
	assert.deepEqual([row.state, row.failed, row.failure, row.feeSats], ['complete', false, null, 2]);
	assert.equal((await h.call('POST /pay', body, 'pay-key')).status, 'COMPLETED');
	assert.equal(named(h, 'payInvoice').length, 1);
	assert.equal((await h.get('/channels')).channels[0].localBalance, '550');
});

test('a wallet stopped while a payment is on its way writes nothing of how it ended, and the next start settles it', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const quote = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	const body = { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: '50' };
	h.ln.opts.payStatus = 'pending';
	h.cfg.payWaitMs = 30000;
	const asked = h.call('POST /pay', body, 'pay-key');
	for (let i = 0; i < 100 && named(h, 'payInvoice').length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
	await new Promise((r) => setTimeout(r, 20));
	// The daemon stops: the service is closed, and can no longer be asked.
	h.host.shutdown();
	const answer = await asked;
	assert.equal(answer.status, 'PENDING');
	const stored = JSON.parse(h.storage.get(`h/row/ln-send-${answer.paymentHash}`));
	assert.deepEqual([stored.state, stored.failure], ['pending', null]);

	const again = h.restart();
	made.push(again);
	await again.boot();
	assert.equal((await again.get('/activity', 'kind=ln-send')).rows[0].state, 'pending');
	again.ln.finish(answer.paymentHash, 'complete');
	await again.host.pass();
	assert.equal((await again.get('/activity', 'kind=ln-send')).rows[0].state, 'complete');
	assert.equal((await again.call('POST /pay', body, 'pay-key')).status, 'COMPLETED');
	assert.equal(named(again, 'payInvoice').length, 1);
});

test('only a refusal the library makes before sending says nothing was sent', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const payWith = async (code, key) => {
		h.ln.opts.payFails = code;
		const quote = await h.call('POST /pay/quote', { bolt11, key: asset.key });
		const answer = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: '50' }, key);
		h.ln.opts.payFails = null;
		return answer;
	};
	// Refused before anything left: failed at once, in the host's words.
	const short = await payWith('ERR_BEIGNET_LN_INSUFFICIENT_OUTBOUND', 'first-key');
	assert.deepEqual([short.status, short.failureDescription], ['FAILED', 'No asset channel of this wallet can send that much.']);
	assert.deepEqual((await h.get('/activity', 'kind=ln-send')).rows[0].failure, { code: 'INSUFFICIENT_OUTBOUND', message: 'No asset channel of this wallet can send that much.' });

	// Anything else may have left. The row waits for the node's own record.
	const unsure = await payWith('ERR_BEIGNET_LN_PEER_OFFLINE', 'second-key');
	assert.deepEqual([unsure.status, unsure.failureDescription], ['PENDING', null]);
	await h.host.pass();
	assert.equal((await h.get('/activity', 'kind=ln-send')).rows[0].state, 'pending');
	// The node has no record of it and nobody is sending it: after a while that is taken to mean it never left.
	h.clock.t += 31000;
	await h.host.pass();
	const row = (await h.get('/activity', 'kind=ln-send')).rows[0];
	assert.deepEqual([row.state, row.failure], ['failed', { code: 'PAYMENT_NOT_SENT', message: 'This payment was never sent, so nothing was paid.' }]);

	// And that is taken back the moment the node turns out to have it after all.
	h.ln.payments.set(row.paymentHash, { paymentHash: row.paymentHash, assetAmount: 50n, status: 'pending', feeMsat: null, failure: null, channelId: (await h.get('/channels')).channels[0].channelId });
	await h.host.pass();
	assert.deepEqual([(await h.get('/activity', 'kind=ln-send')).rows[0].state, (await h.get('/activity', 'kind=ln-send')).rows[0].failure], ['pending', null]);
	h.ln.finish(row.paymentHash, 'complete');
	await h.host.pass();
	assert.equal((await h.get('/activity', 'kind=ln-send')).rows[0].state, 'complete');
});

test('before an invoice is paid again after a failure, the node is asked what became of it', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const quote = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	h.ln.opts.payStatus = 'failed';
	const first = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: '50' }, 'pay-key');
	assert.equal(first.status, 'FAILED');
	h.ln.opts.payStatus = 'complete';
	// A new price is given while the record says failed. What the record
	// says by the time the price is used is what counts.
	const retry = async (key, status) => {
		h.ln.payments.get(first.paymentHash).status = 'failed';
		const again = await h.call('POST /pay/quote', { bolt11, key: asset.key });
		h.ln.payments.get(first.paymentHash).status = status;
		return codeOf(h.call('POST /pay', { bolt11, key: asset.key, quoteId: again.quoteId, maxAssetAmount: '50' }, key));
	};
	// The row says failed, and the node says it is still trying, or that it got through.
	assert.deepEqual(await retry('second-key', 'pending'), ['PAYMENT_IN_FLIGHT', 409]);
	assert.deepEqual(await retry('third-key', 'complete'), ['ALREADY_PAID', 409]);
	assert.equal(named(h, 'payInvoice').length, 1);
	// A node that cannot be asked is not taken to have said no.
	const real = h.host.ln.payment;
	h.host.ln.payment = () => {
		throw Object.assign(new Error('not ready'), { code: 'ERR_BEIGNET_LN_NOT_READY' });
	};
	assert.deepEqual(await retry('fourth-key', 'failed'), ['ASSETS_STARTING', 503]);
	h.host.ln.payment = real;
	assert.equal(named(h, 'payInvoice').length, 1);
});

test('opening a channel and paying an invoice need a request key', async () => {
	const { h, asset } = await channelled();
	const open = await refused(h.call('POST /channels/open', openBody(asset, '100')));
	assert.deepEqual([open.extensionCode, open.status], ['IDEMPOTENCY_KEY_REQUIRED', 400]);
	assert.equal(open.message, 'This request needs an X-Idempotency-Key header, so that sending it twice does not open two channels.');
	const bolt11 = fakeInvoice({ msat: 50000 });
	const quote = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	const pay = await refused(h.call('POST /pay', { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: '50' }));
	assert.deepEqual([pay.extensionCode, pay.status], ['IDEMPOTENCY_KEY_REQUIRED', 400]);
	assert.equal(pay.message, 'This request needs an X-Idempotency-Key header, so that sending it twice does not pay twice.');
	assert.equal(named(h, 'openChannel').length, 1);
	assert.deepEqual(named(h, 'payInvoice'), []);
	assert.deepEqual(keys(h, 'row/ln-send-'), []);
});

test('a payment still on its way is answered as pending, and settled by the loop', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const quote = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	const other = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	h.ln.opts.payStatus = 'pending';
	h.cfg.payWaitMs = 10;
	const body = { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: '50' };
	const answer = await h.call('POST /pay', body, 'pay-key');
	assert.deepEqual(answer, { status: 'PENDING', paymentHash: answer.paymentHash, assetAmount: '50', feeSats: null, failureDescription: null });
	assert.equal((await h.get('/activity', 'kind=ln-send')).rows[0].state, 'pending');
	// Asked again with the same key: the same payment, not another.
	assert.equal((await h.call('POST /pay', body, 'pay-key')).status, 'PENDING');
	// A second payment of the same invoice is not begun while this one is out.
	assert.deepEqual(await codeOf(h.call('POST /pay', { ...body, quoteId: other.quoteId }, 'other-key')), ['PAYMENT_IN_FLIGHT', 409]);
	assert.equal(named(h, 'payInvoice').length, 1);

	h.ln.finish(answer.paymentHash, 'complete');
	await h.host.pass();
	const row = (await h.get('/activity', 'kind=ln-send')).rows[0];
	assert.deepEqual([row.state, row.feeSats], ['complete', 2]);
	assert.equal((await h.call('POST /pay', body, 'pay-key')).status, 'COMPLETED');
	assert.deepEqual(events(h, 'payment').map((e) => e.row.state), ['pending', 'complete']);
});

test('a restart between the row and the payment: the node has no record of it, and after a while the row says it never left', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const quote = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	// The library never answers, and the process dies.
	h.host.ln.payInvoice = () => new Promise(() => undefined);
	h.cfg.payWaitMs = 10;
	const body = { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: '50' };
	// The request does not wait for ever on a library that says nothing.
	assert.equal((await h.call('POST /pay', body, 'pay-key')).status, 'PENDING');
	assert.equal(keys(h, 'row/ln-send-').length, 1);
	// While the library still has the call, the loop leaves its row alone, however long it takes.
	h.clock.t += 60000;
	await h.host.pass();
	assert.equal((await h.get('/activity', 'kind=ln-send')).rows[0].state, 'pending');

	const again = h.restart();
	made.push(again);
	await again.boot();
	const row = (await again.get('/activity', 'kind=ln-send')).rows[0];
	assert.deepEqual([row.state, row.failure], ['failed', { code: 'PAYMENT_NOT_SENT', message: 'This payment was never sent, so nothing was paid.' }]);
	const replay = await again.call('POST /pay', body, 'pay-key');
	assert.deepEqual([replay.status, replay.failureDescription], ['FAILED', 'This payment was never sent, so nothing was paid.']);
});

test('until the chain is known to be the wallet\'s, nothing is carried on, brought back or opened', async () => {
	const { h, id, channel } = await channelled();
	await h.call('POST /channels/close', { channelId: channel.channelId, force: true });
	h.host.shutdown();
	h.host.ln.close();
	h.ln.calls.length = 0;
	let answer = new Error("The wallet's Electrum server has not said which chain it is on");
	const waiting = world({
		lightning: true,
		shared: h.world,
		chainCheck: async () => {
			if (answer) throw answer;
		}
	});
	await waiting.boot();
	await waiting.host.pass({ block: true });
	assert.equal((await waiting.get('/status')).ready, false);
	// Nothing that signs was asked of the library.
	assert.deepEqual(named(waiting, 'resume'), []);
	assert.deepEqual(named(waiting, 'resumeRecovery'), []);
	// What the wallet has is still listed, as it is, and nothing new is begun.
	assert.deepEqual((await waiting.get('/channels')).channels.map((c) => c.state), ['FORCE_CLOSING']);
	assert.deepEqual(await codeOf(waiting.call('POST /channels/quote', { key: channel.asset.key, amount: '1', feeRate: 2 })), ['ASSETS_STARTING', 503]);
	assert.deepEqual(await codeOf(waiting.call('POST /pay/quote', { bolt11: fakeInvoice({ msat: 1000 }), key: channel.asset.key })), ['ASSETS_STARTING', 503]);
	assert.equal(await waiting.ln.offer({ pendingChannelId: '01'.repeat(32), peerPubkey: PEER.pubkey, assets: [{ assetId: channel.asset.assetId, amount: 1n }] }), false);
	assert.deepEqual(named(waiting, 'settleFundingReservations'), []);

	// Once it is, the loop carries on where it was.
	answer = null;
	await waiting.host.pass({ block: true });
	assert.equal(named(waiting, 'resume').length, 1);
	assert.equal(named(waiting, 'resumeRecovery').length, 1);
	waiting.ln.recover(id);
	await waiting.host.pass({ block: true });
	assert.deepEqual((await waiting.get('/channels')).channels.map((c) => c.state), ['FORCE_CLOSED']);
});

/* ------------------------------------------------- what the library is told */

test('a channel a peer offers is taken only when asset channels are on, for an asset its proof server knows', async () => {
	const { h, asset } = await funded();
	const offer = (id, assetId = asset.assetId) => h.ln.offer({ pendingChannelId: id, assets: [{ assetId, amount: 10n }] });
	assert.equal(await offer('01'.repeat(32)), true);
	// One the proof server has never heard of is turned down.
	assert.equal(await offer('02'.repeat(32), 'ee'.repeat(32)), false);
	assert.equal(await offer('03'.repeat(32), 'not hex'), false);
	assert.equal(await h.ln.offer({ pendingChannelId: '04'.repeat(32), peerPubkey: PEER.pubkey, assets: [] }), false);
	// Four at a time, and no more until one is open.
	for (const n of ['05', '06', '07']) assert.equal(await offer(n.repeat(32)), true);
	assert.equal(await offer('08'.repeat(32)), false);
	// The same offer asked again is still the same one.
	assert.equal(await offer('01'.repeat(32)), true);

	const off = world({ lightning: true, env: { BEIGNET_ASSETS_LIGHTNING: 'off' } });
	await off.boot();
	assert.equal(await off.ln.offer({ pendingChannelId: '09'.repeat(32), peerPubkey: PEER.pubkey, assets: [{ assetId: asset.assetId, amount: 10n }] }), false);
});

test('a channel a peer opened shows what it holds, though the wallet has none of the asset on-chain', async () => {
	const { h, asset } = await funded();
	// All of it is sent away on-chain first, by spending the record.
	for (const r of h.tap.records) r.spent = true;
	await h.host.pass({ block: true });
	assert.deepEqual((await h.get('/balances')).assets, []);
	const flow = h.ln.inbound({ assetId: asset.assetId, amount: 300n });
	await h.host.pass({ block: true });
	const { channels } = await h.get('/channels');
	assert.deepEqual(
		[channels[0].channelId, channels[0].state, channels[0].localBalance, channels[0].receivable, channels[0].asset.name, channels[0].peerAlias],
		[flow.channelId, 'NORMAL', '0', '300', 'coin', null]
	);
	const held = (await h.get('/balances')).assets;
	assert.deepEqual(held.map((a) => [a.key, a.name, a.balance.total, a.balance.onchain, a.balance.lightningReceivable]), [[asset.key, 'coin', '0', '0', '300']]);
	// A wallet whose only asset is in a channel still holds assets.
	assert.equal((await h.get('/status')).holdsAssets, true);
	assert.deepEqual(events(h, 'channel').pop(), { channelId: flow.channelId, state: 'NORMAL' });
});

test('the library is handed the adapter, the proof server and the host callbacks, each outside the lock', async () => {
	const { h, asset } = await funded();
	// What the host hands the glue.
	const options = lightning.startOptions(h.host);
	assert.deepEqual(Object.keys(options).sort(), ['acceptIncoming', 'adapter', 'confirmations', 'fetchGroupProof', 'fetchProof', 'lib', 'onError', 'onEvent', 'quiet']);
	assert.equal(options.adapter, h.tap);
	assert.equal(options.lib, h.host.lib);
	// What buries a transaction for good is the wallet's own measure: one block on regtest.
	assert.equal(options.confirmations, h.cfg.minConfirmations);
	// And what the glue made of it for the library: its own names, and no forwarding.
	const given = h.ln.state.options;
	assert.deepEqual(Object.keys(given).sort(), ['acceptIncoming', 'confirmationDepth', 'fetchProvenance', 'groupProofResolver', 'now', 'onError', 'onEvent']);
	assert.equal(given.confirmationDepth, 1);
	// The issuance that created a group comes from the wallet's own proof server too, as bytes.
	const groupFile = await given.groupProofResolver(`02${'9c'.repeat(32)}`);
	assert.ok(Buffer.isBuffer(groupFile));
	assert.deepEqual(h.world.fetched.pop(), { uri: 'universerpc://universe.example.com:10029', groupKey: `02${'9c'.repeat(32)}` });
	assert.equal(h.ln.state.adapter, h.tap);
	assert.equal(given.now(), BigInt(Math.floor(h.clock.t / 1000)));
	// A proof is fetched from the wallet's own proof server.
	const locator = { assetId: asset.assetId, scriptKey: `02${'11'.repeat(32)}`, anchorOutPoint: `${'22'.repeat(32)}:0` };
	const file = await options.fetchProof(locator);
	assert.ok(Buffer.isBuffer(file));
	assert.deepEqual(h.world.fetched.pop(), { uri: 'universerpc://universe.example.com:10029', locator });
	// The library asks with a proof, and is handed the file decoded.
	const decoded = await given.fetchProvenance({ ...locator, more: 'of the proof' });
	assert.deepEqual(h.world.fetched.pop(), { uri: 'universerpc://universe.example.com:10029', locator });
	assert.equal(decoded.decoded.assetId, asset.assetId);
	// Called from inside a section of the host, a callback still starts outside it.
	const seen = [];
	await h.host.lock.run(async () => {
		assert.equal(h.host.lock.held(), true);
		const real = h.host.courierFor;
		h.host.courierFor = (uri) => {
			seen.push(h.host.lock.held());
			return real(uri);
		};
		await given.fetchProvenance(locator);
		h.host.courierFor = real;
	});
	assert.deepEqual(seen, [false]);
	// An event is a reason to look, and never throws back into the library.
	for (const event of [{ type: 'channel' }, { type: 'channel', error: 'the peer said no' }, { type: 'invoice' }, { type: 'payment' }, { type: 'recovery' }, {}, null]) given.onEvent(event);
	// What goes wrong where nobody waits is logged, the same words once.
	const before = h.logs.length;
	given.onError(new Error('peer 03aa sent a message of type 52001 that could not be read'));
	given.onError(new Error('peer 03aa sent a message of type 52001 that could not be read'));
	assert.deepEqual(h.logs.slice(before).map(([level, text]) => [level, /message of type 52001/.test(text)]), [['warn', true]]);
});

/* ------------------------------------------- what the library's list says */

test('a signed funding the library gives up as unable to confirm is over: said once, its units free again, and its key too', async () => {
	const { h, asset } = await funded();
	const answer = await h.call('POST /channels/open', openBody(asset), 'open-key');
	const id = answer.pendingChannelId;
	const channelId = h.ln.flow(id).channelId;
	await h.host.pass({ block: true });
	assert.equal(h.host.mem.summary.channels, 1);
	// An input of the funding is spent by another transaction, buried for
	// good. The library gives the funding up and releases what it set aside.
	// The daemon stops before the library's event is sent: the list is all
	// there is to read, and the engine still holds the dead channel.
	h.ln.abandon(id, undefined, { silent: true });
	await h.host.pass({ block: true });
	assert.deepEqual(await h.get('/channels'), { channels: [] });
	assert.equal(h.host.mem.summary.channels, 0);
	const { balance } = (await h.get('/balances')).assets[0];
	assert.deepEqual([balance.total, balance.onchain, balance.channelLocal], ['1000', '1000', '0']);
	assert.deepEqual(events(h, 'error'), [
		{
			code: 'CHANNEL_FUNDING_FAILED',
			message:
				'This channel was not opened. Its funding transaction can no longer confirm, because a coin it spends was spent by another transaction. What was set aside for the channel has been released.',
			channelId
		}
	]);
	assert.equal(events(h, 'channel').pop().state, 'CLOSED');
	assert.deepEqual([keys(h, 'committed/funding:'), keys(h, 'chan/'), keys(h, 'idem/channels/')], [[], [], []]);
	// What the library wrote of it is in the log, and nowhere else.
	assert.equal(h.logs.some(([level, text]) => level === 'warn' && /was spent by 77c1/.test(text)), true);
	assert.equal(JSON.stringify(h.events).includes('77c1'), false);
	// The library was asked to let go of it, and keeps it while the engine does. It is said once all the same.
	assert.deepEqual(named(h, 'forgetChannel').map((c) => c[1]), [id]);
	assert.equal(h.ln.flows.has(id), true);
	await h.host.pass({ block: true });
	const again = h.restart();
	made.push(again);
	await again.boot();
	await again.host.pass({ block: true });
	assert.equal(events(again, 'error').length, 1);
	assert.deepEqual(await again.get('/channels'), { channels: [] });
	// The same key opens a channel again, under a new id.
	const second = await again.call('POST /channels/open', openBody(asset), 'open-key');
	assert.notEqual(second.pendingChannelId, id);
	assert.equal(named(again, 'openChannel').length, 2);
});

test('an open the user gave up is undone without a word, however the library lists it', async () => {
	// A cancel that landed on a negotiated channel, and one that landed
	// before, which the library lists as failed or turned down with the
	// reason. In each the daemon stopped before the host forgot the open.
	for (const listed of [{ phase: 'cancelled' }, { phase: 'failed', error: 'cancelled' }, { phase: 'rejected', error: 'cancelled' }]) {
		const { h, asset } = await funded();
		h.ln.opts.openTimesOut = true;
		const { pendingChannelId: id } = await h.call('POST /channels/open', openBody(asset), 'open-key');
		h.ln.opts.openTimesOut = false;
		h.ln.set(id, listed);
		// It is no channel from that moment, whatever is still to be tidied.
		assert.deepEqual(await h.get('/channels'), { channels: [] });
		const again = h.restart();
		made.push(again);
		await again.boot();
		assert.deepEqual(events(again, 'error'), [], JSON.stringify(listed));
		assert.deepEqual([keys(again, 'committed/funding:'), keys(again, 'chan/'), keys(again, 'idem/channels/')], [[], [], []]);
		assert.deepEqual(await again.get('/channels'), { channels: [] });
		// Nothing is opened for it again, and the library's list is rid of it.
		assert.equal(named(again, 'openChannel').length, 1);
		assert.equal(again.ln.flows.has(id), false);
	}
	// One that ended for a reason of its own is said.
	const { h, asset } = await funded();
	h.ln.opts.openTimesOut = true;
	const { pendingChannelId: id } = await h.call('POST /channels/open', openBody(asset), 'open-key');
	h.ln.set(id, { phase: 'failed', error: 'the peer hung up' });
	await h.host.pass({ block: true });
	assert.deepEqual(events(h, 'error').map((e) => [e.code, e.channelId]), [['CHANNEL_OPEN_FAILED', id]]);
	assert.equal(h.logs.some(([, text]) => /the peer hung up/.test(text)), true);
});

test('an open the node no longer holds a channel for is undone, and a channel on record that the node does not hold is said to be missing', async () => {
	const { h, asset } = await funded();
	h.ln.opts.openTimesOut = true;
	const { pendingChannelId: id } = await h.call('POST /channels/open', openBody(asset, '100'), 'open-key');
	h.ln.opts.openTimesOut = false;
	// Negotiated with the peer, and the node has let go of the channel
	// since: the library leaves the flow as it is, and nobody carries it on.
	h.ln.set(id, { phase: 'negotiated' });
	assert.equal((await h.get('/channels')).channels[0].state, 'OPENING');
	await h.host.pass({ block: true });
	assert.deepEqual(named(h, 'cancelFlow').map((c) => c[1]), [id]);
	assert.deepEqual(await h.get('/channels'), { channels: [] });
	assert.deepEqual(events(h, 'error').map((e) => [e.code, e.channelId]), [['CHANNEL_OPEN_FAILED', id]]);
	assert.deepEqual([keys(h, 'committed/funding:'), keys(h, 'chan/'), keys(h, 'idem/channels/')], [[], [], []]);
	// One a peer began that went the same way is nothing of this wallet's: not listed, not counted.
	h.ln.plant('cc'.repeat(32), { initiator: false, phase: 'negotiated', assetId: asset.assetId, remote: 10n });
	assert.deepEqual(await h.get('/channels'), { channels: [] });

	// A signed funding is another matter. Its transaction may confirm, and
	// the node holds no channel for it: it is listed, counted with what it
	// was funded with, and never usable.
	const { pendingChannelId: signed } = await h.call('POST /channels/open', openBody(asset, '600'), 'second-key');
	h.ln.set(signed, { state: null, engine: 'missing' });
	await h.host.pass({ block: true });
	const listed = (await h.get('/channels')).channels;
	assert.deepEqual(listed.map((c) => [c.pendingChannelId, c.state, c.localBalance, c.sendable, c.receivable]), [[signed, 'MISSING', '600', '0', '0']]);
	const { balance } = (await h.get('/balances')).assets[0];
	assert.deepEqual([balance.total, balance.onchain, balance.channelLocal, balance.lightningSendable], ['1000', '400', '600', '0']);
	assert.equal(h.host.mem.summary.channels, 1);
	const status = (await h.get('/status')).lightning;
	assert.deepEqual([status.mode, status.usableChannels], ['full', 0]);
	assert.match(status.warning, /^An asset channel is on record that the wallet's node does not hold/);
	assert.deepEqual(status.warnings, [{ code: 'CHANNEL_MISSING', text: status.warning }]);
	const close = await refused(h.call('POST /channels/close', { channelId: listed[0].channelId, force: true }));
	assert.deepEqual([close.extensionCode, close.status], ['CHANNEL_MISSING', 409]);
	assert.equal(close.message, "This channel is on record, but the wallet's node does not hold it, as happens after a restore from a backup. It cannot be closed from this wallet.");
	assert.deepEqual(named(h, 'closeChannel'), []);
	// It is not an open under way: it takes none of the places for channels peers offer.
	for (const n of ['01', '02', '03', '04']) assert.equal(await h.ln.offer({ pendingChannelId: n.repeat(32), assets: [{ assetId: asset.assetId, amount: 1n }] }), true);
	// And the host never undoes it.
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${signed}`]);
});

test('a channel whose close has been asked for carries nothing, also while the engine still calls it normal', async () => {
	const { h, asset, id } = await channelled({ remote: 200n });
	assert.equal((await h.get('/status')).lightning.usableChannels, 1);
	// The library says a close is under way from the moment one is asked for.
	h.ln.set(id, { recovery: 'pending' });
	await h.host.pass();
	const listed = (await h.get('/channels')).channels[0];
	assert.deepEqual([listed.state, listed.localBalance, listed.sendable, listed.receivable], ['CLOSING', '400', '0', '0']);
	assert.equal((await h.get('/status')).lightning.usableChannels, 0);
	const { balance } = (await h.get('/balances')).assets[0];
	assert.deepEqual([balance.channelLocal, balance.lightningSendable, balance.lightningReceivable], ['400', '0', '0']);
	assert.deepEqual(await codeOf(h.call('POST /pay/quote', { bolt11: fakeInvoice({ msat: 1000 }), key: asset.key })), ['INSUFFICIENT_OUTBOUND', 409]);
	assert.deepEqual(await codeOf(h.call('POST /invoices/quote', { key: asset.key, amount: '1' })), ['INSUFFICIENT_INBOUND', 409]);
	assert.deepEqual(named(h, 'quotePayment'), []);
	assert.deepEqual(named(h, 'quoteInvoice'), []);
});

test('a payment the library refuses after an earlier try failed keeps the words of this refusal', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const first = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	h.ln.opts.payStatus = 'failed';
	h.ln.opts.payFailure = null;
	const failed = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: first.quoteId, maxAssetAmount: '50' }, 'first-key');
	assert.equal(failed.status, 'FAILED');
	// Tried again, and this time the engine does not take the payment. The
	// library puts its record back to what the first try left: a failure.
	h.ln.opts.payStatus = 'complete';
	h.ln.opts.payFails = 'ERR_BEIGNET_LN_PAYMENT';
	const second = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	const refusedNow = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: second.quoteId, maxAssetAmount: '50' }, 'second-key');
	const said = 'The payment could not be made, so nothing was paid.';
	assert.deepEqual([refusedNow.status, refusedNow.failureDescription], ['FAILED', said]);
	assert.equal(h.ln.payments.get(failed.paymentHash).status, 'failed');
	// The loop reads the record, which is still that of the first try: the
	// library never recorded this one, so it was never sent. The row's own
	// words stand, and for good.
	assert.deepEqual([h.ln.payments.get(failed.paymentHash).attempt, JSON.parse(h.storage.get(`h/row/ln-send-${failed.paymentHash}`)).attemptBefore], [1, 1]);
	await h.host.pass();
	await h.host.pass();
	const row = (await h.get('/activity', 'kind=ln-send')).rows[0];
	assert.deepEqual([row.state, row.failure], ['failed', { code: 'PAYMENT_NOT_SENT', message: said }]);
	assert.equal('assumed' in JSON.parse(h.storage.get(`h/row/${row.id}`)), false);
	assert.equal((await h.get('/channels')).channels[0].localBalance, '600');
	// The codes that mean nothing was sent are the library's own list, handed on as it is.
	assert.deepEqual([...h.host.ln.refusals], [...h.ln.entry.ASSET_PAYMENT_REFUSALS]);
});

test('the bitcoin of a funding that will not confirm is taken back: once per request key, at a fee rate the wallet allows, and the open ends when the chain says so', async () => {
	const { h, asset } = await funded();
	const answer = await h.call('POST /channels/open', openBody(asset), 'open-key');
	const id = answer.pendingChannelId;
	const flow = h.ln.flow(id);
	const row = async () => (await h.get('/channels')).channels[0];
	assert.deepEqual([(await row()).state, (await row()).reclaimable, (await row()).fundingTxid, (await row()).reclaimTxid], ['OPENING', true, flow.fundingTxid, null]);

	// It takes a request key, a channel there is, and a fee rate within the wallet's limits.
	assert.deepEqual(await codeOf(h.call('POST /channels/reclaim', { channelId: id })), ['IDEMPOTENCY_KEY_REQUIRED', 400]);
	assert.deepEqual(await codeOf(h.call('POST /channels/reclaim', { channelId: 'ab'.repeat(32) }, 'no-such')), ['CHANNEL_NOT_FOUND', 404]);
	const dear = await refused(h.call('POST /channels/reclaim', { channelId: id, feeRate: h.cfg.limits.maxFeeRate + 1 }, 'too-dear'));
	assert.deepEqual([dear.extensionCode, dear.status, dear.details], ['FEE_TOO_HIGH', 400, { maxFeeRate: h.cfg.limits.maxFeeRate }]);
	assert.equal(named(h, 'reclaimFunding').length, 0);
	assert.deepEqual(keys(h, 'idem/channels/reclaim/'), []);

	// By either id. The answer names the spend as a person is shown it.
	const told = events(h, 'channel').length;
	const body = { channelId: flow.channelId, feeRate: 9 };
	const taken = await h.call('POST /channels/reclaim', body, 'reclaim-key');
	assert.deepEqual(taken, { channelId: flow.channelId, pendingChannelId: id, txid: flow.reclaimed, feeSats: 300, feeRate: 9 });
	assert.match(taken.txid, /^[0-9a-f]{64}$/);
	assert.deepEqual(named(h, 'reclaimFunding'), [['reclaimFunding', id, 9]]);
	assert.deepEqual(h.ln.violations, []);
	// The same key asks once, and answers the same. With another request it is refused.
	assert.deepEqual(await h.call('POST /channels/reclaim', body, 'reclaim-key'), taken);
	assert.equal(named(h, 'reclaimFunding').length, 1);
	assert.deepEqual(await codeOf(h.call('POST /channels/reclaim', { ...body, feeRate: 10 }, 'reclaim-key')), ['IDEMPOTENCY_KEY_REUSED', 409]);

	// Nothing is released by it: the channel is as it was, and its row names the spend.
	assert.deepEqual([(await row()).state, (await row()).reclaimable, (await row()).reclaimTxid], ['OPENING', true, taken.txid]);
	assert.deepEqual(events(h, 'channel').slice(told), [{ channelId: flow.channelId, state: 'OPENING' }]);
	const books = async () => {
		const { balance } = (await h.get('/balances')).assets[0];
		return [balance.total, balance.onchain, balance.channelLocal];
	};
	assert.deepEqual(await books(), ['1000', '400', '600']);
	assert.equal(h.logs.some(([level, text]) => level === 'info' && text.includes(`is being taken back in transaction ${taken.txid}`)), true);
	// It survives a restart of the wallet's records.
	assert.equal(JSON.parse(h.storage.get(`h/chan/${id}`)).reclaim.txid, taken.txid);

	// The spend is buried: the library holds the proof that the funding
	// cannot confirm, ends the open and frees what it set aside.
	h.ln.abandon(id);
	await h.host.pass({ block: true });
	assert.deepEqual(await h.get('/channels'), { channels: [] });
	assert.deepEqual(await books(), ['1000', '1000', '0']);
});

test('a funding that cannot be taken back says why, the key is free again, and what the library wrote stays in the log', async () => {
	const { h, channel } = await channelled();
	// On the chain already: there is nothing to take back.
	assert.equal(channel.reclaimable, false);
	const open = await refused(h.call('POST /channels/reclaim', { channelId: channel.channelId, feeRate: 9 }, 'confirmed-key'));
	assert.deepEqual(
		[open.extensionCode, open.status, open.message],
		['CHANNEL_NOT_RECLAIMABLE', 409, 'The funding of this channel is on the chain, so there is nothing to take back. Close the channel instead.']
	);
	assert.equal(named(h, 'reclaimFunding').length, 0);

	const { h: other, asset } = await funded();
	made.push(other);
	const id = (await other.call('POST /channels/open', openBody(asset), 'open-key')).pendingChannelId;
	const body = { channelId: id, feeRate: 9 };
	// The library refuses before it makes anything.
	other.ln.opts.reclaimFails = 'ERR_BEIGNET_LN_FUNDING';
	const refusedNow = await refused(other.call('POST /channels/reclaim', body, 'reclaim-key'));
	assert.deepEqual(
		[refusedNow.extensionCode, refusedNow.status, refusedNow.message],
		['CHANNEL_NOT_RECLAIMABLE', 409, "The funding of this channel cannot be taken back: it has confirmed, the open is over, or none of this wallet's own bitcoin went into it. Nothing was spent."]
	);
	// Anything else: the wallet could not make the spend, or the network did not take it.
	other.ln.opts.reclaimFails = 'ERR_SOMETHING_NOBODY_NAMED';
	const failed = await refused(other.call('POST /channels/reclaim', body, 'reclaim-key'));
	assert.deepEqual(
		[failed.extensionCode, failed.status, failed.message],
		[
			'CHANNEL_RECLAIM_FAILED',
			502,
			'The transaction that takes the funding back could not be made or sent. If the funding transaction is already on the network, it takes a fee rate above the one that transaction pays.'
		]
	);
	assert.equal(failed.message.includes('4f2a'), false);
	assert.equal(other.logs.filter(([level, text]) => level === 'warn' && text.includes('could not be taken back') && text.includes('4f2a:0')).length, 2);
	// Nothing was written down as done: the same key takes it back once the library does.
	assert.deepEqual(keys(other, 'idem/channels/reclaim/'), []);
	assert.equal((await other.get('/channels')).channels[0].reclaimTxid, null);
	other.ln.opts.reclaimFails = null;
	const taken = await other.call('POST /channels/reclaim', body, 'reclaim-key');
	assert.equal(taken.txid, other.ln.flow(id).reclaimed);
	assert.equal(named(other, 'reclaimFunding').length, 3);
});

test('an open the node holds the funding of, with the peer yet to sign, cannot be dropped: it says its funding can be taken back, and is', async () => {
	const { h, asset } = await funded();
	// This wallet signed the funding transaction, the engine has it, and no
	// word of the peer's signature comes in time. That is not past the point
	// of no return, and the engine cannot be made to drop the open either.
	h.ln.opts.openStopsUnsigned = true;
	h.ln.opts.engineHoldsFunding = true;
	const answer = await h.call('POST /channels/open', openBody(asset), 'open-key');
	const id = answer.pendingChannelId;
	const flow = h.ln.flow(id);
	assert.deepEqual([flow.signed, !!flow.fundingTxid, flow.phase], [false, true, 'funding-created']);
	const row = async () => (await h.get('/channels')).channels[0];
	assert.deepEqual([(await row()).state, (await row()).reclaimable, (await row()).fundingTxid], ['OPENING', true, flow.fundingTxid]);
	// What it set aside is still the wallet's own until the peer commits: it is not counted as a channel's.
	const { balance } = (await h.get('/balances')).assets[0];
	assert.equal(balance.channelLocal, '0');
	assert.equal(balance.total, '1000');

	const close = await refused(h.call('POST /channels/close', { channelId: id }));
	assert.deepEqual([close.extensionCode, close.status, close.details], ['CHANNEL_OPENING', 409, { reclaimable: true }]);
	assert.match(close.message, /If that transaction will not confirm, its bitcoin can be taken back instead, which ends the open\.$/);
	assert.deepEqual(keys(h, 'committed/funding:'), [`h/committed/funding:${id}`]);

	const taken = await h.call('POST /channels/reclaim', { channelId: id, feeRate: 9 }, 'reclaim-key');
	assert.deepEqual([taken.channelId, taken.pendingChannelId, taken.txid], [id, id, flow.reclaimed]);

	// Once the engine has dropped the open, it can be given up like any other that signed nothing.
	h.ln.opts.engineHoldsFunding = false;
	assert.deepEqual(await h.call('POST /channels/close', { channelId: id }), { channelId: id, closing: true, force: false });
	assert.deepEqual(await h.get('/channels'), { channels: [] });
	assert.deepEqual((await h.get('/balances')).assets[0].balance.onchain, '1000');
	assert.deepEqual(h.ln.violations, []);
});

test('an open that fails after this wallet signed its funding and before the peer signed is undone: nothing was opened and nothing is set aside', async () => {
	const { h, asset } = await funded();
	h.ln.opts.openFailsUnsigned = 'ERR_BEIGNET_LN_FUNDING_REJECTED';
	const err = await refused(h.call('POST /channels/open', openBody(asset), 'open-key'));
	assert.deepEqual([err.extensionCode, err.status], ['PEER_NO_ASSET_CHANNELS', 409]);
	assert.deepEqual(await h.get('/channels'), { channels: [] });
	assert.deepEqual([keys(h, 'committed/funding:'), keys(h, 'chan/'), keys(h, 'idem/channels/')], [[], [], []]);
	const { balance } = (await h.get('/balances')).assets[0];
	assert.deepEqual([balance.total, balance.onchain, balance.channelLocal], ['1000', '1000', '0']);
	assert.equal(h.tap.records.some((r) => r.reservedBy), false);
	// The key opens a channel again.
	h.ln.opts.openFailsUnsigned = null;
	assert.equal((await h.call('POST /channels/open', openBody(asset), 'open-key')).phase, 'funding');
});

test('a node that does not offer asset channels says why in the status, begins nothing new, and still lists and closes what there is', async () => {
	const { h, asset, channel } = await channelled({ remote: 200n });
	assert.deepEqual((await h.get('/status')).lightning, { mode: 'full', usableChannels: 1 });
	// A feature the overlay depends on is off in the node's settings.
	h.ln.opts.advertisement = { advertised: false, reason: 'option_simple_taproot is not signalled by this node' };
	const said =
		"This wallet's node does not offer asset channels to its peers: a Lightning feature they depend on is turned off in the node's settings. Nothing new can be opened, invoiced or paid over asset channels until it is turned on. The channels there already are stay listed and can still be closed.";
	assert.deepEqual((await h.get('/status')).lightning, {
		mode: 'off',
		usableChannels: 1,
		unavailable: { code: 'NOT_ADVERTISED', message: said, reason: 'option_simple_taproot is not signalled by this node' }
	});
	for (const [route, body, key] of [
		['POST /channels/quote', openBody(asset), undefined],
		['POST /channels/open', openBody(asset), 'a-key-not-used-before'],
		['POST /invoices/quote', { key: asset.key, amount: '10' }, undefined],
		['POST /pay/quote', { bolt11: fakeInvoice({ msat: 50000 }), key: asset.key }, undefined],
		['GET /invoices', {}, undefined]
	]) {
		const err = await refused(ask(h, route, body, key));
		assert.deepEqual([err.extensionCode, err.status, err.message, err.details], ['LIGHTNING_NOT_ADVERTISED', 409, said, { reason: 'option_simple_taproot is not signalled by this node' }], route);
	}
	assert.equal(named(h, 'openChannel').length, 1);
	// What there is stays listed, and can be closed.
	assert.equal((await h.get('/channels')).channels[0].channelId, channel.channelId);
	assert.deepEqual(await h.call('POST /channels/close', { channelId: channel.channelId }), { channelId: channel.channelId, closing: true, force: false });
	// Offered again, it is as it was. An engine that cannot say is not taken for a no.
	h.ln.opts.advertisement = undefined;
	assert.equal((await h.get('/status')).lightning.mode, 'full');
	assert.equal('unavailable' in (await h.get('/status')).lightning, false);
});

test('a fee budget for channel fees that is used up is said in a sentence, with nothing done', async () => {
	const { h, channel } = await channelled();
	h.ln.opts.closeFails = 'FEE_BUDGET_EXHAUSTED';
	const err = await refused(h.call('POST /channels/close', { channelId: channel.channelId, force: true }));
	assert.deepEqual(
		[err.extensionCode, err.status, err.message],
		[
			'FEE_BUDGET_EXHAUSTED',
			409,
			'The budget this app sets for the miner fees of asset channels is used up, so nothing was done. Nothing was lost: the channels and what is in them are as they were.'
		]
	);
	assert.equal((await h.get('/channels')).channels[0].state, 'NORMAL');
});

test('a payment is settled from the record of its own try: what an earlier try left says nothing of it', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const first = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	h.ln.opts.payStatus = 'failed';
	h.ln.opts.payFailure = 'no route';
	const failed = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: first.quoteId, maxAssetAmount: '50' }, 'first-key');
	assert.equal(failed.status, 'FAILED');
	const stored = () => JSON.parse(h.storage.get(`h/row/ln-send-${failed.paymentHash}`));
	assert.deepEqual([stored().attemptBefore, stored().attempt], [0, 1]);

	// Tried again, and the call throws something that is no refusal before
	// the library has written a word of this try. Its record is still that
	// of the first try, a failure, and is not taken for the end of this one.
	h.ln.opts.payStatus = 'complete';
	h.ln.opts.payFails = 'ERR_SOMETHING_NOBODY_NAMED';
	h.cfg.payWaitMs = 10;
	const second = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	const answer = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: second.quoteId, maxAssetAmount: '50' }, 'second-key');
	assert.deepEqual([answer.status, answer.failureDescription], ['PENDING', null]);
	assert.deepEqual([stored().attemptBefore, 'attempt' in stored(), h.ln.payments.get(failed.paymentHash).attempt], [1, false, 1]);
	await h.host.pass();
	assert.equal(stored().state, 'pending');
	// Nobody is sending it and the library never recorded it: once it has
	// had its time it is the host's conclusion that it was never sent, and
	// the record still being that of the first try makes that final.
	h.clock.t += 31_000;
	await h.host.pass();
	assert.deepEqual([stored().state, stored().failure.code, stored().assumed], ['failed', 'PAYMENT_NOT_SENT', true]);
	await h.host.pass();
	assert.deepEqual([stored().state, stored().failure.code, 'assumed' in stored()], ['failed', 'PAYMENT_NOT_SENT', false]);
	assert.equal((await h.get('/channels')).channels[0].localBalance, '600');

	// A third try that the node takes is the record's third, and ends as the record of it says.
	h.ln.opts.payFails = null;
	h.ln.opts.payStatus = 'pending';
	const third = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	assert.equal((await h.call('POST /pay', { bolt11, key: asset.key, quoteId: third.quoteId, maxAssetAmount: '50' }, 'third-key')).status, 'PENDING');
	assert.deepEqual([stored().attemptBefore, stored().attempt, stored().state], [1, 2, 'pending']);
	h.ln.finish(failed.paymentHash, 'complete');
	await h.host.pass();
	assert.deepEqual([stored().state, stored().attempt], ['complete', 2]);
	assert.equal((await h.get('/channels')).channels[0].localBalance, '550');
});

test('a payment the node no longer has a record of stays pending, says so, and its invoice is never paid again', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const quote = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	const other = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	h.ln.opts.payStatus = 'pending';
	h.cfg.payWaitMs = 10;
	const answer = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: '50' }, 'pay-key');
	assert.equal(answer.status, 'PENDING');
	assert.equal('notice' in answer, false);

	// The engine forgets the payment, with no HTLC of it left on the channel. Nothing says how it ended.
	h.ln.forget(answer.paymentHash);
	await h.host.pass();
	const said = {
		code: 'PAYMENT_UNACCOUNTED',
		message: 'The node no longer has a record of this payment, so how it ended cannot be known. It may have been paid. This wallet will not pay the invoice again.'
	};
	const row = async () => (await h.get('/activity', 'kind=ln-send')).rows[0];
	assert.deepEqual([(await row()).state, (await row()).failed, (await row()).failure, (await row()).notice], ['pending', false, null, said]);
	assert.equal(h.logs.filter(([level, text]) => level === 'warn' && text.includes(answer.paymentHash) && text.includes('how it ended cannot be known')).length, 1);
	// The request that began it answers the same, and the invoice is not paid a second time.
	assert.deepEqual((await h.call('POST /pay', { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: '50' }, 'pay-key')).notice, said);
	const refused = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: other.quoteId, maxAssetAmount: '50' }, 'other-key').catch((err) => err);
	assert.deepEqual([refused.extensionCode, refused.status, refused.message], ['PAYMENT_UNACCOUNTED', 409, said.message]);
	assert.equal(named(h, 'payInvoice').length, 1);
	// Time ends nothing, and the same is not logged on every pass.
	h.clock.t += 3 * 24 * 60 * 60 * 1000;
	await h.host.pass();
	await h.host.pass();
	assert.equal((await row()).state, 'pending');
	assert.equal(h.logs.filter(([, text]) => text.includes('how it ended cannot be known')).length, 1);
	// No new price is given for it either.
	assert.deepEqual(await codeOf(h.call('POST /pay/quote', { bolt11, key: asset.key })), ['ALREADY_PAID', 409]);
	// The channel still counts the units as leaving.
	assert.equal((await h.get('/channels')).channels[0].localBalance, '600');

	// Should the engine have a word on that very try after all, it is taken, and the notice goes.
	h.ln.finish(answer.paymentHash, 'complete');
	await h.host.pass();
	assert.deepEqual([(await row()).state, 'notice' in (await row())], ['complete', false]);
});

test('a send the node took without confirming its asset records is followed like any other, and says so to the end', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const quote = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	// Thrown after the engine took the payment, with a code that is not one
	// of the library's refusals: the record is kept, and flagged.
	h.ln.opts.payThrowsAfter = 'ERR_BEIGNET_LN_RECORDS_UNCONFIRMED';
	assert.equal(h.host.ln.refusals.includes('ERR_BEIGNET_LN_RECORDS_UNCONFIRMED'), false);
	h.cfg.payWaitMs = 10;
	const answer = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: '50' }, 'pay-key');
	const said = {
		code: 'PAYMENT_UNCONFIRMED',
		message: 'The node took this payment without confirming that it went out as an asset payment. It ends as the node reports, and its units are not known to have left the channel.'
	};
	assert.deepEqual([answer.status, answer.failureDescription, answer.notice], ['PENDING', null, said]);
	await h.host.pass();
	const row = async () => (await h.get('/activity', 'kind=ln-send')).rows[0];
	assert.deepEqual([(await row()).state, (await row()).notice], ['pending', said]);
	// It is in flight like any other: not paid a second time.
	assert.deepEqual(await codeOf(h.call('POST /pay/quote', { bolt11, key: asset.key })), ['ALREADY_PAID', 409]);
	// It ends as the node reports, and goes on saying what was never confirmed.
	h.ln.finish(answer.paymentHash, 'complete');
	await h.host.pass();
	assert.deepEqual([(await row()).state, (await row()).failure, (await row()).notice], ['complete', null, said]);
	assert.equal(named(h, 'payInvoice').length, 1);
});

test('the wallet\'s own spending limit refuses a payment before anything is sent, and the limit is named when the engine names it', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const pay = async (key) => {
		const quote = await h.call('POST /pay/quote', { bolt11, key: asset.key });
		return h.call('POST /pay', { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: '50' }, key);
	};
	// The library's code, with what the engine threw as its cause.
	h.ln.opts.payFails = 'ERR_BEIGNET_LN_SPENDING_LIMIT';
	h.ln.opts.payCause = Object.assign(new Error('ASSET_PAYMENT_REFUSED: 50000 msat is over what is left of the daily limit'), { code: 'ASSET_PAYMENT_REFUSED' });
	const plain = await pay('first-key');
	assert.deepEqual([plain.status, plain.failureDescription], ['FAILED', "This wallet's own spending limit refused the payment, so nothing was paid."]);
	h.ln.opts.payCause = Object.assign(new Error('ASSET_PAYMENT_REFUSED'), { code: 'ASSET_PAYMENT_REFUSED', limit: 'daily' });
	const named = await pay('second-key');
	assert.deepEqual([named.status, named.failureDescription], ['FAILED', "This wallet's own spending limit (daily) refused the payment, so nothing was paid."]);
	const row = (await h.get('/activity', 'kind=ln-send')).rows[0];
	assert.deepEqual([row.state, row.failure.code], ['failed', 'SPENDING_LIMIT']);
	// Nothing was recorded and nothing left.
	assert.equal(h.ln.payments.size, 0);
	assert.equal((await h.get('/channels')).channels[0].localBalance, '600');
	// What the engine wrote is in neither answer.
	assert.equal(JSON.stringify([plain, named]).includes('50000 msat'), false);
});

test('an invoice that brought in a unit less than it asked for counts what arrived and still says what was invoiced', async () => {
	const { h, asset } = await channelled({ remote: 200n });
	const quote = await h.call('POST /invoices/quote', { key: asset.key, amount: '150' });
	const invoice = await h.call('POST /invoices', { key: asset.key, amount: '150', quoteId: quote.quoteId });
	assert.equal((await h.get('/invoices')).invoices[0].receivedAmount, null);
	// The payer's rate rounded it down by one.
	h.ln.settle(invoice.paymentHash, 149n);
	await h.host.pass();
	const row = (await h.get('/activity', 'kind=ln-receive')).rows[0];
	assert.deepEqual([row.state, row.assets[0].amount], ['complete', '149']);
	const listed = (await h.get('/invoices')).invoices[0];
	assert.deepEqual([listed.status, listed.assetAmount, listed.receivedAmount], ['PAID', '150', '149']);
	const channel = (await h.get('/channels')).channels[0];
	assert.deepEqual([channel.localBalance, channel.remoteBalance], ['549', '51']);
});

test('an invoice paid in full says that all of it arrived', async () => {
	const { h, asset } = await channelled({ remote: 200n });
	const quote = await h.call('POST /invoices/quote', { key: asset.key, amount: '150' });
	const invoice = await h.call('POST /invoices', { key: asset.key, amount: '150', quoteId: quote.quoteId });
	h.ln.settle(invoice.paymentHash);
	await h.host.pass();
	const listed = (await h.get('/invoices')).invoices[0];
	assert.deepEqual([listed.status, listed.assetAmount, listed.receivedAmount], ['PAID', '150', '150']);
});

test('a peer whose price cannot name the amount gets no invoice made at it', async () => {
	const { h, asset } = await channelled({ remote: 200n });
	h.ln.opts.quoteFails = 'ERR_BEIGNET_LN_RATE_TOO_COARSE';
	const refused = await h.call('POST /invoices/quote', { key: asset.key, amount: '150' }).catch((err) => err);
	assert.deepEqual(
		[refused.extensionCode, refused.status, refused.message],
		['RATE_TOO_COARSE', 409, "The channel's peer priced this asset too coarsely for a Lightning invoice to name that amount, so no invoice was made."]
	);
	assert.deepEqual(keys(h, 'l-quote/'), []);
	assert.deepEqual((await h.get('/invoices')).invoices, []);
});

/* ------------------------------------------------------------------ backup */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Run `fn` with a directory of its own, removed afterwards. */
async function inDir(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-ln-'));
	try {
		return await fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** The backup file a wallet writes, read back. */
async function exportedFile(h, dir) {
	h.cfg.backupFile = path.join(dir, `backup-${made.length}.json`);
	await h.host.exportNow();
	return JSON.parse(fs.readFileSync(h.cfg.backupFile, 'utf8'));
}

/** A file left for a wallet to restore at its next start. */
function leftFor(dir, file) {
	const importFile = path.join(dir, 'import.json');
	fs.writeFileSync(importFile, JSON.stringify(file));
	return importFile;
}

const pairs = (part) => part.rows.map((r) => [r.key, r.value]);
const MISSING_WARNING =
	"An asset channel is on record that the wallet's node does not hold, as happens after a restore from a backup. It cannot be used or closed from this wallet, and its balance is the last one known. This wallet cannot bring the assets in it back by itself.";
const CHANGE_WARNING =
	"Part of an asset went into the funding transaction of a channel as change and is not in this wallet's records, so it is not in the balance shown. The wallet's log says which asset and how much.";

test('the backup carries of asset channels what the library says a backup may, and nothing else of its store', async () => {
	await inDir(async (dir) => {
		const { h, asset, id, channel } = await channelled({ remote: 200n });
		const quote = await h.call('POST /invoices/quote', { key: asset.key, amount: '150' });
		const invoice = await h.call('POST /invoices', { key: asset.key, amount: '150', quoteId: quote.quoteId });
		await h.call('POST /invoices/quote', { key: asset.key, amount: '10' });
		const bolt11 = fakeInvoice({ msat: 50000 });
		const price = await h.call('POST /pay/quote', { bolt11, key: asset.key });
		await h.call('POST /pay', { bolt11, key: asset.key, quoteId: price.quoteId, maxAssetAmount: '50' }, 'pay-key');
		await h.call('POST /pay/quote', { bolt11: fakeInvoice({ msat: 7000 }), key: asset.key });
		// The library's store holds what only this machine can honour: a price, an invoice, the record of a payment.
		const stored = h.storage.list('l/').map((r) => r.key);
		for (const scope of ['l/tap/quotes/', 'l/lightning/invoice/', 'l/tap/channel/v1/sent/']) assert.equal(stored.some((key) => key.startsWith(scope)), true, scope);

		const file = await exportedFile(h, dir);
		// Of the host's rows: the activity, and nothing that would have another machine open or pay again.
		const kept = file.rows.map(([key]) => key);
		assert.deepEqual(kept, backup.collectRows(h.storage).map(([key]) => key));
		assert.equal(kept.some((key) => key.startsWith('l/')), false);
		assert.ok(kept.includes(`h/row/ln-receive-${invoice.paymentHash}`));
		for (const gone of [`h/chan/${id}`, `h/committed/funding:${id}`, `h/inv/${invoice.paymentHash}`]) assert.equal(kept.includes(gone), false, gone);
		assert.equal(kept.some((key) => key.startsWith('h/l-quote/') || key.startsWith('h/idem/')), false);
		// The marker of a mint is not a channel's, and stays.
		assert.equal(kept.filter((key) => key.startsWith('h/committed/')).length, 1);
		// Their checksum is over them alone, as a reader that knows nothing of channels checks it.
		assert.equal(file.rowsHash, backup.hashRows(file.rows));

		// Of the library's rows: what it gave when asked, as it gave it, with a checksum of its own.
		assert.deepEqual(file.lightning, h.host.ln.backup());
		assert.equal(file.lightningHash, backup.hashRows(pairs(file.lightning)));
		assert.deepEqual(file.lightning.rows.map((r) => r.key).sort(), [`tap/channel/v1/channel/${channel.channelId}`, `tap/channel/v1/last/${channel.channelId}`]);

		// Written again only when something changed, a channel's last known balance included.
		assert.equal((await h.host.exportNow()).changed, false);
		h.ln.move(channel.channelId, -10n);
		assert.equal((await h.host.exportNow()).changed, true);

		// A wallet that has never had to do with a channel writes the file it always wrote.
		const plain = await funded();
		const before = await exportedFile(plain.h, dir);
		assert.equal('lightning' in before, false);
		assert.equal('lightningHash' in before, false);
	});
});

test('a wallet restored from a backup knows its channels and cannot run them: listed as missing, counted, and never usable', async () => {
	await inDir(async (dir) => {
		const source = await channelled({ remote: 200n });
		const file = await exportedFile(source.h, dir);
		const importFile = leftFor(dir, file);
		// Another machine: nothing in its store, and a node that holds no channel.
		const h = world({ lightning: true, env: { BEIGNET_ASSETS_IMPORT_FILE: importFile } });
		await h.boot();
		assert.equal((await h.get('/status')).backup.importError, undefined);
		assert.equal(fs.existsSync(importFile), false);
		// The library was handed its rows back and wrote them itself.
		for (const row of file.lightning.rows) assert.equal(h.storage.get(`l/${row.key}`), row.value, row.key);

		// The channel is on record, with its last known balance, and the node does not hold it.
		const listed = (await h.get('/channels')).channels;
		assert.deepEqual(
			listed.map((c) => [c.channelId, c.pendingChannelId, c.peerPubkey, c.state, c.localBalance, c.remoteBalance, c.sendable, c.receivable, c.asset.name]),
			[[source.channel.channelId, source.id, PEER.pubkey, 'MISSING', '400', '200', '0', '0', 'coin']]
		);
		assert.deepEqual((await h.get('/status')).lightning, { mode: 'full', usableChannels: 0, warning: MISSING_WARNING, warnings: [{ code: 'CHANNEL_MISSING', text: MISSING_WARNING }] });
		// It counts as a channel for the manager, and its units are in the books.
		assert.equal(h.host.mem.summary.channels, 1);
		const { balance } = (await h.get('/balances')).assets[0];
		assert.deepEqual([balance.channelLocal, balance.lightningSendable, balance.lightningReceivable], ['400', '0', '0']);
		// Nothing can be done with it from here.
		assert.deepEqual(await codeOf(h.call('POST /channels/close', { channelId: source.channel.channelId, force: true })), ['CHANNEL_MISSING', 409]);
		assert.deepEqual(named(h, 'closeChannel'), []);
		assert.deepEqual(await codeOf(h.call('POST /pay/quote', { bolt11: fakeInvoice({ msat: 1000 }), key: source.asset.key })), ['INSUFFICIENT_OUTBOUND', 409]);
		assert.deepEqual(await codeOf(h.call('POST /invoices/quote', { key: source.asset.key, amount: '1' })), ['INSUFFICIENT_INBOUND', 409]);
		// What a funding may have left set aside was asked about, once, after the restore.
		assert.equal(named(h, 'settleFundingReservations').length, 1);

		// It is no channel to restore over. The same file is taken again from
		// the dashboard, and the wallet's own Lightning rows stand.
		const rows = h.storage.list('l/');
		const second = await h.call('POST /backup/import', { backup: file });
		assert.equal(typeof second.imported, 'number');
		assert.deepEqual(h.storage.list('l/'), rows);
		assert.equal(named(h, 'settleFundingReservations').length, 1);
		await h.host.pass({ block: true });
		// A restore may have brought records a funding set aside: asked again after it.
		assert.equal(named(h, 'settleFundingReservations').length, 2);

		// And it is the same after a restart.
		const again = h.restart();
		made.push(again);
		await again.boot();
		assert.deepEqual((await again.get('/channels')).channels.map((c) => [c.channelId, c.state, c.localBalance]), [[source.channel.channelId, 'MISSING', '400']]);
		assert.deepEqual(events(again, 'error'), []);
	});
});

test('after a restore, what a channel funding had set aside is settled from the chain: kept for now, released, or moved into the channel', async () => {
	await inDir(async (dir) => {
		const source = await channelled();
		const file = await exportedFile(source.h, dir);
		const h = world({ lightning: true, env: { BEIGNET_ASSETS_IMPORT_FILE: leftFor(dir, file) } });
		// The on-chain records as an older backup had them: the input of the
		// channel's funding still set aside under its name, and one more set
		// aside for a funding that never came to anything.
		const like = source.h.tap.records[0];
		const record = (amount, reservedBy, n) => ({ ...like, spent: false, amount: String(amount), reservedBy, anchorOutPoint: `${String(n).repeat(64)}:0` });
		const never = 'ee'.repeat(32);
		h.tap.records.push(record(1000, `funding:${source.id}`, 5), record(70, `funding:${never}`, 6));
		// The backup was made before that funding was signed, so it carries
		// nothing that rebuilds the outputs of the transaction.
		h.ln.opts.changeRestorable = false;
		// The funding transaction is seen and not buried yet.
		h.ln.opts.settleKeeps = 'the funding transaction is not buried deep enough yet: look again later';
		await h.boot();
		const books = async () => {
			const { balance } = (await h.get('/balances')).assets[0];
			return [balance.total, balance.onchain, balance.channelLocal];
		};
		// Kept for now. The channel's 600 are counted in the channel and not on-chain a second time.
		assert.equal(named(h, 'settleFundingReservations').length, 1);
		assert.deepEqual(await books(), ['1070', '470', '600']);
		assert.equal(h.logs.filter(([, text]) => /stays set aside for now: the funding transaction is not buried deep enough yet/i.test(text)).length, 2);
		// Asked again on a new block, and not before. The same reason is not logged again.
		await h.host.pass();
		assert.equal(named(h, 'settleFundingReservations').length, 1);
		await h.host.pass({ block: true });
		assert.equal(named(h, 'settleFundingReservations').length, 2);
		assert.equal(h.logs.filter(([, text]) => /stays set aside for now/.test(text)).length, 2);
		assert.deepEqual(await books(), ['1070', '470', '600']);

		// Buried. Nothing spent the one: it is free again. The funding spent
		// the other: 600 went into the channel, and 400 into an output of that
		// transaction this wallet has no record of.
		h.ln.opts.settleKeeps = null;
		const said = events(h, 'balance').length;
		await h.host.pass({ block: true });
		assert.equal(named(h, 'settleFundingReservations').length, 3);
		assert.deepEqual(h.tap.records.filter((r) => !r.spent).map((r) => [r.amount, r.reservedBy]), [['70', undefined]]);
		assert.deepEqual(await books(), ['670', '70', '600']);
		assert.equal(events(h, 'balance').length > said, true);
		const fundingTxid = h.ln.flow(source.id).fundingTxid;
		assert.deepEqual(h.host.rows.list('l-change/').map((r) => r.value), [
			{ id: source.id, channelId: source.channel.channelId, fundingTxid, change: [{ assetId: source.asset.assetId, amount: '400' }], at: h.clock.t }
		]);
		// The status says so in a sentence, and the log says which asset and how much.
		assert.deepEqual((await h.get('/status')).lightning, {
			mode: 'full',
			usableChannels: 0,
			warning: `${MISSING_WARNING} ${CHANGE_WARNING}`,
			warnings: [
				{ code: 'CHANNEL_MISSING', text: MISSING_WARNING },
				{ code: 'CHANGE_NOT_BACK', text: CHANGE_WARNING }
			]
		});
		assert.equal(h.logs.some(([level, text]) => level === 'warn' && text.includes(`400 of ${source.asset.assetId}`)), true);
		assert.equal(h.logs.some(([, text]) => text.includes('is free again') && text.includes(`70 of ${source.asset.assetId}`)), true);
		// Settled: not asked again, by a block or by a restart of the loop's look.
		await h.host.pass({ block: true });
		assert.equal(named(h, 'settleFundingReservations').length, 3);

		// The note of it is carried in a backup, and goes once a record of that transaction turns up.
		assert.equal(backup.collectRows(h.storage).some(([key]) => key === `h/l-change/${source.id}`), true);
		h.tap.records.push({ ...like, spent: false, reservedBy: undefined, amount: '400', anchorOutPoint: `${fundingTxid}:1` });
		await h.host.pass({ block: true });
		assert.deepEqual(h.host.rows.list('l-change/'), []);
		assert.deepEqual((await h.get('/status')).lightning, { mode: 'full', usableChannels: 0, warning: MISSING_WARNING, warnings: [{ code: 'CHANNEL_MISSING', text: MISSING_WARNING }] });
		assert.deepEqual(await books(), ['1070', '470', '600']);
	});
});

test('a backup is never restored over a channel the node holds, and its record of asset channels goes into an empty store or nowhere', async () => {
	await inDir(async (dir) => {
		const { h, id, channel } = await channelled();
		const file = await exportedFile(h, dir);
		const live = await refused(h.call('POST /backup/import', { backup: file }));
		assert.deepEqual([live.extensionCode, live.status], ['ASSET_CHANNELS_OPEN', 409]);
		assert.equal(live.message, 'This wallet has an asset channel, and a backup is never restored over one. Close its asset channels first.');

		// Once it is closed and its assets are home, a backup is taken again.
		await h.call('POST /channels/close', { channelId: channel.channelId, force: false });
		assert.deepEqual(await codeOf(h.call('POST /backup/import', { backup: file })), ['ASSET_CHANNELS_OPEN', 409]);
		h.ln.recover(id);
		await h.host.pass({ block: true });
		const now = await exportedFile(h, dir);
		assert.deepEqual(await h.call('POST /backup/import', { backup: now }), { imported: 0, same: true });
		// The wallet has Lightning rows of its own, and they stand whatever a file says of asset channels.
		const mine = h.storage.list('l/');
		assert.equal(mine.length > 0, true);
		const other = { version: 1, rows: [{ key: `tap/channel/v1/last/${'ee'.repeat(32)}`, value: 'another channel' }] };
		assert.deepEqual(await h.call('POST /backup/import', { backup: { ...now, lightning: other, lightningHash: backup.hashRows(pairs(other)) } }), { imported: 0, same: true });
		assert.deepEqual(h.storage.list('l/'), mine);

		// A wallet with nothing: a file whose record of asset channels is damaged, or is not one the library takes, restores nothing at all.
		const fresh = world({ lightning: true });
		await fresh.boot();
		const into = (changes) => refused(fresh.call('POST /backup/import', { backup: { ...file, ...changes } }));
		const nothing = () => assert.deepEqual([fresh.storage.list('l/'), keys(fresh, 'row/'), keys(fresh, 'reg/')], [[], [], []]);
		const damaged = 'That assets backup is damaged: its record of asset channels does not match its checksum.';
		for (const changes of [{ lightningHash: 'ab'.repeat(32) }, { lightningHash: undefined }, { lightning: { version: 1, rows: [['a', 'b']] } }, { lightning: 'rows' }]) {
			const err = await into(changes);
			assert.deepEqual([err.extensionCode, err.status, err.message], ['BAD_BACKUP', 400, damaged], JSON.stringify(changes));
			nothing();
		}
		// A funding flow is a row no backup may carry: restored, it could sign again.
		const flow = { version: 1, rows: [...file.lightning.rows, { key: `tap/funding/v1/flow/${id}`, value: '{}' }] };
		const foreign = await into({ lightning: flow, lightningHash: backup.hashRows(pairs(flow)) });
		assert.deepEqual(
			[foreign.extensionCode, foreign.status, foreign.message],
			['BAD_BACKUP', 400, 'That assets backup holds a record of asset channels that this app cannot read, so nothing was restored.']
		);
		nothing();
		// A row of the library's store among the host's own rows is written nowhere.
		const rows = [...file.rows, ['l/tap/funding/v1/flow/aa', '{}']].sort(([a], [b]) => (a < b ? -1 : 1));
		const taken = await fresh.call('POST /backup/import', { backup: { ...file, rows, rowsHash: backup.hashRows(rows) } });
		assert.equal(taken.imported > 0, true);
		assert.equal(fresh.storage.get('l/tap/funding/v1/flow/aa'), null);
		assert.deepEqual(fresh.storage.list('l/').map((r) => r.key).filter((key) => !key.endsWith('/restored')).sort(), file.lightning.rows.map((r) => `l/${r.key}`).sort());

		// A wallet that cannot have asset channels takes the rest of the file and leaves that part alone.
		const without = world({});
		await without.boot();
		assert.equal((await without.call('POST /backup/import', { backup: file })).imported > 0, true);
		assert.deepEqual(without.storage.list('l/'), []);
	});
});

test('a backup left for a wallet is restored, its record of asset channels included, before its Lightning service is started', async () => {
	await inDir(async (dir) => {
		const source = await channelled();
		const importFile = leftFor(dir, await exportedFile(source.h, dir));
		const h = world({ lightning: true, env: { BEIGNET_ASSETS_IMPORT_FILE: importFile } });
		// What the wallet's store held when its Lightning service was handed the adapter.
		const held = [];
		const start = h.host.ln.start;
		h.host.ln.start = (options) => {
			held.push([h.storage.list('h/row/').length, h.storage.list('l/').length > 0, named(h, 'start').length]);
			return start(options);
		};
		await h.boot();
		assert.equal((await h.get('/status')).backup.importError, undefined);
		assert.equal(fs.existsSync(importFile), false);
		// The mint the backup carried and the channel's record were already there, and the service was not running.
		assert.deepEqual(held, [[1, true, 0]]);
		assert.equal(named(h, 'start').length, 1);
	});
});

test('a backup left for a wallet with Lightning rows of its own is not restored before its node can be asked', async () => {
	await inDir(async (dir) => {
		const source = await funded();
		const importFile = leftFor(dir, await exportedFile(source.h, dir));
		const h = world({ lightning: true, env: { BEIGNET_ASSETS_IMPORT_FILE: importFile } });
		h.storage.set(`l/tap/channel/v1/channel/${'aa'.repeat(32)}`, 'a channel');
		await h.boot();
		assert.match((await h.get('/status')).backup.importError, /^This wallet has Lightning records of its own, so the backup was left alone\./);
		assert.equal(fs.existsSync(importFile), true);
		assert.deepEqual((await h.get('/balances')).assets, []);
	});
});

test('a funding whose change comes back with it leaves no note: only a backup made before the funding was signed does', async () => {
	await inDir(async (dir) => {
		const source = await channelled();
		const file = await exportedFile(source.h, dir);
		const h = world({ lightning: true, env: { BEIGNET_ASSETS_IMPORT_FILE: leftFor(dir, file) } });
		const like = source.h.tap.records[0];
		h.tap.records.push({ ...like, spent: false, amount: '1000', reservedBy: `funding:${source.id}`, anchorOutPoint: `${'5'.repeat(64)}:0` });
		// A note a store already has from before the library brought any
		// change back, for another channel: 30 units in an output of a
		// transaction this wallet has no record of.
		const old = { id: 'dd'.repeat(32), channelId: 'de'.repeat(32), fundingTxid: 'df'.repeat(32), change: [{ assetId: source.asset.assetId, amount: '30' }], at: 1 };
		h.storage.set(`h/l-change/${old.id}`, JSON.stringify(old));
		await h.boot();
		// The funding is buried. The backup carried what rebuilds its outputs:
		// 600 are the channel's, and the 400 of change are back on-chain.
		const { balance } = (await h.get('/balances')).assets[0];
		assert.deepEqual([balance.total, balance.onchain, balance.channelLocal], ['1000', '400', '600']);
		assert.equal(h.logs.some(([level, text]) => level === 'info' && text.includes("is back in this wallet's records") && text.includes(`400 of ${source.asset.assetId}`)), true);
		assert.equal(h.logs.some(([, text]) => text.includes("is not in this wallet's records")), false);
		// Nothing is written down for it. The note there already was is kept, and still said.
		assert.deepEqual(h.host.rows.list('l-change/').map((r) => r.value), [old]);
		assert.deepEqual((await h.get('/status')).lightning.warnings.map((w) => w.code), ['CHANNEL_MISSING', 'CHANGE_NOT_BACK']);
		assert.equal(backup.collectRows(h.storage).some(([key]) => key === `h/l-change/${old.id}`), true);

		// A record of that older transaction turns up while the wallet is
		// stopped. The first look after a start drops its note, without
		// waiting for a block.
		h.tap.records.push({ ...like, spent: false, reservedBy: undefined, amount: '30', anchorOutPoint: `${old.fundingTxid}:1` });
		const again = h.restart();
		made.push(again);
		await again.boot();
		assert.deepEqual(again.host.rows.list('l-change/'), []);
		assert.deepEqual((await again.get('/status')).lightning.warnings.map((w) => w.code), ['CHANNEL_MISSING']);
	});
});

test('the status says how many asset channels are not over, and says nothing rather than none while the node cannot be asked', async () => {
	// The node is not there yet: the count is not known, which is not 0.
	const early = world({ lightning: 'unbound' });
	await early.boot();
	assert.equal((await early.get('/status')).assetChannels, null);
	// One channel, counted while it is open and while it is closing.
	const { h, channel } = await channelled();
	await h.host.pass();
	assert.equal((await h.get('/status')).assetChannels, 1);
	await h.call('POST /channels/close', { channelId: channel.channelId });
	await h.host.pass();
	assert.equal((await h.get('/status')).assetChannels, 1);
	// A wallet with no Lightning side for its assets has none.
	const plain = harness();
	made.push(plain);
	await plain.boot();
	assert.equal((await plain.get('/status')).assetChannels, 0);
});

test('a peer\'s asset of a group this wallet has never held is taken: the issuance that made the group is fetched from the proof server for the library to verify', async () => {
	const { h, asset } = await funded();
	const group = `02${'9c'.repeat(32)}`;
	const offer = (id) => h.ln.offer({ pendingChannelId: id, assets: [{ assetId: asset.assetId, amount: 10n }], groupKey: group });
	// The library is handed a way to ask, in its own values.
	const given = h.ln.state.options;
	assert.equal(typeof given.groupProofResolver, 'function');
	// A group the wallet already knows needs nothing fetched.
	assert.equal(await offer('01'.repeat(32)), true);
	assert.equal(h.world.fetched.some((f) => f.groupKey), false);
	// One it has never held: asked of the wallet's own proof server, by the group's key.
	h.ln.opts.knowsGroups = false;
	assert.equal(await offer('02'.repeat(32)), true);
	assert.deepEqual(h.world.fetched.filter((f) => f.groupKey).map((f) => f.groupKey), [group]);
	assert.deepEqual(named(h, 'groupProof'), [['groupProof', group]]);
	assert.deepEqual(h.ln.violations, []);
	// A proof server that does not have it, or answers with another group's, and the open is not taken.
	h.tap.opts.groupMissing = true;
	await assert.rejects(offer('03'.repeat(32)));
	h.tap.opts.groupMissing = false;
	h.tap.opts.groupWrong = true;
	assert.equal(await offer('04'.repeat(32)), false);
});

test('a fee budget for channel fees that the loop meets used up is a warning in the status, gone with the first pass that does not meet it', async () => {
	const { h } = await channelled();
	const warnings = async () => ((await h.get('/status')).lightning.warnings || []).map((w) => w.code);
	const said = 'The budget this app sets for the miner fees of asset channels is used up, so nothing was done. Nothing was lost: the channels and what is in them are as they were.';
	await h.host.pass();
	assert.deepEqual(await warnings(), []);
	// Carrying a channel on: the engine refuses the fee action, inside what the library throws.
	h.ln.opts.resumeFails = 'FEE_BUDGET_EXHAUSTED';
	const told = events(h, 'status').length;
	await h.host.pass();
	assert.deepEqual((await h.get('/status')).lightning.warnings, [{ code: 'FEE_BUDGET_EXHAUSTED', text: said }]);
	assert.equal((await h.get('/status')).lightning.warning, said);
	assert.equal(events(h, 'status').length > told, true);
	// The loop goes on all the same, and the channel is as it was.
	assert.equal((await h.get('/channels')).channels[0].state, 'NORMAL');
	await h.host.pass();
	assert.deepEqual(await warnings(), ['FEE_BUDGET_EXHAUSTED']);
	h.ln.opts.resumeFails = null;
	await h.host.pass();
	assert.deepEqual(await warnings(), []);
	// Bringing a closed channel's assets home reports it as data, by name.
	await h.call('POST /channels/close', { channelId: (await h.get('/channels')).channels[0].channelId, force: true });
	h.ln.opts.recoveryErrors = ['the sweep was not bumped: FEE_BUDGET_EXHAUSTED'];
	await h.host.pass();
	assert.deepEqual(await warnings(), ['FEE_BUDGET_EXHAUSTED']);
	h.ln.opts.recoveryErrors = [];
	await h.host.pass();
	assert.deepEqual(await warnings(), []);
	// Another failure of the loop's is not taken for it.
	h.ln.opts.resumeFails = 'ERR_SOMETHING_NOBODY_NAMED';
	await h.host.pass();
	assert.deepEqual(await warnings(), []);
});
