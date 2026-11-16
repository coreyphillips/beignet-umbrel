'use strict';

/**
 * The assets host over a stand-in wallet and library (test-fakes.js): the
 * rules that protect funds, checked where they can go wrong.
 *
 *   - a preview stops at the fee and is never broadcast by anything
 *   - the marker, the request key and the row are written in one step,
 *     before the library is told to go on
 *   - the same request key acts once, also after a restart
 *   - a preview lasts three minutes and there is one of them
 *   - at start, work that was never committed is cancelled, and committed
 *     work is not
 *   - a closed database stops the loop without a sound
 *
 * A restart here is a new host over the same storage.
 *
 * Run: cd manager && npm test
 * Or:  cd manager && node --test server/assets-host/host.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { harness, refused, encodeFake, fakeProof } = require('./test-fakes');
const { STATES } = require('./adapter');
const { stepFailure, STEP_WAIT_MS, STEP_WAIT_MAX_MS } = require('./service');

const B = STATES.Batch;
const S = STATES.Send;
const COURIER = 'universerpc://universe.example.com:10029';
const TTL = 3 * 60 * 1000;

const COIN = { name: 'coin', type: 'normal', amount: '1000', decimalDisplay: 2, meta: null, group: { mode: 'none' } };
const mintBody = (extra = {}) => ({ seedlings: [COIN], feeRate: 2, ...extra });

let serial = 9000;
/** An address of some other wallet, for `amount` of `asset`. */
const foreign = (asset, amount = '250', extra = {}, hrp) =>
	encodeFake({ n: (serial += 1), assetId: asset.assetId, groupKey: null, amount, courier: COURIER, version: 1, ...extra }, hrp);

const keys = (h, prefix) => h.storage.list(`h/${prefix}`).map((r) => r.key);
const rowOf = async (h, id) => (await h.get('/activity')).rows.find((r) => r.id === id) || null;
const named = (h, name) => h.tap.calls.filter((c) => c[0] === name);
const count = (h, event) => h.events.filter(([name]) => name === event).length;
const reserved = (h) => h.tap.records.filter((r) => r.reservedBy).length;

/** A wallet that minted 1000 coin, confirmed. */
async function funded(opts) {
	const h = harness(opts);
	await h.boot();
	const mint = await h.call('POST /mint', mintBody(), 'mint-key');
	await h.confirm(mint.row.txid);
	const asset = (await h.get('/balances')).assets[0];
	return { h, mint, asset };
}

/** The same, with a send previewed and waiting to be committed. */
async function previewed(amount = '250') {
	const ctx = await funded();
	const address = foreign(ctx.asset, amount);
	const preview = await ctx.h.call('POST /send/prepare', { address, feeRate: 2 }, 'prepare-key');
	const parcel = [...ctx.h.tap.parcels.values()].pop();
	return { ...ctx, address, preview, parcel };
}

/* ----------------------------------------------------------------- reading */

test('an empty wallet: status, balances and activity answer', async () => {
	const h = harness();
	await h.boot();
	const status = await h.get('/status');
	assert.equal(status.phase, 'ready');
	assert.equal(status.ready, true);
	assert.equal(status.holdsAssets, false);
	assert.deepEqual(status.lightning, { mode: 'off', usableChannels: 0 });
	assert.equal(status.proofServer.reachable, true);
	assert.deepEqual(await h.get('/balances'), { assets: [], btc: { anchorSats: 0, anchorCount: 0, spendableSats: 500000 } });
	assert.deepEqual(await h.get('/activity'), { rows: [], nextBefore: null });
	assert.equal(count(h, 'status') >= 1, true);
});

test('nothing that spends is served before the start sequence has run', async () => {
	const h = harness();
	await h.host.attach();
	assert.equal((await h.get('/status')).ready, false);
	const asset = { assetId: 'ab'.repeat(32) };
	for (const [route, body] of [
		['POST /mint', mintBody()],
		['POST /send/prepare', { address: foreign(asset), feeRate: 2 }],
		['POST /burn/prepare', { assetId: asset.assetId, amount: '1', feeRate: 2 }],
		['POST /send/commit', { previewId: 'anything' }],
		['POST /mint/quote', { count: 1, feeRate: 2 }]
	]) {
		const err = await refused(h.call(route, body, 'a-key'));
		assert.equal(err.extensionCode, 'ASSETS_STARTING', route);
		assert.equal(err.status, 503, route);
	}
	assert.deepEqual(h.tap.calls, []);
});

/* ------------------------------------------------------------------- mints */

test('a mint: the marker, the request key and the row are written before the transaction is signed', async () => {
	const h = harness();
	await h.boot();
	const seen = [];
	const advance = h.tap.minter.advance.bind(h.tap.minter);
	h.tap.minter.advance = async (id, target) => {
		seen.push({ target, marker: !!h.host.rows.get(`committed/${id}`), row: !!h.host.rows.get(`row/mint-${id}`), journal: keys(h, 'idem/mint/').length });
		return advance(id, target);
	};
	const { row } = await h.call('POST /mint', mintBody(), 'mint-key');
	assert.deepEqual(seen, [
		{ target: B.Committed, marker: false, row: false, journal: 0 },
		{ target: B.Broadcast, marker: true, row: true, journal: 1 }
	]);
	assert.equal(row.kind, 'mint');
	assert.equal(row.state, 'broadcast');
	assert.match(row.txid, /^[0-9a-f]{64}$/);
	assert.deepEqual([row.feeSats, row.satsPerVbyte, row.anchorSats, row.confirmations], [306, 2, 1000, 0]);
	assert.deepEqual(row.assets.map((a) => [a.name, a.type, a.amount, a.decimalDisplay]), [['coin', 'normal', '1000', 2]]);
	assert.equal(h.events.some(([name, data]) => name === 'mint' && data.row.id === row.id), true);
	// The fee ceiling goes to the library with the request.
	assert.deepEqual(named(h, 'minter.freeze'), [['minter.freeze', 2, 250000n]]);
});

test('a mint: the same key answers the same row and mints once, also after a restart', async () => {
	const h = harness();
	await h.boot();
	const first = await h.call('POST /mint', mintBody(), 'mint-key');
	const second = await h.call('POST /mint', mintBody(), 'mint-key');
	assert.equal(second.row.id, first.row.id);
	assert.equal(second.row.txid, first.row.txid);

	const again = h.restart();
	await again.boot();
	const third = await again.call('POST /mint', mintBody(), 'mint-key');
	assert.equal(third.row.id, first.row.id);
	assert.equal(third.row.txid, first.row.txid);
	assert.equal(again.tap.batches.size, 1);
	assert.equal(named(again, 'minter.queue').length, 1);

	// The answer is the row as it is now, not as it was.
	await again.confirm(first.row.txid);
	assert.equal((await again.call('POST /mint', mintBody(), 'mint-key')).row.state, 'complete');

	const reused = await refused(again.call('POST /mint', mintBody({ feeRate: 3 }), 'mint-key'));
	assert.equal(reused.extensionCode, 'IDEMPOTENCY_KEY_REUSED');
	assert.equal(reused.status, 409);
	assert.equal(again.tap.batches.size, 1);
});

test('a mint above the fee the request allows is refused and leaves nothing behind', async () => {
	const h = harness();
	await h.boot();
	const err = await refused(h.call('POST /mint', mintBody({ maxFeeSats: 100 }), 'mint-key'));
	assert.equal(err.extensionCode, 'FEE_TOO_HIGH');
	assert.deepEqual([keys(h, 'committed/'), keys(h, 'row/'), keys(h, 'idem/'), keys(h, 'asset/')], [[], [], [], []]);
	assert.equal([...h.tap.batches.values()].every((b) => b.state >= B.SeedlingCancelled), true);
	// The request's own ceiling is what the library is given when it is the lower one.
	assert.deepEqual(named(h, 'minter.freeze'), [['minter.freeze', 2, 100n]]);
	const ok = await h.call('POST /mint', mintBody({ maxFeeSats: 306 }), 'mint-key');
	assert.equal(ok.row.state, 'broadcast');
});

test('the fee ceilings of the environment hold for every mint', async () => {
	const h = harness({ env: { BEIGNET_ASSETS_MAX_FEE_SATS: '200', BEIGNET_ASSETS_MAX_FEE_RATE: '10' } });
	await h.boot();
	const sats = await refused(h.call('POST /mint', mintBody({ maxFeeSats: 9999 }), 'k1'));
	assert.equal(sats.extensionCode, 'FEE_TOO_HIGH');
	assert.deepEqual(named(h, 'minter.freeze'), [['minter.freeze', 2, 200n]]);
	const rate = await refused(h.call('POST /mint', mintBody({ feeRate: 11 }), 'k2'));
	assert.equal(rate.extensionCode, 'FEE_TOO_HIGH');
	assert.deepEqual([keys(h, 'committed/'), keys(h, 'row/'), keys(h, 'idem/')], [[], [], []]);
});

