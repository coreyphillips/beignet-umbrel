'use strict';

/**
 * Asset channels over a stand-in wallet, library and Lightning service
 * (test-fakes.js): the nine routes, and the rules that protect funds in
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
	for (const route of LIGHTNING_ROUTES.filter((r) => !['GET /channels', 'POST /channels/close'].includes(r))) {
		assert.deepEqual(await codeOf(ask(h, route, {}, undefined)), ['LIGHTNING_UNAVAILABLE', 409], route);
	}
	// Closing works on what there is, and here there is nothing.
	assert.deepEqual(await codeOf(h.call('POST /channels/close', { channelId: 'ab'.repeat(32) })), ['CHANNEL_NOT_FOUND', 404]);
});

test('a Lightning service that will not start leaves the wallet its assets and no Lightning', async () => {
	const h = world({ lightning: true });
	h.ln.start = async () => {
		throw new Error('the node is too old for this');
	};
	await h.boot();
	assert.deepEqual((await h.get('/status')).lightning, { mode: 'off', usableChannels: 0 });
	assert.deepEqual(await codeOf(h.call('POST /channels/quote', {})), ['LIGHTNING_UNAVAILABLE', 409]);
	const mint = await h.call('POST /mint', { seedlings: [COIN], feeRate: 2 }, 'mint-key');
	assert.equal(mint.row.kind, 'mint');
});

test('before the engine has handed over its node, nothing is read as "no channels"', async () => {
	const h = world({ lightning: 'unbound' });
	await h.boot();
	assert.deepEqual((await h.get('/status')).lightning, { mode: 'full', usableChannels: 0 });
	for (const route of ['GET /channels', 'POST /channels/quote', 'POST /channels/close', 'POST /invoices/quote', 'POST /pay/quote']) {
		const err = await refused(ask(h, route, {}, undefined));
		assert.deepEqual([err.extensionCode, err.status, err.message], ['ASSETS_STARTING', 503, 'Lightning is still starting. Try again in a moment.'], route);
	}
	// The node arrives: the next pass settles what a restart left, and the routes answer.
	h.ln.attachment.bind({ the: 'node' });
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
		channelSats: 100000
	});
	// Still opening once the engine has it, and told again under the engine's id.
	assert.deepEqual(events(h, 'channel'), [
		{ channelId: id, state: 'OPENING' },
		{ channelId: flow.channelId, state: 'OPENING' }
	]);
	// The units left the chain for the channel: the same total, held two ways.
	assert.deepEqual((await h.get('/balances')).assets[0].balance, {
		total: '1000',
		onchain: '400',
		pendingIn: '0',
		pendingOut: '0',
		channelLocal: '600',
		lightningSendable: '0',
		lightningReceivable: '0'
	});
	assert.deepEqual((await h.get('/status')).lightning, { mode: 'full', usableChannels: 0 });
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
	// Its units left the on-chain records for the channel, and are in the books there.
	const total = async (w) => {
		const { balance } = (await w.get('/balances')).assets[0];
		return [balance.total, balance.onchain, balance.channelLocal];
	};
	assert.deepEqual(await total(h), ['1000', '400', '600']);

	// Whatever the flow's phase says, a signed funding transaction is a channel in being.
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
	assert.equal(close.message, 'This channel is still being opened, and its funding transaction is already signed. It can be closed once it is on the chain.');
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
	const flow = (id, extra) =>
		h.ln.flows.set(id, {
			pendingChannelId: id,
			channelId: null,
			peerPubkey: PEER.pubkey,
			initiator: true,
			phase: 'accepted',
			signed: false,
			confirmed: false,
			state: null,
			assetId: asset.assetId,
			groupKey: null,
			local: 100n,
			remote: 0n,
			reserved: 0n,
			fundingSats: 100000,
			reserveSats: null,
			recovery: 'none',
			...extra
		});
	flow('aa'.repeat(32), {});
	flow('bb'.repeat(32), { signed: true, phase: 'broadcasting' });
	// One a peer began is not this wallet's to cancel.
	flow('cc'.repeat(32), { initiator: false });
	const again = h.restart();
	made.push(again);
	await again.boot();
	assert.deepEqual(named(again, 'cancelFlow').map((c) => c[1]), ['aa'.repeat(32)]);
	assert.deepEqual([...again.ln.flows.keys()].sort(), ['bb'.repeat(32), 'cc'.repeat(32)]);
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
	h.ln.state.bound = false;
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
	assert.equal(err.message, 'This channel is still being opened, and its funding transaction is already signed. It can be closed once it is on the chain.');
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
	const kept = (await h.call('POST /channels/open', openBody(asset, '100'), 'kept-key')).pendingChannelId;
	h.ln.opts.openTimesOut = false;
	h.ln.flows.delete(lost);
	h.ln.set(kept, { signed: true, phase: 'failed' });
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
	h.ln.flows.set(id, {
		pendingChannelId: id,
		channelId: null,
		peerPubkey: PEER.pubkey,
		initiator: true,
		phase: 'accepted',
		signed: false,
		confirmed: false,
		state: null,
		assetId: asset.assetId,
		groupKey: null,
		local: 100n,
		remote: 0n,
		reserved: 0n,
		fundingSats: 100000,
		reserveSats: null,
		recovery: 'none'
	});
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
	h.ln.state.bound = false;
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
	assert.deepEqual(named(h, 'quoteInvoice')[0][1], { assetId: asset.assetId, groupKey: null, amount: 150n, peerPubkey: channel.peerPubkey });
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
	const options = h.ln.state.options;
	const offer = (id) => options.acceptIncoming({ pendingChannelId: id, peerPubkey: `03${'cd'.repeat(32)}`, assets: [{ assetId: asset.assetId, amount: 10n }], groupKey: null });
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
		warning: 'The assets of a closed channel have not come back on-chain yet. The wallet keeps trying, and its log says why.'
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
	// Another key for an invoice already paid is refused, with a new price or without one.
	const next = await again.call('POST /pay/quote', { bolt11, key: asset.key });
	assert.deepEqual(await codeOf(again.call('POST /pay', { ...body, quoteId: next.quoteId }, 'other-key')), ['ALREADY_PAID', 409]);
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
	h.clock.t += 60001;
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
	const answer = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: '50' }, 'pay-key');
	const said = 'No route to the recipient could be found, so nothing was paid.';
	assert.deepEqual(answer, { status: 'FAILED', paymentHash: answer.paymentHash, assetAmount: '50', feeSats: null, failureDescription: said });
	const row = (await h.get('/activity', 'kind=ln-send')).rows[0];
	assert.deepEqual([row.state, row.failed, row.failure], ['failed', true, { code: 'PAYMENT_FAILED', message: said }]);
	// Nothing left the channel.
	assert.equal((await h.get('/channels')).channels[0].localBalance, '600');

	// A reason the host has no words for is not passed on as the node wrote it.
	h.ln.opts.payFailure = 'htlc 7 failed at 03aa: temporary_channel_failure (0x1007)';
	const second = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	const odd = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: second.quoteId, maxAssetAmount: '50' }, 'second-key');
	assert.deepEqual([odd.status, odd.failureDescription], ['FAILED', 'The payment did not go through, so nothing was paid.']);
	assert.equal(JSON.stringify(await h.get('/activity', 'kind=ln-send')).includes('temporary_channel_failure'), false);

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
	const body = { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: '50' };
	// The node has the payment, and the call that handed it over times out.
	h.ln.opts.payThrowsAfter = 'ERR_BEIGNET_LN_TIMEOUT';
	h.cfg.payWaitMs = 10;
	const answer = await h.call('POST /pay', body, 'pay-key');
	assert.deepEqual([answer.status, answer.failureDescription], ['PENDING', null]);
	await h.host.pass();
	assert.equal((await h.get('/activity', 'kind=ln-send')).rows[0].state, 'pending');
	// It is in flight: the same invoice is not paid a second time.
	const other = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	assert.deepEqual(await codeOf(h.call('POST /pay', { ...body, quoteId: other.quoteId }, 'other-key')), ['PAYMENT_IN_FLIGHT', 409]);

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
	const retry = async (key) => {
		const again = await h.call('POST /pay/quote', { bolt11, key: asset.key });
		return codeOf(h.call('POST /pay', { bolt11, key: asset.key, quoteId: again.quoteId, maxAssetAmount: '50' }, key));
	};
	// The row says failed, and the node says it is still trying, or that it got through.
	h.ln.payments.get(first.paymentHash).status = 'pending';
	assert.deepEqual(await retry('second-key'), ['PAYMENT_IN_FLIGHT', 409]);
	h.ln.payments.get(first.paymentHash).status = 'complete';
	assert.deepEqual(await retry('third-key'), ['ALREADY_PAID', 409]);
	assert.equal(named(h, 'payInvoice').length, 1);
	// A node that cannot be asked is not taken to have said no.
	h.ln.payments.get(first.paymentHash).status = 'failed';
	const real = h.ln.payment;
	h.ln.payment = () => {
		throw Object.assign(new Error('not ready'), { code: 'ERR_BEIGNET_LN_NOT_READY' });
	};
	assert.deepEqual(await retry('fourth-key'), ['ASSETS_STARTING', 503]);
	h.ln.payment = real;
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
	h.ln.opts.payStatus = 'pending';
	h.cfg.payWaitMs = 10;
	const body = { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: '50' };
	const answer = await h.call('POST /pay', body, 'pay-key');
	assert.deepEqual(answer, { status: 'PENDING', paymentHash: answer.paymentHash, assetAmount: '50', feeSats: null, failureDescription: null });
	assert.equal((await h.get('/activity', 'kind=ln-send')).rows[0].state, 'pending');
	// Asked again with the same key: the same payment, not another.
	assert.equal((await h.call('POST /pay', body, 'pay-key')).status, 'PENDING');
	// A second payment of the same invoice is not begun while this one is out.
	const other = await h.call('POST /pay/quote', { bolt11, key: asset.key });
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
	h.ln.payInvoice = () => new Promise(() => undefined);
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
	h.ln.state.bound = false;
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
	assert.equal(await waiting.ln.state.options.acceptIncoming({ pendingChannelId: '01'.repeat(32), peerPubkey: PEER.pubkey, assets: [{ assetId: channel.asset.assetId, amount: 1n }] }), false);

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
	const options = h.ln.state.options;
	const offer = (id, assetId = asset.assetId) => options.acceptIncoming({ pendingChannelId: id, peerPubkey: `03${'cd'.repeat(32)}`, assets: [{ assetId, amount: 10n }], groupKey: null });
	assert.equal(await offer('01'.repeat(32)), true);
	// One the proof server has never heard of is turned down.
	assert.equal(await offer('02'.repeat(32), 'ee'.repeat(32)), false);
	assert.equal(await offer('03'.repeat(32), 'not hex'), false);
	assert.equal(await options.acceptIncoming({ pendingChannelId: '04'.repeat(32), peerPubkey: PEER.pubkey, assets: [] }), false);
	// Four at a time, and no more until one is open.
	for (const n of ['05', '06', '07']) assert.equal(await offer(n.repeat(32)), true);
	assert.equal(await offer('08'.repeat(32)), false);
	// The same offer asked again is still the same one.
	assert.equal(await offer('01'.repeat(32)), true);

	const off = world({ lightning: true, env: { BEIGNET_ASSETS_LIGHTNING: 'off' } });
	await off.boot();
	assert.equal(await off.ln.state.options.acceptIncoming({ pendingChannelId: '09'.repeat(32), peerPubkey: PEER.pubkey, assets: [{ assetId: asset.assetId, amount: 10n }] }), false);
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
	const options = h.ln.state.options;
	assert.deepEqual(Object.keys(options).sort(), ['acceptIncoming', 'adapter', 'fetchProof', 'lib', 'onEvent', 'quiet']);
	assert.equal(options.adapter, h.tap);
	assert.equal(options.lib, h.host.lib);
	// A proof is fetched from the wallet's own proof server.
	const locator = { assetId: asset.assetId, scriptKey: `02${'11'.repeat(32)}`, anchorOutPoint: `${'22'.repeat(32)}:0` };
	const file = await options.fetchProof(locator);
	assert.ok(Buffer.isBuffer(file));
	assert.deepEqual(h.world.fetched.pop(), { uri: 'universerpc://universe.example.com:10029', locator });
	// Called from inside a section of the host, a callback still starts outside it.
	const seen = [];
	h.ln.state.options = lightning.startOptions(h.host);
	await h.host.lock.run(async () => {
		assert.equal(h.host.lock.held(), true);
		const real = h.host.courierFor;
		h.host.courierFor = (uri) => {
			seen.push(h.host.lock.held());
			return real(uri);
		};
		await h.ln.state.options.fetchProof(locator);
		h.host.courierFor = real;
	});
	assert.deepEqual(seen, [false]);
	// An event is a reason to look, and never throws back into the library.
	for (const event of [{ type: 'channel' }, { type: 'invoice' }, { type: 'payment' }, { type: 'recovery' }, {}, null]) options.onEvent(event);
});

/* ------------------------------------------------------------------ backup */

