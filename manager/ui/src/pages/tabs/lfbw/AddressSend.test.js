/**
 * Run with: npm test (from manager/ui).
 *
 * A lightning-first wallet pays an address by splicing out of its home
 * channel, priced by the daemon at the converted fee rate, and pays a
 * beignet request as a direct funding only when a confirmed coin of its
 * own covers it, with the fallback rule the daemon's contract demands.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
import { click, render, settle, type } from '../../../../test/render.mjs';
import { ToastProvider } from '../../../components/Toast.jsx';
import { buildBip21 } from '../../../lib/payment-uri.js';
import { encodeFundingEnvelope } from '../../../lib/funding-envelope.js';
import AddressSend from './AddressSend.jsx';

const ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

/** A daemon refusal, as api.js throws it: the daemon's message and code. */
function refused(message, code) {
	const e = new Error(message);
	e.code = code;
	return e;
}
const PK = '03' + '22'.repeat(32);
const NODE = '02' + 'ab'.repeat(32);
const HOME = { channelId: 'c'.repeat(64), peerPubkey: PK, state: 'NORMAL', htlcUsable: true, localBalanceSats: 400_000, remoteBalanceSats: 100_000 };
const REQUEST = encodeFundingEnvelope({ nodeId: NODE, expiresAt: Date.now() + 3_600_000, amountSats: 50_000 });

// The manager, which the card reaches through the module rather than a prop:
// the sibling wallet list, and the record a direct-funding fallback leaves.
const realFetch = globalThis.fetch;
let managerCalls = [];
test.beforeEach(() => {
	managerCalls = [];
	globalThis.fetch = async (url, init = {}) => {
		managerCalls.push({
			url: String(url),
			method: init.method || 'GET',
			body: init.body ? JSON.parse(init.body) : null
		});
		return { ok: true, status: 200, json: async () => ({ ok: true, result: init.method === 'POST' ? { persisted: true } : [] }) };
	};
});
test.afterEach(() => {
	globalThis.fetch = realFetch;
});

const recorded = () =>
	managerCalls.find((c) => c.method === 'POST' && c.url.endsWith('/direct-funding/fallbacks'));

function stubApi({ utxos = [], sendAnswer, spliceError } = {}) {
	const calls = [];
	return {
		calls,
		get: async (path) => {
			calls.push(['GET', path]);
			if (path === '/fees/estimates') return { fast: 18, normal: 7, slow: 2 };
			if (path === '/utxos') return utxos;
			return null;
		},
		post: async (path, body) => {
			calls.push(['POST', path, body]);
			if (path === '/channel/splice-quote') return { feeSats: 1200, maxAmountSats: 380_000, spendableSats: 395_000, reserveSats: 5000 };
			if (path === '/channel/splice-out') {
				if (spliceError) throw new Error(spliceError);
				return { ok: true, txid: 'd'.repeat(64) };
			}
			if (path === '/direct-funding/send') {
				if (sendAnswer instanceof Error) throw sendAnswer;
				return sendAnswer;
			}
			if (path === '/direct-funding/prepare') return { requestId: 'r'.repeat(32), connection: 'connecting' };
			throw new Error(`unexpected POST ${path}`);
		}
	};
}

function Harness({ api, channels }) {
	const [state, setState] = useState({ input: '', request: null, amount: '', feeRate: '', maxMode: false });
	return createElement(ToastProvider, {
		children: createElement(AddressSend, {
			id: 'w1',
			api,
			rec: { id: 'w1', network: 'mainnet', lfbw: { enabled: true, primaryPubkey: PK, setup: 'ready' } },
			channels,
			bump: () => {},
			state,
			patch: (next) => setState((s) => ({ ...s, ...next }))
		})
	});
}

async function mount(api, channels = [HOME]) {
	const view = await render(Harness, { api, channels });
	await settle(300);
	return view;
}

const sendButton = (view) => view.$$('button').find((b) => /^(Send|Send max|Pay as direct funding)$/.test(b.textContent.trim()));