test('a mint the wallet cannot pay for says so and leaves nothing behind', async () => {
	const h = harness();
	await h.boot();
	h.tap.opts.fundFails = true;
	const err = await refused(h.call('POST /mint', mintBody(), 'mint-key'));
	assert.equal(err.extensionCode, 'INSUFFICIENT_BTC');
	assert.equal(err.status, 409);
	assert.deepEqual([keys(h, 'committed/'), keys(h, 'row/'), keys(h, 'idem/')], [[], [], []]);
	assert.equal([...h.tap.batches.values()].every((b) => b.state >= B.SeedlingCancelled), true);
});

test('a mint that was signed but not sent is kept, never cancelled, and sent by the loop', async () => {
	const h = harness();
	await h.boot();
	h.tap.opts.mintBroadcastFails = true;
	const { row } = await h.call('POST /mint', mintBody(), 'mint-key');
	const batch = [...h.tap.batches.values()][0];
	assert.equal(row.state, 'pending');
	assert.equal(row.failure.code, 'BROADCAST_FAILED');
	assert.equal(row.failure.retrying, true);
	assert.equal(keys(h, 'committed/').length, 1);

	// Still failing across a restart: it is committed work, so it stays.
	const again = h.restart();
	await again.boot();
	assert.equal(batch.state, B.Committed);
	assert.deepEqual(named(again, 'minter.cancel'), []);
	assert.equal((await again.call('POST /mint', mintBody(), 'mint-key')).row.id, row.id);

	again.tap.opts.mintBroadcastFails = false;
	await again.host.pass();
	const sent = await rowOf(again, row.id);
	assert.equal(sent.state, 'broadcast');
	assert.equal(sent.failure, null);
	assert.equal(batch.state, B.Broadcast);
});

test('a mint: amounts are whole numbers in a string, as large as the protocol allows', async () => {
	const h = harness();
	await h.boot();
	const big = '18446744073709551615';
	const { row } = await h.call('POST /mint', mintBody({ seedlings: [{ ...COIN, amount: big }] }), 'big');
	assert.equal(row.assets[0].amount, big);
	for (const amount of ['0', '1.5', '-1', '', 'ten', '99999999999999999999999']) {
		const err = await refused(h.call('POST /mint', mintBody({ seedlings: [{ ...COIN, name: 'other', amount }] }), `bad-${amount}`));
		assert.equal(err.extensionCode, 'BAD_AMOUNT', `amount ${JSON.stringify(amount)}`);
	}
	assert.equal((await refused(h.call('POST /mint', { seedlings: [], feeRate: 2 }, 'none'))).extensionCode, 'INVALID_PARAMS');
});

test('a mint quote is the wallet\'s own figure, and holds no coins afterwards', async () => {
	const h = harness();
	await h.boot();
	h.tap.calls.length = 0;
	const quote = await h.call('POST /mint/quote', { count: 2, feeRate: 2 });
	assert.deepEqual(quote, { feeSats: 306, vsize: 153, anchorSats: 1000, totalSats: 1306, spendableSats: 500000, sufficient: true, count: 2 });
	assert.deepEqual(h.tap.calls[h.tap.calls.length - 1], ['anchor.releaseFunding', 'host-quote']);
	h.tap.opts.fundFails = true;
	const guess = await h.call('POST /mint/quote', { count: 1, feeRate: 2 });
	assert.equal(guess.sufficient, false);
	assert.equal(guess.totalSats, guess.feeSats + 1000);
	assert.equal('onHandSats' in guess, false, 'it holds the working amount, so that is not what stopped it');
	// A wallet that holds the cost and not what the transaction is built around is told the larger figure.
	h.wallet.getBalanceBreakdown = () => ({ total: 3300, spendable: 3300, frozen: 0 });
	const thin = await h.call('POST /mint/quote', { count: 1, feeRate: 2 });
	assert.deepEqual([thin.sufficient, thin.totalSats, thin.spendableSats, thin.onHandSats], [false, 1308, 3300, 4308]);
	h.wallet.getBalanceBreakdown = () => ({ total: 500000, spendable: 500000, frozen: 0 });
	assert.equal((await refused(h.call('POST /mint/quote', { count: 1, feeRate: 9999 }))).extensionCode, 'FEE_TOO_HIGH');
});

test('a finished mint whose proof the server did not take says so and asks again later', async () => {
	const h = harness();
	await h.boot();
	const { row } = await h.call('POST /mint', mintBody(), 'mint-key');
	h.world.net.down = true;
	await h.confirm(row.txid);
	const held = await rowOf(h, row.id);
	assert.equal(held.state, 'complete');
	assert.equal(held.failure.code, 'COURIER_UNREACHABLE');
	assert.equal(held.failure.retrying, true);
	assert.equal(keys(h, 'publish/').length, 1);
	assert.equal((await h.get('/balances')).assets[0].balance.onchain, '1000');

	// Not asked again straight away, however often the loop runs.
	h.world.net.down = false;
	await h.host.pass({ block: true });
	assert.equal(h.world.delivered.length, 0);
	h.clock.t += 61 * 1000;
	await h.host.pass();
	assert.equal(h.world.delivered.length, 1);
	assert.equal(h.world.delivered[0].uri, COURIER);
	assert.deepEqual(keys(h, 'publish/'), []);
	assert.equal((await rowOf(h, row.id)).failure, null);
});

test('retrying a mint\'s proof asks the proof server at once', async () => {
	const h = harness();
	await h.boot();
	const { row } = await h.call('POST /mint', mintBody(), 'mint-key');
	h.world.net.down = true;
	await h.confirm(row.txid);
	h.world.net.down = false;
	const retried = await h.call('POST /proofs/retry', { id: row.id });
	assert.equal(retried.row.state, 'complete');
	assert.equal(retried.row.failure, null);
	assert.equal(h.world.delivered.length, 1);
	assert.equal((await refused(h.call('POST /proofs/retry', { id: 'mint-nothing' }))).extensionCode, 'NOT_FOUND');
});

/* ---------------------------------------------------------------- previews */

test('a prepared send stops at the fee: no marker, no row, nothing the loop will touch', async () => {
	const { h, address, preview, parcel } = await previewed();
	assert.deepEqual(Object.keys(preview), ['previewId', 'expiresAt', 'asset', 'amount', 'change', 'fee', 'btc', 'courier', 'warnings']);
	assert.deepEqual([preview.amount, preview.change], ['250', '750']);
	assert.deepEqual(preview.fee, { sats: 500, vbytes: 250, feeRate: 2 });
	assert.equal(preview.expiresAt, h.clock.t + TTL);
	assert.equal(preview.courier.host, 'universe.example.com:10029');
	assert.equal(parcel.state, S.StorePreBroadcast);
	assert.equal(parcel.maxFee, 250000n);
	assert.deepEqual(named(h, 'freighter.advance'), [['freighter.advance', parcel.id, S.StorePreBroadcast]]);
	assert.equal(h.host.rows.get(`committed/${parcel.id}`), null);
	assert.deepEqual(keys(h, 'row/').filter((k) => k.includes('send-')), []);

	await h.host.pass({ block: true });
	await h.host.pass();
	assert.equal(parcel.state, S.StorePreBroadcast);
	assert.equal(named(h, 'freighter.advance').length, 1);

	// The same key is the same preview, not a second parcel.
	assert.deepEqual(await h.call('POST /send/prepare', { address, feeRate: 2 }, 'prepare-key'), preview);
	assert.equal(h.tap.parcels.size, 1);
});

test('a commit writes the marker, the request key and the row, then tells the library to send', async () => {
	const { h, address, preview, parcel, asset } = await previewed();
	const seen = [];
	const advance = h.tap.freighter.advance.bind(h.tap.freighter);
	h.tap.freighter.advance = async (id, target) => {
		seen.push({
			target,
			marker: !!h.host.rows.get(`committed/${id}`),
			row: !!h.host.rows.get(`row/send-${id}`),
			journal: keys(h, 'idem/send/commit/').length,
			preview: !!h.host.rows.get('preview')
		});
		return advance(id, target);
	};
	const { row } = await h.call('POST /send/commit', { previewId: preview.previewId }, 'commit-key');
	assert.deepEqual(seen, [{ target: S.WaitTxConf, marker: true, row: true, journal: 1, preview: false }]);
	assert.equal(row.id, `send-${parcel.id}`);
	assert.deepEqual([row.kind, row.state, row.feeSats, row.address, row.courier], ['send', 'broadcast', 500, address, 'universe.example.com:10029']);
	assert.deepEqual(row.assets, [{ key: asset.key, assetId: asset.assetId, name: 'coin', type: 'normal', decimalDisplay: 2, amount: '250' }]);
	const during = (await h.get('/balances')).assets[0].balance;
	assert.deepEqual([during.onchain, during.pendingOut], ['750', '250']);

	h.tap.freighter.advance = advance;
	await h.confirm(row.txid);
	const done = await rowOf(h, row.id);
	assert.equal(done.state, 'complete');
	assert.equal(done.confirmations, 1);
	assert.ok(done.at.confirmed && done.at.completed);
	const after = (await h.get('/balances')).assets[0].balance;
	assert.deepEqual([after.onchain, after.pendingOut], ['750', '0']);
	assert.equal(h.events.some(([name, data]) => name === 'transfer' && data.row.state === 'complete'), true);
	assert.equal(h.events.some(([name, data]) => name === 'balance' && data.key === asset.key), true);
});

