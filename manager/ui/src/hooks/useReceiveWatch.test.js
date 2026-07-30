/**
 * Run with: npm test (from manager/ui).
 *
 * The receive watcher exists because a payment arrived on a real node and
 * nothing on screen said so. These tests pin the contract that makes that
 * impossible to repeat quietly: everything present at the first look is
 * history, everything that appears afterwards is announced exactly once,
 * whichever of the two sources (the event stream, the poll) says it first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useEffect } from 'react';
import { render, settle } from '../../test/render.mjs';
import { describeReceive, useReceiveWatch } from './useReceiveWatch.js';

// Fast enough that a test waits one beat, slow enough that a settle() between
// beats never races the next sweep.
const TICK = 60;

/** A daemon whose payment and transaction lists the test mutates directly. */
function stubApi() {
	const state = { payments: [], txs: [], failPayments: false, failTxs: false };
	return {
		state,
		get: async (path) => {
			if (path === '/payments') {
				if (state.failPayments) throw new Error('down');
				return [...state.payments];
			}
			if (path === '/transactions') {
				if (state.failTxs) throw new Error('down');
				return [...state.txs];
			}
			throw new Error(`unexpected GET ${path}`);
		}
	};
}

function Probe({ api, onReceive, expose }) {
	const { onEvent } = useReceiveWatch(api, true, onReceive, TICK);
	useEffect(() => {
		expose(onEvent);
	}, [expose, onEvent]);
	return null;
}

async function mountWatch(api) {
	const got = [];
	const handle = { onEvent: () => {} };
	const view = await render(Probe, {
		api,
		onReceive: (r) => got.push(r),
		expose: (fn) => {
			handle.onEvent = fn;
		}
	});
	// Let the first sweep land: it is the baseline and must announce nothing.
	await settle(TICK);
	return { view, got, handle };
}

const payment = (hash, status = 'COMPLETED', amountSats = 21000) => ({
	paymentHash: hash,
	direction: 'INCOMING',
	status,
	amountSats
});
const tx = (txid, valueSats = 50000, confirmed = false) => ({
	txid,
	type: 'received',
	valueSats,
	confirmed
});

test('what the first look finds is history, what appears later is news', async () => {
	const api = stubApi();
	api.state.payments = [payment('a'.repeat(64)), payment('b'.repeat(64), 'PENDING')];
	api.state.txs = [tx('c'.repeat(64), 12000, true)];
	const { view, got } = await mountWatch(api);
	assert.equal(got.length, 0, 'the baseline announces nothing');

	api.state.payments.unshift(payment('d'.repeat(64), 'COMPLETED', 42000));
	await settle(TICK * 2);
	assert.equal(got.length, 1, 'a new settled receive is announced');
	assert.deepEqual(got[0], {
		rail: 'lightning',
		amountSats: 42000,
		paymentHash: 'd'.repeat(64)
	});

	await settle(TICK * 2);
	assert.equal(got.length, 1, 'and only once, however often the poll runs');
	await view.unmount();
});

test('a pending receive settling while someone watches is news', async () => {
	const api = stubApi();
	api.state.payments = [payment('b'.repeat(64), 'PENDING')];
	const { view, got } = await mountWatch(api);

	api.state.payments = [payment('b'.repeat(64), 'COMPLETED', 7000)];
	await settle(TICK * 2);
	assert.equal(got.length, 1, 'the settlement is announced');
	assert.equal(got[0].amountSats, 7000);
	await view.unmount();
});

test('an on-chain receive is announced from the poll, sends are not', async () => {
	const api = stubApi();
	const { view, got } = await mountWatch(api);

	api.state.txs.unshift(tx('e'.repeat(64), 33000));
	api.state.txs.unshift({ txid: 'f'.repeat(64), type: 'sent', valueSats: -9000, confirmed: false });
	await settle(TICK * 2);
	assert.equal(got.length, 1, 'the receive alone is announced');
	assert.deepEqual(got[0], {
		rail: 'onchain',
		amountSats: 33000,
		txid: 'e'.repeat(64),
		pending: true
	});
	await view.unmount();
});

test('the stream announces first, and the poll does not say it again', async () => {
	const api = stubApi();
	const { view, got, handle } = await mountWatch(api);

	handle.onEvent('payment:received', { paymentHash: 'a'.repeat(64), amountSats: 500 });
	assert.equal(got.length, 1, 'the event is announced at once');

	// Both events fire for a settled invoice; the second says nothing new.
	handle.onEvent('invoice:settled', { paymentHash: 'a'.repeat(64), amountSats: 500 });
	assert.equal(got.length, 1, 'the same hash is one receive, not two');

	api.state.payments = [payment('a'.repeat(64), 'COMPLETED', 500)];
	await settle(TICK * 2);
	assert.equal(got.length, 1, 'and the poll recognises it as already told');
	await view.unmount();
});

test('a source that was down at the first look gets its own baseline', async () => {
	const api = stubApi();
	api.state.failTxs = true;
	api.state.payments = [payment('a'.repeat(64))];
	const { view, got } = await mountWatch(api);

	// The transaction list comes back holding history. None of it is news:
	// with one shared baseline flag this would announce every old transaction
	// the moment the endpoint recovered.
	api.state.failTxs = false;
	api.state.txs = [tx('b'.repeat(64), 1000, true), tx('c'.repeat(64), 2000, true)];
	await settle(TICK * 2);
	assert.equal(got.length, 0, 'recovered history is still history');

	api.state.txs.unshift(tx('d'.repeat(64), 3000));
	await settle(TICK * 2);
	assert.equal(got.length, 1, 'and what arrives after it is news');
	await view.unmount();
});

test('a receive is described with its amount and its rail', () => {
	assert.equal(
		describeReceive({ rail: 'lightning', amountSats: 25000 }),
		'Received 25,000 sats over Lightning'
	);
	assert.equal(
		describeReceive({ rail: 'onchain', amountSats: 50000, pending: true }),
		'Received 50,000 sats on-chain, waiting for a block'
	);
	assert.equal(
		describeReceive({ rail: 'onchain', amountSats: 50000, pending: false }),
		'Received 50,000 sats on-chain'
	);
	assert.equal(
		describeReceive({ rail: 'lightning', amountSats: 4200 }, 'Savings'),
		'Savings received 4,200 sats over Lightning'
	);
	assert.equal(
		describeReceive({ rail: 'lightning', amountSats: null }),
		'Received a payment over Lightning'
	);
});