test('the backup leaves out what only this machine can honour, and keeps the activity', async () => {
	const { h, asset, id } = await channelled({ remote: 200n });
	const quote = await h.call('POST /invoices/quote', { key: asset.key, amount: '150' });
	const invoice = await h.call('POST /invoices', { key: asset.key, amount: '150', quoteId: quote.quoteId });
	await h.call('POST /invoices/quote', { key: asset.key, amount: '10' });
	// What the library keeps of its own, as the real one would.
	for (const key of ['l/tap/quotes/aa', 'l/lightning/invoice/bb', 'l/native-lightning/v1/destination/cc', 'l/native-recovery/v1/job/dd']) h.storage.set(key, 'x');
	const kept = backup.collectRows(h.storage).map(([key]) => key);
	assert.ok(kept.includes(`h/row/ln-receive-${invoice.paymentHash}`));
	assert.ok(kept.includes('l/native-lightning/v1/destination/cc'));
	assert.ok(kept.includes('l/native-recovery/v1/job/dd'));
	for (const gone of [`h/chan/${id}`, `h/committed/funding:${id}`, `h/inv/${invoice.paymentHash}`, 'l/tap/quotes/aa', 'l/lightning/invoice/bb']) {
		assert.equal(kept.includes(gone), false, gone);
	}
	assert.equal(kept.some((key) => key.startsWith('h/l-quote/') || key.startsWith('h/idem/')), false);
	// The marker of a mint is not a channel's, and stays.
	assert.equal(kept.filter((key) => key.startsWith('h/committed/')).length, 1);
});

