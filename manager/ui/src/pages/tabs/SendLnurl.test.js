/**
 * Run with: npm test (from manager/ui).
 *
 * LNURL on the Send tab, which looks no different for it. A Lightning
 * address or an LNURL pasted in either box ends up in the Lightning card,
 * read by the manager in place of the daemon's decode; a pay link is paid
 * with the invoice the manager fetched and checked, and a withdraw or login
 * link shows its own panel instead of a Pay button.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { click, render, settle, type } from '../../../test/render.mjs';
import { ToastProvider } from '../../components/Toast.jsx';
import SendTab from './SendTab.jsx';

const OPEN_CHANNEL = { channelId: 'c'.repeat(64), state: 'NORMAL', htlcUsable: true, localBalanceSats: 500_000 };
const FETCHED_INVOICE = 'lnbc42u1fetchedinvoicefromtheservice';

/** The manager, answering the LNURL routes the way lnurl.js does. */
function stubManager(links) {
	const calls = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init = {}) => {
		const body = init.body ? JSON.parse(init.body) : null;
		calls.push({ url: String(url), body });
		const answer = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
		const path = String(url);
		if (path.endsWith('/lnurl/resolve')) return answer(links[body.input]);
		if (path.endsWith('/lnurl/pay')) {
			return answer({ bolt11: FETCHED_INVOICE, paymentHash: 'b'.repeat(64), successAction: { tag: 'message', message: 'Thanks!' } });
		}
		if (path.endsWith('/lnurl/withdraw')) return answer({ ok: true, domain: 'atm.example', paymentHash: 'e'.repeat(64) });
		if (path.endsWith('/lnurl/auth')) return answer({ ok: true, domain: 'site.example', linkingKey: '02' + 'd'.repeat(64) });
		return answer([]);
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
			if (path === '/invoice/pay-safe') return { status: 'COMPLETED', feeSats: 1, paymentHash: 'b'.repeat(64), preimage: 'f'.repeat(64) };
			if (path === '/invoice/create') return { bolt11: 'lnbc210u1withdrawinvoice', paymentHash: 'e'.repeat(64), amountSats: body.amountSats };
			throw new Error(`unexpected POST ${path}`);
		}
	};
}

const PAY_LINK = {
	session: 's-pay',
	tag: 'pay',
	domain: 'getalby.com',
	lightningAddress: 'corey@getalby.com',
	description: 'Sats for Corey',
	minSats: 1,
	maxSats: 100_000,
	commentAllowed: 0
};

// Every mounted view, unmounted after each test whether it passed or not: a
// view left mounted keeps its polls running and the run never ends.
const mounted = [];
test.afterEach(async () => {
	while (mounted.length) await mounted.pop().unmount();
});

async function mountSend(api) {
	const view = await render(ToastProvider, {
		children: createElement(SendTab, {
			id: 'w1',
			api,
			info: { onchainBalanceSats: 1_000_000, channelCount: 1 },
			rec: { network: 'mainnet' },
			tick: 0,
			bump: () => {}
		})
	});
	mounted.push(view);
	await settle(50);
	return view;
}

test('a Lightning address in the on-chain box is moved across and paid with the fetched invoice', async () => {
	const mgr = stubManager({ 'corey@getalby.com': PAY_LINK });
	try {
		const api = stubApi();
		const view = await mountSend(api);
		await type(view.$('input[placeholder^="bc1"]'), 'Corey@GetAlby.com');
		await settle(800);

		const ln = view.$('textarea[placeholder^="lnbc"]');
		assert.ok(ln, 'the Lightning card is showing, under its usual title');
		assert.equal(ln.value, 'corey@getalby.com');
		assert.match(view.text(), /That is a Lightning address, so it was moved here/);
		assert.match(view.text(), /Sats for Corey/, 'what the service said the payment is for');
		assert.match(view.text(), /getalby\.com takes 1 sats? to 100,000 sats/);
		assert.ok(!api.calls.some(([, p]) => p === '/invoice/decode'), 'the daemon is not asked to decode an address');

		await type(view.$('.amount-input'), '4200');
		await settle(50);
		const payBtn = view.$$('button').find((b) => b.textContent.trim() === 'Pay');
		assert.ok(payBtn && !payBtn.disabled);
		await click(payBtn);
		await settle(100);

		const asked = mgr.calls.find((c) => c.url.endsWith('/lnurl/pay'));
		assert.deepEqual(asked.body, { session: 's-pay', amountSats: 4200 });
		const paid = api.calls.find(([m, p]) => m === 'POST' && p === '/invoice/pay-safe');
		assert.deepEqual(paid[2], { bolt11: FETCHED_INVOICE }, 'the invoice the manager checked, and nothing else');
		assert.match(view.text(), /Payment COMPLETED/);
		assert.match(view.text(), /Thanks!/, 'the service message after the payment');
	} finally {
		mgr.restore();
	}
});