test('a commit: the same key sends once and answers the same row, also after a restart', async () => {
	const { h, preview } = await previewed();
	const first = await h.call('POST /send/commit', { previewId: preview.previewId }, 'commit-key');
	const second = await h.call('POST /send/commit', { previewId: preview.previewId }, 'commit-key');
	assert.equal(second.row.id, first.row.id);

	const again = h.restart();
	await again.boot();
	const third = await again.call('POST /send/commit', { previewId: preview.previewId }, 'commit-key');
	assert.equal(third.row.id, first.row.id);
	assert.equal(third.row.txid, first.row.txid);
	assert.equal(named(again, 'freighter.queueSend').length, 1);
	assert.equal(again.tap.parcels.size, 1);
	assert.deepEqual(named(again, 'freighter.cancel'), []);

	// The preview is spent: another key cannot commit it a second time.
	const spent = await refused(again.call('POST /send/commit', { previewId: preview.previewId }, 'another-key'));
	assert.equal(spent.extensionCode, 'PREVIEW_EXPIRED');
	assert.equal(spent.status, 410);
});

test('a preview is good for three minutes, and a late commit frees its coins', async () => {
	const { h, preview, parcel } = await previewed();
	h.clock.t += TTL + 1;
	const err = await refused(h.call('POST /send/commit', { previewId: preview.previewId }, 'commit-key'));
	assert.equal(err.extensionCode, 'PREVIEW_EXPIRED');
	assert.equal(err.status, 410);
	assert.equal(parcel.state, S.Cancelled);
	assert.equal(h.host.rows.get('preview'), null);
	assert.deepEqual([keys(h, 'committed/').length, keys(h, 'idem/send/commit/').length, reserved(h)], [1, 0, 0]);
	assert.deepEqual(named(h, 'freighter.advance').map((c) => c[2]), [S.StorePreBroadcast]);
});

test('a commit at the very end of the three minutes still goes through', async () => {
	const { h, preview } = await previewed();
	h.clock.t += TTL;
	const { row } = await h.call('POST /send/commit', { previewId: preview.previewId }, 'commit-key');
	assert.equal(row.state, 'broadcast');
});

test('the loop cancels a preview nobody committed', async () => {
	const { h, parcel } = await previewed();
	h.clock.t += TTL - 1;
	await h.host.pass();
	assert.equal(parcel.state, S.StorePreBroadcast);
	h.clock.t += 2;
	await h.host.pass();
	assert.equal(parcel.state, S.Cancelled);
	assert.equal(h.host.rows.get('preview'), null);
	assert.equal(reserved(h), 0);
	assert.equal((await h.get('/balances')).assets[0].balance.onchain, '1000');
});

test('there is one preview: a new one takes the place of the last and cancels it', async () => {
	const { h, preview, parcel, asset } = await previewed();
	const burn = await h.call('POST /burn/prepare', { key: asset.key, assetId: asset.assetId, amount: '100', feeRate: 2 }, 'burn-prepare');
	assert.equal(parcel.state, S.Cancelled);
	assert.equal(h.host.rows.get('preview').previewId, burn.previewId);
	assert.deepEqual([burn.amount, burn.change, burn.courier], ['100', '900', null]);
	assert.equal([...h.tap.parcels.values()].filter((p) => p.state !== S.Cancelled).length, 1);

	const old = await refused(h.call('POST /send/commit', { previewId: preview.previewId }, 'commit-key'));
	assert.equal(old.extensionCode, 'PREVIEW_EXPIRED');
	// A burn preview is not a send.
	assert.equal((await refused(h.call('POST /send/commit', { previewId: burn.previewId }, 'wrong-kind'))).extensionCode, 'PREVIEW_EXPIRED');

	// A burn is committed with the amount typed again.
	const mistyped = await refused(h.call('POST /burn/commit', { previewId: burn.previewId, confirmAmount: '1000' }, 'burn-typo'));
	assert.equal(mistyped.extensionCode, 'INVALID_PARAMS');
	assert.equal(h.host.rows.get('preview').previewId, burn.previewId);
	const { row } = await h.call('POST /burn/commit', { previewId: burn.previewId, confirmAmount: '100' }, 'burn-commit');
	assert.deepEqual([row.kind, row.state, row.assets[0].amount, row.address], ['burn', 'broadcast', '100', null]);
	await h.confirm(row.txid);
	const held = (await h.get('/balances')).assets[0];
	assert.deepEqual([held.balance.onchain, held.supply.burned], ['900', '100']);
});

test('cancelling a preview frees its coins, and cancelling twice is not an error', async () => {
	const { h, preview, parcel } = await previewed();
	// The wrong kind of cancel leaves it alone.
	assert.deepEqual(await h.call('POST /burn/cancel', { previewId: preview.previewId }), { cancelled: true });
	assert.equal(parcel.state, S.StorePreBroadcast);
	assert.deepEqual(await h.call('POST /send/cancel', { previewId: preview.previewId }), { cancelled: true });
	assert.equal(parcel.state, S.Cancelled);
	assert.equal(h.host.rows.get('preview'), null);
	assert.equal(reserved(h), 0);
	assert.deepEqual(await h.call('POST /send/cancel', { previewId: preview.previewId }), { cancelled: true });
});

test('a commit that fails before the library has stored that it will send is undone', async () => {
	const { h, preview, parcel } = await previewed();
	h.tap.opts.storeFails = true;
	const err = await refused(h.call('POST /send/commit', { previewId: preview.previewId }, 'commit-key'));
	assert.equal(err.extensionCode, 'WALLET_ERROR');
	assert.equal(parcel.state, S.Cancelled);
	assert.deepEqual([h.host.rows.get(`committed/${parcel.id}`), h.host.rows.get(`row/send-${parcel.id}`)], [null, null]);
	assert.deepEqual(keys(h, 'idem/send/commit/'), []);
	assert.equal(reserved(h), 0);
	assert.equal((await h.get('/balances')).assets[0].balance.onchain, '1000');
});

test('a commit whose transaction did not reach the network is kept and sent by the loop', async () => {
	const { h, preview, parcel } = await previewed();
	h.tap.opts.sendBroadcastFails = true;
	const { row } = await h.call('POST /send/commit', { previewId: preview.previewId }, 'commit-key');
	assert.equal(row.failure.code, 'BROADCAST_FAILED');
	assert.equal(row.failure.retrying, true);
	assert.equal(parcel.state, S.Broadcast);
	assert.ok(h.host.rows.get(`committed/${parcel.id}`));
	assert.deepEqual(named(h, 'freighter.cancel'), []);

	h.tap.opts.sendBroadcastFails = false;
	await h.host.pass();
	assert.equal(parcel.state, S.WaitTxConf);
	assert.equal((await rowOf(h, row.id)).failure, null);
});

test('a send is refused before anything is reserved when it cannot work', async () => {
	const { h, asset } = await funded();
	const made = await h.call('POST /addresses', { key: asset.key, amount: '5' });
	const cases = [
		[{ address: 'not an address', feeRate: 2 }, 'BAD_ADDRESS'],
		[{ address: '', feeRate: 2 }, 'BAD_ADDRESS'],
		[{ address: foreign(asset, '250', {}, 'tapbc'), feeRate: 2 }, 'WRONG_NETWORK'],
		[{ address: foreign(asset, '250', { version: 2 }), feeRate: 2 }, 'UNSUPPORTED_ADDRESS'],
		[{ address: foreign(asset, '250', { courier: 'universerpc://stranger.example.net:10029' }), feeRate: 2 }, 'UNKNOWN_COURIER'],
		[{ address: made.address.encoded, feeRate: 2 }, 'OWN_ADDRESS'],
		[{ address: foreign({ assetId: 'ee'.repeat(32) }, '1'), feeRate: 2 }, 'ASSET_NOT_FOUND'],
		[{ address: foreign(asset, '1001'), feeRate: 2 }, 'INSUFFICIENT_ASSET_BALANCE'],
		[{ address: foreign(asset), feeRate: 501 }, 'FEE_TOO_HIGH'],
		[{ address: foreign(asset), feeRate: 0 }, 'INVALID_PARAMS']
	];
	for (const [body, code] of cases) {
		const err = await refused(h.call('POST /send/prepare', body, `key-${code}`));
		assert.equal(err.extensionCode, code, `${code}: ${err.message}`);
		assert.match(err.message, /^[A-Z].*\.$/, code);
		assert.equal(h.host.rows.get('preview'), null, code);
		assert.equal(reserved(h), 0, code);
	}
	assert.equal([...h.tap.parcels.values()].every((p) => p.state === S.Cancelled), true);
	assert.deepEqual(keys(h, 'idem/send/'), []);
});

