import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	planEpoch,
	bookFits,
	settlementChannels,
	describeEpoch,
	describeReturn,
	returnOutcome,
	currentEpoch,
	refusalText,
	slotLabel,
	MIN_MARGIN_BLOCKS,
	EXPIRY_HEADROOM_BLOCKS
} from './ffor.js';

const CH = 'ab'.repeat(32);
const epoch = (state, slots, extra = {}) => ({
	channelId: CH,
	role: 'R',
	state,
	epochId: 'e1',
	settlementDeadline: 1000,
	voucherExpiry: 2200,
	epochStartHeight: 800,
	slots: slots.map((s, i) => ({ k: i + 1, amountMsat: '50000000', state: s })),
	...extra
});

test('planEpoch turns the card fields into the start body, heights absolute, no witness restriction', () => {
	const plan = planEpoch({ channelId: CH, amountSats: 50000, count: 2, awayDays: 1, tip: 746 });
	assert.deepEqual(plan.body, {
		channelId: CH,
		voucherAmountsMsat: ['50000000', '50000000'],
		settlementDeadline: 746 + 144,
		voucherExpiry: 746 + 144 + MIN_MARGIN_BLOCKS + EXPIRY_HEADROOM_BLOCKS,
		feeBaseMsat: 1000,
		feeProportionalMillionths: 100,
		witnessPeers: []
	});
	assert.equal(plan.budgetSats, 100000);
	assert.match(planEpoch({ channelId: CH, amountSats: 0, count: 1, awayDays: 1, tip: 1 }).error, /whole number of sats/);
	assert.match(planEpoch({ channelId: CH, amountSats: 1, count: 500, awayDays: 1, tip: 1 }).error, /483/);
	assert.match(planEpoch({ channelId: CH, amountSats: 1, count: 1, awayDays: 0, tip: 1 }).error, /one day/);
	assert.match(planEpoch({ channelId: CH, amountSats: 1, count: 1, awayDays: 1, tip: 0 }).error, /block height/);
	assert.match(planEpoch({ amountSats: 1, count: 1, awayDays: 1, tip: 1 }).error, /channel/);
	assert.equal(planEpoch({ channelId: CH, amountSats: 1, count: 1, awayDays: 1, tip: 1, feeBaseMsat: 0, feePpm: '0' }).body.feeBaseMsat, 0);
});

test('bookFits reads the peer side of the channel and says what it holds', () => {
	assert.equal(bookFits(100000, { remoteBalanceSats: 250000 }).ok, true);
	const short = bookFits(300000, { remoteBalanceSats: 250000 });
	assert.equal(short.ok, false);
	assert.match(short.note, /needs 300,000 sats .* holds 250,000 sats/);
});

test('settlementChannels are the open channels to opted-in siblings, named', () => {
	const candidates = [{ id: 's1', name: 'Settler', nodeId: '02aa' }];
	const channels = [
		{ channelId: 'a', peerPubkey: '02aa', state: 'NORMAL' },
		{ channelId: 'b', peerPubkey: '02bb', state: 'NORMAL' },
		{ channelId: 'c', peerPubkey: '02aa', state: 'AWAITING_REESTABLISH' }
	];
	const got = settlementChannels(channels, candidates);
	assert.deepEqual(got.map((c) => [c.channelId, c.settler.name]), [['a', 'Settler']]);
});

test('currentEpoch prefers the live one, then setup, then the newest', () => {
	const closed = epoch('CLOSED', ['settled'], { epochStartHeight: 900 });
	const active = epoch('ACTIVE', ['exposed'], { epochStartHeight: 700 });
	assert.equal(currentEpoch([closed, active]).state, 'ACTIVE');
	assert.equal(currentEpoch([closed, { ...active, role: 'S' }]).state, 'CLOSED');
	assert.equal(currentEpoch([]), null);
});

