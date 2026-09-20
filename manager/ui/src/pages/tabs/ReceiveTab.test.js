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

test('an invoice the home channel covers is plain; one it cannot is provisioned through the primary', async () => {
	stubManager();
	const api = stubLfbwApi();
	const view = await mountLfbw(api, lfbwRec());
	try {
		await createInvoice(view, '30000');
		assert.ok(api.calls.some(([m, p]) => m === 'POST' && p === '/invoice/create'), 'covered by the home channel');
		assert.equal(api.calls.some(([m, p]) => m === 'POST' && p === '/jit/invoice'), false);
		assert.doesNotMatch(view.text(), /Payable now/);
	} finally {
		await view.unmount();
	}
	const api2 = stubLfbwApi({ channels: [] });
	const view2 = await mountLfbw(api2, lfbwRec());
	try {
		await createInvoice(view2, '30000');
		const jit = api2.calls.find(([m, p]) => m === 'POST' && p === '/jit/invoice');
		assert.deepEqual(jit[2], { lspPubkey: PK, amountSats: 30000, description: '', targetRemainingInboundSat: 10000, expirySecs: 900 });
		assert.equal(api2.calls.some(([m, p]) => m === 'POST' && p === '/invoice/create'), false);
		assert.match(view2.text(), /Payable now: your primary node provides the inbound capacity/);
		assert.equal(api2.calls.some(([, p]) => p.startsWith('/receive/')), false, 'nothing offline was asked for');
	} finally {
		await view2.unmount();
	}
	// An amountless invoice with no inbound at all is provisioned too.
	const api3 = stubLfbwApi({ channels: [] });
	const view3 = await mountLfbw(api3, lfbwRec());
	try {
		await createInvoice(view3);
		assert.ok(api3.calls.some(([m, p]) => m === 'POST' && p === '/jit/invoice'));
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
		await type(view.$$('input[placeholder="any amount"]')[1], '30000');
		await settle(400);
		assert.equal(view.$('[data-testid="jit-quote"]'), null);
		await type(view.$$('input[placeholder="any amount"]')[1], '80000');
		await settle(400);
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

test("a price above this wallet's own ceilings is a refusal with the numbers, and Create is held", async () => {
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

/* ------------------------------------------- receiving offline, as an opt-in */

const offlineBox = (view) => view.$('[data-testid="receive-offline"]');
const enterAmount = (view, amount) => type(view.$$('input[placeholder="any amount"]')[1], amount);

test('a lightning-first wallet offers Receive offline as an opt-in, once an amount is typed', async () => {
	stubManager();
	sessionStorage.clear();
	const api = stubLfbwApi({ channels: [], quote: { terms: { feeBaseMsat: 1000, feePpm: 100 } } });
	const view = await mountLfbw(api, lfbwRec(), { ...QUOTES, offlineReceiveAvailable: true, fforAvailable: true });
	try {
		assert.equal(offlineBox(view).checked, false, 'off by default');
		assert.equal(offlineBox(view).disabled, true, 'and nothing to tick without an amount');
		assert.match(view.text(), /Enter an amount of at least 354 sats to receive offline/);
		assert.equal(createButton(view).disabled, false, 'the ordinary invoice is still on offer');
		await enterAmount(view, '30000');
		await settle(400);
		assert.equal(offlineBox(view).disabled, false);
		assert.match(view.text(), /Your primary node prepares it, so it has to offer offline settlement/);
		assert.equal(api.calls.some(([, p]) => p.startsWith('/receive/quote')), false, 'unticked, the primary is not asked');
		await click(offlineBox(view));
		await settle(400);
		assert.match(api.calls.find(([m, p]) => m === 'GET' && p.startsWith('/receive/quote'))[1], new RegExp(`peer=${PK}&amountSats=30000`));
		assert.match(view.$('[data-testid="receive-quote"]').textContent, /payer covers your primary node's fee of 1000 msat plus 100 ppm/);
		assert.equal(view.$('select'), null, 'the primary is the receiving node; nothing to pick');
		await click(createButton(view));
		await settle(100);
		const body = api.calls.find(([, p]) => p === '/receive/invoice')[2];
		assert.equal(body.peer, PK);
		assert.equal(body.amountSats, 30000);
		assert.equal(body.quote.terms.feePpm, 100);
		assert.equal(api.calls.some(([, p]) => p === '/jit/invoice' || p === '/invoice/create'), false);
		assert.match(view.text(), /You can close your wallet/);
		assert.doesNotMatch(view.text(), /also carries a direct-funding request/, 'an offline invoice is not carried with a funding request');
	} finally {
		await view.unmount();
	}
});

// beignet 0.21.10 answers the quote with mode 'direct-funding' and no terms
// when no channel with the primary has room for the amount: an offline receive
// never has the primary open a channel. The box says so and holds Create; the
// ordinary invoice is provisioned just in time once the box is unticked.
test('an offline receive with no channel that has room is held, naming the untick as the way out', async () => {
	stubManager();
	const api = stubLfbwApi({
		channels: [],
		quote: { mode: 'direct-funding', minAmountSat: 25000, terms: undefined }
	});
	const view = await mountLfbw(api, lfbwRec(), { ...QUOTES, offlineReceiveAvailable: true, fforAvailable: true });
	try {
		await enterAmount(view, '30000');
		await settle(400);
		await click(offlineBox(view));
		await settle(400);
		assert.match(view.text(), /No channel with your primary node has room to receive 30,000 sats offline yet, and receiving offline never opens one/);
		assert.equal(createButton(view).disabled, true, 'Create is held');
		await click(offlineBox(view));
		await settle(400);
		assert.equal(createButton(view).disabled, false, 'unticked, the ordinary invoice is back');
		assert.equal(api.calls.some(([, p]) => p === '/receive/invoice'), false);
	} finally {
		await view.unmount();
	}
});

test('a primary that does not offer offline receiving holds the box, and unticking gives the JIT invoice back', async () => {
	stubManager();
	const api = stubLfbwApi({ channels: [], quote: new Error('Your node does not provide offline receiving.') });
	const view = await mountLfbw(api, lfbwRec(), { ...QUOTES, offlineReceiveAvailable: true, fforAvailable: true });
	try {
		await enterAmount(view, '30000');
		await settle(400);
		await click(offlineBox(view));
		await settle(400);
		const line = view.$('[data-testid="receive-quote"]');
		assert.match(line.textContent, /does not provide offline receiving/);
		assert.match(line.textContent, /offer offline settlement/);
		assert.match(line.textContent, /untick Receive offline for an ordinary invoice/);
		assert.equal(createButton(view).disabled, true);
		await click(offlineBox(view));
		await settle(400);
		assert.equal(createButton(view).disabled, false);
		assert.equal(view.$('[data-testid="receive-quote"]'), null);
		await click(createButton(view));
		await settle(100);
		assert.ok(api.calls.some(([m, p]) => m === 'POST' && p === '/jit/invoice'));
		assert.equal(api.calls.some(([, p]) => p === '/receive/invoice'), false);
	} finally {
		await view.unmount();
	}
});

test('the box stays off while the primary link is not ready or the primary is not connected', async () => {
	stubManager();
	const notReady = stubLfbwApi({ channels: [] });
	const view = await mountLfbw(notReady, lfbwRec({ lfbw: { ...lfbwRec().lfbw, setup: 'pending' } }));
	try {
		await enterAmount(view, '30000');
		await settle(400);
		assert.equal(offlineBox(view).disabled, true);
		assert.match(view.text(), /Available once the link to your primary node is ready/);
	} finally {
		await view.unmount();
	}
	const api = stubLfbwApi({ channels: [] });
	const get = api.get;
	api.get = (p) => (p === '/peers' ? Promise.resolve([]) : get(p));
	const view2 = await mountLfbw(api, lfbwRec());
	try {
		await enterAmount(view2, '30000');
		await settle(400);
		assert.equal(offlineBox(view2).disabled, true);
		assert.match(view2.text(), /Available while your primary node is connected/);
	} finally {
		await view2.unmount();
	}
});

test('a lost response retries the same durable request and does not show unsupported coverage', async () => {
	stubManager();
	sessionStorage.clear();
	const api = stubLfbwApi({ channels: [] });
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
		await enterAmount(view, '30000');
		await settle(400);
		await click(offlineBox(view));
		await settle(400);
		await click(createButton(view));
		await settle(60);
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