test('an address is paid by splicing out of the home channel at the converted fee rate', async () => {
	const api = stubApi();
	const view = await mount(api);
	try {
		assert.match(view.text(), /Spendable: 380,000 sats at 7 sat\/vB/);
		const quote = api.calls.find(([m, p]) => m === 'POST' && p === '/channel/splice-quote');
		assert.deepEqual(quote[2], { channelId: HOME.channelId, direction: 'out', feeratePerkw: 1750 });
		await type(view.$('input[placeholder^="bc1"]'), ADDR);
		await type(view.$('.amount-input'), '40000');
		await settle(300);
		await click(sendButton(view));
		await settle(50);
		const splice = api.calls.find(([m, p]) => m === 'POST' && p === '/channel/splice-out');
		assert.deepEqual(splice[2], { channelId: HOME.channelId, amountSats: 40000, feeratePerkw: 1750, address: ADDR });
		assert.match(view.text(), /Sent from your channel/);
	} finally {
		await view.unmount();
	}
});

test('reaching for more than the channel can release becomes Max, at the daemon\'s ceiling', async () => {
	const api = stubApi();
	const view = await mount(api);
	try {
		await type(view.$('input[placeholder^="bc1"]'), ADDR);
		await type(view.$('.amount-input'), '390000');
		await settle(300);
		assert.equal(sendButton(view).textContent.trim(), 'Send max');
		assert.equal(view.$('.amount-input').value, '380000', 'the figure is the ceiling, never the reach');
		await click(sendButton(view));
		await settle(50);
		const splice = api.calls.find(([m, p]) => m === 'POST' && p === '/channel/splice-out');
		assert.equal(splice[2].amountSats, 380000);
	} finally {
		await view.unmount();
	}
});

test('with no home channel there is nothing to send from, and the form says so', async () => {
	const view = await mount(stubApi(), []);
	try {
		assert.match(view.text(), /Nothing to send from yet/);
		assert.equal(sendButton(view).disabled, true);
	} finally {
		await view.unmount();
	}
});

test('a beignet request is paid as direct funding only when a confirmed coin covers it', async () => {
	const uri = buildBip21({ address: ADDR, funding: REQUEST });
	// No coin: the request is read, but the payment is a plain splice-out.
	const plain = stubApi();
	let view = await mount(plain);
	try {
		await type(view.$('input[placeholder^="bc1"]'), uri);
		await settle(300);
		assert.match(view.text(), /asks for 50,000 sats/);
		assert.match(view.text(), /lands as an ordinary transaction they move into Lightning/);
		assert.equal(view.$('input[type="checkbox"]'), null);
		assert.equal(sendButton(view).textContent.trim(), 'Send');
	} finally {
		await view.unmount();
	}
	// A confirmed coin that covers it: direct funding, and the coin is spent.
	const direct = stubApi({
		utxos: [{ txid: 'a'.repeat(64), vout: 0, valueSats: 80_000, height: 100 }],
		sendAnswer: { status: 'MEMPOOL_SEEN', fundingTxid: 'f'.repeat(64), attested: true, receiptPreimageHex: 'b'.repeat(64), amountSat: 50_000 }
	});
	view = await mount(direct);
	try {
		await type(view.$('input[placeholder^="bc1"]'), uri);
		await settle(300);
		assert.match(view.text(), /a confirmed deposit of yours can become their channel funding directly/);
		assert.equal(sendButton(view).textContent.trim(), 'Pay as direct funding');
		await click(sendButton(view));
		await settle(50);
		const sent = direct.calls.find(([m, p]) => m === 'POST' && p === '/direct-funding/send');
		assert.deepEqual(sent[2], { request: REQUEST, amountSats: 50_000, feeHeadroomSats: 1000 });
		assert.equal(direct.calls.some(([m, p]) => m === 'POST' && p === '/channel/splice-out'), false);
		assert.match(view.text(), /signed a receipt/);
	} finally {
		await view.unmount();
	}
});

