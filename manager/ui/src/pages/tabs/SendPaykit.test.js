/**
 * Run with: npm test (from manager/ui).
 *
 * A pubky on the Send tab, which looks no different for it. Pasted in
 * either box, the manager looks up what it publishes and the box is handed
 * one request this wallet can pay: in the on-chain box an address that
 * carries the payee's direct funding request and offer, in the Lightning
 * box the offer. What the payee does not take moves to the rail it does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { click, render, settle, type } from '../../../test/render.mjs';
import { ToastProvider } from '../../components/Toast.jsx';
import { encodeFundingEnvelope } from '../../lib/funding-envelope.js';
import SendTab from './SendTab.jsx';

const PUBKY = 'aihfhgdfshrj8nz9ofo7khayc1mgcqa4wrrdjahs5tmgo4pna3iy';
const ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const OFFER = `lno1${'qwerty0123456789'.repeat(6)}`;
const ENVELOPE = encodeFundingEnvelope({ nodeId: '02' + 'a'.repeat(64), expiresAt: Date.now() + 7 * 86400000 });
const OPEN_CHANNEL = { channelId: 'c'.repeat(64), state: 'NORMAL', htlcUsable: true, localBalanceSats: 500_000 };

/** The manager's Paykit lookup, answering with `endpoints` (or failing). */
function stubManager(endpoints) {
	const calls = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init = {}) => {
		const body = init.body ? JSON.parse(init.body) : null;
		calls.push({ url: String(url), body });
		if (String(url).endsWith('/paykit/lookup')) {
			if (endpoints instanceof Error) {
				return {
					ok: false,
					status: 502,
					json: async () => ({ ok: false, error: { code: 'PAYKIT_UNREACHABLE', message: endpoints.message } })
				};
			}
			return { ok: true, status: 200, json: async () => ({ ok: true, result: { pubky: body.pubky, endpoints } }) };
		}
		return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
	};
	return { calls, restore: () => (globalThis.fetch = realFetch) };
}

function stubApi() {
	const calls = [];
	return {
		calls,
		get: async (path) => {
			calls.push(['GET', path]);
			if (path === '/channels') return [OPEN_CHANNEL];
			if (path === '/fees/estimates') return { fast: 18, normal: 7, slow: 2 };
			if (path === '/utxos') return [];
			return null;
		},
		post: async (path, body) => {
			calls.push(['POST', path, body]);
			if (path === '/offer/decode') return { offerId: 'o'.repeat(64), description: 'Paykit payment', amountSats: null };
			if (path === '/offer/pay') return { status: 'COMPLETED', feeSats: 1, paymentHash: 'b'.repeat(64) };
			if (path === '/direct-funding/prepare') return {};
			throw new Error(`unexpected POST ${path}`);
		}
	};
}

// Every mounted view, unmounted after each test whether it passed or not: a
// view left mounted keeps its polls running and the run never ends.
const mounted = [];
test.afterEach(async () => {
	while (mounted.length) await mounted.pop().unmount();
});

async function mountSend(api, rec = { network: 'mainnet' }) {
	const view = await render(ToastProvider, {
		children: createElement(SendTab, {
			id: 'w1',
			api,
			info: { onchainBalanceSats: 1_000_000, channelCount: 1 },
			rec,
			tick: 0,
			bump: () => {}
		})
	});
	mounted.push(view);
	await settle(50);
	return view;
}

const ALL = [
	{ appId: 'beignet', identifier: 'btc-lightning-bolt12', value: OFFER },
	{ appId: 'beignet', identifier: 'btc-bitcoin-p2wpkh', value: ADDR },
	{ appId: 'beignet', identifier: 'btc-bitcoin-bip21', value: `bitcoin:${ADDR}?bgnq=${ENVELOPE}` }
];

