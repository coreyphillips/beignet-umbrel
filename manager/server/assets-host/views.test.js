'use strict';

/**
 * The shapes the dashboard reads: a row for each kind and state, an asset
 * with its balance, the set of receives worth watching, and the status.
 *
 * Run: cd manager && npm test
 * Or:  cd manager && node --test server/assets-host/views.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const views = require('./views');
const { STATES } = require('./adapter');
const { parseConfig } = require('./config');

const MODULES = '/opt/engine/node_modules';
const UNIVERSES = JSON.stringify([{ courier: 'universerpc://universe.example.com:10029', rest: 'https://universe.example.com', isDefault: true }]);
const regtest = parseConfig('regtest', { BEIGNET_ASSETS_MODULES: MODULES, BEIGNET_ASSETS_UNIVERSES: UNIVERSES });
const mainnet = parseConfig('mainnet', { BEIGNET_ASSETS_MODULES: MODULES });

const G = `03${'aa'.repeat(32)}`;
const A1 = '11'.repeat(32);
const A2 = '22'.repeat(32);
const C = 'cc'.repeat(32);
const T0 = 1_700_000_000_000;

test('a mint: pending until sent, then broadcast, confirming, proofs, complete', () => {
	const B = STATES.Batch;
	const expected = {
		Pending: ['pending', 'pending'],
		Frozen: ['pending', 'pending'],
		Committed: ['pending', 'pending'],
		Broadcast: ['broadcast', 'confirming'],
		Confirmed: ['proofs', 'proofs'],
		Finalized: ['complete', 'complete'],
		SeedlingCancelled: ['failed', 'failed'],
		SproutCancelled: ['failed', 'failed']
	};
	assert.deepEqual(Object.keys(B).sort(), Object.keys(expected).sort());
	for (const [name, [unconfirmed, confirmed]] of Object.entries(expected)) {
		assert.equal(views.deriveMint(B[name], 0), unconfirmed, name);
		assert.equal(views.deriveMint(B[name], 1), confirmed, name);
	}
});

test('a send or a burn: pending through the fee preview, complete once its proofs are out', () => {
	const S = STATES.Send;
	const expected = {
		StartHandleAddrParcel: ['pending', 'pending'],
		VirtualCommitmentSelect: ['pending', 'pending'],
		VirtualSign: ['pending', 'pending'],
		AnchorSign: ['pending', 'pending'],
		VerifyPreBroadcast: ['pending', 'pending'],
		StorePreBroadcast: ['pending', 'pending'],
		Broadcast: ['broadcast', 'confirming'],
		WaitTxConf: ['broadcast', 'confirming'],
		StorePostAnchorTxConf: ['broadcast', 'confirming'],
		TransferProofs: ['proofs', 'proofs'],
		Complete: ['complete', 'complete'],
		Cancelled: ['failed', 'failed']
	};
	assert.deepEqual(Object.keys(S).sort(), Object.keys(expected).sort());
	for (const [name, [unconfirmed, confirmed]] of Object.entries(expected)) {
		assert.equal(views.deriveTransfer(S[name], 0), unconfirmed, name);
		assert.equal(views.deriveTransfer(S[name], 3), confirmed, name);
	}
});

test('a receive: waiting, confirming until deep enough, proofs, complete', () => {
	const R = STATES.Receive;
	assert.equal(views.deriveReceive(R.Registered, 0, 6), 'waiting');
	assert.equal(views.deriveReceive(R.Located, 0, 6), 'confirming');
	assert.equal(views.deriveReceive(R.Located, 5, 6), 'confirming');
	assert.equal(views.deriveReceive(R.Located, 6, 6), 'proofs');
	assert.equal(views.deriveReceive(R.Located, 1, 1), 'proofs');
	assert.equal(views.deriveReceive(R.Verified, 6, 6), 'proofs');
	assert.equal(views.deriveReceive(R.Complete, 6, 6), 'complete');
});

test('a row of every kind in every state has the fields the dashboard reads', () => {
	const states = { mint: ['pending', 'broadcast', 'confirming', 'proofs', 'complete', 'failed'], receive: ['waiting', 'confirming', 'proofs', 'complete', 'failed'] };
	states.send = states.mint;
	states.burn = states.mint;
	const keys = [
		'id', 'kind', 'state', 'failed', 'failure', 'assets', 'txid', 'feeSats', 'satsPerVbyte', 'vbytes', 'anchorSats', 'address', 'courier',
		'paymentHash', 'confirmations', 'confirmationsRequired', 'blockHeight', 'stuck', 'watching', 'at', 'clientRef'
	];
	for (const [kind, list] of Object.entries(states)) {
		for (const state of list) {
			const stored = { ...views.newRow({ id: `${kind}-1`, kind, ref: 'ref', created: T0 }), state };
			const row = views.rowView(stored, { tip: 100, cfg: regtest, now: T0 });
			assert.deepEqual(Object.keys(row).sort(), [...keys].sort(), `${kind} ${state}`);
			assert.equal(row.kind, kind);
			assert.equal(row.state, state);
			assert.equal(row.failed, state === 'failed', `${kind} ${state}`);
			assert.equal(row.paymentHash, null);
			assert.equal(row.confirmationsRequired, 1);
			assert.deepEqual(row.at, { created: T0, broadcast: null, confirmed: null, proof: null, completed: null });
			assert.equal(row.stuck, false);
			assert.equal('ref' in row, false);
		}
	}
});

test('a new row starts pending, with nothing known yet', () => {
	const row = views.newRow({ id: 'send-1', kind: 'send', ref: 'p1', created: T0, feeSats: 500, address: 'taprt1x' });
	assert.equal(row.state, 'pending');
	assert.equal(row.failure, null);
	assert.deepEqual(row.assets, []);
	assert.equal(row.feeSats, 500);
	assert.equal(row.address, 'taprt1x');
	assert.equal(row.txid, null);
	assert.equal(views.isTerminal('complete'), true);
	assert.equal(views.isTerminal('failed'), true);
	assert.equal(views.isTerminal('proofs'), false);
});

test('confirmations are counted from the block the transaction is in', () => {
	const stored = { ...views.newRow({ id: 'mint-1', kind: 'mint', ref: 'b', created: T0 }), state: 'confirming', blockHeight: 100 };
	assert.equal(views.rowView(stored, { tip: 100, cfg: mainnet }).confirmations, 1);
	assert.equal(views.rowView(stored, { tip: 105, cfg: mainnet }).confirmations, 6);
	assert.equal(views.rowView(stored, { tip: 99, cfg: mainnet }).confirmations, 0);
	assert.equal(views.rowView({ ...stored, blockHeight: null }, { tip: 105, cfg: mainnet }).confirmations, 0);
	assert.equal(views.rowView(stored, { tip: 105, cfg: mainnet }).confirmationsRequired, 6);
});

test('stuck: three blocks with no confirmation on regtest, an hour elsewhere', () => {
	const sent = { ...views.newRow({ id: 'send-1', kind: 'send', ref: 'p', created: T0 }), state: 'broadcast', txid: 'ab'.repeat(32), seenHeight: 100 };
	sent.at.broadcast = T0;
	assert.equal(views.rowView(sent, { tip: 102, cfg: regtest, now: T0 }).stuck, false);
	assert.equal(views.rowView(sent, { tip: 103, cfg: regtest, now: T0 }).stuck, true);
	assert.equal(views.rowView({ ...sent, seenHeight: null }, { tip: 500, cfg: regtest, now: T0 }).stuck, false);

	const minute = 60 * 1000;
	assert.equal(views.rowView(sent, { tip: 500, cfg: mainnet, now: T0 + 59 * minute }).stuck, false);
	assert.equal(views.rowView(sent, { tip: 500, cfg: mainnet, now: T0 + 61 * minute }).stuck, true);
	// Sending it again starts the hour again.
	assert.equal(views.rowView({ ...sent, sentAgainAt: T0 + 30 * minute }, { tip: 500, cfg: mainnet, now: T0 + 61 * minute }).stuck, false);

	// Never stuck: confirmed, finished, or not ours to send.
	assert.equal(views.rowView({ ...sent, blockHeight: 101 }, { tip: 110, cfg: regtest, now: T0 }).stuck, false);
	assert.equal(views.rowView({ ...sent, state: 'failed' }, { tip: 110, cfg: regtest, now: T0 }).stuck, false);
	assert.equal(views.rowView({ ...sent, kind: 'receive' }, { tip: 110, cfg: regtest, now: T0 }).stuck, false);
	assert.equal(views.rowView({ ...sent, txid: null }, { tip: 110, cfg: regtest, now: T0 }).stuck, false);
});

test('an asset as a row names it: amounts are strings, a collectible has no decimals', () => {
	assert.deepEqual(views.brief({ assetId: A1, groupKey: G, name: 'coin', type: 'normal', decimalDisplay: 2 }, 5n), {
		key: G,
		assetId: A1,
		name: 'coin',
		type: 'normal',
		decimalDisplay: 2,
		amount: '5'
	});
	const card = views.brief({ assetId: C, name: 'card', type: 1, decimalDisplay: 4 });
	assert.deepEqual(card, { key: C, assetId: C, name: 'card', type: 'collectible', decimalDisplay: null });
	assert.equal(views.brief({ assetId: A1 }).decimalDisplay, 0);
	assert.equal(views.brief({ assetId: A1 }).name, null);
	assert.equal(views.typeName(0), 'normal');
	assert.equal(views.typeName('collectible'), 'collectible');
});

test('units held: all of them, and the part no unconfirmed send is using', () => {
	const held = views.heldByAsset([
		{ assetId: A1, amount: '10' },
		{ assetId: A1, amount: '5', reservedBy: 'parcel' },
		{ assetId: A1, amount: '7', spent: true },
		{ assetId: A1, amount: '3', spentExternally: true },
		{ assetId: A1, amount: '2', watchOnly: true },
		{ assetId: A2, amount: '18446744073709551615', groupKey: G }
	]);
	assert.deepEqual(held.get(A1), { total: 15n, free: 10n, groupKey: null });
	assert.deepEqual(held.get(A2), { total: 18446744073709551615n, free: 18446744073709551615n, groupKey: G });
	assert.equal(held.size, 2);
});

test('assets: a group is one entry with the balance of all its issuances', () => {
	const registry = new Map([
		[A1, { assetId: A1, groupKey: G, name: 'coin', type: 'normal', decimalDisplay: 2, issued: '1000', mintedHere: true }],
		[A2, { assetId: A2, groupKey: G, name: 'coin', type: 'normal', decimalDisplay: 2, issued: '500', mintedHere: true, point: { outpoint: 'feed:0', height: 90, timestamp: T0 } }],
		[C, { assetId: C, name: 'card', type: 'collectible', issued: '1', mintedHere: false, supplyKnown: false }]
	]);
	const records = [
		{ assetId: C, amount: '1', type: 1, name: 'card', anchorOutPoint: 'z:0' },
		{ assetId: A1, groupKey: G, amount: '300', anchorOutPoint: 'x:0' },
		{ assetId: A1, groupKey: G, amount: '100', anchorOutPoint: 'y:1' },
		{ assetId: A2, groupKey: G, amount: '600', anchorOutPoint: 'x:0' },
		{ assetId: A2, groupKey: G, amount: '50', anchorOutPoint: 'w:0', spent: true }
	];
	const row = (kind, state, amount) => ({ kind, state, assets: [{ key: G, amount }] });
	const rows = [row('send', 'broadcast', '100'), row('burn', 'complete', '25'), row('receive', 'confirming', '40'), row('send', 'complete', '9'), row('send', 'failed', '7')];
	const out = views.assetViews({ records, registry, groups: new Map([[G, true]]), rows });
	assert.equal(out.length, 2);
	const [coin, card] = out;
	assert.deepEqual(coin, {
		key: G,
		assetId: A2,
		groupKey: G,
		name: 'coin',
		type: 'normal',
		decimalDisplay: 2,
		balance: { total: '900', onchain: '900', pendingIn: '40', pendingOut: '100', channelLocal: '0', lightningSendable: '0', lightningReceivable: '0' },
		lockedSats: 2000,
		anchors: 2,
		canReissue: true,
		mintedHere: true,
		supply: { issued: '1500', burned: '25', known: true },
		genesis: { outpoint: 'feed:0', height: 90, timestamp: T0 }
	});
	assert.deepEqual(card, {
		key: C,
		assetId: C,
		groupKey: null,
		name: 'card',
		type: 'collectible',
		decimalDisplay: null,
		balance: { total: '1', onchain: '1', pendingIn: '0', pendingOut: '0', channelLocal: '0', lightningSendable: '0', lightningReceivable: '0' },
		lockedSats: 1000,
		anchors: 1,
		canReissue: false,
		mintedHere: false,
		supply: { issued: null, burned: '0', known: false },
		genesis: { outpoint: null, height: null, timestamp: null }
	});
});

test('assets: supply is only called known when it is', () => {
	const records = [{ assetId: A1, amount: '5', anchorOutPoint: 'x:0' }];
	const looked = views.assetViews({ records, registry: new Map([[A1, { assetId: A1, name: 'coin', type: 'normal', issued: '77', supplyKnown: true }]]) });
	assert.deepEqual(looked[0].supply, { issued: '77', burned: '0', known: true });
	const unknown = views.assetViews({ records, registry: new Map() });
	assert.deepEqual(unknown[0].supply, { issued: null, burned: '0', known: false });
	assert.equal(unknown[0].name, null);
	// A group this wallet did not mint may have issuances it has never seen.
	const grouped = [{ assetId: A1, groupKey: G, amount: '5', anchorOutPoint: 'x:0' }];
	const foreign = views.assetViews({ records: grouped, registry: new Map([[A1, { assetId: A1, groupKey: G, issued: '77', supplyKnown: true }]]) });
	assert.equal(foreign[0].supply.known, false);
	assert.equal(foreign[0].canReissue, false);
	assert.deepEqual(views.assetViews({ records: [], registry: new Map() }), []);
});

test('only a bounded set of receives is watched: the newest fifty', () => {
	const R = STATES.Receive;
	const fresh = [];
	for (let i = 0; i < 60; i += 1) fresh.push({ id: `r${i}`, state: R.Registered, createdAt: T0 - i * 1000 });
	const picked = views.activeReceives(fresh, { now: T0, windowMs: regtest.receiveWindowMs, max: regtest.receiveSetMax });
	assert.equal(picked.length, 50);
	assert.deepEqual(picked.slice(0, 3).map((r) => r.id), ['r0', 'r1', 'r2']);
	assert.equal(picked[49].id, 'r49');
});

test('a receive leaves the watched set when it is old and unpaid, or finished', () => {
	const R = STATES.Receive;
	const day = 24 * 60 * 60 * 1000;
	const records = [
		{ id: 'fresh', state: R.Registered, createdAt: T0 - day },
		{ id: 'stale', state: R.Registered, createdAt: T0 - 8 * day },
		{ id: 'old but paid', state: R.Located, createdAt: T0 - 30 * day },
		{ id: 'old but verified', state: R.Verified, createdAt: T0 - 30 * day },
		{ id: 'done', state: R.Complete, createdAt: T0 - 1000 }
	];
	const picked = views.activeReceives(records, { now: T0, windowMs: 7 * day, max: 50 }).map((r) => r.id);
	assert.deepEqual(picked, ['old but paid', 'old but verified', 'fresh']);
});

test('a paid receive is followed however many newer addresses there are', () => {
	const R = STATES.Receive;
	const records = [{ id: 'paid long ago', state: R.Located, createdAt: T0 - 90 * 24 * 60 * 60 * 1000 }];
	for (let i = 0; i < 80; i += 1) records.push({ id: `r${i}`, state: R.Registered, createdAt: T0 - i * 1000 });
	const picked = views.activeReceives(records, { now: T0, windowMs: regtest.receiveWindowMs, max: 50 }).map((r) => r.id);
	assert.equal(picked[0], 'paid long ago');
	assert.equal(picked.length, 51);
	assert.equal(picked[50], 'r49');
});

test('a waiting receive row says whether its address is still looked at', () => {
	const day = 24 * 60 * 60 * 1000;
	const row = (created, state = 'waiting') => ({ ...views.newRow({ id: 'recv-1', kind: 'receive', ref: 'taprt1x', created }), state });
	// Before the loop has made a pass, the age of the address decides.
	assert.equal(views.rowView(row(T0 - day), { cfg: regtest, now: T0 }).watching, true);
	assert.equal(views.rowView(row(T0 - 8 * day), { cfg: regtest, now: T0 }).watching, false);
	// After one, what the loop looked at does: an address past the newest fifty is not.
	assert.equal(views.rowView(row(T0 - day), { cfg: regtest, now: T0, watched: new Set() }).watching, false);
	assert.equal(views.rowView(row(T0 - 8 * day), { cfg: regtest, now: T0, watched: new Set(['recv-1']) }).watching, true);
	// It is a question only while nothing has been seen.
	assert.equal(views.rowView(row(T0 - 8 * day, 'confirming'), { cfg: regtest, now: T0 }).watching, null);
	assert.equal(views.rowView({ ...row(T0), kind: 'send' }, { cfg: regtest, now: T0 }).watching, null);
});

test('status: every field the dashboard reads, with lightning off', () => {
	const status = views.statusView({ cfg: regtest, phase: 'starting' });
	assert.deepEqual(Object.keys(status), [
		'phase', 'ready', 'error', 'network', 'hrp', 'chain', 'pending', 'holdsAssets', 'lockedSats', 'anchorCount', 'startup', 'lightning',
		'proofServer', 'backup', 'limits'
	]);
	assert.equal(status.ready, false);
	assert.equal(status.error, null);
	assert.deepEqual(status.chain, { name: 'regtest', height: 0, minConfirmations: 1 });
	// A testnet wallet that has not found out which testnet it is on says so by saying nothing.
	assert.equal(views.statusView({ cfg: { ...regtest, network: 'testnet', tapNetwork: null }, phase: 'starting' }).chain.name, null);
	assert.equal(views.statusView({ cfg: { ...regtest, network: 'testnet', tapNetwork: 'testnet4' }, phase: 'ready' }).chain.name, 'testnet4');
	assert.deepEqual(status.pending, { mints: 0, sends: 0, receives: 0, burns: 0 });
	assert.deepEqual(status.lightning, { mode: 'off', usableChannels: 0 });
	assert.deepEqual(status.proofServer, {
		host: 'universe.example.com:10029',
		courier: 'universerpc://universe.example.com:10029',
		rest: 'https://universe.example.com',
		isDefault: true,
		reachable: null,
		lastError: null,
		viaTor: false
	});
	assert.deepEqual(status.backup, { exportedAt: null, dirty: false });
	assert.deepEqual(status.limits, { maxFeeRate: 500, maxFeeSats: 250000 });
});

test('status: ready when running or degraded, and it says why when it is not', () => {
	assert.equal(views.statusView({ cfg: regtest, phase: 'ready' }).ready, true);
	assert.equal(views.statusView({ cfg: regtest, phase: 'degraded' }).ready, true);
	const failed = views.statusView({ cfg: parseConfig('signet', {}), phase: 'failed', error: 'Assets are not available on signet in this app.' });
	assert.equal(failed.ready, false);
	assert.equal(failed.error, 'Assets are not available on signet in this app.');
	assert.equal(failed.proofServer.host, null);
	const busy = views.statusView({
		cfg: regtest,
		phase: 'ready',
		tip: 120,
		summary: { pending: { mints: 1, receives: 2 }, holdsAssets: true, lockedSats: 3000, anchorCount: 3 },
		startup: { done: 1, total: 4 },
		proofServer: { reachable: false, lastError: 'Could not reach universe.example.com', viaTor: true },
		backup: { exportedAt: T0, dirty: true, importError: 'That assets backup belongs to another wallet' }
	});
	assert.deepEqual(busy.pending, { mints: 1, sends: 0, receives: 2, burns: 0 });
	assert.deepEqual([busy.holdsAssets, busy.lockedSats, busy.anchorCount, busy.chain.height], [true, 3000, 3, 120]);
	assert.deepEqual(busy.startup, { done: 1, total: 4 });
	assert.deepEqual([busy.proofServer.reachable, busy.proofServer.lastError, busy.proofServer.viaTor], [false, 'Could not reach universe.example.com', true]);
	assert.deepEqual(busy.backup, { exportedAt: T0, dirty: true, importError: 'That assets backup belongs to another wallet' });
});