test('a preview whose fee is above the ceiling is refused and cancelled', async () => {
	const { h, asset } = await funded();
	h.tap.opts.parcelFee = 250001;
	const err = await refused(h.call('POST /send/prepare', { address: foreign(asset), feeRate: 2 }, 'prepare-key'));
	assert.equal(err.extensionCode, 'FEE_TOO_HIGH');
	assert.equal(h.host.rows.get('preview'), null);
	assert.equal([...h.tap.parcels.values()].every((p) => p.state === S.Cancelled), true);
	assert.equal(reserved(h), 0);
});

test('a burn takes a whole number of units the wallet holds', async () => {
	const { h, asset } = await funded();
	for (const amount of ['0', '1.5', '-1', '', 'all']) {
		const err = await refused(h.call('POST /burn/prepare', { key: asset.key, assetId: asset.assetId, amount, feeRate: 2 }, `burn-${amount}`));
		assert.equal(err.extensionCode, 'BAD_AMOUNT', `amount ${JSON.stringify(amount)}`);
	}
	const over = await refused(h.call('POST /burn/prepare', { key: asset.key, assetId: asset.assetId, amount: '1001', feeRate: 2 }, 'burn-over'));
	assert.equal(over.extensionCode, 'INSUFFICIENT_ASSET_BALANCE');
	const none = await refused(h.call('POST /burn/prepare', { key: 'ee'.repeat(32), amount: '1', feeRate: 2 }, 'burn-none'));
	assert.equal(none.extensionCode, 'ASSET_NOT_FOUND');
	assert.equal(h.tap.parcels.size, 0);
});

/* ------------------------------------------------------------------- start */

test('at start, work that was never committed is cancelled and committed work is left alone', async () => {
	const { h, asset } = await funded();
	// Committed: a second mint, sent and waiting for a block.
	const second = await h.call('POST /mint', mintBody({ seedlings: [{ ...COIN, name: 'second' }] }), 'second-mint');
	const committed = [...h.tap.batches.values()].pop();
	// Not committed: a preview, and three mints a crash left at each early stage.
	await h.call('POST /send/prepare', { address: foreign(asset), feeRate: 2 }, 'prepare-key');
	const parcel = [...h.tap.parcels.values()].pop();
	const funded3 = (await h.tap.minter.queue({ name: 'stray funded', type: 0, amount: 1n })).batchId;
	await h.tap.minter.freeze({ feeRate: 2 });
	await h.tap.minter.advance(funded3, B.Committed);
	const frozen = (await h.tap.minter.queue({ name: 'stray frozen', type: 0, amount: 1n })).batchId;
	await h.tap.minter.freeze({ feeRate: 2 });
	const pending = (await h.tap.minter.queue({ name: 'stray pending', type: 0, amount: 1n })).batchId;

	const again = h.restart();
	again.tap.calls.length = 0;
	await again.boot();

	assert.equal(parcel.state, S.Cancelled);
	assert.equal(again.host.rows.get('preview'), null);
	assert.equal(reserved(again), 0);
	assert.deepEqual([again.tap.batches.get(funded3).state, again.tap.batches.get(frozen).state, again.tap.batches.get(pending).state], [
		B.SproutCancelled,
		B.SeedlingCancelled,
		B.SeedlingCancelled
	]);
	assert.equal(committed.state, B.Broadcast);
	assert.deepEqual(named(again, 'freighter.cancel').map((c) => c[1]), [parcel.id]);
	assert.deepEqual(named(again, 'minter.cancel').map((c) => c[1]).sort(), [funded3, frozen, pending].sort());
	assert.equal((await rowOf(again, second.row.id)).state, 'broadcast');

	// The order: cancel, then protect the anchors and reconcile, then move committed work on.
	const names = again.tap.calls.map((c) => c[0]);
	const lastCancel = Math.max(names.lastIndexOf('freighter.cancel'), names.lastIndexOf('minter.cancel'));
	const protect = names.indexOf('anchor.protectAnchor');
	const reconcile = names.indexOf('freighter.reconcile');
	const firstAdvance = names.findIndex((n) => n === 'minter.advance' || n === 'freighter.advance');
	assert.ok(lastCancel >= 0 && protect > lastCancel, `cancel ${lastCancel}, protect ${protect}`);
	assert.ok(reconcile > protect, `protect ${protect}, reconcile ${reconcile}`);
	assert.ok(firstAdvance > reconcile, `reconcile ${reconcile}, first advance ${firstAdvance}`);
	assert.deepEqual(named(again, 'anchor.protectAnchor').map((c) => c[1]), [...new Set(again.tap.records.filter((r) => !r.spent).map((r) => r.anchorOutPoint))]);
	// Only the committed batch was advanced.
	assert.deepEqual([...new Set(named(again, 'minter.advance').map((c) => c[1]))], [committed.id]);
	assert.deepEqual(named(again, 'freighter.advance'), []);
});

test('the loop moves only committed work on, whatever else the library holds', async () => {
	const { h, asset } = await funded();
	const stray = await h.tap.freighter.queueSend({ addresses: [{ encoded: foreign(asset, '10') }], feeRate: 2 });
	await h.tap.freighter.advance(stray.id, S.StorePreBroadcast);
	const batchId = (await h.tap.minter.queue({ name: 'stray', type: 0, amount: 1n })).batchId;
	await h.tap.minter.freeze({ feeRate: 2 });
	h.tap.calls.length = 0;
	await h.host.pass({ block: true });
	await h.host.pass();
	assert.deepEqual(named(h, 'freighter.advance'), []);
	assert.deepEqual(named(h, 'minter.advance'), []);
	assert.equal(stray.state, S.StorePreBroadcast);
	assert.equal(h.tap.batches.get(batchId).state, B.Frozen);
});

test('a row whose marker is gone is never moved on or sent again', async () => {
	const { h, preview, parcel } = await previewed();
	const { row } = await h.call('POST /send/commit', { previewId: preview.previewId }, 'commit-key');
	h.host.rows.del(`committed/${parcel.id}`);
	h.tap.calls.length = 0;
	await h.call('POST /addresses/check', { id: row.id });
	await h.host.pass({ block: true });
	assert.deepEqual(named(h, 'freighter.advance'), []);
	const err = await refused(h.call('POST /transfers/rebroadcast', { id: row.id }));
	assert.equal(err.extensionCode, 'NOT_BROADCAST');
	assert.deepEqual(named(h, 'anchor.broadcast'), []);
});

test('a start sequence that failed part way is finished by the loop', async () => {
	const h = harness();
	const stray = (await h.tap.minter.queue({ name: 'stray', type: 0, amount: 1n })).batchId;
	await h.tap.minter.freeze({ feeRate: 2 });
	const list = h.tap.stores.parcels.listParcels;
	let failures = 0;
	h.tap.stores.parcels.listParcels = async () => {
		if (failures === 0) {
			failures += 1;
			throw new Error('the wallet database is busy');
		}
		return list();
	};
	h.tap.calls.length = 0;
	await h.boot();
	const before = await h.get('/status');
	assert.deepEqual([before.phase, before.ready], ['starting', false]);
	assert.equal(before.startup.waiting, 'The wallet database is busy');
	const early = await refused(h.call('POST /mint', mintBody(), 'mint-key'));
	assert.equal(early.extensionCode, 'ASSETS_STARTING');
	assert.match(early.message, /The wallet database is busy/);
	assert.deepEqual(h.tap.calls.filter((c) => /advance|cancel|queue|protect/.test(c[0])), []);

	await h.host.pass();
	const after = await h.get('/status');
	assert.deepEqual([after.phase, after.ready, after.startup], ['ready', true, null]);
	assert.equal(h.tap.batches.get(stray).state, B.SeedlingCancelled);
	const names = h.tap.calls.map((c) => c[0]);
	assert.ok(names.indexOf('minter.cancel') >= 0 && names.indexOf('minter.cancel') < names.indexOf('freighter.reconcile'));
	assert.equal((await h.call('POST /mint', mintBody(), 'mint-key')).row.state, 'broadcast');
});

