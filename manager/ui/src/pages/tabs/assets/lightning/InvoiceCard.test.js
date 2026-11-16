/**
 * Run with: npm test (from manager/ui).
 *
 * Receiving an asset over Lightning: the invoice card beside the on-chain
 * address. A wallet without asset channels never sees it. One with them is
 * told what it can receive before it can make anything, gets an invoice it
 * can show and copy with the time it has left, and sees the code give way to
 * a receipt when the wallet says it was paid, and to plain words when the
 * time ran out first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assetsBackend, mountAssets } from '../../../../../test/assets-backend.mjs';
import { click, settle, type } from '../../../../../test/render.mjs';

test.beforeEach(() => sessionStorage.clear());

const chip = (r, name) => r.$$('.asset-chip').find((b) => b.querySelector('.asset-chip-name').textContent === name);
const titles = (r) => r.$$('[data-testid="asset-receive"] .card-head h3').map((h) => h.firstChild.textContent);
// A price is asked for a beat after the amount stops moving.
const PRICED_MS = 400;
const ANSWERED_MS = 80;

/** The Receive view with an asset chosen and an amount typed, and time for a price. */
async function asking(backend, wallet, name, amount, options) {
	const r = await mountAssets(backend, wallet, options);
	await r.view('Receive');
	if (name) await click(chip(r, name));
	if (amount != null) await type(r.test('asset-receive-amount'), amount);
	await settle(PRICED_MS);
	return r;
}

test('a wallet without asset channels has no invoice card, and its peer is never asked for a price', async () => {
	const backend = assetsBackend();
	// An engine that cannot carry asset channels, as every released one is.
	const off = await asking(backend, 'demo-main', 'BUSD', '250', { config: { assetsAvailable: true, assetChannelsAvailable: false } });
	try {
		assert.equal(off.test('asset-invoice-card'), null);
		assert.deepEqual(titles(off), ['On-chain address', 'Recent receives']);
		assert.doesNotMatch(off.test('asset-receive').textContent, /Lightning invoice/);
		assert.ok(off.test('asset-address-create'), 'the on-chain address is offered as before');
	} finally {
		await off.unmount();
	}

	// An on-chain only wallet, on an engine that can.
	const savings = await asking(backend, 'demo-savings', 'Gold Gram', '1');
	try {
		assert.equal(savings.test('asset-invoice-card'), null);
		assert.deepEqual(titles(savings), ['On-chain address', 'Recent receives']);
	} finally {
		await savings.unmount();
	}

	// A wallet whose assets host says its Lightning side is off.
	const hostOff = assetsBackend({ lightning: false });
	const quiet = await asking(hostOff, 'demo-main', 'BUSD', '250');
	try {
		assert.equal(quiet.test('asset-invoice-card'), null);
	} finally {
		await quiet.unmount();
	}

	assert.equal(backend.posted('/invoices/quote').length + hostOff.posted('/invoices/quote').length, 0);
	assert.equal(backend.posted('/invoices').length + hostOff.posted('/invoices').length, 0);
});