test('a backup is never restored over an asset channel, and never replaces a Lightning row', async () => {
	const { h, id, channel } = await channelled();
	const file = { format: backup.FORMAT, version: backup.VERSION, network: 'regtest', chain: 'regtest', wallet: await h.host.fingerprint(), exportedAt: 1, rows: backup.collectRows(h.storage) };
	file.rowsHash = backup.hashRows(file.rows);
	const live = await refused(h.call('POST /backup/import', { backup: file }));
	assert.deepEqual([live.extensionCode, live.status], ['ASSET_CHANNELS_OPEN', 409]);
	assert.equal(live.message, 'This wallet has an asset channel, and a backup is never restored over one. Close its asset channels first.');

	// Once it is closed and its assets are home, a backup is taken again.
	await h.call('POST /channels/close', { channelId: channel.channelId, force: false });
	assert.deepEqual(await codeOf(h.call('POST /backup/import', { backup: file })), ['ASSET_CHANNELS_OPEN', 409]);
	h.ln.recover(id);
	await h.host.pass({ block: true });
	const now = { ...file, rows: backup.collectRows(h.storage) };
	now.rowsHash = backup.hashRows(now.rows);
	assert.deepEqual(await h.call('POST /backup/import', { backup: now }), { imported: 0, same: true });

	// A Lightning row the wallet has is its own. One it lacks is taken.
	h.storage.set('l/native-recovery/v1/job/aa', 'mine');
	const rows = [...backup.collectRows(h.storage).filter(([key]) => !key.startsWith('l/')), ['l/native-recovery/v1/job/aa', 'theirs'], ['l/native-recovery/v1/job/bb', 'new'], ['l/tap/quotes/cc', 'a price']].sort(([a], [b]) => (a < b ? -1 : 1));
	const res = backup.importBackup({ storage: h.storage, cfg: h.cfg, fingerprint: await h.host.fingerprint(), backup: { ...file, rows, rowsHash: backup.hashRows(rows) } });
	assert.equal(res.imported, 1);
	assert.equal(h.storage.get('l/native-recovery/v1/job/aa'), 'mine');
	assert.equal(h.storage.get('l/native-recovery/v1/job/bb'), 'new');
	assert.equal(h.storage.get('l/tap/quotes/cc'), null);
});

test('a backup left for a wallet with Lightning rows of its own is not restored before its node can be asked', async () => {
	const fs = require('fs');
	const os = require('os');
	const path = require('path');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-ln-'));
	try {
		const source = await funded();
		const file = { format: backup.FORMAT, version: backup.VERSION, network: 'regtest', chain: 'regtest', wallet: await source.h.host.fingerprint(), exportedAt: 1, rows: backup.collectRows(source.h.storage) };
		file.rowsHash = backup.hashRows(file.rows);
		const importFile = path.join(dir, 'import.json');
		fs.writeFileSync(importFile, JSON.stringify(file));
		const h = world({ lightning: true, env: { BEIGNET_ASSETS_IMPORT_FILE: importFile } });
		h.storage.set('l/native-lightning/v1/channel/aa', 'a channel');
		await h.boot();
		assert.match((await h.get('/status')).backup.importError, /^This wallet has Lightning records of its own, so the backup was left alone\./);
		assert.equal(fs.existsSync(importFile), true);
		assert.deepEqual((await h.get('/balances')).assets, []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