test('a start sequence that keeps failing keeps the wallet from spending, and says why', async () => {
	const h = harness();
	h.tap.stores.batches.listBatches = async () => {
		throw new Error('the wallet database is busy');
	};
	await h.boot();
	await h.host.pass();
	await h.host.pass({ block: true });
	const status = await h.get('/status');
	assert.equal(status.ready, false);
	assert.equal(status.startup.waiting, 'The wallet database is busy');
	assert.equal((await refused(h.call('POST /send/commit', { previewId: 'x' }, 'k'))).extensionCode, 'ASSETS_STARTING');
	assert.deepEqual(h.tap.calls.filter((c) => /advance|queue/.test(c[0])), []);
});

test('a request right after the wallet\'s own transaction waits for the wallet to count its coins again', async () => {
	const h = harness();
	await h.boot();
	await h.call('POST /mint', mintBody(), 'first');
	// The wallet has spent its coins and not yet taken in its change.
	let reads = 0;
	h.wallet.getBalanceBreakdown = () => {
		reads += 1;
		return reads < 3 ? { total: 0, spendable: 0, frozen: 0 } : { total: 498000, spendable: 498000, frozen: 0 };
	};
	const started = Date.now();
	const quote = await h.call('POST /mint/quote', { count: 1, feeRate: 2 });
	assert.deepEqual([quote.spendableSats, quote.sufficient], [498000, true]);
	assert.ok(reads >= 3 && Date.now() - started >= 300, 'it waited for the count to come back');
	reads = 0;
	const second = await h.call('POST /mint', mintBody({ seedlings: [{ ...COIN, name: 'Second' }] }), 'second');
	assert.equal(second.row.state, 'broadcast');

	// A count that stays at nothing is believed once the wait is over.
	h.cfg.settleWaitMs = 250;
	h.wallet.getBalanceBreakdown = () => ({ total: 0, spendable: 0, frozen: 0 });
	const empty = await h.call('POST /mint/quote', { count: 1, feeRate: 2 });
	assert.equal(empty.spendableSats, 0);

	// And a wallet that has sent nothing lately is not kept waiting at all.
	const idle = harness();
	await idle.boot();
	idle.wallet.getBalanceBreakdown = () => ({ total: 0, spendable: 0, frozen: 0 });
	const at = Date.now();
	assert.equal((await idle.call('POST /mint/quote', { count: 1, feeRate: 2 })).spendableSats, 0);
	assert.ok(Date.now() - at < 150);
});

test('a host whose server has not named its chain checks nothing against the chain and spends nothing', async () => {
	// What the wallet held before this start: a mint the loop is following.
	const first = harness();
	await first.boot();
	await first.call('POST /mint', mintBody(), 'mint-key');
	first.host.shutdown();

	let answer = new Error("The wallet's Electrum server has not said which chain it is on");
	let asked = 0;
	const h = harness({
		shared: first.world,
		chainCheck: async () => {
			asked += 1;
			if (answer) throw answer;
		}
	});
	h.tap.calls.length = 0;
	await h.boot();
	await h.host.pass({ block: true });
	const waiting = await h.get('/status');
	assert.deepEqual([waiting.phase, waiting.ready], ['starting', false]);
	assert.equal(waiting.startup.waiting, "The wallet's Electrum server has not said which chain it is on");
	assert.ok(asked >= 2, 'every pass asks again');
	const early = await refused(h.call('POST /mint', mintBody(), 'second-key'));
	assert.equal(early.extensionCode, 'ASSETS_STARTING');
	assert.match(early.message, /has not said which chain it is on/);
	// Nothing was read from the chain or stepped: no reconcile, no anchor protected, no batch advanced.
	const touched = h.tap.calls.map((c) => c[0]).filter((name) => /reconcile|protectAnchor|advance|repairProofs/.test(name));
	assert.deepEqual(touched, []);

	// A server on the wrong chain is the same wait, with its own reason.
	answer = new Error("This wallet's assets are on testnet3, and its Electrum server is on testnet4. Point the wallet at a testnet3 server to use them.");
	await h.host.pass();
	assert.match((await h.get('/status')).startup.waiting, /assets are on testnet3/);

	// Once it names the right chain the host finishes starting and stops asking.
	answer = null;
	const before = asked;
	await h.host.pass({ block: true });
	assert.equal(asked, before + 1);
	assert.equal((await h.get('/status')).ready, true);
	assert.ok(h.tap.calls.some((c) => c[0] === 'freighter.reconcile'));
	await h.host.pass({ block: true });
	assert.equal(asked, before + 1);
});

test('a timer the host starts inside a section waits for the lock like anything else', async () => {
	const h = harness({ timers: true });
	await h.host.attach();
	const order = [];
	const list = h.tap.stores.parcels.listParcels;
	h.tap.stores.parcels.listParcels = async () => {
		order.push('loop');
		return list();
	};
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	await h.host.lock.run(async () => {
		order.push('section in');
		// The loop is asked to run in a quarter of a second.
		h.host.nudge();
		// Still inside when it does, as a slow broadcast would be.
		await sleep(400);
		order.push('section out');
	});
	await sleep(60);
	h.host.shutdown();
	assert.deepEqual(order.slice(0, 3), ['section in', 'section out', 'loop']);
});

test('the preview and backup timers are started holding nothing, too', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-host-test-'));
	const h = harness({ timers: true, env: { BEIGNET_ASSETS_BACKUP_FILE: path.join(dir, 'backup.json') } });
	await h.host.attach();
	let through = 0;
	const outside = h.host.lock.outside;
	h.host.lock.outside = (fn) => {
		through += 1;
		return outside(fn);
	};
	await h.host.lock.run(async () => {
		h.host.nudge();
		h.host.armPreview(h.clock.t + 60000);
		h.host.markDirty();
	});
	h.host.shutdown();
	assert.equal(through, 3);
});

/* ---------------------------------------------------------- rows and proofs */

test('a send whose proof could not be delivered waits in "proofs" and is delivered later', async () => {
	const { h, preview } = await previewed();
	const { row } = await h.call('POST /send/commit', { previewId: preview.previewId }, 'commit-key');
	h.tap.opts.courierDown = true;
	await h.confirm(row.txid);
	const waiting = await rowOf(h, row.id);
	assert.equal(waiting.state, 'proofs');
	assert.deepEqual([waiting.failure.code, waiting.failure.retrying], ['COURIER_UNREACHABLE', true]);
	assert.equal((await h.get('/status')).ready, true);
	// The coins have moved all the same.
	assert.equal((await h.get('/balances')).assets[0].balance.onchain, '750');

	h.tap.opts.courierDown = false;
	const retried = await h.call('POST /proofs/retry', { id: row.id });
	assert.equal(retried.row.state, 'complete');
	assert.equal(retried.row.failure, null);
	assert.equal(h.events.some(([name, data]) => name === 'proof-delivery' && data.row.id === row.id), true);
});

test('a send the proof server refuses says whose answer it was, and is offered again less and less often', async () => {
	const { h, preview } = await previewed();
	const { row } = await h.call('POST /send/commit', { previewId: preview.previewId }, 'commit-key');
	h.tap.opts.courierRefuses =
		'upsert leaf (uni=transfer-ab (asset_id=ab, group_key=<nil>, proof_type=transfer), leaf_key=cd): unable to verify proof: ' +
		'unable to verify proof (transfer-ab (asset_id=ab, group_key=<nil>, proof_type=transfer), outpoint=ef:1, scriptKey=02aa): invalid split commitment proof';
	await h.confirm(row.txid);
	const waiting = await rowOf(h, row.id);
	assert.equal(waiting.state, 'proofs');
	assert.deepEqual(waiting.failure, {
		code: 'PROOF_REFUSED',
		message: 'The proof server did not take the proof: invalid split commitment proof (HTTP 500)',
		retrying: true
	});
	// The coins have moved all the same, and the wallet carries on.
	assert.equal((await h.get('/balances')).assets[0].balance.onchain, '750');
	assert.equal((await h.get('/status')).ready, true);
	const offers = () => named(h, 'courier.refused').length;
	assert.equal(offers(), 1);

	// However often the chain moves, the server is not asked again before the wait is over.
	for (let i = 0; i < 5; i++) await h.host.pass({ block: true });
	assert.equal(offers(), 1);
	h.clock.t += STEP_WAIT_MS;
	await h.host.pass();
	assert.equal(offers(), 2);
	// Twice as long the next time.
	h.clock.t += STEP_WAIT_MS;
	await h.host.pass();
	assert.equal(offers(), 2);
	h.clock.t += STEP_WAIT_MS;
	await h.host.pass();
	assert.equal(offers(), 3);
	// And never longer than an hour.
	for (let i = 0; i < 12; i++) {
		h.clock.t += STEP_WAIT_MAX_MS.refused;
		await h.host.pass();
	}
	assert.equal(offers(), 15);
	h.clock.t += STEP_WAIT_MAX_MS.refused - 1;
	await h.host.pass();
	assert.equal(offers(), 15);

	// Asked for by hand, it is offered at once.
	const again = await h.call('POST /proofs/retry', { id: row.id });
	assert.equal(offers(), 16);
	assert.equal(again.row.failure.code, 'PROOF_REFUSED');

	// A server that changes its mind is believed.
	h.tap.opts.courierRefuses = null;
	const done = await h.call('POST /proofs/retry', { id: row.id });
	assert.deepEqual([done.row.state, done.row.failure], ['complete', null]);
});

