/**
 * Run with: npm test (from manager/ui).
 *
 * Sending an asset on-chain. The address is the whole form, so what matters
 * is that it is read rightly: what it asks for is shown before anything can
 * be pressed, the fee on screen is the fee of the transaction that will be
 * broadcast, pressing Send broadcasts it once, and an address this wallet
 * cannot pay is refused with the reason and without a button.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { assetsBackend, mountAssets } from '../../../../test/assets-backend.mjs';
import { blur, click, focus, settle, type } from '../../../../test/render.mjs';

test.beforeEach(() => sessionStorage.clear());

const BUSD = (holdings) => holdings.assets.find((a) => a.name === 'BUSD');
// The decode waits a beat for the typing to stop, and the prepare waits for the decode.
const READ_MS = 400;
const PRICED_MS = 800;
const DONATION =
	'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql';

/** An address made by another wallet, for `units` of the main wallet's BUSD. */
async function addressFrom(backend, wallet, units) {
	const held = await backend.api('demo-main').get('/x/assets/balances');
	const made = await backend.api(wallet).post('/x/assets/addresses', { key: BUSD(held).key, amount: units });
	return made.address.encoded;
}

/** The Send view of a wallet, with `address` pasted and read. */
async function pasted(backend, wallet, address, options) {
	const r = await mountAssets(backend, wallet, options);
	await r.view('Send');
	await type(r.test('asset-send-input'), address);
	await settle(READ_MS);
	return r;
}

const refusals = (r) => r.tests('asset-send-refusal').map((n) => n.getAttribute('data-code'));

test('pasting an address is the whole form: the asset, the amount and the cost are read from it', async () => {
	const backend = assetsBackend();
	const address = await addressFrom(backend, 'demo-witness', '10000');
	const r = await mountAssets(backend, 'demo-main');
	try {
		await r.view('Send');
		assert.match(r.test('asset-send-hint').textContent, /It names the asset and the amount, so there is nothing else to fill in/);
		assert.equal(r.test('asset-send-submit'), null, 'no button before there is something to send');

		await type(r.test('asset-send-input'), address);
		await settle(READ_MS);
		const preview = r.test('asset-send-preview');
		assert.equal(preview.getAttribute('data-state'), 'read');
		assert.equal(preview.getAttribute('aria-live'), 'polite', 'what was read is announced');
		assert.match(preview.textContent, /100\.00\s*BUSD/);
		assert.match(preview.textContent, /BUSD · 1f2268…2a06db/, 'named with its ID, which is what identifies it');
		assert.match(preview.textContent, /100\.00 BUSD · set by the address/);
		assert.match(preview.textContent, /universe\.lightning\.finance:10029/, 'and where the proof will go');
		assert.match(preview.textContent, /You hold\s*12,500\.00 BUSD on-chain/);
		assert.equal(r.$('[data-testid$="amount"]'), null, 'there is no amount to type: the address fixed it');

		const send = r.test('asset-send-submit');
		assert.equal(send.textContent, 'Send 100.00 BUSD');
		assert.equal(send.disabled, true, 'not until the wallet has built the transaction');

		await settle(PRICED_MS);
		const cost = r.test('asset-send-cost').textContent;
		assert.match(cost, /Miner fee: 4,590 sats at 18 sat\/vB over 255 vB\. This is what the transaction pays, not an estimate of it\./);
		assert.match(cost, /Travels with the asset: 1,000 sats/);
		assert.match(cost, /Change: 12,400\.00 BUSD comes back to this wallet/);
		assert.match(r.test('no-bump-note').textContent, /cannot be fee-bumped/);
		assert.equal(send.disabled, false);
		assert.deepEqual(refusals(r), []);
	} finally {
		await r.unmount();
	}
});

