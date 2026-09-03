/**
 * Run with: npm test (from manager/ui).
 *
 * The one reduction every lightning-first card reads: which sats can be
 * spent, which are arriving and why, and which invoice to mint.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { arrivingFundsNote, homeChannel, lfbwStatus, planInvoice, previousPrimaryChannels } from './lfbw.js';

const PK = '03' + '22'.repeat(32);
const rec = (lf = {}) => ({ lfbw: { enabled: true, mode: 'internal', primaryPubkey: PK, setup: 'ready', ...lf } });
const home = (extra = {}) => ({
	channelId: 'c1',
	peerPubkey: PK,
	state: 'NORMAL',
	htlcUsable: true,
	capacitySats: 500_000,
	localBalanceSats: 200_000,
	remoteBalanceSats: 300_000,
	...extra
});

test('homeChannel is the usable channel with the primary and nothing else', () => {
	assert.equal(homeChannel([home({ peerPubkey: 'other' })], PK), null);
	assert.equal(homeChannel([home({ state: 'CLOSED' })], PK), null);
	assert.equal(homeChannel([home({ state: 'AWAITING_FUNDING_CONFIRMED', htlcUsable: false })], PK), null);
	assert.equal(homeChannel([home()], PK).channelId, 'c1');
});

test('planInvoice mints plain when the home channel covers it, JIT when the primary must provision', () => {
	assert.deepEqual(planInvoice({ wantedSats: 100_000, channels: [home()], primaryPubkey: PK, setup: 'ready' }), { kind: 'plain' });
	assert.deepEqual(planInvoice({ wantedSats: 400_000, channels: [home()], primaryPubkey: PK, setup: 'ready' }), { kind: 'jit' }, 'a short home channel is provisioned through the primary too');
	assert.deepEqual(planInvoice({ wantedSats: 400_000, channels: [home({ htlcUsable: false, state: 'AWAITING_FUNDING_CONFIRMED' })], primaryPubkey: PK, setup: 'ready' }), { kind: 'jit' }, 'a channel that is not usable yet does not count');
	assert.deepEqual(planInvoice({ wantedSats: 0, channels: [], primaryPubkey: PK, setup: 'ready' }), { kind: 'jit' });
	assert.deepEqual(planInvoice({ wantedSats: 0, channels: [home()], primaryPubkey: PK, setup: 'ready' }), { kind: 'plain' });
	assert.deepEqual(
		planInvoice({ wantedSats: 400_000, channels: [home()], primaryPubkey: PK, setup: 'ready', primaryRunning: false }),
		{ kind: 'refuse', code: 'PRIMARY_DOWN', reason: 'not-running' }
	);
	assert.deepEqual(
		planInvoice({ wantedSats: 100_000, channels: [home()], primaryPubkey: PK, setup: 'ready', primaryRunning: false }),
		{ kind: 'plain' },
		'a covered amount does not need the primary'
	);
	assert.deepEqual(planInvoice({ wantedSats: 1, channels: [home()], primaryPubkey: PK, setup: 'failed' }), { kind: 'refuse', code: 'NOT_READY' });
	assert.deepEqual(planInvoice({ wantedSats: 1, channels: [home()], primaryPubkey: null, setup: 'ready' }), { kind: 'refuse', code: 'NOT_READY' });
});

test('lfbwStatus tells spendable, receivable and the three kinds of arriving sats apart', () => {
	const s = lfbwStatus({
		rec: rec(),
		balance: { onchain: 40_000, lightning: 200_000, total: 240_000, splicingSats: 5_000 },
		liquidity: { sendableSats: 190_000, totalLocalBalanceSats: 200_000 },
		channels: [home(), home({ channelId: 'c2', state: 'AWAITING_FUNDING_CONFIRMED', htlcUsable: false, localBalanceSats: 30_000, remoteBalanceSats: 0 })],
		utxos: [{ valueSats: 30_000, height: 100 }, { valueSats: 10_000, height: null }],
		peers: [{ pubkey: PK, state: 'connected' }]
	});
	assert.equal(s.home.channelId, 'c1');
	assert.equal(s.canSend, 190_000, 'sendable from the liquidity snapshot, reserve excluded');
	assert.equal(s.canReceive, 300_000);
	assert.equal(s.unconfirmed, 10_000);
	assert.equal(s.confirmedOnchain, 30_000);
	assert.equal(s.pending, 10_000 + 30_000 + 30_000 + 5_000);
	assert.equal(s.total, 200_000 + 40_000 + 30_000 + 5_000);
	assert.equal(s.primaryConnected, true);
	assert.equal(s.notes.length, 4);
	assert.match(s.notes[0], /10,000 sats are arriving/);
	assert.match(s.notes[1], /30,000 sats have confirmed and are moving/);
	assert.match(s.notes[2], /30,000 sats are in a channel that is still confirming/);
	assert.match(s.notes[3], /5,000 sats rejoin/);
});

test('a deposit under the floor is said to be waiting, and nothing is said before setup is ready', () => {
	const below = lfbwStatus({
		rec: rec(),
		balance: { onchain: 12_000, lightning: 0 },
		channels: [],
		utxos: [{ valueSats: 12_000, height: 100 }],
		peers: []
	});
	assert.equal(below.notes.length, 1);
	assert.match(below.notes[0], /12,000 sats are waiting: amounts under 25,000 sats/);
	assert.equal(below.primaryConnected, false);
	const notReady = lfbwStatus({ rec: rec({ setup: 'pending' }), balance: { onchain: 12_000 }, channels: [], utxos: [{ valueSats: 12_000, height: 100 }] });
	assert.deepEqual(notReady.notes, []);
});

test('a confirmed deposit the manager holds for the fee is said so, and the override is offered while it lasts', () => {
	const waiting = lfbwStatus({
		rec: rec({ lastChannelize: { at: 1, action: 'wait', reason: 'fee-too-high', feeSats: 2400, amountSats: 28_000 } }),
		balance: { onchain: 30_000, lightning: 200_000 },
		channels: [home()],
		utxos: [{ valueSats: 30_000, height: 100 }],
		peers: []
	});
	assert.equal(waiting.notes.length, 1);
	assert.match(waiting.notes[0], /30,000 sats have confirmed and are waiting for the fee rate to come down, or for more to arrive: moving them now would pay about 2,400 sats in fees/);
	assert.deepEqual(waiting.feeWait, { feeSats: 2400, amountSats: 28_000 });
	// The last decision is stale once the funds moved: nothing confirmed on-chain, no override.
	const moved = lfbwStatus({
		rec: rec({ lastChannelize: { at: 1, action: 'wait', reason: 'fee-too-high', feeSats: 2400, amountSats: 28_000 } }),
		balance: { onchain: 0, lightning: 230_000 },
		channels: [home()],
		utxos: [],
		peers: []
	});
	assert.equal(moved.feeWait, null);
	assert.deepEqual(moved.notes, []);
	const other = lfbwStatus({
		rec: rec({ lastChannelize: { at: 1, action: 'wait', reason: 'below-floor' } }),
		balance: { onchain: 30_000, lightning: 0 },
		channels: [],
		utxos: [{ valueSats: 30_000, height: 100 }],
		peers: []
	});
	assert.equal(other.feeWait, null);
	assert.match(other.notes[0], /30,000 sats have confirmed and are moving/);
});

test('without a liquidity snapshot the home channel\'s local balance stands in for spendable', () => {
	const s = lfbwStatus({ rec: rec(), balance: null, info: { onchainBalanceSats: 0, lightningBalanceSats: 200_000 }, liquidity: null, channels: [home()], utxos: null, peers: null });
	assert.equal(s.canSend, 200_000);
	assert.equal(s.lightning, 200_000);
	assert.equal(s.pending, 0);
});

test('planInvoice refuses when the primary is not connected, naming that rather than "not running"', () => {
	const channels = [home({ remoteBalanceSats: 1000 })];
	const base = { wantedSats: 50_000, channels, primaryPubkey: PK, setup: 'ready' };
	assert.deepEqual(planInvoice({ ...base, primaryConnected: false }), { kind: 'refuse', code: 'PRIMARY_DOWN', reason: 'not-connected' });
	assert.deepEqual(planInvoice({ ...base, primaryRunning: false, primaryConnected: false }), { kind: 'refuse', code: 'PRIMARY_DOWN', reason: 'not-running' });
	assert.deepEqual(planInvoice({ ...base, primaryConnected: true }), { kind: 'jit' });
	assert.deepEqual(planInvoice({ ...base, wantedSats: 500, primaryConnected: false }), { kind: 'plain' }, 'a covered amount never needs the primary');
});

test('previous-primary channels are listed on the status and excluded from the home channel', () => {
	const OLD = '03' + '11'.repeat(32);
	const channels = [home(), home({ channelId: 'old', peerPubkey: OLD, localBalanceSats: 120_000 }), home({ channelId: 'gone', peerPubkey: OLD, state: 'CLOSED' })];
	const status = lfbwStatus({ rec: rec({ previousPrimary: { pubkey: OLD, walletId: 'p0', at: 1 } }), channels, balance: null, liquidity: null, utxos: [], peers: [] });
	assert.deepEqual(status.previousChannels.map((c) => c.channelId), ['old']);
	assert.equal(status.previousPrimary.pubkey, OLD);
	assert.equal(status.home.channelId, 'c1');
	assert.deepEqual(previousPrimaryChannels(channels, null), []);
});

test('arrivingFundsNote explains the shortfall from what is arriving, and only between Can send and Total', () => {
	const status = (extra) => ({
		canSend: 100_000,
		total: 200_000,
		pending: 100_000,
		unconfirmed: 0,
		confirmedOnchain: 0,
		pendingChannels: [],
		feeWait: null,
		...extra
	});
	assert.equal(arrivingFundsNote(90_000, status()), null, 'payable now');
	assert.equal(arrivingFundsNote(250_000, status()), null, 'above Total stays the plain refusal');
	assert.equal(arrivingFundsNote(0, status()), null);

	const moving = arrivingFundsNote(150_000, status({ confirmedOnchain: 100_000 }));
	assert.match(moving, /asks for 50,000 sats more than you can send right now/);
	assert.match(moving, /100,000 sats are moving into your channel, about one block from now/);
	assert.match(moving, /the request stays here/);

	const unconfirmed = arrivingFundsNote(150_000, status({ unconfirmed: 100_000 }));
	assert.match(unconfirmed, /need one confirmation, and then a move into your channel, so about two blocks/);

	const feeWait = arrivingFundsNote(150_000, status({ confirmedOnchain: 100_000, feeWait: { feeSats: 6000, amountSats: 100_000 } }));
	assert.match(feeWait, /waiting on the fee rate; "Move now anyway"/);

	const opening = arrivingFundsNote(150_000, status({ pendingChannels: [{ localBalanceSats: 100_000 }] }));
	assert.match(opening, /in a channel that is still confirming/);

	const splicing = arrivingFundsNote(150_000, status({ pending: 100_000 }));
	assert.match(splicing, /rejoin your balance when the current splice locks/);

	const small = arrivingFundsNote(110_000, status({ confirmedOnchain: 12_000, pending: 12_000, total: 112_000 }));
	assert.match(small, /waiting for more to arrive before they move/);
});