test('an amount outside the link limits holds Pay back and says why', async () => {
	const mgr = stubManager({ 'corey@getalby.com': { ...PAY_LINK, minSats: 1000, maxSats: 5000 } });
	try {
		const api = stubApi();
		const view = await mountSend(api);
		await click(view.$$('.pill').find((b) => b.textContent.trim() === 'Lightning'));
		await type(view.$('textarea[placeholder^="lnbc"]'), 'corey@getalby.com');
		await settle(800);
		await type(view.$('.amount-input'), '200');
		await settle(50);
		const payBtn = view.$$('button').find((b) => b.textContent.trim() === 'Pay');
		assert.ok(payBtn.disabled);
		assert.match(view.text(), /getalby\.com takes 1,000 sats to 5,000 sats\./);
	} finally {
		mgr.restore();
	}
});

test('a withdraw link shows a withdraw panel and hands the service an invoice', async () => {
	const mgr = stubManager({
		'lnurlw://atm.example/w': { session: 's-w', tag: 'withdraw', domain: 'atm.example', minSats: 1, maxSats: 21000, defaultDescription: 'Voucher' }
	});
	try {
		const api = stubApi();
		const view = await mountSend(api);
		await click(view.$$('.pill').find((b) => b.textContent.trim() === 'Lightning'));
		await type(view.$('textarea[placeholder^="lnbc"]'), 'lnurlw://atm.example/w');
		await settle(800);

		assert.ok(!view.$$('button').some((b) => /^Pay/.test(b.textContent.trim())), 'no Pay button for a withdrawal');
		const withdraw = view.$$('button').find((b) => /^Withdraw/.test(b.textContent.trim()));
		assert.ok(withdraw, 'a Withdraw button instead');
		await click(withdraw);
		await settle(100);

		const made = api.calls.find(([m, p]) => m === 'POST' && p === '/invoice/create');
		assert.deepEqual(made[2], { description: 'Voucher', amountSats: 21000 });
		const handed = mgr.calls.find((c) => c.url.endsWith('/lnurl/withdraw'));
		assert.deepEqual(handed.body, { session: 's-w', bolt11: 'lnbc210u1withdrawinvoice' });
		assert.match(view.text(), /atm\.example accepted the invoice/);
	} finally {
		mgr.restore();
	}
});

test('a login link asks first, then signs in', async () => {
	const k1 = 'a'.repeat(64);
	const input = `keyauth://site.example/auth?tag=login&k1=${k1}`;
	const mgr = stubManager({ [input]: { session: 's-l', tag: 'login', domain: 'site.example', action: 'login' } });
	try {
		const api = stubApi();
		const view = await mountSend(api);
		await click(view.$$('.pill').find((b) => b.textContent.trim() === 'Lightning'));
		await type(view.$('textarea[placeholder^="lnbc"]'), input);
		await settle(800);
		assert.match(view.text(), /Log in to site\.example with this wallet\?/);
		assert.ok(!mgr.calls.some((c) => c.url.endsWith('/lnurl/auth')), 'nothing signed before the click');
		await click(view.$$('button').find((b) => b.textContent.trim() === 'Log in'));
		await settle(100);
		assert.ok(mgr.calls.some((c) => c.url.endsWith('/lnurl/auth')));
		assert.match(view.text(), /site\.example accepted the signature/);
	} finally {
		mgr.restore();
	}
});

test('a service refusal is shown as the service gave it', async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		if (String(url).endsWith('/lnurl/resolve')) {
			return { ok: false, status: 502, json: async () => ({ ok: false, error: { code: 'LNURL_SERVICE_ERROR', message: 'getalby.com says: Unknown user' } }) };
		}
		return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
	};
	try {
		const view = await mountSend(stubApi());
		await click(view.$$('.pill').find((b) => b.textContent.trim() === 'Lightning'));
		await type(view.$('textarea[placeholder^="lnbc"]'), 'nobody@getalby.com');
		await settle(800);
		assert.match(view.text(), /getalby\.com says: Unknown user/);
	} finally {
		globalThis.fetch = realFetch;
	}
});
