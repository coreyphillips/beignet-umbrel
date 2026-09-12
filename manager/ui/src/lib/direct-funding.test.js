/**
 * Run with: npm test (from manager/ui).
 *
 * The one rule that keeps a payer from paying twice: a plain on-chain send
 * may follow a direct funding only when the daemon rejected it or reported a
 * status from before the witness left the device.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeFallback, describeFunding, fallbackRecord, fundingOutcome, persistFallback } from './direct-funding.js';

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

test('a fallback carries the reason and the request it was paying, for the record', () => {
	const funding = { nodeId: '02' + 'ab'.repeat(32), requestId: 'c'.repeat(32), envelope: 'ignored' };
	const record = fallbackRecord('receiver declined the offer', {
		funding,
		address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
		amountSats: 50_000,
		txid: 'a'.repeat(64)
	});
	assert.deepEqual(record, {
		reason: 'receiver declined the offer',
		address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
		amountSats: 50_000,
		nodeId: funding.nodeId,
		requestId: funding.requestId,
		txid: 'a'.repeat(64),
		error: null
	});
	// A typed amount that never became a number must not be recorded as one.
	assert.equal(fallbackRecord('x', { amountSats: NaN }).amountSats, null);
	assert.equal(fallbackRecord('x').requestId, null);
	assert.match(describeFallback(record), /That did not happen \(receiver declined the offer\)/);
});

test('a reason is said inside our own sentence, however it was written', () => {
	// The daemon's own default is a full sentence, and reads as a quotation
	// dropped mid-line unless it is let into the one around it.
	const said = describeFallback(fundingOutcome({ status: 'OFFERED' }));
	assert.match(said, /That did not happen \(the recipient did not take the direct funding\), so/);
	// A code is not prose and is left exactly as it came.
	assert.match(describeFallback({ reason: 'DF_REQUEST_EXPIRED' }), /\(DF_REQUEST_EXPIRED\)/);
});

test('fallback text distinguishes an attempted or failed ordinary payment from a sent one', () => {
	const record = fallbackRecord('request expired');
	assert.match(describeFallback({ ...record, pending: true }), /ordinary payment is being attempted/);
	const failed = describeFallback({ ...record, error: 'Insufficient funds' });
	assert.match(failed, /ordinary payment also failed \(insufficient funds\)/);
	assert.doesNotMatch(failed, /went out as an ordinary payment/);
});

test('saving a fallback retains the payment details even when persistence fails', async () => {
	const record = fallbackRecord('request expired', { txid: 'a'.repeat(64) });
	const saved = await persistFallback(record, async () => ({ persisted: true }));
	assert.equal(saved.persisted, true);
	for (const save of [async () => ({ persisted: false }), async () => { throw new Error('offline'); }]) {
		const result = await persistFallback(record, save);
		assert.deepEqual(result, { ...record, persisted: false });
	}
});