test('an invoice is priced, made, shown with the time it has, and gives way to a receipt when paid', async () => {
	const backend = assetsBackend();
	const twin = assetsBackend();
	const busd = (await twin.api('demo-main').get('/x/assets/balances')).assets.find((a) => a.name === 'BUSD');
	const expected = await twin.api('demo-main').post('/x/assets/invoices/quote', { key: busd.key, amount: '25000' });
	const sats = `${expected.amountSats.toLocaleString('en-US')} sats`;

	const r = await mountAssets(backend, 'demo-main');
	try {
		await r.view('Receive');
		assert.deepEqual(titles(r), ['On-chain address', 'Lightning invoice', 'Recent receives'], 'beside the on-chain address');
		const card = () => r.test('asset-invoice-card');
		assert.match(card().textContent, /Choose the asset above first\./);

		await click(chip(r, 'BUSD'));
		assert.match(r.test('asset-invoice-hint').textContent, /same asset and amount as the address\. Type the amount first\./);
		assert.equal(backend.posted('/invoices/quote').length, 0, 'no price is asked for before there is an amount');

		await type(r.test('asset-receive-amount'), '250');
		await settle(PRICED_MS);
		const quote = r.test('asset-invoice-quote');
		assert.equal(quote.getAttribute('data-state'), 'priced');
		assert.equal(quote.getAttribute('aria-live'), 'polite');
		assert.match(quote.textContent, /250\.00\s*BUSD/);
		assert.ok(quote.textContent.includes(`Worth nowabout ${sats}`), 'what it is worth in sats');
		assert.ok(quote.textContent.includes(expected.rateText), 'the rate');
		assert.match(quote.textContent, /from Lightning Labs edge/);
		assert.match(quote.textContent, /Can receive now\s*up to 3,100\.00 BUSD/, 'and the most this wallet can receive');
		assert.equal(backend.posted('/invoices').length, 0, 'no invoice exists until it is asked for');

		await type(r.test('asset-invoice-note'), 'Table 12');
		await click(r.test('asset-invoice-create'));
		await settle(ANSWERED_MS);
		const quotes = backend.posted('/invoices/quote');
		assert.equal(quotes.length, 2, 'the price is asked for again as the invoice is made');
		assert.deepEqual(quotes[1].body, { key: busd.key, amount: '25000' });
		const made = backend.posted('/invoices');
		assert.equal(made.length, 1);
		assert.equal(made[0].body.key, busd.key);
		assert.equal(made[0].body.amount, '25000');
		assert.equal(made[0].body.description, 'Table 12');
		assert.ok(made[0].body.quoteId);

		assert.equal(card().getAttribute('data-state'), 'waiting');
		const listed = (await backend.api('demo-main').get('/x/assets/invoices')).invoices[0];
		assert.match(listed.bolt11, /^lnbc/);
		assert.ok(r.test('asset-invoice-qr').querySelector('svg'), 'a code to scan');
		assert.equal(r.test('asset-invoice-full').textContent, listed.bolt11);
		assert.ok(r.test('asset-invoice-text').textContent.includes(listed.bolt11.slice(-6)), 'and the invoice, by its two ends');
		assert.equal(r.test('asset-invoice-copy').textContent, 'Copy invoice');
		const facts = r.test('asset-invoice-facts').textContent;
		assert.match(facts, /For 250\.00 BUSD/);
		assert.ok(facts.includes(`The payer is asked for ${sats}`));
		assert.ok(facts.includes(`${expected.rateText} · price from Lightning Labs edge`));
		assert.match(facts, /Time left to pay/);
		assert.match(r.test('asset-invoice-who').textContent, /^Any Lightning wallet can pay this\. You receive BUSD: your channel peer makes the exchange at this price/);
		assert.ok(r.test('countdown'), 'counting down');
		assert.equal(r.test('asset-invoice-create'), null, 'the form steps aside for the invoice');

		// It is in the list of receives, as a Lightning one.
		assert.equal(r.tests('asset-receive-row')[0].querySelector('.badge').textContent, 'lightning');

		// Looking elsewhere does not lose it.
		await r.view('Holdings');
		await r.view('Receive');
		assert.ok(r.test('asset-invoice-qr'));

		// The payer pays. The wallet says so, and the code gives way.
		await r.pass(13_000);
		await settle(350);
		assert.equal(card().getAttribute('data-state'), 'paid');
		assert.equal(r.test('asset-invoice-qr'), null, 'a paid invoice is not left looking like one still waiting');
		const paid = r.test('asset-invoice-paid');
		assert.equal(paid.getAttribute('role'), 'status');
		assert.match(paid.textContent, /Received/);
		assert.match(paid.textContent, /250\.00 BUSD received over Lightning\./);
		const after = (await backend.api('demo-main').get('/x/assets/balances')).assets.find((a) => a.name === 'BUSD');
		assert.equal(after.balance.lightningSendable, '265000', 'and it is on this side of the channel');

		await click(r.test('asset-invoice-again'));
		await settle(PRICED_MS);
		assert.equal(r.test('asset-invoice-paid'), null);
		assert.ok(r.test('asset-invoice-create'), 'the form is back for the next one');
	} finally {
		await r.unmount();
	}
});

