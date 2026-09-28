/**
 * Run with: npm test (from manager/ui).
 *
 * A payment made from this page is announced once, by the card that made it;
 * the daemon's event for it is announced only when nobody here did.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { beginOwnPayment, endOwnPayment, isOwnPayment, resetOwnPayments } from './own-payments.js';

const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

test.beforeEach(() => resetOwnPayments());

test('an event arriving while a payment is in flight is ours, hash or not', () => {
	const token = beginOwnPayment();
	assert.equal(isOwnPayment({ paymentHash: OTHER }), true);
	assert.equal(isOwnPayment({}), true);
	endOwnPayment(token, HASH);
	assert.equal(isOwnPayment({ paymentHash: OTHER }), false, 'and stops being ours once the answer is in');
});

test('an event arriving after the answer is ours when its hash matches', () => {
	const token = beginOwnPayment();
	endOwnPayment(token, HASH);
	assert.equal(isOwnPayment({ paymentHash: HASH }), true);
	assert.equal(isOwnPayment({ paymentHash: OTHER }), false);
	assert.equal(isOwnPayment({}), false, 'an event with no hash is not claimed');
	assert.equal(isOwnPayment(null), false);
});

test('a payment that failed to answer claims nothing afterwards', () => {
	const token = beginOwnPayment();
	endOwnPayment(token, undefined);
	assert.equal(isOwnPayment({ paymentHash: HASH }), false);
});

test('a remembered hash is forgotten after two minutes', () => {
	const t0 = 1_000_000;
	endOwnPayment(beginOwnPayment(), HASH, t0);
	assert.equal(isOwnPayment({ paymentHash: HASH }, t0 + 60_000), true);
	assert.equal(isOwnPayment({ paymentHash: HASH }, t0 + 121_000), false);
});

test('two payments in flight: the event stays claimed until both return', () => {
	const a = beginOwnPayment();
	const b = beginOwnPayment();
	endOwnPayment(a, HASH);
	assert.equal(isOwnPayment({ paymentHash: OTHER }), true);
	endOwnPayment(b, OTHER);
	assert.equal(isOwnPayment({ paymentHash: OTHER }), true, 'by its hash now');
	assert.equal(isOwnPayment({ paymentHash: 'c'.repeat(64) }), false);
});
