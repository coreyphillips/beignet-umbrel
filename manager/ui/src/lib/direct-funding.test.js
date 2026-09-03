/**
 * Run with: npm test (from manager/ui).
 *
 * The one rule that keeps a payer from paying twice: a plain on-chain send
 * may follow a direct funding only when the daemon rejected it or reported a
 * status from before the witness left the device.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeFunding, fundingOutcome } from './direct-funding.js';

test('a rejection permits the fallback, with the daemon\'s reason', () => {
	const out = fundingOutcome(new Error('request expired'));
	assert.equal(out.kind, 'fallback');
	assert.equal(out.reason, 'request expired');
});

test('CREATED and OFFERED are before the witness went out, so they permit the fallback', () => {
	for (const status of ['CREATED', 'OFFERED']) {
		const out = fundingOutcome({ status, caveat: 'receiver declined the offer' });
		assert.equal(out.kind, 'fallback', status);
		assert.equal(out.reason, 'receiver declined the offer');
	}
	assert.equal(fundingOutcome(null).kind, 'fallback');
});

test('every status after the witness left is a payment out of our hands, never a fallback', () => {
	for (const status of ['SIGNED_PENDING', 'MEMPOOL_SEEN', 'CONFIRMED', 'ABORTED', 'FAILED']) {
		const out = fundingOutcome({ status, spentTxid: 'a'.repeat(64), amountSat: 50_000 });
		assert.equal(out.kind, 'sent', status);
		assert.equal(out.txid, 'a'.repeat(64));
		assert.equal(out.amountSats, 50_000);
	}
	const settled = fundingOutcome({
		status: 'CONFIRMED',
		fundingTxid: 'f'.repeat(64),
		spentTxid: 'a'.repeat(64),
		attested: true,
		receiptPreimageHex: 'b'.repeat(64)
	});
	assert.equal(settled.settled, true);
	assert.equal(settled.txid, 'f'.repeat(64), 'the funding txid over the spent one');
	assert.equal(settled.attested, true);
	assert.equal(settled.receiptPreimageHex, 'b'.repeat(64));
	assert.match(describeFunding(settled), /signed a receipt/);
	const failed = fundingOutcome({ status: 'FAILED', caveat: 'funding never reached the mempool' });
	assert.equal(failed.failed, true);
	assert.match(describeFunding(failed), /did not complete \(failed\)\. funding never reached the mempool/);
	assert.match(describeFunding(failed), /before paying again/);
	assert.match(describeFunding(fundingOutcome({ status: 'SIGNED_PENDING' })), /signed pending/);
});
