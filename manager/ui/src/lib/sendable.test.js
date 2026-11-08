/**
 * Run with: npm test (from manager/ui).
 *
 * The send form's ceiling, pinned where it failed in the field: a wallet
 * holding 20,000 sats on one channel was offered 20,000 by Max, and the
 * channel refused it as "Insufficient balance for HTLC", because the reserve
 * (and, on a channel the wallet opened, its commitment fee) cannot leave.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { channelSendableSats, liquiditySendableSats } from './sendable.js';

test("a channel's ceiling is the daemon's maxSendableSats, not its balance", () => {
	assert.equal(channelSendableSats({ localBalanceSats: 20_000, maxSendableSats: 19_646 }), 19_646);
});

test('a channel the daemon says can send nothing sends nothing, whatever it holds', () => {
	assert.equal(channelSendableSats({ localBalanceSats: 20_000, maxSendableSats: 0 }), 0);
});

test('a daemon that reports no ceiling falls back to the balance', () => {
	assert.equal(channelSendableSats({ localBalanceSats: 20_000 }), 20_000);
	assert.equal(channelSendableSats(null), 0);
});

test("the wallet's ceiling prefers the exact figure, then the balance above the reserve", () => {
	const liq = { totalLocalBalanceSats: 20_000, sendableSats: 19_646, maxSendableSats: 18_212 };
	assert.equal(liquiditySendableSats(liq), 18_212);
	assert.equal(liquiditySendableSats({ ...liq, maxSendableSats: undefined }), 19_646);
	assert.equal(liquiditySendableSats({ totalLocalBalanceSats: 20_000 }), 20_000);
	assert.equal(liquiditySendableSats(null), 0);
});
