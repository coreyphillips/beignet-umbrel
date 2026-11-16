/**
 * Run with: npm test (from manager/ui).
 *
 * Paying a Lightning invoice with an asset. The invoice asks for bitcoin and
 * the wallet pays in an asset at a price its channel peer quotes, so what
 * matters is that the reader sees the amount before paying it and never pays
 * another: the button names the amount, the payment carries that amount as
 * its ceiling, a price that moved is shown and asked about again, and a
 * price that ran out is not paid at.
 *
 * A wallet without asset channels is offered none of this
 * (SendView.test.js pins that).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assetsBackend, mountAssets } from '../../../../../test/assets-backend.mjs';
import { click, settle, type } from '../../../../../test/render.mjs';
import { cmpUnits, fmtAsset } from '../../../../lib/asset-amount.js';
import { bech32Encode } from '../../../../lib/payment-uri.js';
import { CHANGE_HOLD_MS } from './PayInvoice.jsx';

test.beforeEach(() => sessionStorage.clear());

// Shaped exactly like an invoice, checksum included, which is all the page
// reads of one. The demo wallet prices it from the amount in its prefix.
const invoiceFor = (hrp) => bech32Encode(hrp, Array.from({ length: 200 }, (_, i) => (i * 7 + 3) % 32));
const FIVE_THOUSAND = invoiceFor('lnbc50u');
const ANY_AMOUNT = invoiceFor('lnbc');
const TEN_MILLION = invoiceFor('lnbc100m');

// The box is read at once, and the price is asked for a beat later.
const PRICED_MS = 450;
const ANSWERED_MS = 60;

const busdOf = async (backend) => (await backend.api('demo-main').get('/x/assets/balances')).assets.find((a) => a.name === 'BUSD');

/** What a fresh wallet quotes for an invoice, worked out on a backend of its own. */
async function priceOf(bolt11, extra = {}) {
	const twin = assetsBackend();
	const busd = await busdOf(twin);
	return { busd, quote: await twin.api('demo-main').post('/x/assets/pay/quote', { bolt11, key: busd.key, ...extra }) };
}

/** The Send view with something pasted, and time for a price to arrive. */
async function pasted(backend, wallet, text, options = {}) {
	const r = await mountAssets(backend, wallet, { at: { view: 'send' }, ...options });
	await type(r.test('asset-send-input'), text);
	await settle(PRICED_MS);
	return r;
}

