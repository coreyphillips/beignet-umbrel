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

/** A lightning-first wallet's daemon: mints requests, invoices, JIT invoices, and quotes. */
function stubLfbwApi({ channels = [HOME], quote } = {}) {
	const calls = [];
	return {
		calls,
		get: async (path) => {
			calls.push(['GET', path]);
			if (path === '/invoices') return [];
			if (path === '/channels') return channels;
			if (path.startsWith('/jit/quote?')) {
				if (quote instanceof Error) throw quote;
				return quote || { accepted: true, flatFeeSat: 0, feePpm: 0, feeSats: 0, maxClientFundingSats: 1_000_000, fundingSats: 50_000, withinCeilings: true };
			}
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

async function mountLfbw(api, rec, config) {
	const view = await render(ToastProvider, {
		children: createElement(ReceiveTab, { id: 'w1', api, rec, tick: 0, lastReceive: null, config })
	});
	await settle(500);
	return view;
}

const QUOTES = { jitQuoteAvailable: true };
const quoteCalls = (api) => api.calls.filter(([m, p]) => m === 'GET' && p.startsWith('/jit/quote?'));
const createButton = (view) => view.$$('button').find((b) => b.textContent.trim() === 'Create invoice');

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
		assert.deepEqual(jit[2], { lspPubkey: PK, amountSats: 30000, description: '', targetRemainingInboundSat: 10000, expirySecs: 900 });
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

/* ------------------------------------------------- the price, before the invoice */

test('a receive the primary must fund is priced beside the amount before anything is minted', async () => {
	stubManager();
	const api = stubLfbwApi({
		channels: [],
		quote: { accepted: true, flatFeeSat: 1000, feePpm: 5000, feeSats: 1150, maxClientFundingSats: 1_000_000, fundingSats: 50_000, withinCeilings: true }
	});
	const view = await mountLfbw(api, lfbwRec(), QUOTES);
	try {
		assert.equal(quoteCalls(api).length, 1, 'quoted at once: nothing covers an amountless invoice either');
		assert.equal(quoteCalls(api)[0][1], `/jit/quote?lspPubkey=${PK}&targetRemainingInboundSat=10000`, 'no amount, no amount parameter');
		assert.match(view.$('[data-testid="jit-quote"]').textContent, /funds what the channel cannot take for 1,000 sats plus 5000 ppm/);
		await type(view.$$('input[placeholder="any amount"]')[1], '30000');
		await settle(400);
		assert.equal(quoteCalls(api).at(-1)[1], `/jit/quote?lspPubkey=${PK}&amountSats=30000&targetRemainingInboundSat=10000`);
		assert.match(view.$('[data-testid="jit-quote"]').textContent, /will fund this receive for 1,150 sats \(1,000 sats plus 5000 ppm\), taken from the delivery/);
		assert.equal(createButton(view).disabled, false);
		assert.equal(api.calls.some(([m, p]) => m === 'POST' && p === '/jit/invoice'), false, 'a quote registers nothing');
	} finally {
		await view.unmount();
	}
});

test('an amount the home channel covers is not quoted; one it cannot is', async () => {
	stubManager();
	const api = stubLfbwApi();
	const view = await mountLfbw(api, lfbwRec(), QUOTES);
	try {
		assert.equal(quoteCalls(api).length, 0, 'the home channel has 50,000 inbound');
		assert.equal(view.$('[data-testid="jit-quote"]'), null);
		await type(view.$$('input[placeholder="any amount"]')[1], '80000');
		await settle(400);
		assert.equal(quoteCalls(api).length, 1, 'past the inbound, the primary is asked');
		assert.match(view.$('[data-testid="jit-quote"]').textContent, /at no charge/);
	} finally {
		await view.unmount();
	}
});

test('a primary that cannot front the amount says so, with the reason, and Create is held', async () => {
	stubManager();
	const api = stubLfbwApi({
		channels: [],
		quote: { accepted: false, reason: 'the provider holds 120,000 sats on-chain; this funding needs about 152,000', flatFeeSat: 0, feePpm: 0, feeSats: 0, maxClientFundingSats: 1_000_000, fundingSats: 152_000, withinCeilings: true }
	});
	const view = await mountLfbw(api, lfbwRec(), QUOTES);
	try {
		await type(view.$$('input[placeholder="any amount"]')[1], '140000');
		await settle(400);
		const line = view.$('[data-testid="jit-quote"]');
		assert.match(line.textContent, /Your primary cannot fund this invoice right now: the provider holds 120,000 sats on-chain/);
		assert.ok(line.classList.contains('error-note'));
		assert.equal(createButton(view).disabled, true, 'an invoice that would fail at the payer is not minted');
	} finally {
		await view.unmount();
	}
});

test('a price above this wallet\'s own ceilings is a refusal with the numbers, and Create is held', async () => {
	stubManager();
	const api = stubLfbwApi({
		channels: [],
		quote: { accepted: true, reason: null, flatFeeSat: 20000, feePpm: 0, feeSats: 20000, maxClientFundingSats: 1_000_000, fundingSats: 50_000, withinCeilings: false, client: { maxFlatFeeSat: 10000, maxFeePpm: 50000 } }
	});
	const view = await mountLfbw(api, lfbwRec(), QUOTES);
	try {
		const line = view.$('[data-testid="jit-quote"]');
		assert.match(line.textContent, /asks 20,000 sats for this, more than this wallet accepts \(up to 10,000 sats plus 50000 ppm\)/);
		assert.ok(line.classList.contains('error-note'));
		assert.equal(createButton(view).disabled, true);
	} finally {
		await view.unmount();
	}
});

test('a primary that is not connected is said so, and Create is held', async () => {
	stubManager();
	const api = stubLfbwApi({ channels: [], quote: Object.assign(new Error('JIT receive needs the LSP connected as a peer'), { code: 'PEER_NOT_CONNECTED' }) });
	const view = await mountLfbw(api, lfbwRec(), QUOTES);
	try {
		assert.match(view.$('[data-testid="jit-quote"]').textContent, /Your primary node is not connected/);
		assert.equal(createButton(view).disabled, true);
	} finally {
		await view.unmount();
	}
	// Any other failure to price is said, but does not hold the invoice: the
	// creation itself is the honest test.
	const slow = stubLfbwApi({ channels: [], quote: Object.assign(new Error('The LSP did not answer in time'), { code: 'JIT_TIMEOUT' }) });
	const view2 = await mountLfbw(slow, lfbwRec(), QUOTES);
	try {
		assert.match(view2.$('[data-testid="jit-quote"]').textContent, /Could not get a price from your primary node: The LSP did not answer in time/);
		assert.equal(createButton(view2).disabled, false);
	} finally {
		await view2.unmount();
	}
});

test('an engine without the quote route is never asked, and the tab reads as before', async () => {
	stubManager();
	const api = stubLfbwApi({ channels: [] });
	const view = await mountLfbw(api, lfbwRec(), { jitQuoteAvailable: false });
	try {
		await type(view.$$('input[placeholder="any amount"]')[1], '30000');
		await settle(400);
		assert.equal(quoteCalls(api).length, 0);
		assert.equal(view.$('[data-testid="jit-quote"]'), null);
		assert.equal(createButton(view).disabled, false);
	} finally {
		await view.unmount();
	}
	const noConfig = stubLfbwApi({ channels: [] });
	const view2 = await mountLfbw(noConfig, lfbwRec());
	try {
		assert.equal(quoteCalls(noConfig).length, 0, 'no config at all: no quote');
	} finally {
		await view2.unmount();
	}
});
