/**
 * Run with: npm test (from manager/ui).
 *
 * The invoice card's paid receipt. Someone showing this QR across a table is
 * watching this screen, not their balance, so the screen itself has to say
 * when the invoice settles: instantly when the receive watcher hands the
 * settled hash down, and within a poll when every event was missed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createElement, useEffect, useState } from 'react';
import { click, render, settle, type } from '../../../test/render.mjs';
import { ToastProvider } from '../../components/Toast.jsx';
import ReceiveTab from './ReceiveTab.jsx';

const HASH = 'ab'.repeat(32);
const BOLT11 = `lnbc210n1${'q'.repeat(80)}`;

/** A daemon that mints one invoice and reports it however the test says. */
function stubApi({ paidInList = false } = {}) {
	const state = { paidInList, created: null };
	return {
		state,
		get: async (path) => {
			if (path === '/invoices') {
				if (!state.created) return [];
				return [
					{
						...state.created,
						status: state.paidInList ? 'PAID' : 'PENDING'
					}
				];
			}
			throw new Error(`unexpected GET ${path}`);
		},
		post: async (path, body) => {
			if (path === '/address/new') return { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' };
			if (path === '/invoice/create') {
				state.created = {
					bolt11: BOLT11,
					paymentHash: HASH,
					amountSats: body.amountSats ?? null,
					description: body.description || ''
				};
				return { ...state.created };
			}
			throw new Error(`unexpected POST ${path}`);
		}
	};
}

/** ReceiveTab under a prop it can watch change, the way WalletPage feeds it. */
function Harness({ api, expose }) {
	const [lastReceive, setLastReceive] = useState(null);
	useEffect(() => {
		expose(setLastReceive);
	}, [expose]);
	return createElement(ToastProvider, {
		children: createElement(ReceiveTab, { id: 'w1', api, tick: 0, lastReceive })
	});
}

async function mountReceive(api) {
	let setLastReceive;
	const view = await render(Harness, { api, expose: (fn) => (setLastReceive = fn) });
	await settle(50);
	return { view, setLastReceive: (r) => act(async () => setLastReceive(r)) };
}

const createInvoice = async (view, amount) => {
	if (amount) await type(view.$$('input[placeholder="any amount"]')[1], amount);
	await click(view.$$('button').find((b) => b.textContent.trim() === 'Create invoice'));
	await settle(50);
};

test('the settled hash flips the invoice to a receipt, instantly', async () => {
	const api = stubApi();
	const { view, setLastReceive } = await mountReceive(api);
	await createInvoice(view, '21000');

	assert.equal(view.$$('.qr').length, 2, 'the invoice QR is up beside the address QR');
	assert.ok(!view.$('.paid-receipt'), 'and nothing claims it is paid');

	// A receive for some other invoice says nothing about this one.
	await setLastReceive({ rail: 'lightning', amountSats: 5, paymentHash: 'cd'.repeat(32) });
	assert.ok(!view.$('.paid-receipt'), "someone else's hash does not flip it");

	await setLastReceive({ rail: 'lightning', amountSats: 21000, paymentHash: HASH });
	const receipt = view.$('.paid-receipt');
	assert.ok(receipt, 'the receipt takes the stage');
	assert.match(receipt.textContent, /Paid/);
	assert.match(receipt.textContent, /21,000 sats received over Lightning/);
	await settle(400);
	assert.equal(
		view.$$('.qr').length,
		1,
		'the paid QR is gone: leaving it up invites the one scan guaranteed to fail'
	);
	assert.doesNotMatch(
		view.text(),
		/Carry the Lightning invoice/,
		'and a settled invoice is not offered for carrying'
	);
	await view.unmount();
});

test('the invoice list alone flips it, when every event was missed', async () => {
	// The list is refreshed right after creation and polled after; here the
	// daemon already reports the invoice paid, standing in for a settlement
	// that happened while the event stream was dead.
	const api = stubApi({ paidInList: true });
	const { view } = await mountReceive(api);
	await createInvoice(view, '4200');

	const receipt = view.$('.paid-receipt');
	assert.ok(receipt, 'the poll is enough');
	assert.match(receipt.textContent, /4,200 sats received over Lightning/);
	await view.unmount();
});
