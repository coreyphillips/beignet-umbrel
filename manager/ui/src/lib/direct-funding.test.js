/**
 * Run with: npm test (from manager/ui).
 *
 * The one rule that keeps a payer from paying twice: a plain on-chain send
 * may follow a direct funding only when the daemon rejected it or reported a
 * status from before the witness left the device. A request whose answer
 * never arrived is not a rejection (umbrel #140).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	describeFallback,
	describeFunding,
	describeStep,
	describeUnknown,
	fallbackRecord,
	fundingOutcome,
	idempotencyKey,
	isRefusal,
	persistFallback,
	sendDirectFunding,
	stepOffset,
	stepsFinished
} from './direct-funding.js';

/** A daemon refusal, as api.js throws it: the daemon's message and code. */
function refused(message, code) {
	const e = new Error(message);
	e.code = code;
	return e;
}

test('a rejection permits the fallback, with the daemon\'s reason', () => {
	const out = fundingOutcome(refused('request expired', 'EXPIRED'));
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

test('a request whose answer never arrived is unknown, never a fallback (umbrel #140)', () => {
	const proxy = refused('connect ECONNREFUSED 127.0.0.1:4101', 'PROXY_ERROR');
	proxy.status = 502;
	const notJson = new Error('Request failed (504)');
	notJson.status = 504;
	const lost = [
		new TypeError('Failed to fetch'), // Chromium
		new TypeError('Load failed'), // WebKit
		new TypeError('NetworkError when attempting to fetch resource.'), // Firefox
		new DOMException('The operation was aborted.', 'AbortError'),
		refused('Wallet is not responding', 'WALLET_UNRESPONSIVE'),
		proxy,
		refused('Wallet is not running', 'NOT_RUNNING'),
		notJson
	];
	for (const error of lost) {
		const out = fundingOutcome(error);
		assert.equal(out.kind, 'unknown', error.message);
		assert.equal(isRefusal(error), false, error.message);
	}
	assert.equal(fundingOutcome(new TypeError('Failed to fetch')).reason, 'Failed to fetch');
});

test('a daemon refusal code still permits the fallback', () => {
	for (const code of ['OFFER_DECLINED', 'NO_SUITABLE_UTXO', 'UNREACHABLE', 'EXCHANGE_TIMEOUT', 'EXPIRED']) {
		const out = fundingOutcome(refused(`refused: ${code}`, code));
		assert.equal(out.kind, 'fallback', code);
		assert.equal(out.reason, `refused: ${code}`);
	}
});

/** A page whose visibility a test flips. */
function fakeDocument(hidden = false) {
	const listeners = new Set();
	const doc = {
		hidden,
		addEventListener: (_, fn) => listeners.add(fn),
		removeEventListener: (_, fn) => listeners.delete(fn),
		show: () => {
			doc.hidden = false;
			for (const fn of [...listeners]) fn();
		},
		listeners
	};
	return doc;
}

test('a lost answer is asked for again with the same call, and the answer that comes back is used', async () => {
	const answers = [new TypeError('Failed to fetch'), refused('Wallet is not running', 'NOT_RUNNING'), { status: 'SIGNED_PENDING', spentTxid: 'a'.repeat(64) }];
	let calls = 0;
	const heard = [];
	const out = await sendDirectFunding(
		async () => {
			const answer = answers[calls++];
			if (answer instanceof Error) throw answer;
			return answer;
		},
		{ onUnknown: (o) => heard.push(o.reason), delaysMs: [0], doc: fakeDocument() }
	);
	assert.equal(calls, 3);
	assert.deepEqual(heard, ['Failed to fetch', 'Wallet is not running']);
	assert.equal(out.kind, 'sent');
	assert.equal(out.txid, 'a'.repeat(64));
});

test('a refusal on a retry is the answer: it falls back, and asking stops', async () => {
	let calls = 0;
	const out = await sendDirectFunding(
		async () => {
			calls++;
			throw calls === 1 ? new TypeError('Failed to fetch') : refused('the receiver declined the offer', 'OFFER_DECLINED');
		},
		{ delaysMs: [0], doc: fakeDocument() }
	);
	assert.equal(calls, 2);
	assert.equal(out.kind, 'fallback');
});

test('an answer still missing when the budget runs out stays unknown', async () => {
	let clock = 0;
	let calls = 0;
	const out = await sendDirectFunding(
		async () => {
			calls++;
			clock += 60_000;
			throw new TypeError('Failed to fetch');
		},
		{ delaysMs: [0], doc: fakeDocument(), now: () => clock, budgetMs: 180_000 }
	);
	assert.equal(out.kind, 'unknown');
	assert.equal(calls, 3);
	assert.match(describeUnknown({ reason: out.reason, waiting: false }), /Nothing was paid to the address/);
	assert.match(describeUnknown({ reason: out.reason, waiting: true }), /\(failed to fetch\).*Asking again/);
});

test('a hidden page waits to be shown, then asks at least once more however long it was away', async () => {
	let clock = 0;
	let calls = 0;
	const doc = fakeDocument(true);
	const pending = sendDirectFunding(
		async () => {
			calls++;
			if (calls === 1) throw new TypeError('Load failed');
			return { status: 'MEMPOOL_SEEN', fundingTxid: 'f'.repeat(64) };
		},
		{ delaysMs: [0], doc, now: () => clock, budgetMs: 1000 }
	);
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(calls, 1, 'nothing is asked while the page is hidden');
	clock = 10 * 60_000; // away far longer than the budget
	doc.show();
	const out = await pending;
	assert.equal(calls, 2);
	assert.equal(out.kind, 'sent');
	assert.equal(out.settled, true);
	assert.equal(doc.listeners.size, 0, 'the visibility listener is removed once shown');
});

test('each send gets its own idempotency key', () => {
	const a = idempotencyKey();
	assert.match(a, /^[0-9a-f]{32}$/);
	assert.notEqual(a, idempotencyKey());
});

test('a skipped route says which route and why, in words (umbrel #147)', () => {
	assert.equal(
		describeStep({ action: 'df_lane_skipped', data: { transportType: 2, reason: 'lane_not_established', error: 'connection timed out' } }),
		'Route skipped: onion message (could not connect: connection timed out)'
	);
	assert.equal(
		describeStep({ action: 'df_lane_skipped', data: { transportType: 3, reason: 'introduction_node_is_self' } }),
		"Route skipped: relay through the recipient's liquidity peer (the route starts at this wallet)"
	);
	assert.equal(
		describeStep({ action: 'df_frame_dropped', data: { transport: 'direct_peer', reason: 'no_listener' } }),
		'Message dropped on the direct peer (no listener)'
	);
	assert.equal(describeStep({ action: 'df_offer_declined', data: { reason: 'no liquidity peer' } }), 'Offer declined (no liquidity peer)');
	assert.equal(describeStep({ action: 'df_send_refused', data: {} }), 'Refused');
	assert.equal(describeStep({ action: 'df_something_new', data: {} }), 'something new', 'a step nobody described is still shown');
});

test('offsets count from the offer, and a step before it has none', () => {
	const steps = [
		{ timestamp: 1000, action: 'df_send_prepared', data: {} },
		{ timestamp: 5000, action: 'df_send_started', data: {} },
		{ timestamp: 76_500, action: 'df_send_committed', data: {} }
	];
	assert.deepEqual(steps.map((s) => stepOffset(s, steps)), [null, '+0.0 s', '+71.5 s']);
	assert.equal(stepsFinished(steps), false);
	assert.equal(stepsFinished([...steps, { timestamp: 78_000, action: 'df_send_completed', data: {} }]), true);
	assert.equal(stepsFinished(null), false);
});