test('an invoice is paid with an asset: what it asks, what it costs, and a button that names the amount', async () => {
	const backend = assetsBackend();
	const { busd, quote } = await priceOf(FIVE_THOUSAND);
	const r = await mountAssets(backend, 'demo-main', { at: { view: 'send' } });
	try {
		assert.equal(r.$('.field-label').textContent, 'Taproot Assets address or Lightning invoice');
		assert.match(r.test('asset-send-hint').textContent, /A Lightning invoice can be pasted here too/);

		await type(r.test('asset-send-input'), FIVE_THOUSAND);
		await settle(PRICED_MS);
		assert.equal(r.test('asset-send-invoice'), null, 'the note that invoices are not paid here is gone');
		assert.match(r.test('asset-pay-invoice').textContent, /5,000 satsis what this Lightning invoice asks for · lnbc50u1/);

		// BUSD is the one asset a channel of this wallet can send, so it is chosen.
		const chips = r.$$('[data-testid="asset-pay-picker"] .asset-chip');
		assert.deepEqual(chips.map((c) => c.textContent), ['BUSD'], 'only what a channel can send is offered');
		assert.equal(chips[0].getAttribute('aria-checked'), 'true');

		const panel = r.test('asset-pay-quote');
		assert.equal(panel.getAttribute('data-state'), 'priced');
		assert.equal(panel.getAttribute('aria-live'), 'polite', 'the price is announced when it arrives');
		const amount = fmtAsset(quote.assetAmount, busd);
		assert.ok(panel.textContent.replace(/\s+/g, ' ').includes(amount.replace(' BUSD', '')), `the price panel says ${amount}`);
		assert.match(panel.textContent, /The invoice gets\s*5,000 sats/);
		assert.ok(panel.textContent.includes(quote.rateText), 'with the rate it was worked out at');
		assert.match(panel.textContent, /from Lightning Labs edge/, 'and whose price it is');
		assert.match(panel.textContent, /You can send\s*2,400\.00 BUSD over Lightning/);
		assert.ok(r.test('countdown'), 'and how long the price holds');

		const asked = backend.posted('/pay/quote');
		assert.equal(asked.length, 1);
		assert.equal(asked[0].body.bolt11, FIVE_THOUSAND);
		assert.equal(asked[0].body.key, busd.key);

		const submit = r.test('asset-pay-submit');
		assert.equal(submit.textContent, `Pay ${amount}`);
		assert.equal(submit.disabled, false);
		assert.equal(backend.posted('/pay').length, 0, 'nothing is paid before the button is pressed');

		await click(submit);
		await settle(ANSWERED_MS);
		const sent = backend.posted('/pay');
		assert.equal(sent.length, 1);
		assert.equal(sent[0].body.bolt11, FIVE_THOUSAND);
		assert.equal(sent[0].body.key, busd.key);
		assert.equal(sent[0].body.maxAssetAmount, quote.assetAmount, 'the amount on the button is the most that may be paid');
		assert.ok(sent[0].body.quoteId, 'at the price that was shown');
		assert.match(sent[0].headers['X-Idempotency-Key'], /^[0-9a-f-]{16,}$/i, 'and it is sent so that it happens once');

		const receipt = r.test('asset-pay-receipt');
		assert.equal(receipt.getAttribute('role'), 'status');
		assert.equal(receipt.getAttribute('data-settled'), 'yes');
		assert.match(receipt.textContent, /Paid/);
		assert.ok(receipt.textContent.includes(`${amount} paid over Lightning, for an invoice of 5,000 sats.`));
		assert.match(receipt.textContent, /Routing fee\s*2 sats/);
		assert.match(receipt.textContent, /Payment hash\s*[0-9a-f]{8}…[0-9a-f]{8}/);
		assert.equal(r.test('asset-pay-submit'), null, 'a paid invoice is not offered for paying again');
		assert.ok(r.toasts().some((t) => t === `Paid ${amount} over Lightning`));

		// It left the channel, and the row says what it was.
		const after = await busdOf(backend);
		assert.equal(cmpUnits(after.balance.lightningSendable, busd.balance.lightningSendable), -1);
		const rows = (await backend.api('demo-main').get('/x/assets/activity?limit=5')).rows;
		assert.equal(rows[0].kind, 'ln-send');
		assert.equal(rows[0].assets[0].amount, quote.assetAmount);

		// A look elsewhere and back finds the receipt, not a second chance to pay.
		await r.view('Holdings');
		await r.view('Send');
		assert.ok(r.test('asset-pay-receipt'));
		assert.equal(r.test('asset-pay-submit'), null);

		await click(r.test('asset-pay-another'));
		await settle(50);
		assert.equal(r.test('asset-send-input').value, '');
		assert.equal(r.test('asset-pay-receipt'), null);
		assert.equal(backend.posted('/pay').length, 1);
	} finally {
		await r.unmount();
	}
});

