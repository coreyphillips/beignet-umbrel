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
const PK = '03' + '22'.repeat(32);
const NODE = '02' + 'ab'.repeat(32);
const HOME = { channelId: 'c'.repeat(64), peerPubkey: PK, state: 'NORMAL', htlcUsable: true, localBalanceSats: 400_000, remoteBalanceSats: 100_000 };
const REQUEST = encodeFundingEnvelope({ nodeId: NODE, expiresAt: Date.now() + 3_600_000, amountSats: 50_000 });

const realFetch = globalThis.fetch;
test.beforeEach(() => {
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: [] }) });
});
test.afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubApi({ utxos = [], sendAnswer } = {}) {
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
			if (path === '/channel/splice-out') return { ok: true, txid: 'd'.repeat(64) };
			if (path === '/direct-funding/send') {
				if (sendAnswer instanceof Error) throw sendAnswer;
				return sendAnswer;
			}
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

test('a rejected direct funding falls back to the splice-out; a signed one never does', async () => {
	const uri = buildBip21({ address: ADDR, funding: REQUEST });
	const coin = [{ txid: 'a'.repeat(64), vout: 0, valueSats: 80_000, height: 100 }];
	const rejected = stubApi({ utxos: coin, sendAnswer: new Error('receiver declined the offer') });
	let view = await mount(rejected);
	try {
		await type(view.$('input[placeholder^="bc1"]'), uri);
		await settle(300);
		await click(sendButton(view));
		await settle(50);
		assert.ok(rejected.calls.some(([m, p]) => m === 'POST' && p === '/channel/splice-out'), 'the plain payment followed');
		assert.match(view.text(), /Direct funding not taken \(receiver declined the offer\)/);
	} finally {
		await view.unmount();
	}
	const signed = stubApi({ utxos: coin, sendAnswer: { status: 'SIGNED_PENDING', spentTxid: 'a'.repeat(64), caveat: 'the funding has not reached the mempool yet' } });
	view = await mount(signed);
	try {
		await type(view.$('input[placeholder^="bc1"]'), uri);
		await settle(300);
		await click(sendButton(view));
		await settle(50);
		assert.equal(signed.calls.some(([m, p]) => m === 'POST' && p === '/channel/splice-out'), false, 'the witness is out: paying again would pay twice');
		assert.match(view.text(), /signed and on its way \(signed pending\)\. the funding has not reached the mempool yet/);
	} finally {
		await view.unmount();
	}
});