test('Send broadcasts the transaction that was priced, and only once', async () => {
	const backend = assetsBackend();
	const address = await addressFrom(backend, 'demo-witness', '10000');
	const r = await pasted(backend, 'demo-main', address);
	try {
		await settle(PRICED_MS);
		const send = r.test('asset-send-submit');
		// Two presses before the first has answered: a double click.
		await act(async () => {
			send.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
			send.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
		});
		await settle(50);

		const commits = backend.posted('/send/commit', 'demo-main');
		assert.equal(commits.length, 1);
		assert.match(commits[0].headers['X-Idempotency-Key'], /^[0-9a-f]{32}$/, 'under a key, so a retry cannot send it twice');
		assert.match(commits[0].body.previewId, /^preview-/, 'the prepared transaction, by name: nothing is rebuilt on the way');
		assert.deepEqual(Object.keys(commits[0].body), ['previewId']);

		assert.deepEqual(r.toasts(), ['Send broadcast']);
		assert.equal(r.test('asset-send-input').value, '', 'the box is emptied, so the same address is not sent to again by accident');
		const status = r.test('asset-send-status');
		assert.equal(status.getAttribute('data-state'), 'broadcast');
		assert.deepEqual(
			[...status.querySelectorAll('li')].map((li) => `${li.getAttribute('data-step')}:${li.getAttribute('data-state')}`),
			['broadcast:done', 'confirmed:current', 'proof:pending', 'complete:pending']
		);

		await r.pass(6000);
		assert.equal(r.test('asset-send-status').getAttribute('data-state'), 'proofs');
		await r.pass(5000);
		assert.equal(r.test('asset-send-status').getAttribute('data-state'), 'complete');
		assert.match(r.test('asset-send-status').textContent, /The recipient has the asset and its proof/);

		await r.view('Holdings');
		await settle(900);
		assert.match(r.$('[data-testid^="asset-row-"]').textContent, /14,800\.00/, 'and the holding is 100.00 lighter');
	} finally {
		await r.unmount();
	}
});

test('a change of fee rate prepares the transaction again, and the fee shown is the new one', async () => {
	const backend = assetsBackend();
	const address = await addressFrom(backend, 'demo-witness', '10000');
	const r = await pasted(backend, 'demo-main', address);
	try {
		await settle(PRICED_MS);
		const before = backend.posted('/send/prepare', 'demo-main').length;
		await click(r.$$('.preset-row button').find((b) => /^Slow/.test(b.textContent)));
		await settle(PRICED_MS);
		assert.equal(backend.posted('/send/prepare', 'demo-main').length, before + 1);
		assert.equal(backend.posted('/send/prepare', 'demo-main').at(-1).body.feeRate, 2);
		assert.match(r.test('asset-send-cost').textContent, /Miner fee: 510 sats at 2 sat\/vB over 255 vB/);
		assert.equal(r.test('asset-send-submit').disabled, false);
	} finally {
		await r.unmount();
	}
});

test('a prepared transaction that expired is prepared again, not sent blind', async () => {
	const backend = assetsBackend();
	const address = await addressFrom(backend, 'demo-witness', '10000');
	const r = await pasted(backend, 'demo-main', address);
	try {
		await settle(PRICED_MS);
		const prepared = backend.posted('/send/prepare', 'demo-main').length;
		// The wallet's minute runs out behind the page's back.
		backend.pass(61_000);
		await click(r.test('asset-send-submit'));
		await settle(50);
		assert.match(r.test('asset-send').textContent, /expired before it was sent, so it was prepared again\. Check the fee and press Send once more\./);
		assert.equal(r.test('asset-send-status'), null, 'nothing was sent');
		assert.equal(backend.posted('/send/prepare', 'demo-main').length, prepared + 1);
		assert.equal(r.test('asset-send-input').value, address, 'and the address is still in the box');
	} finally {
		await r.unmount();
	}
});

