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
		'paymentHash', 'confirmations', 'confirmationsRequired', 'blockHeight', 'stuck', 'watching', 'handedOver', 'at', 'clientRef'
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
			assert.equal(row.handedOver, null);
			assert.equal('ref' in row, false);
			// The sender's word that a proof was handed over as a file is a send's alone.
			const marked = views.rowView({ ...stored, handedOver: T0 + 5 }, { tip: 100, cfg: regtest, now: T0 });
			assert.equal(marked.handedOver, kind === 'send' ? T0 + 5 : null, `${kind} ${state}`);
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

test('assets: the bitcoin locked with an asset is what its anchors hold, as their proofs say, and 1,000 sat where that is not read yet', () => {
	const registry = new Map([[A1, { assetId: A1, name: 'coin', type: 'normal', decimalDisplay: 2, issued: '1000', mintedHere: true }]]);
	const records = [
		{ assetId: A1, amount: '300', anchorOutPoint: 'x:0' },
		// The swept output of a channel closed by force: the side's whole channel bitcoin.
		{ assetId: A1, amount: '600', anchorOutPoint: 'sweep:1' },
		{ assetId: A1, amount: '100', anchorOutPoint: 'new:0' }
	];
	const read = new Map([
		['x:0', 1000],
		['sweep:1', 98292]
	]);
	const [coin] = views.assetViews({ records, registry, anchorValues: read });
	assert.deepEqual([coin.anchors, coin.lockedSats], [3, 1000 + 98292 + 1000]);
	// Not read at all: 1,000 sat an anchor, as before.
	assert.equal(views.assetViews({ records, registry }).find((a) => a.key === A1).lockedSats, 3000);
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
		balance: { total: '900', onchain: '900', channelable: '600', pendingIn: '40', pendingOut: '100', channelLocal: '0', lightningSendable: '0', lightningReceivable: '0' },
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
		balance: { total: '1', onchain: '1', channelable: '1', pendingIn: '0', pendingOut: '0', channelLocal: '0', lightningSendable: '0', lightningReceivable: '0' },
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

test('an asset in a channel: the total is what is on the chain and what is on this side of the channel', () => {
	const registry = new Map([[A1, { assetId: A1, groupKey: null, name: 'coin', type: 0, decimalDisplay: 2, mintedHere: true }]]);
	const records = [{ assetId: A1, groupKey: null, amount: '400', anchorOutPoint: 'x:0' }];
	const channel = (extra) => ({ key: A1, assetId: A1, groupKey: null, counted: true, local: 0n, sendable: 0n, receivable: 0n, ...extra });
	const channels = [
		channel({ local: 550n, sendable: 500n, receivable: 50n }),
		channel({ local: 30n, sendable: 0n, receivable: 0n }),
		// An open whose units have not left the chain is in the on-chain figure already.
		channel({ counted: false, local: 999n, sendable: 999n, receivable: 999n })
	];
	const [coin] = views.assetViews({ records, registry, channels });
	assert.deepEqual(coin.balance, { total: '980', onchain: '400', channelable: '400', pendingIn: '0', pendingOut: '0', channelLocal: '580', lightningSendable: '500', lightningReceivable: '50' });

	// An asset held only in a channel is still an asset of this wallet.
	const [only, ...rest] = views.assetViews({ records: [], registry, channels: [channel({ local: 0n, receivable: 300n })] });
	assert.deepEqual(rest, []);
	assert.deepEqual([only.key, only.assetId, only.name, only.decimalDisplay, only.anchors, only.lockedSats], [A1, A1, 'coin', 2, 0, 0]);
	assert.deepEqual(only.balance, { total: '0', onchain: '0', channelable: '0', pendingIn: '0', pendingOut: '0', channelLocal: '0', lightningSendable: '0', lightningReceivable: '300' });
	// And one the wallet knows nothing about is not invented.
	assert.deepEqual(views.assetViews({ records: [], registry: new Map(), channels: [channel({ key: null })] }), []);
});

test('a channel whose funding has not confirmed: what it set aside is counted in the channel once, and its change stays on-chain', () => {
	const registry = new Map([[A1, { assetId: A1, groupKey: null, name: 'coin', type: 0, decimalDisplay: 0, mintedHere: true }]]);
	const id = 'cc'.repeat(32);
	const set = (amount, reservedBy, n) => ({ assetId: A1, groupKey: null, amount: String(amount), anchorOutPoint: `${n}:0`, ...(reservedBy ? { reservedBy } : {}) });
	const channel = { id, key: A1, assetId: A1, groupKey: null, counted: true, local: 600n, sendable: 0n, receivable: 0n, assets: [{ assetId: A1, amount: 600n }] };
	const books = (records, channels = [channel]) => {
		const { balance } = views.assetViews({ records, registry, channels })[0];
		return [balance.total, balance.onchain, balance.channelLocal];
	};
	// The funding's input holds 1000 and is still in the on-chain records, under the funding's name. 600 of it are the channel's.
	assert.deepEqual(books([set(1000, `funding:${id}`, 'x'), set(50, null, 'y')]), ['1050', '450', '600']);
	// Two inputs under the one name: the channel's share is taken off once, across them.
	assert.deepEqual(books([set(500, `funding:${id}`, 'x'), set(300, `funding:${id}`, 'y')]), ['800', '200', '600']);
	// What another funding, or a send, has set aside is not this channel's.
	assert.deepEqual(books([set(1000, `funding:${'dd'.repeat(32)}`, 'x'), set(40, 'send:1', 'y')]), ['1640', '1040', '600']);
	// Once the funding has confirmed its inputs are spent, and its change is a record like any other.
	assert.deepEqual(books([set(400, null, 'z')]), ['1000', '400', '600']);
	// An open that is not a channel yet takes nothing off, and adds nothing.
	assert.deepEqual(books([set(1000, `funding:${id}`, 'x')], [{ ...channel, counted: false }]), ['1000', '1000', '0']);
});

test('a channel state: every word the engine has for a channel, and the word the dashboard is told', () => {
	const word = (state, confirmed = false, recovery = 'none') => views.channelWord({ state, confirmed, recovery });
	// The engine's ChannelState, word for word (beignet dist/types/lightning/channel/types.d.ts), and no word at all
	// for a channel the engine does not have yet. [state, not confirmed, confirmed, confirmed with a close under way]
	const TABLE = [
		[null, 'OPENING', 'OPENING', 'OPENING'],
		['NONE', 'OPENING', 'OPENING', 'OPENING'],
		['SENT_OPEN', 'OPENING', 'OPENING', 'OPENING'],
		['SENT_ACCEPT', 'OPENING', 'OPENING', 'OPENING'],
		['SENT_FUNDING_CREATED', 'OPENING', 'OPENING', 'OPENING'],
		['SENT_FUNDING_SIGNED', 'OPENING', 'OPENING', 'OPENING'],
		['AWAITING_FUNDING_CONFIRMED', 'OPENING', 'OPENING', 'OPENING'],
		['AWAITING_CHANNEL_READY', 'OPENING', 'OPENING', 'OPENING'],
		['DUAL_FUNDING_V2', 'OPENING', 'OPENING', 'OPENING'],
		['AWAITING_TX_SIGNATURES', 'OPENING', 'OPENING', 'OPENING'],
		// Usable only once the library has confirmed the funding, and on its way out from the moment a close is asked for.
		['NORMAL', 'OPENING', 'NORMAL', 'CLOSING'],
		// Waiting for its peer: the word it would have with the peer there. That the peer is away is the row's `peerConnected`.
		['AWAITING_REESTABLISH', 'OPENING', 'NORMAL', 'CLOSING'],
		['SHUTTING_DOWN', 'SHUTTING_DOWN', 'SHUTTING_DOWN', 'SHUTTING_DOWN'],
		['NEGOTIATING_CLOSING', 'NEGOTIATING_CLOSING', 'NEGOTIATING_CLOSING', 'NEGOTIATING_CLOSING'],
		// Not something an asset channel does: shown as the engine's own word, live and carrying nothing.
		['SPLICING', 'SPLICING', 'SPLICING', 'SPLICING'],
		// A channel the node gave up is a failed channel once its funding is on chain. Before that nothing is on chain to close: an open under way.
		['ERRORED', 'OPENING', 'ERRORED', 'ERRORED'],
		// Closed is not over until the assets are back on-chain.
		['CLOSED', 'CLOSING', 'CLOSING', 'CLOSING'],
		['FORCE_CLOSED', 'FORCE_CLOSING', 'FORCE_CLOSING', 'FORCE_CLOSING'],
		// A word this host has not met is handed on as it is.
		['SOMETHING_NEW', 'SOMETHING_NEW', 'SOMETHING_NEW', 'SOMETHING_NEW']
	];
	for (const [state, unconfirmed, confirmed, closing] of TABLE) {
		assert.deepEqual([word(state, false), word(state, true), word(state, true, 'pending')], [unconfirmed, confirmed, closing], String(state));
	}
	// Every state the engine names is in the table.
	const engine = ['NONE', 'SENT_OPEN', 'SENT_ACCEPT', 'SENT_FUNDING_CREATED', 'SENT_FUNDING_SIGNED', 'AWAITING_FUNDING_CONFIRMED', 'AWAITING_CHANNEL_READY', 'NORMAL', 'SHUTTING_DOWN', 'NEGOTIATING_CLOSING', 'AWAITING_REESTABLISH', 'DUAL_FUNDING_V2', 'AWAITING_TX_SIGNATURES', 'SPLICING', 'CLOSED', 'FORCE_CLOSED', 'ERRORED'];
	assert.deepEqual(engine.filter((state) => !TABLE.some(([s]) => s === state)), []);
	for (const state of [undefined, '', 'SENT_FUNDING']) assert.equal(word(state), 'OPENING', String(state));
	assert.equal(word('CLOSED', true, 'complete'), 'CLOSED');
	assert.equal(word('FORCE_CLOSED', true, 'complete'), 'FORCE_CLOSED');
	// Only a recovery that is complete makes a closed channel over. No word on it, or one this host has not met, does not.
	for (const recovery of ['none', undefined, null, 'something-new']) {
		assert.equal(word('CLOSED', true, recovery), 'CLOSING', String(recovery));
		assert.equal(word('FORCE_CLOSED', true, recovery), 'FORCE_CLOSING', String(recovery));
	}
	for (const state of ['NORMAL', 'AWAITING_REESTABLISH']) assert.equal(word(state, true, 'something-new'), 'CLOSING', state);
	// On record and signed for, and the node does not hold it: missing, whatever else is said of it.
	for (const state of [null, 'NORMAL', 'CLOSED', 'ERRORED']) assert.equal(views.channelWord({ state, confirmed: true, recovery: 'none', engine: 'missing', signed: true }), 'MISSING', String(state));
	// An open that signed nothing is no channel to miss.
	assert.equal(views.channelWord({ state: null, confirmed: false, recovery: 'none', engine: 'missing', signed: false }), 'OPENING');
	// The manager counts every state but these as a channel the wallet still has. FAILED is an open that came to nothing.
	assert.deepEqual(views.CHANNEL_OVER, ['CLOSED', 'FORCE_CLOSED', 'FAILED']);
	// A channel is closed together with its peer only where that can work: not one that failed, or is on its way out.
	assert.deepEqual(['NORMAL', 'OPENING', 'SPLICING', 'SOMETHING_NEW', 'ERRORED', 'CLOSING', 'MISSING'].map((w) => views.CHANNEL_NO_COOPERATIVE.includes(w)), [false, false, false, false, true, false, false]);
});

test('a channel as the dashboard lists it', () => {
	const c = {
		id: 'aa'.repeat(32),
		channelId: null,
		peerPubkey: `02${'ab'.repeat(32)}`,
		peerAlias: null,
		word: 'OPENING',
		assetId: A1,
		groupKey: null,
		local: 600n,
		remote: 0n,
		sendable: 0n,
		receivable: 0n,
		fundingSats: 100000
	};
	const reg = { assetId: A1, groupKey: null, name: 'coin', type: 0, decimalDisplay: 2 };
	assert.deepEqual(views.channelView(c, reg), {
		channelId: 'aa'.repeat(32),
		pendingChannelId: 'aa'.repeat(32),
		peerPubkey: `02${'ab'.repeat(32)}`,
		peerAlias: null,
		state: 'OPENING',
		failure: null,
		peerConnected: true,
		asset: { key: A1, assetId: A1, name: 'coin', type: 'normal', decimalDisplay: 2 },
		capacity: '600',
		localBalance: '600',
		remoteBalance: '0',
		sendable: '0',
		receivable: '0',
		channelSats: 100000,
		fundingTxid: null,
		reclaimable: false,
		reclaimTxid: null
	});
	// An open that failed: why, and what was asked for, with nothing in it.
	const failure = { code: 'CHANNEL_OPEN_INTERRUPTED', message: 'It was interrupted.' };
	const failed = views.channelView({ ...c, word: 'FAILED', local: 0n, failure, capacity: 600n }, reg);
	assert.deepEqual([failed.state, failed.failure, failed.capacity, failed.localBalance], ['FAILED', failure, '600', '0']);
	// A peer that is away is said on the row, and only a plain false says so.
	assert.deepEqual([false, true, undefined, null].map((peerConnected) => views.channelView({ ...c, peerConnected }, reg).peerConnected), [false, true, true, true]);
	// A funding that is made and not confirmed, and what was sent to take it back.
	const out = views.channelView({ ...c, fundingTxid: 'f1'.repeat(32), reclaimable: true, reclaimTxid: 'f2'.repeat(32) }, reg);
	assert.deepEqual([out.fundingTxid, out.reclaimable, out.reclaimTxid], ['f1'.repeat(32), true, 'f2'.repeat(32)]);
	// The engine's id once there is one, and the peer's name when the user gave one.
	const open = views.channelView({ ...c, channelId: 'bb'.repeat(32), peerAlias: 'edge', word: 'NORMAL', local: 450n, remote: 150n, sendable: 400n, receivable: 150n }, reg);
	assert.deepEqual(
		[open.channelId, open.pendingChannelId, open.peerAlias, open.state, open.capacity, open.sendable, open.receivable],
		['bb'.repeat(32), 'aa'.repeat(32), 'edge', 'NORMAL', '600', '400', '150']
	);
	// This wallet's side of the channel's bitcoin where the node says it, beside the funding, and nothing where it does not.
	const own = views.channelView({ ...c, localSats: 98292 }, reg);
	assert.deepEqual(Object.keys(own).slice(Object.keys(own).indexOf('channelSats'), Object.keys(own).indexOf('channelSats') + 2), ['channelSats', 'localSats']);
	assert.deepEqual([own.channelSats, own.localSats, views.channelView({ ...c, localSats: 0 }, reg).localSats], [100000, 98292, 0]);
	for (const none of [null, undefined, -1, 1.5, '98292']) assert.equal('localSats' in views.channelView({ ...c, localSats: none }, reg), false, String(none));
	// An asset the wallet knows only by its id is still listed.
	assert.deepEqual(views.channelView(c, null).asset, { key: A1, assetId: A1, name: null, type: 'normal', decimalDisplay: 0 });
	// A payment in flight is on neither side, and the channel is no smaller for it:
	// its capacity is what it was funded with, over every issuance.
	const paying = views.channelView({ ...c, word: 'NORMAL', assets: [{ assetId: A1, amount: 600n }], local: 400n, remote: 150n, sendable: 400n, receivable: 150n }, reg);
	assert.deepEqual([paying.capacity, paying.localBalance, paying.remoteBalance], ['600', '400', '150']);
	const two = views.channelView({ ...c, word: 'NORMAL', assets: [{ assetId: A1, amount: 600n }, { assetId: 'cd'.repeat(32), amount: 250n }], local: 700n, remote: 100n }, reg);
	assert.equal(two.capacity, '850');
	// With no funding on record it is the sum of the last balances.
	assert.equal(views.channelView({ ...c, assets: [], local: 450n, remote: 150n }, reg).capacity, '600');
});

test('a peer\'s price as a sentence, and none for one unit to the sat', () => {
	const coin = { name: 'coin', decimalDisplay: 2 };
	const rate = (coefficient, scale = 0) => ({ coefficient: BigInt(coefficient), scale });
	// One unit to the sat is the absence of a price, however it is written.
	assert.equal(views.isNominal(rate(100_000_000)), true);
	assert.equal(views.isNominal(rate(100_000_000_000, 3)), true);
	assert.equal(views.isNominal(rate(4_000_000)), false);
	assert.equal(views.isNominal(null), false);
	assert.equal(views.rateText(coin, rate(100_000_000)), '');
	assert.equal(views.rateText(coin, null), '');
	assert.equal(views.rateText(coin, rate(0)), '');
	// 4,000,000 units a bitcoin is 25 sats a unit, and a coin is a hundred units.
	assert.equal(views.rateText(coin, rate(4_000_000)), '1 coin = 2,500 sats');
	assert.equal(views.rateText(coin, rate(4_000_000_000, 3)), '1 coin = 2,500 sats');
	assert.equal(views.rateText({ name: 'x', decimalDisplay: 0 }, rate(300_000_000)), '1 x = 0.333 sats');
	assert.equal(views.rateText({ name: 'usd', decimalDisplay: 2 }, rate(6_500_000)), '1 usd = 1,538.461 sats');
	assert.equal(views.rateText({ name: 'penny', decimalDisplay: 0 }, rate(50_000_000)), '1 penny = 2 sats');
	assert.equal(views.rateText(null, rate(200_000_000)), '1 unit = 0.5 sats');
	// Millisatoshis as the sats they cost: never rounded to less.
	assert.deepEqual([0n, 1n, 999n, 1000n, 1001n, 150000n].map(views.satsOf), [0, 1, 1, 1, 2, 150]);
});

test('a Lightning row carries its payment hash', () => {
	const hash = 'ef'.repeat(32);
	const row = views.newRow({ id: `ln-send-${hash}`, kind: 'ln-send', ref: hash, created: T0, paymentHash: hash, clientRef: 'pay-key', assets: [{ key: A1, amount: '50' }] });
	const view = views.rowView(row, { cfg: regtest, now: T0 });
	assert.deepEqual([view.kind, view.state, view.paymentHash, view.clientRef, view.txid, view.stuck, view.watching], ['ln-send', 'pending', hash, 'pay-key', null, false, null]);
	// Every other row says it has none.
	assert.equal(views.rowView(views.newRow({ id: 'send-1', kind: 'send', ref: '1', created: T0 }), { cfg: regtest, now: T0 }).paymentHash, null);
});

test('status: lightning is full only when the host says so', () => {
	const of = (lightning) => views.statusView({ cfg: regtest, phase: 'ready', lightning }).lightning;
	assert.deepEqual(of({ mode: 'full', usableChannels: 2, feeCoins: null }), { mode: 'full', usableChannels: 2, feeCoins: null });
	assert.deepEqual(of({ mode: 'off', usableChannels: 1, feeCoins: null }), { mode: 'off', usableChannels: 1, feeCoins: null });
	assert.deepEqual(of({ mode: 'FULL' }), { mode: 'off', usableChannels: 0, feeCoins: null });
	assert.deepEqual(of(undefined), { mode: 'off', usableChannels: 0, feeCoins: null });
});

test('status: every field the dashboard reads, with lightning off', () => {
	const status = views.statusView({ cfg: regtest, phase: 'starting' });
	assert.deepEqual(Object.keys(status), [
		'phase', 'ready', 'error', 'network', 'hrp', 'chain', 'pending', 'holdsAssets', 'assetChannels', 'lockedSats', 'anchorCount', 'startup', 'lightning',
		'proofServer', 'backup', 'limits'
	]);
	assert.equal(status.ready, false);
	assert.equal(status.error, null);
	assert.deepEqual(status.chain, { name: 'regtest', height: 0, minConfirmations: 1 });
	// A testnet wallet that has not found out which testnet it is on says so by saying nothing.
	assert.equal(views.statusView({ cfg: { ...regtest, network: 'testnet', tapNetwork: null }, phase: 'starting' }).chain.name, null);
	assert.equal(views.statusView({ cfg: { ...regtest, network: 'testnet', tapNetwork: 'testnet4' }, phase: 'ready' }).chain.name, 'testnet4');
	assert.deepEqual(status.pending, { mints: 0, sends: 0, receives: 0, burns: 0 });
	assert.deepEqual(status.lightning, { mode: 'off', usableChannels: 0, feeCoins: null });
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

test('an open a peer began that the node does not hold is opening, and missing is only a channel that was signed for', () => {
	const { channelWord } = require('./views');
	const open = { state: null, confirmed: false, recovery: 'none' };
	// The acceptor's side of an open with no channel in the node and no confirmed funding: still waiting.
	assert.equal(channelWord({ ...open, engine: 'absent', signed: false }), 'OPENING');
	assert.equal(channelWord({ ...open, engine: 'absent', signed: true }), 'OPENING');
	assert.equal(channelWord({ ...open, engine: 'missing', signed: false }), 'OPENING');
	assert.equal(channelWord({ ...open, engine: 'missing', signed: true }), 'MISSING');
});

test('a channel that has not taken in the results of earlier payments says how many on its row, and one that has says nothing', () => {
	const row = (extra) =>
		views.channelView(
			{ id: 'aa'.repeat(32), channelId: 'bb'.repeat(32), peerPubkey: `02${'c'.repeat(64)}`, word: 'NORMAL', local: 5n, remote: 0n, capacity: 5n, sendable: 5n, receivable: 0n, fundingSats: 100000, ...extra },
			null
		);
	assert.equal(row({ undeliveredOutcomes: 2 }).undeliveredOutcomes, 2);
	for (const none of [{}, { undeliveredOutcomes: 0 }, { undeliveredOutcomes: -1 }, { undeliveredOutcomes: 1.5 }, { undeliveredOutcomes: '3' }, { undeliveredOutcomes: null }]) {
		assert.equal('undeliveredOutcomes' in row(none), false, JSON.stringify(none));
	}
});

test('a channel the node gave up reads as failed only once its funding is on chain', () => {
	const { channelWord } = require('./views');
	const word = (extra) => channelWord({ state: 'ERRORED', confirmed: true, recovery: 'none', engine: 'held', signed: true, ...extra });
	assert.equal(word({}), 'ERRORED');
	// Its funding transaction is on no chain: an open under way, whoever began it and whatever was signed.
	assert.equal(word({ confirmed: false }), 'OPENING');
	assert.equal(word({ confirmed: false, signed: false }), 'OPENING');
	// What a restore leaves is still said as what it is.
	assert.equal(word({ confirmed: false, engine: 'missing' }), 'MISSING');
});