test('describeEpoch says the state, the count and the return-by height in blocks and days', () => {
	const d = describeEpoch(epoch('ACTIVE', ['settled', 'exposed', 'unissued']), 746);
	assert.equal(d.label, 'receiving offline');
	assert.equal(d.tone, 'green');
	assert.equal(d.settled, 1);
	assert.equal(d.total, 3);
	assert.equal(d.returnBy.blocksLeft, 254);
	assert.match(d.returnBy.text, /by block 1000, about 42 hours from now at ten minutes a block/);
	assert.equal(d.warn, false);
	assert.match(d.detail, /1 of 3 vouchers paid so far/);
	const soon = describeEpoch(epoch('ACTIVE', ['exposed']), 990);
	assert.equal(soon.warn, true, 'under a day of margin');
	const late = describeEpoch(epoch('ACTIVE', ['exposed']), 1200);
	assert.match(late.returnBy.text, /already passed/);
	const mismatch = describeEpoch(epoch('ACTIVE', ['exposed'], { activationMismatch: true }), 746);
	assert.equal(mismatch.tone, 'red');
	assert.match(mismatch.detail, /Enforce on-chain/);
	const closed = describeEpoch(epoch('CLOSED', ['settled', 'unsettled']), 900);
	assert.equal(closed.label, 'closed');
	assert.match(closed.detail, /1 of 2 vouchers were paid while away; 1 not paid/);
	assert.equal(describeEpoch(epoch('NEGOTIATING', []), 1).label, 'setting up');
	const enforced = describeEpoch(epoch('ACTIVE', ['settled', 'exposed']), 900, { state: 'FORCE_CLOSED' });
	assert.equal(enforced.label, 'enforced on-chain');
	assert.equal(enforced.enforced, true);
	assert.equal(enforced.warn, false);
	assert.match(enforced.detail, /force-closed with 1 of 2 vouchers known paid/);
	assert.match(describeEpoch(epoch('ABORTED', [], { abortReason: 2 }), 1).detail, /does not settle offline receives/);
	assert.equal(describeEpoch(null, 1), null);
});

test('describeReturn is complete only once the epoch closed with every slot accounted for', () => {
	const done = describeReturn({ action: 'closed', preimagesKnown: [1], epoch: epoch('CLOSED', ['settled', 'unsettled']) });
	assert.equal(done.complete, false);
	assert.equal(done.credited, 1);
	assert.match(done.detail, /1 voucher paid while away, credited to your channel balance; 1 not paid/);
	const all = describeReturn({ action: 'closed', preimagesKnown: [1, 2], epoch: epoch('CLOSED', ['settled', 'settled']) });
	assert.equal(all.complete, true);
	assert.equal(all.title, 'Back online, epoch closed');
	const none = describeReturn({ action: 'closed', preimagesKnown: [], epoch: epoch('CLOSED', ['unsettled']) });
	assert.match(none.detail, /Nothing was paid while away/);
	const away = describeReturn({ action: 'nothing', preimagesKnown: [], epoch: epoch('ACTIVE', ['exposed']) });
	assert.equal(away.complete, false);
	assert.equal(away.tone, 'yellow');
	assert.match(away.title, /not reachable/);
	const drain = describeReturn({ action: 'nothing', preimagesKnown: [], epoch: epoch('DRAINING', ['settled', 'exposed']) });
	assert.equal(drain.outcome, 'draining');
	assert.equal(drain.complete, false);
	assert.match(drain.title, /Closing the book/);
	const closedAnyway = describeReturn({ action: 'nothing', preimagesKnown: [], epoch: epoch('CLOSED', ['settled']) });
	assert.equal(closedAnyway.outcome, 'closed', 'an epoch that already closed is not an unreachable peer');
	assert.equal(closedAnyway.complete, true);
	const enforcedRet = describeReturn({ action: 'nothing', preimagesKnown: [], channelState: 'FORCE_CLOSED', epoch: epoch('ACTIVE', ['settled']) });
	assert.equal(enforcedRet.outcome, 'enforced');
	assert.equal(returnOutcome({ action: 'nothing', state: 'ACTIVE', channelState: 'NORMAL' }), 'unreachable');
	const failed = describeReturn({ action: null, error: 'boom', epoch: null });
	assert.equal(failed.tone, 'red');
	assert.equal(failed.detail, 'boom');
	assert.equal(describeReturn(null), null);
});

test('refusalText and slotLabel say the daemon words in plain ones', () => {
	assert.match(refusalText(new Error('settlement service not offered by this peer')), /Settle offline receives/);
	assert.match(refusalText(new Error("fee terms are below this peer's floor")), /fee floor/);
	assert.equal(refusalText(new Error('something else')), 'something else');
	assert.equal(slotLabel({ state: 'settled' }), 'Paid while away');
	assert.equal(slotLabel({ state: 'unissued' }), 'Waiting for an invoice');
});
