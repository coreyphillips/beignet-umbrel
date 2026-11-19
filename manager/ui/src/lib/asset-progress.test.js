/**
 * Run with: npm test (from manager/ui).
 *
 * Where an asset operation has got to, as steps and as a sentence. A mint or
 * a receive runs for an hour or a day, and this is what stands on screen for
 * all of it, so it must never claim a step that has not happened: there is
 * no "seen, unconfirmed" for a receive, a late proof is not a failure, and a
 * stopped mint says whether anything was spent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	amountOf,
	burnSteps,
	confirmationsNeeded,
	etaText,
	handedOver,
	headline,
	isFailed,
	isPending,
	kindWord,
	mintSteps,
	namesOf,
	railOf,
	receiveSteps,
	sendSteps,
	statusOf,
	stepsOf,
	stuckNote,
	timelineLabel
} from './asset-progress.js';

const BUSD = { key: 'k1', assetId: 'a1', name: 'BUSD', type: 'normal', decimalDisplay: 2, amount: '10000' };
const TXID = 'ab'.repeat(32);
const row = (kind, state, extra = {}) => ({
	id: 'r1',
	kind,
	state,
	failed: false,
	failure: null,
	assets: [BUSD],
	txid: null,
	confirmations: 0,
	at: { created: 1000 },
	...extra
});
const states = (steps) => steps.map((s) => `${s.key}:${s.state}`).join(' ');

test('a mint walks from prepared to ready, one step current at a time', () => {
	const ctx = { network: 'mainnet' };
	assert.equal(states(mintSteps(row('mint', 'pending'), ctx)), 'prepared:current broadcast:pending first:pending confirmations:pending ready:pending');
	assert.equal(
		states(mintSteps(row('mint', 'broadcast', { txid: TXID }), ctx)),
		'prepared:done broadcast:done first:current confirmations:pending ready:pending'
	);
	const confirming = mintSteps(row('mint', 'confirming', { txid: TXID, confirmations: 2, blockHeight: 870123 }), ctx);
	assert.equal(states(confirming), 'prepared:done broadcast:done first:done confirmations:current ready:pending');
	assert.equal(confirming[1].txid, TXID, 'the broadcast step carries the transaction to look up');
	assert.equal(confirming[2].detail, 'In block 870,123');
	assert.deepEqual(confirming[3].meter, { have: 2, need: 6 });
	assert.equal(confirming[3].detail, 'about 40 minutes left');
	assert.equal(states(mintSteps(row('mint', 'proofs', { txid: TXID, confirmations: 6 }), ctx)), 'prepared:done broadcast:done first:done confirmations:done ready:current');
	const done = mintSteps(row('mint', 'complete', { txid: TXID, confirmations: 6 }), ctx);
	assert.ok(done.every((s) => s.state === 'done'));
	assert.equal(done[4].detail, 'BUSD is in your holdings.');
});

test('on regtest one confirmation is enough, so the count is not a step of its own', () => {
	const steps = mintSteps(row('mint', 'broadcast', { txid: TXID }), { network: 'regtest' });
	assert.deepEqual(steps.map((s) => s.key), ['prepared', 'broadcast', 'first', 'ready']);
	assert.equal(steps[2].detail, 'Waiting for a block. Mine one to continue.');
	assert.equal(confirmationsNeeded({}, 'regtest'), 1);
	assert.equal(confirmationsNeeded({}, 'mainnet'), 6);
	assert.equal(confirmationsNeeded({ confirmationsRequired: 3 }, 'mainnet'), 3, 'the wallet has the last word on how many');
});

test('a mint that stopped before broadcast says nothing was spent', () => {
	const steps = mintSteps(row('mint', 'failed', { failed: true, failure: { code: 'X', message: 'no usable coins' } }), { network: 'mainnet' });
	assert.equal(steps[0].state, 'failed');
	assert.equal(steps[0].detail, 'Minting stopped before anything was broadcast: no usable coins. Nothing was spent.');
	assert.equal(steps[1].state, 'pending', 'nothing after the failed step is claimed');
	const cancelled = mintSteps(row('mint', 'cancelled'), { network: 'mainnet' });
	assert.equal(cancelled[0].detail, 'Cancelled before it was broadcast. Nothing was spent.');
});

test('a receive has no seen-but-unconfirmed step: the first confirmation is how it is seen', () => {
	const ctx = { network: 'mainnet', host: 'universe.example:10029' };
	const waiting = receiveSteps(row('receive', 'waiting'), ctx);
	assert.deepEqual(waiting.map((s) => s.label), ['Waiting for the sender', 'First confirmation', '6 confirmations', 'Proof received', 'Complete']);
	assert.equal(states(waiting), 'waiting:current first:pending confirmations:pending proof:pending complete:pending');
	assert.equal(waiting[0].detail, 'Nothing seen yet. This page updates by itself.');
	assert.doesNotMatch(waiting.map((s) => s.label).join(' '), /unconfirmed|mempool|seen/i);

	// Found in a block: the wait and the first confirmation are passed together.
	const found = receiveSteps(row('receive', 'confirming', { txid: TXID, confirmations: 1 }), ctx);
	assert.equal(states(found), 'waiting:done first:done confirmations:current proof:pending complete:pending');
	assert.deepEqual(found[2].meter, { have: 1, need: 6 });

	const fetching = receiveSteps(row('receive', 'proofs', { txid: TXID, confirmations: 6 }), ctx);
	assert.equal(states(fetching), 'waiting:done first:done confirmations:done proof:current complete:pending');
	assert.equal(fetching[3].detail, 'Fetching it from universe.example:10029…');

	const done = receiveSteps(row('receive', 'complete', { txid: TXID, confirmations: 6, at: { created: 1, proof: 2, completed: 3 } }), ctx);
	assert.ok(done.every((s) => s.state === 'done'));
	assert.equal(done[4].detail, '100.00 BUSD is in your holdings.');
});

test('a late proof is a wait, not a failure', () => {
	const late = row('receive', 'proofs', {
		txid: TXID,
		confirmations: 6,
		failure: { code: 'PROOF_UNAVAILABLE', message: 'not found', retrying: true }
	});
	assert.equal(isFailed(late), false);
	assert.equal(isPending(late), true, 'it is still worth watching');
	const steps = receiveSteps(late, { network: 'mainnet', host: 'u.example:10029' });
	assert.equal(steps[3].state, 'current');
	assert.equal(steps[3].detail, 'Not here yet. The wallet keeps asking u.example:10029.');
	assert.equal(headline(late), 'Receiving 100.00 BUSD: the proof has not arrived yet');
	assert.deepEqual(statusOf(late), { text: 'proof late', tone: 'yellow' });
});

test('a send is broadcast, confirmed, its proof delivered, then complete', () => {
	const ctx = { network: 'mainnet', host: 'u.example:10029' };
	assert.equal(states(sendSteps(row('send', 'broadcast', { txid: TXID }), ctx)), 'broadcast:done confirmed:current proof:pending complete:pending');
	const confirmed = sendSteps(row('send', 'proofs', { txid: TXID, confirmations: 1 }), ctx);
	assert.equal(states(confirmed), 'broadcast:done confirmed:done proof:current complete:pending');
	assert.equal(confirmed[2].detail, 'Delivering it through u.example:10029…');
	const waitingOnServer = sendSteps(row('send', 'proofs', { txid: TXID, confirmations: 1, failure: { code: 'COURIER_DOWN', message: 'refused' } }), ctx);
	assert.match(waitingOnServer[2].detail, /is not answering\. The asset has moved/);
	// A server that answered "no" is said to have answered, with its reason.
	const refused = sendSteps(
		row('send', 'proofs', {
			txid: TXID,
			confirmations: 6,
			failure: { code: 'PROOF_REFUSED', message: 'The proof server did not take the proof: invalid split commitment proof (HTTP 500)', retrying: true }
		}),
		ctx
	);
	assert.equal(states(refused), 'broadcast:done confirmed:done proof:current complete:pending');
	assert.equal(
		refused[2].detail,
		'u.example:10029 did not take the proof: invalid split commitment proof (HTTP 500). The asset has moved, and the recipient cannot receive it until the server takes its proof. This wallet keeps the proof and offers it again from time to time.'
	);
	const refusedRow = row('send', 'proofs', { txid: TXID, confirmations: 6, failure: { code: 'PROOF_REFUSED', message: 'x', retrying: true } });
	assert.equal(headline(refusedRow), 'Sending 100.00 BUSD: the proof server did not take the proof');
	assert.deepEqual(statusOf(refusedRow), { text: 'proof refused', tone: 'red' });
	assert.equal(isFailed(refusedRow), false, 'the wallet goes on offering it');
	assert.equal(isPending(refusedRow), true);
	// A server that is only out of reach stays a late proof, in yellow.
	const unreachable = row('send', 'proofs', { txid: TXID, confirmations: 6, failure: { code: 'COURIER_UNREACHABLE', message: 'x', retrying: true } });
	assert.equal(headline(unreachable), 'Sending 100.00 BUSD: the proof is waiting to be delivered');
	assert.deepEqual(statusOf(unreachable), { text: 'proof late', tone: 'yellow' });
	const bare = sendSteps(row('send', 'proofs', { txid: TXID, confirmations: 6, failure: { code: 'PROOF_REFUSED', message: '', retrying: true } }), ctx);
	assert.match(bare[2].detail, /^u\.example:10029 did not take the proof\. The asset has moved/);
	const stopped = sendSteps(row('send', 'failed', { failed: true, failure: { message: 'rejected by the mempool.' } }), ctx);
	assert.equal(stopped[0].detail, 'Nothing was sent: rejected by the mempool.');
});

test('a send whose proof was handed over as a file reads as done, and says the server is still offered it', () => {
	const ctx = { network: 'mainnet', host: 'u.example:10029' };
	const refused = { code: 'PROOF_REFUSED', message: 'x', retrying: true };
	const settled = row('send', 'proofs', { txid: TXID, confirmations: 6, failure: refused, handedOver: 5000 });
	assert.equal(handedOver(settled), true);
	assert.equal(isPending(settled), false, 'nothing is left for the reader to wait for');
	assert.equal(isFailed(settled), false);
	assert.equal(headline(settled), 'Sent 100.00 BUSD: its proof was handed over as a file');
	assert.deepEqual(statusOf(settled), { text: 'handed over', tone: 'green' });
	const steps = sendSteps(settled, ctx);
	assert.equal(states(steps), 'broadcast:done confirmed:done proof:done complete:current');
	assert.deepEqual([steps[2].label, steps[2].detail, steps[2].at], ['Proof handed over', 'Given to the recipient as a file.', 5000]);
	assert.equal(
		steps[3].detail,
		'The recipient has the asset once they import the file. This wallet still offers the proof to u.example:10029 from time to time.'
	);
	// It is the sender's word about one state: it means nothing before the proof exists or once the server has it.
	assert.equal(handedOver(row('send', 'confirming', { handedOver: 5000 })), false);
	assert.equal(handedOver(row('send', 'complete', { handedOver: 5000 })), false);
	assert.equal(handedOver(row('receive', 'proofs', { handedOver: 5000 })), false);
	const done = sendSteps(row('send', 'complete', { txid: TXID, handedOver: 5000, at: { created: 1000, proof: 6000, completed: 7000 } }), ctx);
	assert.deepEqual([done[2].label, done[2].detail], ['Proof delivered', 'Delivered through u.example:10029.']);
	// With no answer from the server on record (after a restart, say), the mark still stands.
	assert.equal(headline(row('send', 'proofs', { handedOver: 5000 })), 'Sent 100.00 BUSD: its proof was handed over as a file');
});

test('a burn ends by saying the units no longer exist', () => {
	const done = burnSteps(row('burn', 'complete', { txid: TXID, confirmations: 1 }), { network: 'mainnet' });
	assert.deepEqual(done.map((s) => s.label), ['Broadcast', 'Confirmed', 'Burned']);
	assert.equal(done[2].detail, '100.00 BUSD no longer exists.');
	assert.equal(states(burnSteps(row('burn', 'broadcast', { txid: TXID }), {})), 'broadcast:done confirmed:current complete:pending');
});

test('a Lightning row settles in one step and has no timeline', () => {
	assert.deepEqual(stepsOf(row('ln-send', 'complete')), []);
	assert.deepEqual(stepsOf(null), []);
	assert.equal(stepsOf(row('mint', 'pending'), { network: 'mainnet' }).length, 5);
	assert.equal(railOf(row('ln-receive', 'complete')), 'lightning');
	assert.equal(railOf(row('receive', 'complete')), 'on-chain');
	assert.equal(kindWord(row('ln-send', 'complete')), 'Lightning payment');
	assert.equal(timelineLabel(row('mint', 'pending')), 'Mint progress');
});

test('the time left is said the way a person would, and not promised on testnet', () => {
	assert.equal(etaText({ confirmations: 0 }, 'mainnet'), 'about an hour left');
	assert.equal(etaText({ confirmations: 3 }, 'mainnet'), 'about 30 minutes left');
	assert.equal(etaText({ confirmations: 6 }, 'mainnet'), '');
	assert.equal(etaText({ confirmations: 2 }, 'testnet'), 'Testnet blocks are irregular, so this can take a while.');
	assert.equal(etaText({ confirmations: 0 }, 'regtest'), 'Mine one more block to continue.');
});

test('a row is named by what it moves and where it has got to', () => {
	const two = { assets: [BUSD, { ...BUSD, name: 'Club Points' }] };
	assert.equal(namesOf(two), 'BUSD and Club Points');
	assert.equal(namesOf({ assets: [BUSD, BUSD, BUSD] }), '3 assets');
	assert.equal(amountOf({ assets: [BUSD] }), '100.00 BUSD');
	assert.equal(amountOf(two), 'BUSD and Club Points', 'several assets are named, not added up');
	assert.equal(headline(row('mint', 'confirming', { confirmations: 2 }), { network: 'mainnet' }), 'Minting BUSD: 2 of 6 confirmations');
	assert.equal(headline(row('receive', 'waiting')), 'Waiting for 100.00 BUSD');
	assert.equal(headline(row('send', 'complete')), 'Sent 100.00 BUSD');
	assert.equal(headline(row('burn', 'failed', { failed: true })), 'Burning 100.00 BUSD failed');
	assert.deepEqual(statusOf(row('mint', 'confirming', { confirmations: 9 }), { network: 'mainnet' }), { text: '6 of 6', tone: 'yellow' }, 'never more than were needed');
	assert.deepEqual(statusOf(row('receive', 'waiting')), { text: 'waiting', tone: 'muted' });
	assert.equal(isPending(row('receive', 'waiting')), true);
	assert.equal(isPending(row('send', 'complete')), false);
	assert.equal(isPending(row('mint', 'cancelled')), false);
});

test('a transaction left in the mempool is explained, with nothing to press', () => {
	const now = 1_800_000_000_000;
	const fresh = row('send', 'broadcast', { satsPerVbyte: 2, at: { created: 1, broadcast: now - 5 * 60 * 1000 } });
	assert.equal(stuckNote(fresh, { fast: 18 }, now), null, 'five minutes is not stuck');
	const old = row('send', 'broadcast', { satsPerVbyte: 2, at: { created: 1, broadcast: now - 3 * 60 * 60 * 1000 } });
	const note = stuckNote(old, { fast: 18 }, now);
	assert.match(note, /has waited 3 hours for its first block/);
	assert.match(note, /It paid 2 sat\/vB and the network now asks about 18\./);
	assert.match(note, /cannot be fee-bumped yet/);
	assert.equal(stuckNote({ ...old, confirmations: 1 }, { fast: 18 }, now), null, 'a confirmed one is not stuck');
	assert.equal(stuckNote({ ...fresh, stuck: true }, { fast: 18 }, now) !== null, true, 'the wallet saying so is enough');
});

test('a payment the wallet has a note on is worded by the note, never as paid or failed', async () => {
	const { headline, statusOf, isFailed, isPending, noticeOf } = await import('./asset-progress.js');
	const busd = { name: 'BUSD', type: 'normal', decimalDisplay: 2, amount: '357' };
	const row = (state, code, extra = {}) => ({ kind: 'ln-send', state, failed: state === 'failed', assets: [busd], at: { created: 1 }, notice: { code, message: 'The wallet says so.' }, ...extra });
	for (const state of ['pending', 'complete', 'failed']) {
		const lost = row(state, 'PAYMENT_UNACCOUNTED');
		assert.equal(headline(lost), 'Lightning payment of 3.57 BUSD: how it ended is not known');
		assert.deepEqual(statusOf(lost), { text: 'not known', tone: 'blue' });
		assert.equal(isFailed(lost), false);
		const loose = row(state, 'PAYMENT_UNCONFIRMED');
		assert.equal(headline(loose), 'Lightning payment of 3.57 BUSD: not confirmed as an asset payment');
		assert.deepEqual(statusOf(loose), { text: 'unconfirmed', tone: 'blue' });
	}
	assert.equal(isPending(row('pending', 'PAYMENT_UNACCOUNTED')), true);
	// A note this page has no words for is still a note, and still not a failure.
	assert.equal(headline(row('failed', 'SOMETHING_NEW')), 'Lightning payment of 3.57 BUSD: the wallet has a note on it');
	assert.deepEqual(noticeOf(row('pending', 'SOMETHING_NEW')), { code: 'SOMETHING_NEW', message: 'The wallet says so.' });
	// No note, or an empty one, and the row is worded as ever.
	for (const notice of [undefined, null, {}, { code: 'X', message: ' ' }]) {
		assert.equal(noticeOf({ notice }), null);
		assert.equal(headline({ kind: 'ln-send', state: 'complete', assets: [busd], notice }), 'Paid 3.57 BUSD over Lightning');
		assert.equal(isFailed({ kind: 'ln-send', state: 'failed', failed: true, assets: [busd], notice }), true);
	}
});