test('a pubky in the on-chain box becomes its payee address, with direct funding on', async () => {
	const mgr = stubManager(ALL);
	try {
		const view = await mountSend(stubApi());
		await type(view.$('input[placeholder^="bc1"]'), `pubky${PUBKY}`);
		await settle(200);

		const looked = mgr.calls.find((c) => c.url.endsWith('/paykit/lookup'));
		assert.deepEqual(looked.body, { pubky: PUBKY }, 'the bare key is looked up');
		assert.equal(view.$('input[placeholder^="bc1"]').value, ADDR, 'the box holds the address the request settled on');
		assert.match(view.text(), /Read from aihfhgdf…pna3iy's payment details\./);
		assert.match(view.text(), /This request comes from a beignet wallet/);
		const df = view.$$('label.checkbox').find((l) => /Pay as direct funding/.test(l.textContent));
		assert.ok(df && df.querySelector('input').checked, 'direct funding is offered, and on');
		assert.ok(
			view.$$('button').some((b) => b.textContent.trim() === 'Pay over Lightning instead'),
			'the offer rides along'
		);
	} finally {
		mgr.restore();
	}
});

test('a pubky in the Lightning box pays its offer', async () => {
	const mgr = stubManager(ALL);
	try {
		const api = stubApi();
		const view = await mountSend(api);
		await click(view.$$('.pill').find((b) => b.textContent.trim() === 'Lightning'));
		await type(view.$('textarea[placeholder^="lnbc"]'), `pubky://${PUBKY}`);
		await settle(800);

		assert.equal(view.$('textarea[placeholder^="lnbc"]').value, OFFER);
		assert.match(view.text(), /Read from aihfhgdf…pna3iy's payment details\./);
		assert.deepEqual(api.calls.find(([m, p]) => m === 'POST' && p === '/offer/decode')[2], { offer: OFFER });
	} finally {
		mgr.restore();
	}
});

test('a pubky that takes on-chain only is moved from the Lightning box to the on-chain one', async () => {
	const mgr = stubManager([{ appId: 'beignet', identifier: 'btc-bitcoin-p2wpkh', value: ADDR }]);
	try {
		const view = await mountSend(stubApi());
		await click(view.$$('.pill').find((b) => b.textContent.trim() === 'Lightning'));
		await type(view.$('textarea[placeholder^="lnbc"]'), PUBKY);
		await settle(400);

		assert.equal(view.$('input[placeholder^="bc1"]').value, ADDR);
		assert.match(view.text(), /They take on-chain payments only, so it was moved here\./);
	} finally {
		mgr.restore();
	}
});

test('an on-chain only wallet is told it cannot pay a pubky that takes Lightning only', async () => {
	const mgr = stubManager([{ appId: 'beignet', identifier: 'btc-lightning-bolt12', value: OFFER }]);
	try {
		const view = await mountSend(stubApi(), { network: 'mainnet', onchainOnly: true });
		await type(view.$('input[placeholder^="bc1"]'), PUBKY);
		await settle(200);
		assert.match(view.text(), /takes Lightning only, and this wallet is on-chain only, so it cannot pay them\./);
		assert.ok(!view.$('textarea[placeholder^="lnbc"]'), 'there is no Lightning card to move it to');
	} finally {
		mgr.restore();
	}
});

test('a pubky that cannot be read, or publishes nothing payable, says so where it was pasted', async () => {
	let mgr = stubManager(new Error('The Pubky homeserver could not be reached.'));
	try {
		const view = await mountSend(stubApi());
		await type(view.$('input[placeholder^="bc1"]'), `pk:${PUBKY}`);
		await settle(200);
		assert.match(view.text(), /The Pubky homeserver could not be reached\./);
		assert.equal(view.$('input[placeholder^="bc1"]').value, `pk:${PUBKY}`, 'the paste is left alone');
	} finally {
		mgr.restore();
	}
	mgr = stubManager([{ appId: 'bitkit', identifier: 'usdt-tron-address', value: 'T123' }]);
	try {
		const view = await mountSend(stubApi());
		await type(view.$('input[placeholder^="bc1"]'), PUBKY);
		await settle(200);
		assert.match(view.text(), /That pubky publishes no way this wallet can pay \(usdt-tron-address\)\./);
	} finally {
		mgr.restore();
	}
});