test('an amount above what the channel can receive is refused, with the most it can', async () => {
	const backend = assetsBackend();
	const r = await asking(backend, 'demo-main', 'BUSD', '5000');
	try {
		const refusal = r.test('asset-invoice-refusal');
		assert.equal(refusal.getAttribute('data-code'), 'INSUFFICIENT_INBOUND');
		assert.equal(refusal.getAttribute('role'), 'alert');
		assert.match(refusal.textContent, /The most this wallet can receive over Lightning right now is 3,100\.00 BUSD/);
		assert.match(refusal.textContent, /or use an on-chain address for the whole amount\./);
		assert.equal(r.test('asset-invoice-create').disabled, true);
		assert.equal(r.test('asset-invoice-card').getAttribute('data-state'), 'refused');
		assert.equal(r.test('asset-address-create').disabled, false, 'the on-chain address is still there to make');

		// A smaller amount is priced, and the refusal goes.
		await type(r.test('asset-receive-amount'), '3100');
		await settle(PRICED_MS);
		assert.equal(r.test('asset-invoice-refusal'), null);
		assert.equal(r.test('asset-invoice-create').disabled, false);
	} finally {
		await r.unmount();
	}
});

test('an asset with no channel cannot be received over Lightning, and the peer is not asked', async () => {
	const backend = assetsBackend();
	const r = await asking(backend, 'demo-main', 'Club Points', '40');
	try {
		const refusal = r.test('asset-invoice-refusal');
		assert.equal(refusal.getAttribute('data-code'), 'INSUFFICIENT_INBOUND');
		assert.match(refusal.textContent, /No channel of this wallet can receive Club Points right now/);
		assert.match(refusal.textContent, /An on-chain address works meanwhile\./);
		assert.equal(r.test('asset-invoice-create').disabled, true);
		assert.equal(backend.posted('/invoices/quote').length, 0, 'what the wallet already knows is not asked of the peer');
	} finally {
		await r.unmount();
	}
});

test('a collectible is received on-chain, and the card says so', async () => {
	const backend = assetsBackend();
	const r = await asking(backend, 'demo-main', 'Genesis Ticket #7', null);
	try {
		assert.match(r.test('asset-invoice-card').textContent, /A collectible is received on-chain\. A channel cannot carry one\./);
		assert.equal(r.test('asset-invoice-create'), null);
		assert.equal(backend.posted('/invoices/quote').length, 0);
	} finally {
		await r.unmount();
	}
});

test('an invoice whose time ran out unpaid stops being shown as one to scan', async () => {
	const backend = assetsBackend();
	const real = backend.api('demo-main');
	// A peer whose price holds for under a second.
	const api = {
		...real,
		post: async (path, body, options) => {
			const answer = await real.post(path, body, options);
			return path === '/x/assets/invoices' ? { ...answer, expiresAt: Date.now() + 800 } : answer;
		}
	};
	const r = await asking(backend, 'demo-main', 'BUSD', '250', { api });
	try {
		await click(r.test('asset-invoice-create'));
		await settle(ANSWERED_MS);
		assert.ok(r.test('asset-invoice-qr'));

		await settle(1500);
		assert.equal(r.test('asset-invoice-card').getAttribute('data-state'), 'expired');
		assert.equal(r.test('asset-invoice-qr'), null);
		assert.equal(r.test('asset-invoice-paid'), null, 'running out of time is never read as being paid');
		const over = r.test('asset-invoice-expired');
		assert.match(over.textContent, /The invoice for 250\.00 BUSD was not paid before its price ran out, so it can no longer be paid\. Nothing was received\./);

		await click(r.test('asset-invoice-new'));
		await settle(PRICED_MS);
		assert.equal(r.test('asset-invoice-expired'), null);
		assert.ok(r.test('asset-invoice-create'));
	} finally {
		await r.unmount();
	}
});

