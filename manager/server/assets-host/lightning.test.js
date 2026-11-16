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
		state: 'AWAITING_FUNDING_CONFIRMED',
		asset: { key: asset.key, assetId: asset.assetId, name: 'coin', type: 'normal', decimalDisplay: 2 },
		capacity: '600',
		localBalance: '600',
		remoteBalance: '0',
		sendable: '0',
		receivable: '0',
		channelSats: 100000
	});
	assert.deepEqual(events(h, 'channel'), [
		{ channelId: id, state: 'OPENING' },
		{ channelId: flow.channelId, state: 'AWAITING_FUNDING_CONFIRMED' }
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
	// And a restart does not open it a second time: the library has it.
	const again = h.restart();
	made.push(again);
	await again.boot();
	assert.equal(named(again, 'openChannel').length, 1);
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
		invoiceExpiresAt: h.clock.t + 3600000,
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
	assert.deepEqual(named(h, 'createInvoice')[0][1], { quoteId: quote.quoteId, description: 'tea', expirySeconds: 3600 });
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

test('a payment that fails says why, and can be tried again with a new key', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const quote = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	h.ln.opts.payStatus = 'failed';
	const answer = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: '50' }, 'pay-key');
	assert.deepEqual(answer, { status: 'FAILED', paymentHash: answer.paymentHash, assetAmount: '50', feeSats: null, failureDescription: 'No route to the recipient.' });
	const row = (await h.get('/activity', 'kind=ln-send')).rows[0];
	assert.deepEqual([row.state, row.failed, row.failure], ['failed', true, { code: 'PAYMENT_FAILED', message: 'No route to the recipient.' }]);
	// Nothing left the channel.
	assert.equal((await h.get('/channels')).channels[0].localBalance, '600');

	// The library refusing outright reads the same way, in the host's words.
	h.ln.payments.clear();
	h.ln.opts.payStatus = 'complete';
	h.ln.opts.payFails = 'ERR_BEIGNET_LN_PEER_OFFLINE';
	const second = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	const offline = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: second.quoteId, maxAssetAmount: '50' }, 'second-key');
	assert.deepEqual([offline.status, offline.failureDescription], ['FAILED', 'The peer is not connected, so nothing was done. Try again once it is back.']);

	h.ln.opts.payFails = null;
	const third = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	const paid = await h.call('POST /pay', { bolt11, key: asset.key, quoteId: third.quoteId, maxAssetAmount: '50' }, 'third-key');
	assert.equal(paid.status, 'COMPLETED');
	assert.equal((await h.get('/activity', 'kind=ln-send')).rows.length, 1);
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

test('a restart between the row and the payment: nothing was sent, and the row says so', async () => {
	const { h, asset } = await channelled();
	const bolt11 = fakeInvoice({ msat: 50000 });
	const quote = await h.call('POST /pay/quote', { bolt11, key: asset.key });
	// The library never answers, and the process dies.
	h.ln.payInvoice = () => new Promise(() => undefined);
	const body = { bolt11, key: asset.key, quoteId: quote.quoteId, maxAssetAmount: '50' };
	h.call('POST /pay', body, 'pay-key').catch(() => undefined);
	for (let i = 0; i < 50 && keys(h, 'row/ln-send-').length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
	assert.equal(keys(h, 'row/ln-send-').length, 1);
	// While the request is out, the loop leaves its row alone.
	await h.host.pass();
	assert.equal((await h.get('/activity', 'kind=ln-send')).rows[0].state, 'pending');

	const again = h.restart();
	made.push(again);
	await again.boot();
	const row = (await again.get('/activity', 'kind=ln-send')).rows[0];
	assert.deepEqual([row.state, row.failure], ['failed', { code: 'PAYMENT_NOT_SENT', message: 'The wallet restarted before this payment was sent. Nothing was paid.' }]);
	const replay = await again.call('POST /pay', body, 'pay-key');
	assert.deepEqual([replay.status, replay.failureDescription], ['FAILED', 'The wallet restarted before this payment was sent. Nothing was paid.']);
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