test('a price that moved is shown and asked about again, and nothing is paid in between', async () => {
	const backend = assetsBackend();
	const { busd, quote } = await priceOf(FIVE_THOUSAND);
	const r = await pasted(backend, 'demo-main', FIVE_THOUSAND);
	try {
		const first = fmtAsset(quote.assetAmount, busd);
		assert.equal(r.test('asset-pay-submit').textContent, `Pay ${first}`);

		// The price runs out at the wallet a moment before the press reaches it.
		backend.pass(31_000);
		await click(r.test('asset-pay-submit'));
		await settle(ANSWERED_MS);

		assert.equal(r.test('asset-pay-receipt'), null, 'nothing was paid');
		assert.equal((await busdOf(backend)).balance.lightningSendable, busd.balance.lightningSendable, 'and nothing left the channel');
		const changed = r.test('asset-pay-changed');
		assert.equal(changed.getAttribute('role'), 'alert');
		assert.equal(changed.getAttribute('data-direction'), 'more');
		assert.equal(changed.className, 'error-note', 'a higher price is a warning, not a note');

		const sent = backend.posted('/pay');
		assert.equal(sent.length, 1);
		const submit = r.test('asset-pay-submit');
		const second = submit.textContent.replace(/^Pay /, '');
		assert.notEqual(second, first, 'the button names the new amount');
		assert.ok(changed.textContent.includes(`nothing was paid. It is now ${second}, up from ${first}.`));
		assert.ok(r.test('asset-pay-quote').textContent.replace(/\s+/g, ' ').includes(second.replace(' BUSD', '')), 'and so does the price panel');
		assert.equal(submit.disabled, true, 'held still for a moment, so a double press cannot land on the new figure');

		await settle(CHANGE_HOLD_MS + 100);
		assert.equal(r.test('asset-pay-submit').disabled, false);
		await click(r.test('asset-pay-submit'));
		await settle(ANSWERED_MS);

		const again = backend.posted('/pay');
		assert.equal(again.length, 2);
		assert.equal(cmpUnits(again[1].body.maxAssetAmount, again[0].body.maxAssetAmount), 1, 'the second press carries the new ceiling');
		assert.notEqual(again[1].body.quoteId, again[0].body.quoteId);
		assert.notEqual(again[1].headers['X-Idempotency-Key'], again[0].headers['X-Idempotency-Key'], 'a new press is a new payment');
		assert.ok(r.test('asset-pay-receipt').textContent.includes(`${second} paid over Lightning`));
		assert.equal(r.test('asset-pay-changed'), null);
	} finally {
		await r.unmount();
	}
});

test('a price that runs out on screen is not paid at: the button asks for a new one', async () => {
	const backend = assetsBackend();
	const real = backend.api('demo-main');
	// A peer whose price holds for under a second.
	const api = {
		...real,
		post: async (path, body, options) => {
			const answer = await real.post(path, body, options);
			return path === '/x/assets/pay/quote' ? { ...answer, expiresAt: Date.now() + 800 } : answer;
		}
	};
	const r = await pasted(backend, 'demo-main', FIVE_THOUSAND, { api });
	try {
		assert.equal(r.test('asset-pay-quote').getAttribute('data-state'), 'priced');
		assert.match(r.test('asset-pay-submit').textContent, /^Pay \d/);

		await settle(1300);
		assert.equal(r.test('asset-pay-quote').getAttribute('data-state'), 'expired');
		assert.equal(r.test('asset-pay-expired').textContent, 'Expired');
		assert.equal(r.test('asset-pay-submit'), null, 'there is no Pay button for a price that no longer holds');
		assert.match(r.test('asset-pay-stale').textContent, /That price has run out, and nothing was paid/);
		const renew = r.test('asset-pay-renew');
		assert.equal(renew.textContent, 'Get a new price');
		assert.equal(backend.posted('/pay').length, 0);
		assert.equal(backend.posted('/pay/quote').length, 1, 'and the peer is not asked again by a page left open');

		await click(renew);
		await settle(120);
		assert.equal(backend.posted('/pay/quote').length, 2);
		assert.equal(r.test('asset-pay-quote').getAttribute('data-state'), 'priced');
		assert.match(r.test('asset-pay-submit').textContent, /^Pay \d/);
		assert.equal(r.test('asset-pay-stale'), null);
	} finally {
		await r.unmount();
	}
});

test('an invoice that names no amount asks for one, in sats, before any price is asked for', async () => {
	const backend = assetsBackend();
	const { busd, quote } = await priceOf(ANY_AMOUNT, { amountSats: 5000 });
	const r = await pasted(backend, 'demo-main', ANY_AMOUNT);
	try {
		assert.match(r.test('asset-pay-invoice').textContent, /Any amountThis Lightning invoice does not name an amount/);
		assert.equal(backend.posted('/pay/quote').length, 0);
		assert.match(r.test('asset-pay-quote').textContent, /Type how many sats to pay\./);
		assert.equal(r.test('asset-pay-submit').disabled, true);
		assert.equal(r.test('asset-pay-submit').textContent, 'Pay');

		await type(r.test('asset-pay-sats'), '5,000 sats');
		assert.equal(r.test('asset-pay-sats').value, '5000', 'digits only');
		await settle(PRICED_MS);
		const asked = backend.posted('/pay/quote');
		assert.equal(asked.length, 1);
		assert.equal(asked[0].body.amountSats, 5000);
		assert.equal(r.test('asset-pay-submit').textContent, `Pay ${fmtAsset(quote.assetAmount, busd)}`);

		await click(r.test('asset-pay-submit'));
		await settle(ANSWERED_MS);
		assert.ok(r.test('asset-pay-receipt').textContent.includes('for an invoice of 5,000 sats'));
	} finally {
		await r.unmount();
	}
});