test('a proof server that was down is offered the proof as soon as it answers again', async () => {
	const { h, preview } = await previewed();
	const { row } = await h.call('POST /send/commit', { previewId: preview.previewId }, 'commit-key');
	h.tap.opts.courierDown = true;
	h.world.net.down = true;
	await h.confirm(row.txid);
	await h.host.checkProofServer();
	assert.equal((await rowOf(h, row.id)).failure.code, 'COURIER_UNREACHABLE');
	const tries = () => named(h, 'freighter.advance').length;
	const before = tries();

	// Still down: left alone until the wait is over.
	await h.host.pass({ block: true });
	assert.equal(tries(), before);

	// Back, but nobody has noticed yet.
	h.tap.opts.courierDown = false;
	h.world.net.down = false;
	await h.host.pass({ block: true });
	assert.equal(tries(), before);
	assert.equal((await rowOf(h, row.id)).state, 'proofs');

	// Noticed: the wait is dropped.
	await h.host.checkProofServer();
	await h.host.pass();
	const done = await rowOf(h, row.id);
	assert.deepEqual([done.state, done.failure], ['complete', null]);
});

test('what a row says about a proof server: down, in the way, or answering no', () => {
	const http = (status, message) => Object.assign(new Error(`ERR_COURIER_HTTP: Courier returned HTTP ${status}${message ? `: ${message}` : ''}`), { code: 'ERR_COURIER_HTTP', status });
	assert.deepEqual(stepFailure(http(500, 'upsert leaf (uni=a (b)): unable to verify proof (k): invalid split commitment proof'), 'send'), {
		code: 'PROOF_REFUSED',
		message: 'The proof server did not take the proof: invalid split commitment proof (HTTP 500)',
		retrying: true
	});
	assert.equal(stepFailure(http(403, 'proof insertion is not allowed'), 'burn').message, 'The proof server did not take the proof: proof insertion is not allowed (HTTP 403)');
	assert.equal(stepFailure(http(400, ''), 'send').message, 'The proof server did not take the proof: HTTP 400');
	// The server's words are kept short and on one line.
	const long = stepFailure(http(500, `unable to fetch previous proof: ${'x'.repeat(300)}\n  }),\n more`), 'send').message;
	assert.ok(long.length < 230 && !long.includes('\n') && long.endsWith('... (HTTP 500)'), long);
	// A gateway saying the server is down or slow is not the server's answer.
	for (const status of [502, 503, 504]) assert.equal(stepFailure(http(status, ''), 'send').code, 'COURIER_UNREACHABLE');
	assert.equal(stepFailure(Object.assign(new Error('Could not reach it'), { code: 'PROOF_SERVER_UNREACHABLE' }), 'send').code, 'COURIER_UNREACHABLE');
	// A receive that is told "no" is told the proof is not there yet.
	assert.equal(stepFailure(http(404, 'no universe proof found'), 'receive').code, 'PROOF_UNAVAILABLE');
	assert.equal(stepFailure(http(500, 'no universe proof found'), 'receive').code, 'PROOF_UNAVAILABLE');
	assert.equal(stepFailure(new Error('something else'), 'send').code, 'RETRYING');
});

test('sending a transaction again is for committed work that has one', async () => {
	const h = harness();
	await h.boot();
	const { row } = await h.call('POST /mint', mintBody(), 'mint-key');
	h.tap.calls.length = 0;
	const again = await h.call('POST /transfers/rebroadcast', { id: row.id });
	assert.deepEqual(named(h, 'anchor.broadcast'), [['anchor.broadcast', row.txid]]);
	assert.equal(again.row.id, row.id);
	assert.equal(again.row.state, 'broadcast');
	await h.confirm(row.txid);
	const asset = (await h.get('/balances')).assets[0];
	const made = await h.call('POST /addresses', { key: asset.key, amount: '5' });
	assert.equal((await refused(h.call('POST /transfers/rebroadcast', { id: made.row.id }))).extensionCode, 'NOT_BROADCAST');
	const unknown = await refused(h.call('POST /transfers/rebroadcast', { id: 'send-nothing' }));
	assert.deepEqual([unknown.extensionCode, unknown.status], ['NOT_FOUND', 404]);
});

test('a receive: an address, a row that waits, and a balance that grows once it is paid', async () => {
	const { h, asset } = await funded();
	const made = await h.call('POST /addresses', { key: asset.key, amount: '40' });
	assert.deepEqual(Object.keys(made).sort(), ['address', 'row']);
	assert.deepEqual([made.address.version, made.address.amount, made.address.courier, made.address.assetId], [1, '40', COURIER, asset.assetId]);
	assert.equal(made.address.id, made.row.id);
	assert.deepEqual([made.row.kind, made.row.state, made.row.address, made.row.assets[0].amount], ['receive', 'waiting', made.address.encoded, '40']);

	const decoded = await h.call('POST /addresses/decode', { address: made.address.encoded });
	assert.deepEqual([decoded.network, decoded.amount, decoded.own, decoded.version, decoded.courier.known], ['regtest', '40', true, 1, true]);

	// Paid, but the proof is not on the server yet.
	h.tap.opts.proofMissing = true;
	const txid = 'dd'.repeat(32);
	h.tap.chain.pay(made.address.encoded, txid);
	await h.confirm(txid);
	const waiting = await rowOf(h, made.row.id);
	assert.notEqual(waiting.state, 'waiting');
	assert.notEqual(waiting.state, 'complete');
	assert.deepEqual([waiting.failure.code, waiting.failure.retrying], ['PROOF_UNAVAILABLE', true]);

	h.tap.opts.proofMissing = false;
	const checked = await h.call('POST /addresses/check', { id: made.row.id });
	assert.equal(checked.row.state, 'complete');
	assert.equal(checked.row.failure, null);
	assert.equal((await h.get('/balances')).assets[0].balance.onchain, '1040');
	assert.equal(h.events.some(([name, data]) => name === 'receive' && data.row.state === 'complete'), true);
});

test('only the newest fifty unpaid addresses are looked at, and none after a week', async () => {
	const { h, asset } = await funded();
	const made = [];
	for (let i = 0; i < 60; i += 1) {
		h.clock.t += 1000;
		made.push((await h.call('POST /addresses', { key: asset.key, amount: String(i + 1) })).address.encoded);
	}
	h.tap.calls.length = 0;
	await h.host.pass({ block: true });
	const looked = named(h, 'freighter.receive').map((c) => c[1]);
	assert.equal(looked.length, 50);
	assert.deepEqual([...looked].sort(), made.slice(10).sort());

	h.clock.t += 8 * 24 * 60 * 60 * 1000;
	h.tap.calls.length = 0;
	await h.host.pass({ block: true });
	assert.deepEqual(named(h, 'freighter.receive'), []);
	// Asking about one of them still looks.
	const row = (await h.get('/activity', 'limit=200')).rows.find((r) => r.kind === 'receive');
	await h.call('POST /addresses/check', { id: row.id });
	assert.equal(named(h, 'freighter.receive').length, 1);
});

test('looking an asset up: held ones from the wallet, unknown ones refused in words', async () => {
	const { h, asset } = await funded();
	const found = await h.call('POST /lookup', { id: asset.assetId });
	assert.deepEqual([found.asset.assetId, found.asset.name, found.asset.type, found.asset.decimalDisplay], [asset.assetId, 'coin', 'normal', 2]);
	const none = await refused(h.call('POST /lookup', { id: 'ee'.repeat(32) }));
	assert.deepEqual([none.extensionCode, none.status], ['ASSET_NOT_FOUND', 404]);
	assert.equal((await refused(h.call('POST /lookup', { id: 'coin' }))).extensionCode, 'INVALID_PARAMS');
	const detail = await h.get('/asset', `key=${asset.key}`);
	assert.equal(detail.assetId, asset.assetId);
	assert.equal(detail.proofs.count, 1);
	assert.equal((await refused(h.get('/asset', `key=${'ee'.repeat(32)}`))).extensionCode, 'ASSET_NOT_FOUND');
});

/* ------------------------------------------------------- status and events */

test('the status event is sent when what it shows changes, not on every pass', async () => {
	const { h } = await funded();
	await h.host.pass({ block: true });
	const before = count(h, 'status');
	await h.host.pass({ block: true });
	await h.host.pass();
	await h.host.pass();
	assert.equal(count(h, 'status'), before);
	const last = h.events.filter(([name]) => name === 'status').pop()[1];
	assert.deepEqual([last.phase, last.ready, last.holdsAssets, last.anchorCount, last.lockedSats], ['ready', true, true, 1, 1000]);
	assert.deepEqual(last, await h.get('/status'));
});