test('a price that expired before the invoice was made is said in plain words, and asked for again', async () => {
	const backend = assetsBackend();
	const real = backend.api('demo-main');
	let refuse = true;
	const api = {
		...real,
		post: async (path, body, options) => {
			if (path === '/x/assets/invoices' && refuse) {
				refuse = false;
				throw Object.assign(new Error('That price has expired. Ask for a new one'), { code: 'QUOTE_EXPIRED', status: 400 });
			}
			return real.post(path, body, options);
		}
	};
	const r = await asking(backend, 'demo-main', 'BUSD', '250', { api });
	try {
		await click(r.test('asset-invoice-create'));
		await settle(ANSWERED_MS);
		const refusal = r.test('asset-invoice-refusal');
		assert.equal(refusal.getAttribute('data-code'), 'QUOTE_EXPIRED');
		assert.equal(refusal.textContent, 'That price has expired. Ask for a new one.');
		assert.equal(r.test('asset-invoice-qr'), null);
		assert.equal(backend.posted('/invoices/quote').length, 3, 'one to show, one to make it with, and one after the refusal');

		await click(r.test('asset-invoice-create'));
		await settle(ANSWERED_MS);
		assert.ok(r.test('asset-invoice-qr'), 'and the next press makes it');
		assert.equal(r.test('asset-invoice-refusal'), null);
	} finally {
		await r.unmount();
	}
});

test('a peer that sets no bitcoin price: the invoice is for the asset alone, and says who can pay it', async () => {
	// Two wallets of this app with a channel between them. Neither prices the
	// asset, so the sats on the invoice are its face and the page shows none.
	const backend = assetsBackend({ priced: false });
	const r = await asking(backend, 'demo-main', 'BUSD', '250');
	try {
		const quote = r.test('asset-invoice-quote');
		assert.equal(quote.getAttribute('data-state'), 'priced');
		assert.equal(quote.getAttribute('data-priced'), 'no');
		const rows = [...quote.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => td.textContent).join(' | '));
		assert.deepEqual(rows, ['Who can pay it | Your channel peerLightning Labs edge', 'Can receive now | up to 3,100.00 BUSD']);
		assert.doesNotMatch(quote.textContent, /sats|Worth now|Price/, 'no worth and no rate');
		assert.match(
			r.test('asset-invoice-card').textContent,
			/This peer sets no bitcoin price, so the invoice is for the asset alone and only this peer can pay it\./
		);

		await click(r.test('asset-invoice-create'));
		await settle(ANSWERED_MS);
		assert.equal(backend.posted('/invoices').length, 1);
		const facts = r.test('asset-invoice-facts').textContent;
		assert.match(facts, /For 250\.00 BUSD/);
		assert.match(
			r.test('asset-invoice-unpriced').textContent,
			/Only your channel peer, Lightning Labs edge, can pay this invoice\. It is for the asset alone, with no bitcoin price\./
		);
		assert.doesNotMatch(facts, /The payer is asked for|price from/);
		assert.match(facts, /Time left to pay/);
		assert.equal(
			r.test('asset-invoice-who').textContent,
			'You receive BUSD straight from your channel peer, who agreed to this invoice for a set time, which is why it cannot be paid once the time runs out.',
			'and it is not said that any wallet can pay it'
		);
	} finally {
		await r.unmount();
	}
});