test('an invoice for more than the channel can send is refused in plain words', async () => {
	const backend = assetsBackend();
	const r = await pasted(backend, 'demo-main', TEN_MILLION);
	try {
		const refusal = r.test('asset-pay-refusal');
		assert.equal(refusal.getAttribute('data-code'), 'INSUFFICIENT_OUTBOUND');
		assert.equal(refusal.getAttribute('role'), 'alert');
		assert.match(refusal.textContent, /needs more than the 2,400\.00 BUSD this wallet can send over Lightning right now/);
		assert.match(refusal.textContent, /What it holds on-chain cannot pay an invoice\./);
		assert.doesNotMatch(refusal.textContent, /INSUFFICIENT_OUTBOUND/);
		assert.equal(r.test('asset-pay-submit').disabled, true);
		assert.equal(r.test('asset-pay-quote').getAttribute('data-state'), 'empty');
	} finally {
		await r.unmount();
	}
});

test('a wallet with no asset in a channel is told so, and pointed at Channels', async () => {
	const backend = assetsBackend();
	const r = await pasted(backend, 'demo-testnet', invoiceFor('lntb50u'));
	try {
		const none = r.test('asset-pay-none');
		assert.match(none.textContent, /No asset of this wallet can be sent over Lightning right now/);
		assert.match(none.textContent, /To pay this invoice in bitcoin, use the Send tab\./);
		assert.equal(r.test('asset-pay-submit'), null);
		assert.equal(backend.posted('/pay/quote').length, 0);
		await click([...none.querySelectorAll('button')].find((b) => b.textContent === 'Open Channels'));
		assert.equal(r.moves.at(-1)[0], 'channels');
	} finally {
		await r.unmount();
	}
});

test('a payment that fails says why, says nothing was paid, and asks for a new price', async () => {
	const backend = assetsBackend();
	const real = backend.api('demo-main');
	const api = {
		...real,
		post: async (path, body, options) =>
			path === '/x/assets/pay'
				? { status: 'FAILED', paymentHash: null, assetAmount: '0', feeSats: 0, failureDescription: 'no route to the payee' }
				: real.post(path, body, options)
	};
	const r = await pasted(backend, 'demo-main', FIVE_THOUSAND, { api });
	try {
		await click(r.test('asset-pay-submit'));
		await settle(ANSWERED_MS);
		assert.equal(r.test('asset-pay-receipt'), null);
		assert.equal(r.test('asset-pay-failure').textContent, 'The payment did not go through, and nothing was paid. No route to the payee.');
		assert.equal(r.test('asset-pay-failure').getAttribute('role'), 'alert');
		assert.equal(backend.posted('/pay/quote').length, 2, 'the price that payment was tried at is spent');
		assert.match(r.test('asset-pay-submit').textContent, /^Pay \d/);
	} finally {
		await r.unmount();
	}
});

test('a refusal the page has no words for is said in the wallet words, never as a code', async () => {
	const backend = assetsBackend();
	const real = backend.api('demo-main');
	const api = {
		...real,
		post: async (path, body, options) => {
			if (path === '/x/assets/pay') throw Object.assign(new Error('The peer is not connected'), { code: 'PEER_OFFLINE', status: 400 });
			return real.post(path, body, options);
		}
	};
	const r = await pasted(backend, 'demo-main', FIVE_THOUSAND, { api });
	try {
		await click(r.test('asset-pay-submit'));
		await settle(ANSWERED_MS);
		assert.equal(r.test('asset-pay-failure').textContent, 'The peer is not connected.');
		assert.equal(r.test('asset-pay-receipt'), null);
	} finally {
		await r.unmount();
	}
});

