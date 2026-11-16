/**
 * Run with: npm test (from manager/ui).
 *
 * The daemon lists an asset channel beside the bitcoin ones, marked
 * `auxiliary`. The bitcoin screens read the list without it, so its sats are
 * never offered as bitcoin the wallet can send, receive or lend.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bitcoinChannels, isAssetChannel, isClosedChannel } from './channels.js';

const btc = { channelId: 'a'.repeat(64), state: 'NORMAL', localBalanceSats: 500_000 };
const asset = { channelId: 'b'.repeat(64), state: 'NORMAL', localBalanceSats: 98_292, auxiliary: true };

test('only a channel the daemon marks auxiliary is an asset channel', () => {
	assert.equal(isAssetChannel(asset), true);
	assert.equal(isAssetChannel(btc), false);
	assert.equal(isAssetChannel({ ...btc, auxiliary: false }), false);
	assert.equal(isAssetChannel({ ...btc, auxiliary: 'true' }), false);
	assert.equal(isAssetChannel(null), false);
	assert.equal(isAssetChannel(undefined), false);
});

test('the bitcoin channels of a list are the rows that are not asset channels, in the order they came', () => {
	const closed = { channelId: 'c'.repeat(64), state: 'CLOSED' };
	assert.deepEqual(bitcoinChannels([btc, asset, closed]), [btc, closed]);
	assert.deepEqual(bitcoinChannels([asset]), []);
	assert.deepEqual(bitcoinChannels([]), []);
});

test('an answer that is not a list is handed back as it came, so a list that was not read still reads as not read', () => {
	assert.equal(bitcoinChannels(null), null);
	assert.equal(bitcoinChannels(undefined), undefined);
});

test('an asset channel is still a channel to the question "does this wallet have one open"', () => {
	assert.equal(isClosedChannel(asset), false);
	assert.equal([btc, asset].filter((c) => !isClosedChannel(c)).length, 2);
});
