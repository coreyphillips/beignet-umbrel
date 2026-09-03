/**
 * Run with: npm test (from manager/ui).
 *
 * The close story helper: the daemon's closeStatus (beignet 0.9.0+) and the
 * tip height become the sentences the channel detail view prints. Pinned:
 * who closed and why, the honest confirmation line when the daemon reports
 * no height, the funds timelock arithmetic, and when Rebroadcast applies.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	closeStory,
	closerSentence,
	fmtBlocksDuration,
	rebroadcastAlreadyDone
} from './close-story.js';

const TXID = 'f'.repeat(64);

test('who closed and why, in plain words', () => {
	assert.equal(closerSentence({ closer: 'local', reason: 'user' }), 'You closed this channel.');
	assert.equal(closerSentence({ closer: 'local' }), 'You closed this channel.');
	assert.match(
		closerSentence({ closer: 'local', reason: 'REESTABLISH_TIMEOUT_FORCE_CLOSED' }),
		/force-closed it: the peer stayed away past the reestablish deadline/
	);
	// An unlisted code still tells the reader something.
	assert.equal(
		closerSentence({ closer: 'local', reason: 'SOME_NEW_REASON' }),
		'This wallet force-closed it: some new reason.'
	);
	assert.equal(closerSentence({ closer: 'remote', reason: 'user' }), 'The peer closed it.');
	assert.equal(closerSentence({ closer: 'cooperative' }), 'Closed cooperatively.');
	assert.equal(
		closerSentence({ closer: 'cooperative', reason: 'user' }),
		'You closed this channel cooperatively.'
	);
	assert.match(closerSentence({ closer: 'unknown' }), /could not tell/);
	assert.equal(closerSentence(null), null);
});

test('an unconfirmed close is reported as not yet reported, never as a chain fact', () => {
	const s = closeStory(
		{ closer: 'local', reason: 'REESTABLISH_TIMEOUT_FORCE_CLOSED', closingTxid: TXID, broadcast: true, confirmationHeight: 0, resolution: 'pending' },
		908214
	);
	assert.equal(s.confirmedAt, null);
	assert.equal(s.confirmations, null);
	assert.match(s.confirmation, /confirmation not yet reported/);
	assert.match(s.resolution, /until the close confirms/);
	assert.equal(s.canRebroadcast, true, 'unconfirmed with a txid: rebroadcast applies');
	assert.equal(s.funds, null, 'no timelock base without a confirmed commitment');
});

test('a close the daemon never got out says so and offers rebroadcast', () => {
	const s = closeStory(
		{ closer: 'local', closingTxid: TXID, broadcast: false, confirmationHeight: 0, resolution: 'pending' },
		908214
	);
	assert.match(s.confirmation, /has not reached the network/);
	assert.equal(s.canRebroadcast, true);
	const none = closeStory({ closer: 'cooperative', broadcast: false, confirmationHeight: 0, resolution: 'pending' }, 1);
	assert.match(none.confirmation, /No closing transaction recorded/);
	assert.equal(none.canRebroadcast, false, 'nothing to rebroadcast without a txid');
});

test('a confirmed close counts confirmations from the tip and ends rebroadcast', () => {
	const s = closeStory(
		{ closer: 'remote', closingTxid: TXID, broadcast: true, confirmationHeight: 908200, resolution: 'resolved' },
		908214
	);
	assert.equal(s.confirmedAt, 908200);
	assert.equal(s.confirmations, 15);
	assert.match(s.confirmation, /Confirmed at block 908200 \(15 confirmations\)/);
	assert.match(s.resolution, /Every output of the close has been swept/);
	assert.equal(s.canRebroadcast, false);
	// Same height as the tip is one confirmation, never zero.
	assert.equal(closeStory({ closer: 'remote', confirmationHeight: 5, resolution: 'sweeping', broadcast: true }, 5).confirmations, 1);
	// No tip: the height is stated, the count is not invented.
	const noTip = closeStory({ closer: 'remote', confirmationHeight: 908200, resolution: 'sweeping', broadcast: true }, undefined);
	assert.equal(noTip.confirmations, null);
	assert.equal(noTip.confirmation, 'Confirmed at block 908200.');
});

test('the funds line follows the to_local timelock', () => {
	const ahead = closeStory(
		{ closer: 'local', reason: 'user', closingTxid: TXID, broadcast: true, confirmationHeight: 908100, resolution: 'sweeping', fundsAvailableHeight: 908244 },
		908214
	);
	assert.equal(ahead.fundsBlocksLeft, 30);
	assert.match(ahead.funds, /spendable at block 908244, 30 blocks from now \(about 5 hours\)/);
	const matured = closeStory(
		{ closer: 'local', closingTxid: TXID, broadcast: true, confirmationHeight: 908100, resolution: 'sweeping', fundsAvailableHeight: 908200 },
		908214
	);
	assert.equal(matured.fundsBlocksLeft, 0);
	assert.match(matured.funds, /spendable: the timelock has matured/);
});

test('blocks read as a rough duration', () => {
	assert.equal(fmtBlocksDuration(0), 'now');
	assert.equal(fmtBlocksDuration(3), 'about 30 minutes');
	assert.equal(fmtBlocksDuration(6), 'about 1 hour');
	assert.equal(fmtBlocksDuration(144), 'about 24 hours');
	assert.equal(fmtBlocksDuration(1008), 'about 7 days');
});

test('a rebroadcast the network already has is a notice, not an error', () => {
	assert.equal(rebroadcastAlreadyDone('Transaction outputs already in utxo set'), true);
	assert.equal(rebroadcastAlreadyDone('txn-already-known'), true);
	assert.equal(rebroadcastAlreadyDone('Close already confirmed'), true);
	assert.equal(rebroadcastAlreadyDone('Recorded close transaction is invalid'), false);
	assert.equal(rebroadcastAlreadyDone('Channel is not closed (state NORMAL)'), false);
});