test('a pasted request has the daemon start dialing the recipient before Send, coin or no coin', async () => {
	const uri = buildBip21({ address: ADDR, funding: REQUEST });
	const api = stubApi();
	const view = await mount(api);
	try {
		await type(view.$('input[placeholder^="bc1"]'), uri);
		await settle(300);
		const prepared = api.calls.filter(([m, p]) => m === 'POST' && p === '/direct-funding/prepare');
		assert.deepEqual(prepared.map(([, , body]) => body), [{ request: REQUEST }]);
		assert.equal(api.calls.some(([m, p]) => m === 'POST' && p === '/direct-funding/send'), false);
	} finally {
		await view.unmount();
	}
});

test('a rejected direct funding falls back to the splice-out; a signed one never does', async () => {
	const uri = buildBip21({ address: ADDR, funding: REQUEST });
	const coin = [{ txid: 'a'.repeat(64), vout: 0, valueSats: 80_000, height: 100 }];
	const rejected = stubApi({ utxos: coin, sendAnswer: refused('receiver declined the offer', 'OFFER_DECLINED') });
	let view = await mount(rejected);
	try {
		await type(view.$('input[placeholder^="bc1"]'), uri);
		await settle(300);
		await click(sendButton(view));
		await settle(50);
		assert.ok(rejected.calls.some(([m, p]) => m === 'POST' && p === '/channel/splice-out'), 'the plain payment followed');
		assert.match(view.text(), /Direct funding not taken \(receiver declined the offer\)/);
		// The toast said it once. The reason is also recorded against the
		// transaction it became, and stays on the card (umbrel #121).
		const note = recorded();
		assert.ok(note, 'the reason went somewhere durable');
		assert.equal(note.url, '/api/wallets/w1/direct-funding/fallbacks');
		assert.equal(note.body.reason, 'receiver declined the offer');
		assert.equal(note.body.txid, 'd'.repeat(64), 'the splice that went instead');
		assert.equal(note.body.amountSats, 50_000);
		assert.equal(note.body.nodeId, NODE);
		assert.match(view.text(), /That did not happen \(receiver declined the offer\)/);
	} finally {
		await view.unmount();
	}
	managerCalls = []; // the rejection above left one; this half must record none
	const signed = stubApi({ utxos: coin, sendAnswer: { status: 'SIGNED_PENDING', spentTxid: 'a'.repeat(64), caveat: 'the funding has not reached the mempool yet' } });
	view = await mount(signed);
	try {
		await type(view.$('input[placeholder^="bc1"]'), uri);
		await settle(300);
		await click(sendButton(view));
		await settle(50);
		assert.equal(signed.calls.some(([m, p]) => m === 'POST' && p === '/channel/splice-out'), false, 'the witness is out: paying again would pay twice');
		assert.match(view.text(), /signed and on its way \(signed pending\)\. the funding has not reached the mempool yet/);
		assert.equal(recorded(), undefined, 'nothing fell back, so there is nothing to explain');
	} finally {
		await view.unmount();
	}
});

test('a lost answer is asked for again, never spliced out while unknown (umbrel #140)', async () => {
	const base = stubApi({ utxos: [{ txid: 'a'.repeat(64), vout: 0, valueSats: 200_000, height: 100 }] });
	const keys = [];
	let asked = 0;
	const api = {
		...base,
		post: async (path, body, opts) => {
			if (path === '/direct-funding/send') {
				base.calls.push(['POST', path, body]);
				keys.push(opts?.headers?.['X-Idempotency-Key']);
				// Here the fallback is a splice-out, which never touches the coin
				// the funding pinned: a late acceptance would always pay twice.
				if (++asked === 1) throw new TypeError('Load failed');
				return { status: 'MEMPOOL_SEEN', fundingTxid: 'f'.repeat(64), amountSat: 50_000 };
			}
			return base.post(path, body);
		}
	};
	const view = await mount(api);
	try {
		await type(view.$('input[placeholder^="bc1"]'), buildBip21({ address: ADDR, funding: REQUEST }));
		await settle(400);
		await click(sendButton(view));
		await settle(50);
		assert.equal(asked, 1);
		assert.match(view.text(), /did not arrive \(load failed\).*Asking again/);
		assert.equal(base.calls.some(([m, p]) => m === 'POST' && p === '/channel/splice-out'), false);
		await settle(1100);
		assert.equal(asked, 2);
		assert.equal(keys[1], keys[0]);
		assert.equal(base.calls.some(([m, p]) => m === 'POST' && p === '/channel/splice-out'), false, 'a lost answer is not a refusal');
		assert.equal(recorded(), undefined);
		assert.match(view.text(), /Paid as direct funding/);
	} finally {
		await view.unmount();
	}
});