/* ------------------------------------------------------------------ fenced */

test('a database closed under the loop stops it without a sound', async () => {
	const { h } = await funded();
	const events = h.events.length;
	h.fence();
	await h.host.pass({ block: true });
	assert.equal(h.host.mem.stopped, true);
	assert.equal(h.events.length, events);
	await h.host.pass({ block: true });
	assert.doesNotThrow(() => h.host.status());
	for (const [route, body] of [['POST /mint', mintBody()], ['POST /backup/export', {}], ['POST /send/cancel', { previewId: 'x' }]]) {
		const err = await refused(h.call(route, body, 'a-key'));
		assert.deepEqual([err.extensionCode, err.status], ['ASSETS_STOPPING', 503], route);
	}
	const read = await refused(h.get('/balances'));
	assert.deepEqual([read.extensionCode, read.status], ['ASSETS_STOPPING', 503]);
	await h.host.stop('rebuild');
});

test('a database closed during the start sequence ends it quietly', async () => {
	const h = harness();
	await h.host.attach();
	h.fence();
	await h.host.startup();
	assert.equal(h.host.mem.stopped, true);
	assert.deepEqual(h.tap.calls.filter((c) => /advance|cancel|queue/.test(c[0])), []);
	await h.host.stop('rebuild');
});

test('a database closed in the middle of a request refuses it and stops the host', async () => {
	const { h, preview, parcel } = await previewed();
	const advance = h.tap.freighter.advance.bind(h.tap.freighter);
	h.tap.freighter.advance = async (id, target) => {
		h.fence();
		return advance(id, target);
	};
	const err = await refused(h.call('POST /send/commit', { previewId: preview.previewId }, 'commit-key'));
	assert.deepEqual([err.extensionCode, err.status], ['ASSETS_STOPPING', 503]);
	assert.equal(h.host.mem.stopped, true);
	// The marker was written first, so the next generation carries the send on.
	assert.equal(h.world.mem.data.has(`h/committed/${parcel.id}`), true);
	assert.deepEqual(named(h, 'freighter.cancel'), []);
});

/* ------------------------------------------------------------------ backup */

test('the backup: written on request, and the dashboard is told when it changed', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-host-test-'));
	const file = path.join(dir, 'assets', 'backup.json');
	const { h, mint } = await funded({ env: { BEIGNET_ASSETS_BACKUP_FILE: file } });
	const first = await h.call('POST /backup/export', {});
	assert.deepEqual(Object.keys(first), ['exportedAt', 'bytes', 'changed']);
	assert.equal(first.changed, true);
	assert.equal(fs.statSync(file).size, first.bytes);
	assert.deepEqual(h.events.filter(([name]) => name === 'backup').pop()[1], { exportedAt: first.exportedAt, dirty: false, changed: true });
	const second = await h.call('POST /backup/export', {});
	assert.deepEqual(second, { ...first, changed: false });
	assert.equal((await h.get('/status')).backup.exportedAt, first.exportedAt);

	// A copy put where a new wallet looks for one is restored before it starts.
	const pending = path.join(dir, 'pending-import.json');
	fs.copyFileSync(file, pending);
	const restored = harness({ env: { BEIGNET_ASSETS_IMPORT_FILE: pending } });
	await restored.host.attach();
	assert.equal(fs.existsSync(pending), false);
	assert.equal(fs.existsSync(`${pending}.imported`), true);
	assert.ok(restored.storage.get(`h/row/${mint.row.id}`));
	assert.ok(restored.storage.get(`h/committed/${mint.row.id.slice('mint-'.length)}`));
	assert.equal(restored.host.status().backup.importError, undefined);

	// One for another network is left where it is, and the status says why.
	const wrong = path.join(dir, 'wrong-import.json');
	fs.copyFileSync(file, wrong);
	const other = harness({ network: 'mainnet', env: { BEIGNET_ASSETS_IMPORT_FILE: wrong } });
	await other.host.attach();
	assert.equal(fs.existsSync(wrong), true);
	assert.match(other.host.status().backup.importError, /regtest/);
	assert.deepEqual(other.storage.list('h/row/'), []);
});

test('the backup: a restore asked for by hand is checked the same way', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-host-test-'));
	const file = path.join(dir, 'backup.json');
	const { h } = await funded({ env: { BEIGNET_ASSETS_BACKUP_FILE: file } });
	await h.call('POST /backup/export', {});
	const body = JSON.parse(fs.readFileSync(file, 'utf8'));

	const fresh = harness();
	await fresh.boot();
	const tampered = { ...body, rows: body.rows.map(([key, value], i) => [key, i === 0 ? `${value} ` : value]) };
	assert.equal((await refused(fresh.call('POST /backup/import', { backup: tampered }))).extensionCode, 'BAD_BACKUP');
	assert.equal((await refused(fresh.call('POST /backup/import', {}))).extensionCode, 'BAD_BACKUP');
	const res = await fresh.call('POST /backup/import', { backup: body });
	assert.equal(res.same, false);
	assert.equal(res.imported, body.rows.length);
	assert.deepEqual(await fresh.call('POST /backup/import', { backup: body }), { imported: 0, same: true });
});

/* ------------------------------------------------ proofs handed over by file */

const asFile = (bytes) => Buffer.from(bytes).toString('base64');

/** An address of this wallet, paid in a block, whose proof the server does not have. */
async function paidUnserved(amount = '40') {
	const ctx = await funded();
	const made = await ctx.h.call('POST /addresses', { key: ctx.asset.key, amount });
	const txid = 'dd'.repeat(32);
	ctx.h.tap.opts.proofMissing = true;
	ctx.h.tap.chain.pay(made.address.encoded, txid);
	await ctx.h.confirm(txid);
	const scriptKey = ctx.h.host.lib.decodeAddress(made.address.encoded).scriptKey;
	const proof = (extra = {}) => asFile(fakeProof({ assetId: ctx.asset.assetId, scriptKey, anchorOutPoint: `${txid}:0`, amount, ...extra }));
	return { ...ctx, made, txid, proof };
}

test('the sender can take the proof file of a send out, once the transaction is deep enough', async () => {
	const { h, preview, address, mint } = await previewed();
	const { row } = await h.call('POST /send/commit', { previewId: preview.previewId }, 'commit-key');
	const early = await refused(h.get('/proofs/export', `id=${row.id}`));
	assert.deepEqual([early.extensionCode, early.status, early.message], ['PROOF_NOT_READY', 409, 'The proof file exists once the transaction is 1 block deep.']);

	// The proof server says no: the file is what there is to give.
	h.tap.opts.courierRefuses = 'invalid split commitment proof';
	await h.confirm(row.txid);
	assert.equal((await rowOf(h, row.id)).failure.code, 'PROOF_REFUSED');
	const out = await h.get('/proofs/export', `id=${row.id}`);
	assert.deepEqual(Object.keys(out).sort(), ['address', 'assetId', 'bytes', 'file', 'fileName', 'id', 'txid']);
	assert.match(out.fileName, /^proof-[0-9a-f]{8}-[0-9a-f]{8}\.assetproof$/);
	assert.deepEqual([out.id, out.address, out.txid], [row.id, address, row.txid]);
	const bytes = Buffer.from(out.file, 'base64');
	assert.equal(out.bytes, bytes.length);
	// It is the proof of what the recipient was paid, not of this wallet's change.
	const facts = h.host.lib.proofFacts(bytes);
	assert.deepEqual([facts.anchorOutPoint, facts.scriptKey], [`${row.txid}:0`, h.host.lib.decodeAddress(address).scriptKey]);

	// Still there once the server has taken it.
	h.tap.opts.courierRefuses = null;
	assert.equal((await h.call('POST /proofs/retry', { id: row.id })).row.state, 'complete');
	assert.equal((await h.get('/proofs/export', `id=${row.id}`)).file, out.file);

	// A mint has no recipient to hand anything to.
	const none = await refused(h.get('/proofs/export', `id=${mint.row.id}`));
	assert.deepEqual([none.extensionCode, none.status], ['NO_PROOF_FILE', 400]);
	const unknown = await refused(h.get('/proofs/export', 'id=send-00000000'));
	assert.deepEqual([unknown.extensionCode, unknown.status], ['NOT_FOUND', 404]);
});

