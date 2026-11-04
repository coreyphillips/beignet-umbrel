/**
 * Run with: npm test (from manager/ui).
 *
 * The split between a node's real failures and what is only worth knowing,
 * pinned on the field log of 2026-11-04: Core Lightning gossip warnings on the
 * all-zero channel id, and forwards one channel kept turning away.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	errorChannelId,
	groupNodeErrors,
	isGossipWarning,
	isWarningLogLine,
	nodeErrorKind
} from './node-errors.js';
import { formatNodeError } from './channel-open.js';

const ZERO = '0'.repeat(64);
const CH = 'e1a1be904fae800d67a3546605eae48cdc8c84fc5a7e29a2ce7f4df31da1eccd';
const err = (message, extra = {}) => ({ code: 'CHANNEL_ERROR', message, channelId: ZERO, ...extra });

test('peer warnings and refused adds are warnings; everything else is an error', () => {
	assert.equal(nodeErrorKind(err('Remote warning: Unknown UTXO 504311x1993x0')), 'warning');
	assert.equal(nodeErrorKind(err('Insufficient balance for HTLC', { channelId: CH })), 'warning');
	assert.equal(nodeErrorKind(err('Max HTLC value in flight exceeded', { channelId: CH })), 'warning');
	assert.equal(nodeErrorKind(err('Remote error: invalid update')), 'error');
	assert.equal(nodeErrorKind(err('Channel in CLOSING state', { channelId: CH })), 'error');
	// Only the whole refusal, not a longer message that happens to contain it.
	assert.equal(nodeErrorKind(err('Splice failed: Insufficient balance for HTLC reserve')), 'error');
});

test('the all-zero channel id names no channel', () => {
	assert.equal(errorChannelId(err('x')), null);
	assert.equal(errorChannelId({ message: 'x' }), null);
	assert.equal(errorChannelId(err('x', { channelId: CH })), CH);
});

test('gossip warnings are told apart from other peer warnings', () => {
	assert.equal(isGossipWarning(err('Remote warning: Unknown UTXO 503816x1343x1')), true);
	assert.equal(
		isGossipWarning(
			err('Remote warning: Do not set DONT_FORWARD on public channel_updates (898237x1683x0)')
		),
		true
	);
	assert.equal(isGossipWarning(err('Remote warning: Splice feerate_perkw is too low')), false);
	assert.equal(isGossipWarning(err('Remote error: Unknown UTXO')), false);
});

test('repeats fold into one entry, newest first, with the count and first time', () => {
	const list = [
		err('Remote warning: Unknown UTXO 504311x1993x0', { timestamp: 100 }),
		err('Insufficient balance for HTLC', { channelId: CH, timestamp: 200 }),
		err('Insufficient balance for HTLC', { channelId: CH, timestamp: 300 }),
		err('Remote warning: Unknown UTXO 504311x1993x0', { timestamp: 400 }),
		err('Insufficient balance for HTLC', { channelId: 'ab'.repeat(32), timestamp: 350 }),
		err('Insufficient balance for HTLC', { channelId: CH, timestamp: 250 })
	];
	const groups = groupNodeErrors(list);
	assert.deepEqual(
		groups.map((g) => [g.message, g.channelId.slice(0, 4), g.count, g.firstTimestamp, g.timestamp]),
		[
			['Remote warning: Unknown UTXO 504311x1993x0', '0000', 2, 100, 400],
			['Insufficient balance for HTLC', 'abab', 1, 350, 350],
			['Insufficient balance for HTLC', 'e1a1', 3, 200, 300]
		]
	);
	assert.equal(groupNodeErrors(list, 1).length, 1, 'limit applies to groups');
});

test('raw log lines for both kinds are recognised wherever they appear', () => {
	assert.equal(
		isWarningLogLine('[2026-11-04T13:31:58.837Z] node error [CHANNEL_ERROR] Remote warning: Unknown UTXO 503816x1343x1'),
		true
	);
	assert.equal(
		isWarningLogLine('[2026-11-04T08:21:29.791Z] node error [CHANNEL_ERROR] Insufficient balance for HTLC'),
		true
	);
	assert.equal(isWarningLogLine('[2026-11-04T08:21:29.791Z] node error [CHANNEL_ERROR] Remote error: sync error'), false);
});

test('a peer warning reads as the peer\'s words, and says when it is only gossip', () => {
	const gossip = formatNodeError(err('Remote warning: Unknown UTXO 504311x1993x0'));
	assert.match(gossip, /^A peer sent a warning: "Unknown UTXO 504311x1993x0"\./);
	assert.match(gossip, /network map \(gossip\)/);
	assert.doesNotMatch(gossip, /wallet reported a problem/);

	const other = formatNodeError(err('Remote warning: Splice feerate_perkw is too low'));
	assert.match(other, /^A peer sent a warning: "Splice feerate_perkw is too low"\./);
	assert.doesNotMatch(other, /gossip/);
});

test('a turned-away payment no longer assumes the user was sending', () => {
	const text = formatNodeError(err('Insufficient balance for HTLC', { channelId: CH }));
	assert.match(text, /turned away/);
	assert.match(text, /routing through your node/);
	assert.doesNotMatch(text, /^Not enough spendable balance in the channel to send this/);
});