test("this wallet's own address is refused: sending to it would only pay a fee", async () => {
	const backend = assetsBackend();
	const own = await addressFrom(backend, 'demo-main', '10000');
	const r = await pasted(backend, 'demo-main', own);
	try {
		assert.deepEqual(refusals(r), ['OWN_ADDRESS']);
		assert.match(r.test('asset-send-refusal').textContent, /one of this wallet's own addresses/);
		assert.equal(r.test('asset-send-refusal').getAttribute('role'), 'alert');
		assert.equal(r.test('asset-send-submit'), null, 'and there is no button to press anyway');
		await settle(PRICED_MS);
		assert.equal(backend.posted('/send/prepare', 'demo-main').length, 0, 'the wallet is not asked to build what cannot be sent');
	} finally {
		await r.unmount();
	}
});

test('an address for an asset this wallet does not hold is refused, with its ID', async () => {
	const backend = assetsBackend();
	const address = await addressFrom(backend, 'demo-witness', '10000');
	const r = await pasted(backend, 'demo-savings', address);
	try {
		assert.deepEqual(refusals(r), ['ASSET_NOT_HELD']);
		assert.match(r.test('asset-send-refusal').textContent, /an asset this wallet does not hold \(ID 1f22…06db\)/);
		assert.equal(r.test('asset-send-submit'), null);
	} finally {
		await r.unmount();
	}
});

test('an address asking for more than is on-chain is refused, and says what is in channels', async () => {
	const backend = assetsBackend();
	const address = await addressFrom(backend, 'demo-witness', '1300000');
	const r = await pasted(backend, 'demo-main', address);
	try {
		assert.deepEqual(refusals(r), ['INSUFFICIENT_ASSET']);
		const said = r.test('asset-send-refusal').textContent;
		assert.match(said, /asks for 13,000\.00 BUSD and this wallet has 12,500\.00 BUSD on-chain/);
		assert.match(said, /Another 2,400\.00 BUSD is in Lightning channels, which an on-chain send cannot use/);
		assert.equal(r.test('asset-send-submit'), null);
	} finally {
		await r.unmount();
	}
});

test('without bitcoin for the fee, the refusal says how much is needed and for what', async () => {
	const backend = assetsBackend();
	backend.setSpendable('demo-main', 1200);
	const address = await addressFrom(backend, 'demo-witness', '10000');
	const r = await pasted(backend, 'demo-main', address);
	try {
		await settle(PRICED_MS);
		assert.deepEqual(refusals(r), ['INSUFFICIENT_SATS']);
		assert.equal(
			r.test('asset-send-refusal').textContent,
			'Sending costs 5,590 sats, but the wallet has to hold about 40,590 sats on-chain to build the transaction. What is not spent comes straight back. This wallet has 1,200 sats. Deposit bitcoin on the Receive tab first.'
		);
		assert.equal(r.test('asset-send-submit').disabled, true);
		assert.equal(r.test('asset-send-cost'), null, 'no fee is shown for a transaction that was not built');
	} finally {
		await r.unmount();
	}
});

test('an address for another network, or a damaged one, is refused before the wallet is asked', async () => {
	const backend = assetsBackend();
	const held = await backend.api('demo-testnet').get('/x/assets/balances');
	const testnet = (await backend.api('demo-testnet').post('/x/assets/addresses', { key: held.assets[0].key, amount: '5' })).address.encoded;
	const good = await addressFrom(backend, 'demo-witness', '10000');
	const r = await pasted(backend, 'demo-main', testnet);
	try {
		assert.ok(testnet.startsWith('taptb1'));
		assert.deepEqual(refusals(r), ['WRONG_NETWORK']);
		assert.match(r.test('asset-send-refusal').textContent, /for testnet, and this wallet is on mainnet/);

		await type(r.test('asset-send-input'), good.slice(0, -9));
		await settle(READ_MS);
		assert.deepEqual(refusals(r), ['TAP_CHECKSUM'], 'one cut short in the copy is caught by its checksum');
		assert.equal(r.test('asset-send-preview').getAttribute('data-state'), 'empty');
		assert.equal(backend.posted('/addresses/decode', 'demo-main').length, 0);

		// Capitals, as a QR code hands them over, are the same address.
		await type(r.test('asset-send-input'), good.toUpperCase());
		await settle(READ_MS);
		assert.deepEqual(refusals(r), []);
		assert.equal(r.test('asset-send-preview').getAttribute('data-state'), 'read');
		assert.equal(backend.posted('/addresses/decode', 'demo-main').at(-1).body.address, good, 'and the wallet is handed the lower case one');
	} finally {
		await r.unmount();
	}
});

test('half an address is not refused while it is still being put in', async () => {
	const backend = assetsBackend();
	const address = await addressFrom(backend, 'demo-witness', '10000');
	const r = await mountAssets(backend, 'demo-main');
	try {
		await r.view('Send');
		const box = r.test('asset-send-input');
		await focus(box);
		await type(box, address.slice(0, 90));
		await settle(READ_MS);
		assert.deepEqual(refusals(r), [], 'the caret is still in the box and the string is plainly unfinished');
		await blur(box);
		await settle(50);
		assert.deepEqual(refusals(r), ['TAP_CHECKSUM'], 'left like that, it is a mistake worth naming');
	} finally {
		await r.unmount();
	}
});

test('what is not a Taproot Assets address is named for what it is, and pointed at where it is paid', async () => {
	const backend = assetsBackend();
	// An engine that cannot carry asset channels, as every released one is:
	// an invoice is named and pointed elsewhere, and nothing offers to pay it.
	// (With asset channels it is paid here: lightning/PayInvoice.test.js.)
	const r = await mountAssets(backend, 'demo-main', { at: { view: 'send' }, config: { assetsAvailable: true, assetChannelsAvailable: false } });
	try {
		assert.equal(r.$('.field-label').textContent, 'Taproot Assets address', 'the box does not ask for invoices');
		assert.doesNotMatch(r.test('asset-send-hint').textContent, /Lightning/);
		await type(r.test('asset-send-input'), 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
		await settle(READ_MS);
		const bitcoin = r.test('asset-send-bitcoin');
		assert.match(bitcoin.textContent, /That is a bitcoin address\. Assets go to a Taproot Assets address, which starts with tapbc1/);
		assert.deepEqual(refusals(r), [], 'it is not an error, only the wrong tab');
		await click([...bitcoin.querySelectorAll('button')].find((b) => b.textContent === 'Open Send tab'));
		assert.equal(r.moves.at(-1)[0], 'send');

		await type(r.test('asset-send-input'), DONATION);
		await settle(READ_MS);
		assert.match(r.test('asset-send-invoice').textContent, /That is a Lightning invoice\. An asset pays one from an asset channel, and this wallet cannot open those\. To pay it in bitcoin, use the Send tab\./);
		assert.equal(r.test('asset-send-submit'), null);
		assert.equal(r.test('asset-pay'), null);
		assert.equal(backend.posted('/pay/quote').length, 0, 'and the wallet is asked for no price');
	} finally {
		await r.unmount();
	}

	const savings = await mountAssets(backend, 'demo-savings', { at: { view: 'send' } });
	try {
		await type(savings.test('asset-send-input'), DONATION);
		await settle(READ_MS);
		assert.deepEqual(refusals(savings), ['ONCHAIN_ONLY']);
		assert.match(savings.test('asset-send-refusal').textContent, /this wallet is on-chain only, so it cannot pay it/);
	} finally {
		await savings.unmount();
	}
});

test('an address the wallet cannot pay is refused in the wallet\'s own words', async () => {
	const backend = assetsBackend();
	const good = await addressFrom(backend, 'demo-witness', '10000');
	const real = backend.api('demo-main');
	const said = 'This is a version 2 address, which this wallet cannot pay yet. Ask for a version 1 address';
	const api = {
		...real,
		post: (path, body, options) =>
			path === '/x/assets/addresses/decode'
				? Promise.reject(Object.assign(new Error(said), { code: 'UNSUPPORTED_ADDRESS', status: 400 }))
				: real.post(path, body, options)
	};
	const r = await pasted(backend, 'demo-main', good, { api });
	try {
		assert.deepEqual(refusals(r), ['UNSUPPORTED_ADDRESS']);
		assert.equal(r.test('asset-send-refusal').textContent, `${said}.`);
	} finally {
		await r.unmount();
	}
});
