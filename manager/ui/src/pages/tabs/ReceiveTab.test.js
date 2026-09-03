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

/* ---------------------------------------------------------- lightning-first */

import { decodeFundingEnvelope, encodeFundingEnvelope } from '../../lib/funding-envelope.js';

const PK = '03' + '22'.repeat(32);
const NODE = '02' + 'ab'.repeat(32);
const HOME = { channelId: 'c'.repeat(64), peerPubkey: PK, state: 'NORMAL', htlcUsable: true, localBalanceSats: 100_000, remoteBalanceSats: 50_000 };

const realFetch = globalThis.fetch;
test.afterEach(() => {
	globalThis.fetch = realFetch;
});

/** The manager answering the primary wallet's status. */
function stubManager(status = 'running') {
	globalThis.fetch = async (url) => ({
		ok: true,
		status: 200,
		json: async () => ({ ok: true, result: url === '/api/wallets/p1' ? { id: 'p1', status } : null })
	});
}

/** A lightning-first wallet's daemon: mints requests, invoices, JIT invoices. */
function stubLfbwApi({ channels = [HOME] } = {}) {
	const calls = [];
	return {
		calls,
		get: async (path) => {
			calls.push(['GET', path]);
			if (path === '/invoices') return [];
			if (path === '/channels') return channels;
			throw new Error(`unexpected GET ${path}`);
		},
		post: async (path, body) => {
			calls.push(['POST', path, body]);
			if (path === '/address/new') return { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' };
			if (path === '/direct-funding/request') {
				const expiresAt = Date.now() + 3_600_000;
				return { paymentHash: 'e'.repeat(64), expiresAt, request: encodeFundingEnvelope({ nodeId: NODE, expiresAt, amountSats: body.amountSats ?? null }) };
			}
			if (path === '/invoice/create') return { bolt11: BOLT11, paymentHash: HASH, amountSats: body.amountSats ?? null };
			if (path === '/jit/invoice') return { bolt11: BOLT11, paymentHash: HASH, amountSats: body.amountSats ?? null, flatFeeSat: 0, feePpm: 0 };
			throw new Error(`unexpected POST ${path}`);
		}
	};
}

const lfbwRec = (extra = {}) => ({
	id: 'w1',
	network: 'mainnet',
	reach: { host: 'abcd.onion', port: 9102 },
	lfbw: { enabled: true, mode: 'internal', primaryWalletId: 'p1', primaryPubkey: PK, setup: 'ready' },
	...extra
});

async function mountLfbw(api, rec) {
	const view = await render(ToastProvider, {
		children: createElement(ReceiveTab, { id: 'w1', api, rec, tick: 0, lastReceive: null })
	});
	await settle(500);
	return view;
}

test('a lightning-first request carries a direct-funding request minted with the wallet\'s reach', async () => {
	stubManager();
	const api = stubLfbwApi();
	const view = await mountLfbw(api, lfbwRec());
	try {
		const minted = api.calls.find(([m, p]) => m === 'POST' && p === '/direct-funding/request');
		assert.deepEqual(minted[2], { host: 'abcd.onion', port: 9102 });
		const uri = view.$('.copy-text, [class*="copy"]')?.textContent || view.text();
		assert.match(view.text(), /also carries a direct-funding request/);
		assert.match(view.text(), /Deposit bitcoin/);
		// The amount is signed into the request, so a new one is minted for it.
		await type(view.$$('input[placeholder="any amount"]')[0], '25000');
		await settle(500);
		const again = api.calls.filter(([m, p]) => m === 'POST' && p === '/direct-funding/request');
		assert.equal(again.length, 2);
		assert.equal(again[1][2].amountSats, 25000);
		assert.ok(uri.length > 0);
	} finally {
		await view.unmount();
	}
});

test('an invoice the home channel covers is plain; one it cannot is provisioned through the primary', async () => {
	stubManager();
	const api = stubLfbwApi();
	const view = await mountLfbw(api, lfbwRec());
	try {
		await createInvoice(view, '30000');
		assert.ok(api.calls.some(([m, p]) => m === 'POST' && p === '/invoice/create'), 'covered by 50,000 inbound');
		assert.equal(api.calls.some(([m, p]) => m === 'POST' && p === '/jit/invoice'), false);
	} finally {
		await view.unmount();
	}
	const api2 = stubLfbwApi({ channels: [] });
	const view2 = await mountLfbw(api2, lfbwRec());
	try {
		await createInvoice(view2, '30000');
		const jit = api2.calls.find(([m, p]) => m === 'POST' && p === '/jit/invoice');
		assert.deepEqual(jit[2], { lspPubkey: PK, amountSats: 30000, description: '', targetRemainingInboundSat: 10000 });
		assert.match(view2.text(), /your primary node provides the inbound capacity/);
		assert.match(view2.text(), /at no charge/);
	} finally {
		await view2.unmount();
	}
	// A home channel that is short goes through the primary as well: the
	// engine routes the invoice over the existing channel and splices it.
	const api3 = stubLfbwApi();
	const view3 = await mountLfbw(api3, lfbwRec());
	try {
		await createInvoice(view3, '80000');
		assert.ok(api3.calls.some(([m, p]) => m === 'POST' && p === '/jit/invoice'));
		assert.equal(api3.calls.some(([m, p]) => m === 'POST' && p === '/invoice/create'), false);
	} finally {
		await view3.unmount();
	}
});

test('with the primary wallet stopped, an invoice it must provision is refused with directions', async () => {
	stubManager('stopped');
	const api = stubLfbwApi({ channels: [] });
	const view = await mountLfbw(api, lfbwRec());
	try {
		await createInvoice(view, '30000');
		assert.match(view.text(), /Your primary node is not running/);
		assert.equal(api.calls.some(([m, p]) => m === 'POST' && p === '/jit/invoice'), false);
	} finally {
		await view.unmount();
	}
});

test('before setup is ready no request is minted and invoices are refused', async () => {
	stubManager();
	const api = stubLfbwApi({ channels: [] });
	const view = await mountLfbw(api, lfbwRec({ lfbw: { enabled: true, mode: 'internal', primaryWalletId: 'p1', primaryPubkey: PK, setup: 'failed' } }));
	try {
		assert.equal(api.calls.some(([m, p]) => m === 'POST' && p === '/direct-funding/request'), false);
		await createInvoice(view, '30000');
		assert.match(view.text(), /not set up yet/);
	} finally {
		await view.unmount();
	}
	assert.ok(decodeFundingEnvelope);
});