test('a proof file from the sender completes a receive the proof server never served', async () => {
	const { h, made, proof } = await paidUnserved();
	assert.equal((await rowOf(h, made.row.id)).failure.code, 'PROOF_UNAVAILABLE');
	h.tap.calls.length = 0;

	const took = await h.call('POST /proofs/import', { file: proof() });
	assert.deepEqual(Object.keys(took).sort(), ['result', 'row']);
	assert.deepEqual([took.result, took.row.id, took.row.state, took.row.failure], ['complete', made.row.id, 'complete', null]);
	assert.equal((await h.get('/balances')).assets[0].balance.onchain, '1040');
	// The library did the checking, and no server was asked for anything.
	assert.equal(named(h, 'freighter.receive').length, 1);
	assert.deepEqual(h.world.fetched, []);
	// The file is not kept once the asset is.
	assert.deepEqual(keys(h, 'handed/'), []);
	assert.equal(h.events.some(([name, data]) => name === 'receive' && data.row.state === 'complete'), true);

	const again = await h.call('POST /proofs/import', { file: proof() });
	assert.deepEqual([again.result, again.row.state], ['already', 'complete']);
	assert.equal((await h.get('/balances')).assets[0].balance.onchain, '1040');
});

test('a proof file is refused in words when it is not a proof, not for this wallet, or not for this payment', async () => {
	const { h, asset, made, proof } = await paidUnserved();
	const bad = async (body) => {
		const err = await refused(h.call('POST /proofs/import', body));
		return [err.extensionCode, err.status, err.message];
	};
	assert.deepEqual(await bad({}), ['BAD_PROOF_FILE', 400, 'A proof file is needed.']);
	assert.deepEqual(await bad({ file: 'not base64 at all!' }), ['BAD_PROOF_FILE', 400, 'That file is not a Taproot Assets proof file this wallet can read.']);
	assert.deepEqual(await bad({ file: asFile('{"a":1}') }), ['BAD_PROOF_FILE', 400, 'That file is not a Taproot Assets proof file this wallet can read.']);
	assert.deepEqual(await bad({ file: 'A'.repeat(6 * 1024 * 1024) }), ['BAD_PROOF_FILE', 413, 'That file is larger than a proof file this wallet takes (4 MB).']);
	assert.deepEqual(await bad({ file: proof({ scriptKey: `02${'77'.repeat(32)}` }) }), [
		'PROOF_NOT_OURS',
		404,
		'This proof is not for an address this wallet made. It has to be the file of a payment to this wallet.'
	]);
	assert.deepEqual(await bad({ file: proof({ anchorOutPoint: `${'ee'.repeat(32)}:0` }) }), [
		'PROOF_OTHER_PAYMENT',
		409,
		'This proof is for a different payment than the one this wallet found for that address.'
	]);

	// An address nobody has paid: there is nothing on the chain to hold the proof against.
	const unpaid = await h.call('POST /addresses', { key: asset.key, amount: '7' });
	const forUnpaid = asFile(fakeProof({ assetId: asset.assetId, scriptKey: h.host.lib.decodeAddress(unpaid.address.encoded).scriptKey, anchorOutPoint: `${'ee'.repeat(32)}:0` }));
	assert.deepEqual(await bad({ file: forUnpaid }), [
		'PAYMENT_NOT_SEEN',
		409,
		'The payment this proof is for is not in a block yet. Import the file once its transaction has confirmed.'
	]);

	// None of that took anything or left anything behind.
	assert.equal((await h.get('/balances')).assets[0].balance.onchain, '1000');
	assert.deepEqual(keys(h, 'handed/'), []);
	assert.equal((await rowOf(h, made.row.id)).state === 'complete', false);
});

test('a proof file that does not verify is dropped, and the proof server is still asked for the real one', async () => {
	const { h, made, proof } = await paidUnserved();
	const err = await refused(h.call('POST /proofs/import', { file: proof({ valid: false }) }));
	assert.deepEqual(
		[err.extensionCode, err.status, err.message],
		['PROOF_INVALID', 422, 'This proof file did not pass verification, so nothing was taken from it: Proof does not match receive address.']
	);
	assert.deepEqual(keys(h, 'handed/'), []);
	assert.equal((await h.get('/balances')).assets[0].balance.onchain, '1000');

	// The server has it after all: the receive completes from there.
	h.tap.opts.proofMissing = false;
	const checked = await h.call('POST /addresses/check', { id: made.row.id });
	assert.equal(checked.row.state, 'complete');
	assert.equal(h.world.fetched.length, 1);
	assert.equal((await h.get('/balances')).assets[0].balance.onchain, '1040');
});

test('a proof file for a payment that is not deep enough is kept, across a restart, and used without a server', async () => {
	const { h, made, proof } = await paidUnserved();
	h.tap.opts.notBuried = true;
	const took = await h.call('POST /proofs/import', { file: proof() });
	assert.deepEqual([took.result, took.waitingFor, took.reason], ['kept', 'confirmations', null]);
	assert.notEqual(took.row.state, 'complete');
	// What the server said before is not the row's news any more.
	assert.equal(took.row.failure, null);
	assert.equal(keys(h, 'handed/').length, 1);
	assert.equal((await h.get('/balances')).assets[0].balance.onchain, '1000');

	// Blocks pass and it is still not deep enough: nothing is lost by trying.
	await h.host.pass({ block: true });
	assert.equal(keys(h, 'handed/').length, 1);

	const h2 = h.restart();
	await h2.boot();
	assert.equal(keys(h2, 'handed/').length, 1);
	h2.tap.opts.notBuried = false;
	await h2.host.pass({ block: true });
	const done = await rowOf(h2, made.row.id);
	assert.equal(done.state, 'complete');
	assert.equal((await h2.get('/balances')).assets[0].balance.onchain, '1040');
	// The server still does not have it, and was never needed.
	assert.equal(h2.tap.opts.proofMissing, true);
	assert.deepEqual(h2.world.fetched, []);
	assert.deepEqual(keys(h2, 'handed/'), []);
});

test('a kept proof file that later fails verification is dropped by the loop', async () => {
	const { h, made, proof } = await paidUnserved();
	h.tap.opts.notBuried = true;
	// Readable, for the right payment, and not valid: only verification can tell.
	await h.host.lock.run(async () => {
		const record = await h.tap.stores.receives.getReceive(made.address.encoded);
		h.host.keepHanded(record.locator, Buffer.from(proof({ valid: false }), 'base64').toString('hex'), made.address.encoded);
	});
	assert.equal(keys(h, 'handed/').length, 1);
	await h.call('POST /addresses/check', { id: made.row.id });
	assert.deepEqual(keys(h, 'handed/'), []);
	assert.notEqual((await rowOf(h, made.row.id)).state, 'complete');
});

test('a send marked as handed over stops counting as in progress, is still offered to the server, and the mark can be taken back', async () => {
	const { h, preview, mint } = await previewed();
	const { row } = await h.call('POST /send/commit', { previewId: preview.previewId }, 'commit-key');
	const early = await refused(h.call('POST /proofs/handed-over', { id: row.id }));
	assert.deepEqual([early.extensionCode, early.status], ['PROOF_NOT_READY', 409]);

	h.tap.opts.courierRefuses = 'invalid split commitment proof';
	await h.confirm(row.txid);
	await h.host.pass();
	assert.equal((await rowOf(h, row.id)).handedOver, null);
	assert.equal((await h.get('/status')).pending.sends, 1);

	const marked = await h.call('POST /proofs/handed-over', { id: row.id });
	assert.equal(marked.row.state, 'proofs', 'the wallet did not deliver anything: only how it reads changed');
	assert.equal(typeof marked.row.handedOver, 'number');
	assert.equal((await h.call('POST /proofs/handed-over', { id: row.id })).row.handedOver, marked.row.handedOver, 'said twice, kept once');
	await h.host.pass();
	assert.equal((await h.get('/status')).pending.sends, 0);
	// The refusal is still the server's answer, and the wallet still asks.
	const still = await h.call('POST /proofs/retry', { id: row.id });
	assert.deepEqual([still.row.state, still.row.failure.code, still.row.handedOver], ['proofs', 'PROOF_REFUSED', marked.row.handedOver]);

	// Taken back, it is in progress again.
	const undone = await h.call('POST /proofs/handed-over', { id: row.id, handedOver: false });
	assert.equal(undone.row.handedOver, null);
	await h.host.pass();
	assert.equal((await h.get('/status')).pending.sends, 1);

	// Marked again, and then the server takes the proof: complete, and the mark is kept as what happened.
	await h.call('POST /proofs/handed-over', { id: row.id });
	h.tap.opts.courierRefuses = null;
	const done = await h.call('POST /proofs/retry', { id: row.id });
	assert.equal(done.row.state, 'complete');
	assert.equal(typeof done.row.handedOver, 'number');
	assert.equal((await h.call('POST /proofs/handed-over', { id: row.id, handedOver: false })).row.handedOver, done.row.handedOver, 'nothing to take back once it is complete');

	const none = await refused(h.call('POST /proofs/handed-over', { id: mint.row.id }));
	assert.deepEqual([none.extensionCode, none.status], ['NO_PROOF_FILE', 400]);
});
