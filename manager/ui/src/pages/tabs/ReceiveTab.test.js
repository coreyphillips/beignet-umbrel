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
	if (amount)
		await type(view.$('input[placeholder="Enter amount"]') || view.$$('input[placeholder="any amount"]')[1], amount);
	await settle(400);
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
	assert.equal(view.$$('.qr').length, 1, 'the paid QR is gone: leaving it up invites the one scan guaranteed to fail');
	assert.doesNotMatch(view.text(), /Carry the Lightning invoice/, 'and a settled invoice is not offered for carrying');
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
const HOME = {
	channelId: 'c'.repeat(64),
	peerPubkey: PK,
	state: 'NORMAL',
	htlcUsable: true,
	localBalanceSats: 100_000,
	remoteBalanceSats: 50_000
};

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

/** A lightning-first wallet's daemon: mints requests, invoices, JIT invoices, and quotes. */
function stubLfbwApi({ channels = [HOME], quote } = {}) {
	const calls = [];
	return {
		calls,
		get: async (path) => {
			calls.push(['GET', path]);
			if (path === '/invoices') return [];
			if (path === '/channels') return channels;
			if (path === '/peers') return [{ pubkey: PK, state: 'connected' }];
			if (path.startsWith('/receive/quote?')) {
				if (quote instanceof Error) throw quote;
				return {
					peer: PK,
					amountSats: Number(new URLSearchParams(path.split('?')[1]).get('amountSats')),
					expiresAt: Date.now() + 60000,
					terms: { feeBaseMsat: 0, feePpm: 0 },
					...quote
				};
			}
			if (path.startsWith('/jit/quote?')) {
				if (quote instanceof Error) throw quote;
				return (
					quote || {
						accepted: true,
						flatFeeSat: 0,
						feePpm: 0,
						feeSats: 0,
						maxClientFundingSats: 1_000_000,
						fundingSats: 50_000,
						withinCeilings: true
					}
				);
			}
			throw new Error(`unexpected GET ${path}`);
		},
		post: async (path, body) => {
			calls.push(['POST', path, body]);
			if (path === '/address/new') return { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' };
			if (path === '/direct-funding/request') {
				const expiresAt = Date.now() + 3_600_000;
				return {
					paymentHash: 'e'.repeat(64),
					expiresAt,
					request: encodeFundingEnvelope({ nodeId: NODE, expiresAt, amountSats: body.amountSats ?? null })
				};
			}
			if (path === '/receive/invoice')
				return { bolt11: BOLT11, paymentHash: HASH, amountSats: body.amountSats, offlineReceive: true };
			if (path === '/invoice/create') return { bolt11: BOLT11, paymentHash: HASH, amountSats: body.amountSats ?? null };
			if (path === '/jit/invoice')
				return { bolt11: BOLT11, paymentHash: HASH, amountSats: body.amountSats ?? null, flatFeeSat: 0, feePpm: 0 };
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

async function mountLfbw(api, rec, config = { offlineReceiveAvailable: true, fforAvailable: true }) {
	const view = await render(ToastProvider, {
		children: createElement(ReceiveTab, { id: 'w1', api, rec, tick: 0, lastReceive: null, config })
	});
	await settle(500);
	return view;
}

const QUOTES = { jitQuoteAvailable: true };
const quoteCalls = (api) => api.calls.filter(([m, p]) => m === 'GET' && p.startsWith('/jit/quote?'));
const createButton = (view) => view.$$('button').find((b) => b.textContent.trim() === 'Create invoice');

test("a lightning-first request carries a direct-funding request minted with the wallet's reach", async () => {
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

test('every LFBW invoice is prepared for offline receipt, even with existing inbound capacity', async () => {
	for (const channels of [[HOME], []]) {
		sessionStorage.clear();
		const api = stubLfbwApi({ channels });
		const view = await mountLfbw(api, lfbwRec());
		try {
			assert.equal(view.$('[data-testid="receive-offline"]'), null);
			await createInvoice(view, '30000');
			const call = api.calls.find(([m, p]) => m === 'POST' && p === '/receive/invoice');
			assert.equal(call[2].amountSats, 30000);
			assert.equal(call[2].quote.amountSats, 30000);
			assert.match(call[2].requestId, /^[a-f0-9-]{36}$/);
			assert.equal(
				api.calls.some(([, p]) => p === '/invoice/create' || p === '/jit/invoice'),
				false
			);
			assert.match(view.text(), /You can close your wallet/);
			assert.doesNotMatch(view.text(), /Start epoch|Receive while offline|also carries a direct-funding request/);
		} finally {
			await view.unmount();
		}
	}
});
test('unsupported engines refuse LFBW receiving without an online-only fallback', async () => {
	const api = stubLfbwApi();
	const view = await mountLfbw(api, lfbwRec(), {});
	try {
		await createInvoice(view, '30000');
		assert.match(view.text(), /Update the app engine/);
		assert.equal(createButton(view).disabled, true);
		assert.equal(
			api.calls.some(([, p]) => p.includes('invoice') && p !== '/invoices'),
			false
		);
	} finally {
		await view.unmount();
	}
});
test('amountless and below-trim requests never reserve channels', async () => {
	const api = stubLfbwApi();
	const view = await mountLfbw(api, lfbwRec());
	try {
		assert.equal(createButton(view).disabled, true);
		await createInvoice(view, '1');
		assert.match(view.text(), /at least 354/);
		assert.equal(
			api.calls.some(([, p]) => p.startsWith('/receive/')),
			false
		);
	} finally {
		await view.unmount();
	}
});
test('setup and primary connection failures block preparation', async () => {
	for (const setup of ['pending', 'ready']) {
		const api = stubLfbwApi();
		const get = api.get;
		api.get = (p) => (p === '/peers' ? Promise.resolve([]) : get(p));
		const view = await mountLfbw(api, lfbwRec({ lfbw: { ...lfbwRec().lfbw, setup } }));
		try {
			await createInvoice(view, '30000');
			assert.equal(createButton(view).disabled, true);
			assert.match(view.text(), /being prepared|not connected/);
		} finally {
			await view.unmount();
		}
	}
});
test('receive terms are reviewed before creation and quote failures block it', async () => {
	for (const quote of [
		{ terms: { feeBaseMsat: 1000, feePpm: 100 } },
		new Error('Your node has no receive capacity available.')
	]) {
		const api = stubLfbwApi({ quote });
		const view = await mountLfbw(api, lfbwRec());
		try {
			await type(view.$('input[placeholder="Enter amount"]'), '30000');
			await settle(400);
			assert.equal(
				api.calls.some(([m, p]) => m === 'POST' && p === '/receive/invoice'),
				false
			);
			if (quote instanceof Error) {
				assert.equal(createButton(view).disabled, true);
				assert.match(view.text(), /no receive capacity/);
			} else {
				assert.match(view.text(), /payer covers.*1000 msat plus 100 ppm/);
				assert.equal(createButton(view).disabled, false);
			}
		} finally {
			await view.unmount();
		}
	}
});
test('a lost response retries the same durable request and does not show unsupported coverage', async () => {
	sessionStorage.clear();
	const api = stubLfbwApi();
	const post = api.post;
	let lost = true;
	api.post = async (p, b) => {
		const r = await post(p, b);
		if (p === '/receive/invoice' && lost) {
			lost = false;
			throw Error('Connection lost');
		}
		return r;
	};
	const view = await mountLfbw(api, lfbwRec());
	try {
		await createInvoice(view, '30000');
		assert.doesNotMatch(view.text(), /You can close your wallet/);
		await settle(450);
		await click(createButton(view));
		await settle(60);
		const calls = api.calls.filter(([, p]) => p === '/receive/invoice');
		assert.equal(calls.length, 2);
		assert.equal(calls[0][2].requestId, calls[1][2].requestId);
		assert.match(view.text(), /You can close your wallet/);
	} finally {
		await view.unmount();
	}
});

function stubReceivingNodes() {
	globalThis.fetch = async () => ({
		ok: true,
		status: 200,
		json: async () => ({
			ok: true,
			result: [{ id: 'p1', name: 'Always online', nodeId: PK, settles: true, running: true }]
		})
	});
}
const regularRec = { id: 'w1', network: 'mainnet' };
const optionalConfig = { offlineReceiveAvailable: true };
const offlineBox = (view) => view.$('[data-testid="receive-offline"]');
const enterAmount = (view, amount) => type(view.$$('input[placeholder="any amount"]')[1], amount);

test('regular wallets default to ordinary receiving, including amountless invoices', async () => {
	const api = stubLfbwApi();
	const view = await mountLfbw(api, regularRec, optionalConfig);
	try {
		assert.equal(offlineBox(view).checked, false);
		assert.equal(offlineBox(view).disabled, true);
		assert.match(view.text(), /Enter an amount of at least 354 sats to receive offline/);
		await createInvoice(view);
		assert.equal(api.calls.find(([, p]) => p === '/invoice/create')[2].amountSats, undefined);
		await createInvoice(view, '10000');
		assert.equal(offlineBox(view).disabled, false);
		assert.equal(offlineBox(view).checked, false);
		assert.equal(api.calls.filter(([, p]) => p === '/invoice/create').length, 2);
		assert.equal(
			api.calls.some(([, p]) => p.startsWith('/receive/')),
			false
		);
		assert.doesNotMatch(view.text(), /You can close your wallet/);
	} finally {
		await view.unmount();
	}
});

test('regular wallets opt into automatic receipt with reviewed terms and no manual book setup', async () => {
	stubReceivingNodes();
	const api = stubLfbwApi({ quote: { terms: { feeBaseMsat: 1000, feePpm: 50 } } });
	const view = await mountLfbw(api, regularRec, optionalConfig);
	try {
		await enterAmount(view, '20000');
		await click(offlineBox(view));
		await settle(400);
		assert.match(view.text(), /receiving node's fee of 1000 msat plus 50 ppm/);
		assert.equal(view.$('select').value, PK);
		await click(createButton(view));
		await settle(100);
		const body = api.calls.find(([, p]) => p === '/receive/invoice')[2];
		assert.equal(body.peer, PK);
		assert.equal(body.amountSats, 20000);
		assert.equal(body.quote.terms.feePpm, 50);
		assert.match(view.text(), /You can close your wallet/);
		assert.equal(
			api.calls.some(([, p]) => p === '/invoice/create'),
			false
		);
	} finally {
		await view.unmount();
	}
});

test('switching receive mode clears the displayed invoice and requires a new one', async () => {
	stubReceivingNodes();
	const api = stubLfbwApi();
	const view = await mountLfbw(api, regularRec, optionalConfig);
	try {
		await createInvoice(view, '20000');
		assert.equal(view.$$('.qr').length, 2);
		await click(offlineBox(view));
		await settle(400);
		assert.equal(view.$$('.qr').length, 1);
		assert.doesNotMatch(view.text(), /Carry the Lightning invoice/);
		assert.match(view.text(), /Already shared invoices stay unchanged/);
		await click(createButton(view));
		await settle(100);
		assert.match(view.text(), /You can close your wallet/);
		await click(offlineBox(view));
		await settle(400);
		assert.equal(view.$$('.qr').length, 1);
		assert.doesNotMatch(view.text(), /You can close your wallet/);
		await click(createButton(view));
		await settle(100);
		assert.equal(api.calls.filter(([, p]) => p === '/invoice/create').length, 2);
		assert.equal(api.calls.filter(([, p]) => p === '/receive/invoice').length, 1);
		assert.equal(
			api.calls.some(([, p]) => p === '/ffor/recover' || p === '/ffor/epoch/abort'),
			false
		);
	} finally {
		await view.unmount();
	}
});

test('an offline selection never silently falls back when the amount becomes ineligible', async () => {
	stubReceivingNodes();
	const api = stubLfbwApi();
	const view = await mountLfbw(api, regularRec, optionalConfig);
	try {
		await enterAmount(view, '354');
		await click(offlineBox(view));
		await settle(400);
		await enterAmount(view, '');
		assert.equal(offlineBox(view).checked, true);
		assert.equal(createButton(view).disabled, true);
		assert.equal(offlineBox(view).disabled, false, 'user can explicitly return to amountless online receiving');
		await click(offlineBox(view));
		assert.equal(createButton(view).disabled, false);
		assert.equal(
			api.calls.some(([m, p]) => m === 'POST' && p.includes('invoice')),
			false
		);
	} finally {
		await view.unmount();
	}
});

test('unsupported engines disable only the optional feature for regular wallets', async () => {
	const api = stubLfbwApi();
	const view = await mountLfbw(api, regularRec, {});
	try {
		await createInvoice(view, '20000');
		assert.equal(offlineBox(view).disabled, true);
		assert.match(view.text(), /Update the app engine to enable offline receiving/);
		assert.equal(api.calls.filter(([, p]) => p === '/invoice/create').length, 1);
	} finally {
		await view.unmount();
	}
});

test('offline requests block on unavailable peers or quote failures without an online fallback', async () => {
	stubReceivingNodes();
	for (const disconnected of [true, false]) {
		const api = stubLfbwApi({ quote: new Error('Offline receiving is unavailable at this node.') });
		const get = api.get;
		if (disconnected) api.get = (p) => (p === '/peers' ? Promise.resolve([]) : get(p));
		const view = await mountLfbw(api, regularRec, optionalConfig);
		try {
			await enterAmount(view, '20000');
			await click(offlineBox(view));
			await settle(400);
			assert.equal(createButton(view).disabled, true);
			assert.match(
				view.text(),
				disconnected ? /Connect a node that supports offline receiving/ : /Offline receiving is unavailable/
			);
			assert.equal(
				api.calls.some(([m, p]) => m === 'POST' && p.includes('invoice')),
				false
			);
		} finally {
			await view.unmount();
		}
	}
});