test('an invoice a channel peer made for the asset alone is paid at its face, with no price shown', async () => {
	const backend = assetsBackend({ priced: false });
	const busd = await busdOf(backend);
	const r = await pasted(backend, 'demo-main', FIVE_THOUSAND);
	try {
		const panel = r.test('asset-pay-quote');
		assert.equal(panel.getAttribute('data-state'), 'priced');
		assert.equal(panel.getAttribute('data-priced'), 'no');
		// A unit to the sat: 5,000 sats on the invoice is 5,000 units, 50.00 BUSD.
		const amount = fmtAsset('5000', busd);
		assert.equal(amount, '50.00 BUSD');
		const rows = [...panel.querySelectorAll('tr')].map((tr) => tr.children[0].textContent);
		assert.deepEqual(rows, ['Paid to', 'You can send', 'Held for']);
		assert.match(panel.textContent, /Paid to\s*Your channel peerLightning Labs edge/);
		assert.doesNotMatch(panel.textContent, /The invoice gets|Price/);
		assert.match(
			r.test('asset-pay-unpriced').textContent,
			/Your channel peer made this invoice for the asset alone\. The sats written on it are not a price\./
		);

		const submit = r.test('asset-pay-submit');
		assert.equal(submit.textContent, `Pay ${amount}`);
		await click(submit);
		await settle(ANSWERED_MS);
		const sent = backend.posted('/pay');
		assert.equal(sent.length, 1);
		assert.equal(sent[0].body.maxAssetAmount, '5000');
		const receipt = r.test('asset-pay-receipt');
		assert.ok(receipt.textContent.includes(`${amount} paid over Lightning.`));
		assert.doesNotMatch(receipt.textContent, /for an invoice of/);
	} finally {
		await r.unmount();
	}
});

const UNACCOUNTED = 'The node no longer has a record of this payment, so how it ended cannot be known. It may have been paid. This wallet will not pay the invoice again.';
const UNCONFIRMED = 'The node took this payment without confirming that it went out as an asset payment. It ends as the node reports, and its units are not known to have left the channel.';

test('a payment the node has no record of any more is shown with the wallet\'s note, never as paid or failed, and is not paid again', async () => {
	const backend = assetsBackend();
	const api = backend.api('demo-main');
	assert.equal(backend.mock.seed('demo-main', 'pay-unaccounted'), true);
	const before = (await busdOf(backend)).balance.lightningSendable;
	// The row a payment made earlier left: pending, with the note, in the wallet's shape.
	const planted = (await api.get('/x/assets/activity?kind=ln-send')).rows[0];
	assert.deepEqual([planted.state, planted.failed, planted.notice], ['pending', false, { code: 'PAYMENT_UNACCOUNTED', message: UNACCOUNTED }]);
	// A price for the same invoice, held from before it was paid.
	const early = await api.post('/x/assets/pay/quote', { bolt11: FIVE_THOUSAND, key: (await busdOf(backend)).key });
	const r = await pasted(backend, 'demo-main', FIVE_THOUSAND);
	try {
		await click(r.test('asset-pay-submit'));
		await settle(ANSWERED_MS);
		const receipt = r.test('asset-pay-receipt');
		assert.equal(receipt.getAttribute('data-settled'), 'no');
		assert.equal(receipt.getAttribute('data-notice'), 'PAYMENT_UNACCOUNTED');
		assert.equal(receipt.querySelector('.paid-title').textContent, 'Not known');
		assert.equal(/\bpaid\b|failed/i.test(receipt.querySelector('.wallet-meta').textContent), false, 'neither paid nor failed');
		const note = r.test('asset-pay-notice');
		assert.equal(note.getAttribute('data-code'), 'PAYMENT_UNACCOUNTED');
		assert.equal(note.getAttribute('role'), 'status');
		assert.equal(note.className.includes('info-note'), true, 'said, not blocked');
		assert.equal(note.textContent, UNACCOUNTED);
		assert.equal(r.toasts().some((t) => /Paid/.test(t)), false, 'and nothing announces it as paid');
		// Nothing is known to have left the channel.
		assert.equal((await busdOf(backend)).balance.lightningSendable, before);

		// Pasted again, the wallet will not price it, in its own sentence.
		await click(r.test('asset-pay-another'));
		await type(r.test('asset-send-input'), FIVE_THOUSAND);
		await settle(PRICED_MS);
		const refusal = r.test('asset-pay-refusal');
		assert.equal(refusal.getAttribute('data-code'), 'ALREADY_PAID');
		assert.equal(refusal.textContent, 'This wallet has already paid that invoice, or is paying it now.');
	} finally {
		await r.unmount();
	}
	// Asked to pay it all the same, the wallet answers 409 with the note's own words.
	await assert.rejects(
		api.post('/x/assets/pay', { bolt11: FIVE_THOUSAND, key: (await busdOf(backend)).key, quoteId: early.quoteId, maxAssetAmount: early.assetAmount }, { headers: { 'X-Idempotency-Key': 'again' } }),
		(e) => e.code === 'PAYMENT_UNACCOUNTED' && e.status === 409 && e.message === UNACCOUNTED
	);
	// And with a price that has run out, it is not priced again either.
	await assert.rejects(api.post('/x/assets/pay', { bolt11: FIVE_THOUSAND, key: (await busdOf(backend)).key, quoteId: 'none' }, { headers: { 'X-Idempotency-Key': 'stale' } }), (e) => e.code === 'ALREADY_PAID' && e.status === 409);
	// Another invoice is paid as ever: the state was for one payment.
	const other = invoiceFor('lnbc70u');
	const quote = await api.post('/x/assets/pay/quote', { bolt11: other, key: (await busdOf(backend)).key });
	const answer = await api.post('/x/assets/pay', { bolt11: other, key: (await busdOf(backend)).key, quoteId: quote.quoteId, maxAssetAmount: quote.assetAmount }, { headers: { 'X-Idempotency-Key': 'other' } });
	assert.deepEqual([answer.status, 'notice' in answer], ['COMPLETED', false]);
});