test('a failed splice-out retains the direct-funding refusal without claiming payment success', async () => {
	const api = stubApi({ utxos: [{ txid: 'a'.repeat(64), vout: 0, valueSats: 200_000, height: 100 }], sendAnswer: refused('request expired', 'EXPIRED'), spliceError: 'Insufficient funds' });
	const view = await mount(api);
	try {
		await type(view.$('input[placeholder^="bc1"]'), buildBip21({ address: ADDR, funding: REQUEST }));
		await settle(400);
		await click(sendButton(view));
		await settle(50);
		assert.equal(recorded().body.error, 'Insufficient funds');
		assert.match(view.text(), /ordinary payment also failed \(insufficient funds\)/);
		assert.doesNotMatch(view.text(), /went out as an ordinary payment|Sent from your channel/);
	} finally {
		await view.unmount();
	}
});

test('a splice-out still in flight keeps the refusal on the card, not only in the toast', async () => {
	let release;
	const held = new Promise((r) => {
		release = r;
	});
	const base = stubApi({
		utxos: [{ txid: 'a'.repeat(64), vout: 0, valueSats: 200_000, height: 100 }],
		sendAnswer: refused('receiver declined the offer', 'OFFER_DECLINED')
	});
	const api = {
		...base,
		post: async (path, body) => {
			if (path === '/channel/splice-out') await held;
			return base.post(path, body);
		}
	};
	const view = await mount(api);
	try {
		await type(view.$('input[placeholder^="bc1"]'), buildBip21({ address: ADDR, funding: REQUEST }));
		await settle(400);
		await click(sendButton(view));
		await settle(50);
		// The splice negotiates with the peer and can take far longer than the
		// 3.6s a toast lasts, and there is no transaction to record against yet.
		assert.match(view.text(), /That did not happen \(receiver declined the offer\)/);
		assert.match(view.text(), /ordinary payment is being attempted/);
		release();
		await settle(50);
		assert.match(view.text(), /went out as an ordinary payment/);
		assert.equal(recorded().body.txid, 'd'.repeat(64));
	} finally {
		release();
		await view.unmount();
	}
});

test('a failed fallback record keeps the splice transaction visible', async () => {
	const fetch = globalThis.fetch;
	globalThis.fetch = async (url, init = {}) => {
		if (init.method === 'POST') throw new Error('offline');
		return fetch(url, init);
	};
	const api = stubApi({ utxos: [{ txid: 'a'.repeat(64), vout: 0, valueSats: 200_000, height: 100 }], sendAnswer: refused('request expired', 'EXPIRED') });
	const view = await mount(api);
	try {
		await type(view.$('input[placeholder^="bc1"]'), buildBip21({ address: ADDR, funding: REQUEST }));
		await settle(400);
		await click(sendButton(view));
		await settle(50);
		assert.match(view.text(), /Sent from your channel/);
		assert.match(view.text(), /fallback reason could not be saved/);
		assert.equal(api.calls.filter(([m, p]) => m === 'POST' && p === '/channel/splice-out').length, 1);
	} finally {
		await view.unmount();
	}
});