test('an invoice that brought in a unit less than it asked for says both, in its row, its dialog and its receipt', async () => {
	const { invoiceShortfall } = await import('../../../../lib/asset-lightning.js');
	const busd = { name: 'BUSD', type: 'normal', decimalDisplay: 2 };
	assert.deepEqual(invoiceShortfall({ assetAmount: '25000', receivedAmount: '24900', asset: busd }), { asked: '25000', received: '24900', text: 'asked for 250.00 BUSD, received 249.00 BUSD' });
	// Where they agree, or nothing has arrived yet, there is nothing to say.
	for (const receivedAmount of ['25000', null, undefined, '', 'x']) assert.equal(invoiceShortfall({ assetAmount: '25000', receivedAmount, asset: busd }), null);
	assert.equal(invoiceShortfall(null), null);

	const backend = assetsBackend();
	const api = backend.api('demo-main');
	assert.equal(backend.mock.seed('demo-main', 'invoice-short'), true);
	// The wallet's own keys, in its order: what was asked, and what arrived.
	const listed = (await api.get('/x/assets/invoices')).invoices;
	assert.deepEqual(Object.keys(listed[0]), ['bolt11', 'paymentHash', 'assetAmount', 'amountSats', 'rateText', 'priced', 'expiresAt', 'invoiceExpiresAt', 'description', 'asset', 'status', 'receivedAmount', 'createdAt']);
	assert.deepEqual([listed[0].status, listed[0].assetAmount, listed[0].receivedAmount], ['PAID', '25000', '24999']);
	const paidRow = (await api.get('/x/assets/activity?kind=ln-receive')).rows.find((x) => x.paymentHash === listed[0].paymentHash);
	assert.equal(paidRow.assets[0].amount, '24999', 'the row says what arrived');

	const r = await mountAssets(backend, 'demo-main', { at: { view: 'receive' } });
	try {
		await settle(60);
		const rows = r.tests('asset-receive-row');
		const mine = rows.find((tr) => tr.querySelector('[data-testid="asset-receive-short"]'));
		assert.ok(mine, 'the row of that invoice says both');
		assert.equal(mine.querySelector('[data-testid="asset-receive-short"]').textContent, 'asked for 250.00 BUSD, received 249.99 BUSD');
		assert.equal(r.tests('asset-receive-short').length, 1, 'and no other row says anything');
		await click(mine);
		await settle(60);
		assert.match(r.test('asset-invoice-short').textContent, /^The invoice asked for 250\.00 BUSD, received 249\.99 BUSD\. A payer's price can come to a unit less than an invoice names, and\s+the invoice is paid all the same\.$/);
	} finally {
		await r.unmount();
	}

	// The next invoice made here is paid a unit short too, and its receipt says what arrived.
	const busdHeld = (await api.get('/x/assets/balances')).assets.find((a) => a.name === 'BUSD');
	const quote = await api.post('/x/assets/invoices/quote', { key: busdHeld.key, amount: '2000' });
	const made = await api.post('/x/assets/invoices', { key: busdHeld.key, amount: '2000', quoteId: quote.quoteId });
	assert.equal((await api.get('/x/assets/invoices')).invoices.find((i) => i.paymentHash === made.paymentHash).receivedAmount, null, 'nothing has arrived yet');
	backend.pass(13000);
	const after = (await api.get('/x/assets/invoices')).invoices.find((i) => i.paymentHash === made.paymentHash);
	assert.deepEqual([after.status, after.assetAmount, after.receivedAmount], ['PAID', '2000', '1999']);
	// And the one after that arrives whole: where they agree, the list says the same figure twice.
	const q2 = await api.post('/x/assets/invoices/quote', { key: busdHeld.key, amount: '300' });
	const whole = await api.post('/x/assets/invoices', { key: busdHeld.key, amount: '300', quoteId: q2.quoteId });
	backend.pass(13000);
	const settled = (await api.get('/x/assets/invoices')).invoices.find((i) => i.paymentHash === whole.paymentHash);
	assert.deepEqual([settled.status, settled.receivedAmount], ['PAID', '300']);
});