test('a payment the node did not confirm as an asset payment keeps the wallet\'s note on its receipt, in the list and in its dialog', async () => {
	const backend = assetsBackend();
	backend.mock.seed('demo-main', 'pay-unconfirmed');
	const r = await pasted(backend, 'demo-main', FIVE_THOUSAND);
	try {
		await click(r.test('asset-pay-submit'));
		await settle(ANSWERED_MS);
		const receipt = r.test('asset-pay-receipt');
		assert.equal(receipt.getAttribute('data-notice'), 'PAYMENT_UNCONFIRMED');
		assert.equal(receipt.getAttribute('data-settled'), 'no', 'the node says complete, and the page does not call it paid');
		assert.equal(receipt.querySelector('.paid-title').textContent, 'Not confirmed');
		assert.equal(r.test('asset-pay-notice').textContent, UNCONFIRMED);
		assert.equal(r.toasts().some((t) => /Paid/.test(t)), false);
		// The answer is the wallet's shape: its status, and the note beside it.
		const rows = (await backend.api('demo-main').get('/x/assets/activity?kind=ln-send')).rows.filter((x) => x.notice);
		assert.deepEqual(rows.map((x) => [x.state, x.notice.code]), [['complete', 'PAYMENT_UNCONFIRMED'], ['pending', 'PAYMENT_UNCONFIRMED']]);
	} finally {
		await r.unmount();
	}
	// Under Holdings both stay in sight, each with the note, worded as neither paid nor failed.
	const h = await mountAssets(backend, 'demo-main', {});
	try {
		const items = h.tests('asset-progress-item').filter((li) => li.getAttribute('data-kind') === 'ln-send');
		assert.equal(items.length, 2);
		for (const li of items) {
			assert.match(li.querySelector('.progress-title').textContent, /^Lightning payment of [\d.,]+ BUSD: not confirmed as an asset payment$/);
			const note = li.querySelector('[data-testid="asset-row-notice"]');
			assert.equal(note.getAttribute('data-code'), 'PAYMENT_UNCONFIRMED');
			assert.equal(note.textContent, UNCONFIRMED);
			assert.equal(li.className.includes('failed'), false);
			assert.equal(li.querySelector('.error-note'), null);
		}
		await click(items[0].querySelector('button'));
		await settle(60);
		const dialog = h.test('asset-transfer-detail');
		assert.equal(dialog.querySelector('[data-testid="asset-row-notice"]').textContent, UNCONFIRMED);
		assert.match(dialog.querySelector('.badge').textContent, /unconfirmed/);
	} finally {
		await h.unmount();
	}
});
