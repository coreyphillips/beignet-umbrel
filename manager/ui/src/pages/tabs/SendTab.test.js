/**
 * Run with: npm test (from manager/ui).
 *
 * Both bugs found in review of the send form lived in this file, and the suite
 * was green throughout, because `node --test src/lib/*.test.js` cannot reach a
 * .jsx file. These two are the ones that broke, pinned where they broke:
 *
 *   1. the string handed to /send is the one the parser settled on, not the raw
 *      contents of the box
 *   2. what was read out of a pasted request survives the rewrite that reading
 *      it causes
 *
 * The daemon is a stub object, which is the whole of what the card needs: `api`
 * is already a prop, so nothing has to be intercepted to answer for it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { blur, click, focus, render, settle, type } from '../../../test/render.mjs';
import { ToastProvider } from '../../components/Toast.jsx';
import SendTab from './SendTab.jsx';

const ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const BALANCE = 4_000_000;
// Shape only: the card's parser checks that an offer looks like one, and the
// daemon is what actually reads it. An offer carries no checksum to satisfy.
const OFFER = `lno1${'qwerty0123456789'.repeat(6)}`;

/** A channel with enough outbound to make the Lightning rail available. */
const OPEN_CHANNEL = {
	channelId: 'c'.repeat(64),
	state: 'NORMAL',
	htlcUsable: true,
	localBalanceSats: 500_000
};

/** A daemon that records what it was asked, and answers plausibly. */
function stubApi({ channels = [], decodedOffer, offerDecodeError } = {}) {
	const calls = [];
	return {
		calls,
		get: async (path) => {
			calls.push(['GET', path]);
			if (path === '/channels') return channels;
			if (path === '/fees/estimates') return { fast: 18, normal: 7, slow: 2 };
			if (path === '/utxos') return [];
			return null;
		},
		post: async (path, body) => {
			calls.push(['POST', path, body]);
			if (path === '/tx/quote') {
				// Priced from what was asked: the fee follows the rate, and a max
				// quote answers with what a sweep at that rate would send.
				const rate = body.satsPerVbyte ?? 7;
				const quote = { satsPerVbyte: rate, feeSats: rate * 481, vsize: 481 };
				if (body.max) quote.maxSendSats = BALANCE - quote.feeSats;
				return quote;
			}
			if (path === '/send') return { txid: 'a'.repeat(64) };
			if (path === '/offer/decode') {
				if (offerDecodeError) {
					const e = new Error(offerDecodeError);
					e.code = 'INTERNAL_ERROR';
					throw e;
				}
				return decodedOffer ?? { offerId: 'f'.repeat(64), description: 'Donations' };
			}
			if (path === '/offer/pay') return { status: 'COMPLETED', feeSats: 3 };
			throw new Error(`unexpected POST ${path}`);
		}
	};
}

async function mountSend(api, { channelCount = 0 } = {}) {
	return render(ToastProvider, {
		children: createElement(SendTab, {
			id: 'w1',
			api,
			info: { onchainBalanceSats: BALANCE, channelCount },
			rec: { network: 'mainnet' },
			tick: 0,
			bump: () => {}
		})
	});
}

test('the address posted to /send is the one the parser settled on', async () => {
	const api = stubApi();
	const view = await mountSend(api);
	const box = view.$('input[placeholder^="bc1"]');

	// Copied out of a sentence, so the full stop came along. The old form told
	// the user the punctuation "was dropped" and then posted the string with it
	// still attached, which the daemon refused as an invalid address.
	await type(box, `${ADDR}.`);
	await settle(50);
	assert.equal(box.value, ADDR, 'the box holds the address the parser settled on');
	assert.match(view.text(), /Punctuation around it was dropped/);

	await type(view.$('.amount-input'), '50000');
	await settle(400);

	const send = view.$$('button').find((b) => b.textContent.trim() === 'Send');
	assert.ok(send && !send.disabled, 'Send is live');
	await click(send);
	await settle(50);

	const posted = api.calls.find(([method, path]) => method === 'POST' && path === '/send');
	assert.ok(posted, '/send was called');
	assert.equal(posted[2].address, ADDR, 'and it was given the clean address');
	assert.equal(posted[2].amountSats, 50000);
	await view.unmount();
});

test('capitals off a QR code reach the daemon in lower case', async () => {
	const api = stubApi();
	const view = await mountSend(api);
	const box = view.$('input[placeholder^="bc1"]');
	await type(box, ADDR.toUpperCase());
	await settle(50);
	assert.equal(box.value, ADDR);
	assert.match(view.text(), /converted back to lower case/);
	await view.unmount();
});

test("a pasted request's warnings survive the rewrite that reading it causes", async () => {
	const api = stubApi();
	const view = await mountSend(api);
	const box = view.$('input[placeholder^="bc1"]');

	// An unescaped & truncates the message, so what is on screen is not what the
	// payee wrote. Setting the box to the bare address re-ran the parse against a
	// string with nothing left to report, and cleared the warning before the
	// browser painted it.
	await type(box, `bitcoin:${ADDR}?amount=0.00025&message=Coffee&cake`);
	await settle(50);
	assert.equal(box.value, ADDR);
	assert.match(view.text(), /the message may be cut short/);
	assert.match(view.text(), /asks for 25,000 sats/);
	await view.unmount();
});

test('a request asking for zero says why the amount box is empty', async () => {
	const api = stubApi();
	const view = await mountSend(api);
	await type(view.$('input[placeholder^="bc1"]'), `bitcoin:${ADDR}?amount=0&message=Tip`);
	await settle(50);
	assert.match(view.text(), /amount of zero, which means the payer chooses/);
	assert.equal(view.$('.amount-input').value, '', 'and nothing was filled in');
	await view.unmount();
});

test('pressing Max asks the wallet for the sweep, and the amount follows the fee rate', async () => {
	// Max stored an updater function as the mode itself after the form state was
	// lifted out of the card: a function is truthy, so the form entered max mode,
	// but JSON.stringify drops function values, so the quote never asked for the
	// sweep, the amount's ceiling collapsed to zero, and the slider, the field
	// and the Max button all went dead with no way back out.
	const api = stubApi();
	const view = await mountSend(api);
	await type(view.$('input[placeholder^="bc1"]'), ADDR);
	await settle(400);

	const maxBtn = view.$$('button').find((b) => b.textContent.trim() === 'Max');
	await click(maxBtn);

	// The sweep's own figure takes a round trip. Until it lands, the last
	// ceiling holds, so the field must not collapse into a disabled slider
	// under a disabled Max button, which is a form nothing can act on.
	assert.ok(!maxBtn.disabled, 'Max stays pressable while the quote is in flight');
	assert.ok(
		!view.$('input[aria-label="Amount (sats) slider"]').disabled,
		'and the slider stays live'
	);

	await settle(400);
	const quoted = api.calls.filter(([m, p]) => m === 'POST' && p === '/tx/quote').at(-1);
	assert.equal(quoted[2].max, true, 'the daemon was asked for the sweep');
	assert.equal(
		view.$('.amount-input').value,
		String(BALANCE - 7 * 481),
		'and its answer is the amount on screen'
	);

	// Raising the fee re-asks the question, and the amount gives way to the
	// new fee so the total never exceeds the balance.
	await type(view.$('input[aria-label="Fee rate (sat/vB) slider"]'), '18');
	await settle(400);
	assert.equal(
		view.$('.amount-input').value,
		String(BALANCE - 18 * 481),
		'the amount follows the fee rate'
	);
	await view.unmount();
});

test('max mode releases: the button toggles off, and the slider comes back down', async () => {
	const api = stubApi();
	const view = await mountSend(api);
	await type(view.$('input[placeholder^="bc1"]'), ADDR);
	await settle(400);

	const maxBtn = view.$$('button').find((b) => b.textContent.trim() === 'Max');
	await click(maxBtn);
	await settle(400);
	assert.equal(maxBtn.getAttribute('aria-pressed'), 'true', 'max mode is on');

	// Coming back down the slider is leaving max mode, at the number reached.
	await type(view.$('input[aria-label="Amount (sats) slider"]'), '250000');
	await settle(50);
	assert.equal(maxBtn.getAttribute('aria-pressed'), 'false', 'the slider hands max mode back');
	assert.equal(view.$('.amount-input').value, '250000', 'at the amount it was dragged to');

	// And the button itself is the other way out.
	await click(maxBtn);
	await settle(400);
	assert.equal(maxBtn.getAttribute('aria-pressed'), 'true');
	await click(maxBtn);
	await settle(50);
	assert.equal(maxBtn.getAttribute('aria-pressed'), 'false', 'pressing Max again turns it off');
	await view.unmount();
});

test('an offer pasted into the on-chain box is paid from the Lightning card', async () => {
	const api = stubApi({
		channels: [OPEN_CHANNEL],
		decodedOffer: { offerId: 'f'.repeat(64), description: 'Donations', amountSats: 21000 }
	});
	const view = await mountSend(api, { channelCount: 1 });
	await settle(50);

	// Off a QR code, in capitals. It used to be answered with a note sending the
	// payer to the Offers tab; it is moved to the rail that pays it instead.
	await type(view.$('input[placeholder^="bc1"]'), OFFER.toUpperCase());
	await settle(600);

	const ln = view.$('textarea[placeholder^="lnbc"]');
	assert.ok(ln, 'the Lightning card is showing');
	assert.equal(ln.value, OFFER, 'and holds the offer, folded back to lower case');
	assert.match(view.text(), /moved here from the on-chain form/);
	assert.match(view.text(), /Donations/, 'the decoded offer is on screen');

	// An offer is not a destination, so there is no route to price yet.
	assert.ok(
		!api.calls.some(([, path]) => path === '/payment/estimate'),
		'no estimate is asked for'
	);

	const payBtn = view.$$('button').find((b) => /^Pay\s/.test(b.textContent.trim()));
	assert.ok(payBtn && !payBtn.disabled, 'Pay is live');
	await click(payBtn);
	await settle(50);

	const posted = api.calls.find(([method, path]) => method === 'POST' && path === '/offer/pay');
	assert.ok(posted, '/offer/pay was called');
	assert.equal(posted[2].offer, OFFER, 'with the offer the parser settled on');
	await view.unmount();
});

test('an offer naming no amount asks for one, and it reaches the daemon', async () => {
	const api = stubApi({
		channels: [OPEN_CHANNEL],
		decodedOffer: { offerId: 'f'.repeat(64), description: 'Tips' }
	});
	const view = await mountSend(api, { channelCount: 1 });
	await settle(50);
	await type(view.$('input[placeholder^="bc1"]'), OFFER);
	await settle(600);

	assert.match(view.text(), /offer names no amount, so it is yours to choose/);
	await type(view.$('.amount-input'), '4200');
	await settle(100);

	const payBtn = view.$$('button').find((b) => b.textContent.trim() === 'Pay');
	assert.ok(payBtn && !payBtn.disabled, 'Pay is live once an amount is chosen');
	await click(payBtn);
	await settle(50);

	const posted = api.calls.find(([method, path]) => method === 'POST' && path === '/offer/pay');
	assert.ok(posted, '/offer/pay was called');
	assert.equal(posted[2].amountSats, 4200, 'with the amount the payer chose');
	await view.unmount();
});

test('a generic daemon fault is not rewritten into a complaint about the paste', async () => {
	// From beignet 0.8.1 a bad offer comes back as a typed 400 carrying the
	// parser's reason, so a bare "Internal server error" means what it says: a
	// real fault. Translating it into "check your offer" would send the payer to
	// inspect a string that was fine.
	const api = stubApi({
		channels: [OPEN_CHANNEL],
		offerDecodeError: 'Internal server error'
	});
	const view = await mountSend(api, { channelCount: 1 });
	await settle(50);
	await type(view.$('input[placeholder^="bc1"]'), OFFER);
	await settle(600);

	assert.match(view.text(), /internal server error/i, 'shown as the daemon gave it');
	assert.doesNotMatch(view.text(), /copied in full/i, 'and not blamed on the paste');
	await view.unmount();
});

test('a typed message from the daemon is passed through untouched', async () => {
	const api = stubApi({
		channels: [OPEN_CHANNEL],
		offerDecodeError: "BOLT 12 string has invalid character 'b'"
	});
	const view = await mountSend(api, { channelCount: 1 });
	await settle(50);
	await type(view.$('input[placeholder^="bc1"]'), OFFER);
	await settle(600);

	assert.match(view.text(), /invalid character/i, 'the daemon says it better than we could');
	await view.unmount();
});

test('a refusal is held while the field is still being typed into', async () => {
	const api = stubApi();
	const view = await mountSend(api);
	const box = view.$('input[placeholder^="bc1"]');
	await focus(box);
	// Half an address, with the caret still in it.
	await type(box, ADDR.slice(0, 20));
	await settle(400);
	assert.doesNotMatch(view.text(), /checksum|not a valid address/i, 'nothing red while typing');

	// Finished, and wrong: the last character was mistyped. Long enough is the
	// point, not perfect: the rule is that a refusal waits for a string that
	// could plausibly be complete.
	await type(box, `${ADDR.slice(0, -1)}5`);
	await settle(400);
	assert.match(view.text(), /checksum/, 'a complete string that cannot be read is refused');

	// And leaving the field says it at once, however short the string.
	await type(box, 'bc1qzz');
	await settle(50);
	assert.doesNotMatch(view.text(), /not a valid address|checksum/i);
	await blur(box);
	await settle(50);
	assert.match(view.text(), /address|payment/i, 'a finished string gets an answer');
	await view.unmount();
});

/* ---------------------------------------------------------- direct funding */

import { buildBip21 } from '../../lib/payment-uri.js';
import { encodeFundingEnvelope } from '../../lib/funding-envelope.js';

const REQUEST = encodeFundingEnvelope({ nodeId: '02' + 'ab'.repeat(32), expiresAt: Date.now() + 3_600_000, amountSats: 25_000 });

/** The plain stub plus the direct-funding route, answering as told. */
function stubFundingApi(sendAnswer) {
	const api = stubApi();
	const post = api.post;
	api.post = async (path, body) => {
		if (path === '/direct-funding/send') {
			api.calls.push(['POST', path, body]);
			if (sendAnswer instanceof Error) throw sendAnswer;
			return sendAnswer;
		}
		return post(path, body);
	};
	return api;
}

const sendButton = (view) => view.$$('button').find((b) => /^(Send|Send max|Pay as direct funding)$/.test(b.textContent.trim()));

test('a request carrying a direct-funding request offers to pay it that way, and posts the envelope', async () => {
	const api = stubFundingApi({ status: 'MEMPOOL_SEEN', fundingTxid: 'f'.repeat(64), attested: true, receiptPreimageHex: 'b'.repeat(64) });
	const view = await mountSend(api);
	const box = view.$('input[placeholder^="bc1"]');
	await type(box, buildBip21({ address: ADDR, funding: REQUEST }));
	await settle(400);
	assert.equal(box.value, ADDR);
	assert.match(view.text(), /asks for 25,000 sats/, 'the request\'s own amount fills in');
	assert.match(view.text(), /This request comes from a beignet wallet/);
	assert.equal(sendButton(view).textContent.trim(), 'Pay as direct funding');
	await click(sendButton(view));
	await settle(50);
	const sent = api.calls.find(([m, p]) => m === 'POST' && p === '/direct-funding/send');
	assert.deepEqual(sent[2], { request: REQUEST, amountSats: 25_000, feeHeadroomSats: 1000 });
	assert.equal(api.calls.some(([m, p]) => m === 'POST' && p === '/send'), false);
	assert.match(view.text(), /signed a receipt/);
	assert.match(view.text(), /Receipt: b{64}/);
	await view.unmount();
});

test('declining direct funding pays the address plainly, and Max turns it off', async () => {
	const api = stubFundingApi({ status: 'MEMPOOL_SEEN' });
	const view = await mountSend(api);
	await type(view.$('input[placeholder^="bc1"]'), buildBip21({ address: ADDR, funding: REQUEST }));
	await settle(400);
	await click(view.$('input[type="checkbox"]'));
	assert.equal(sendButton(view).textContent.trim(), 'Send');
	await click(sendButton(view));
	await settle(50);
	assert.ok(api.calls.some(([m, p]) => m === 'POST' && p === '/send'));
	assert.equal(api.calls.some(([m, p]) => m === 'POST' && p === '/direct-funding/send'), false);
	await view.unmount();
});

test('a rejected direct funding falls back to the plain send; a signed one never does', async () => {
	const rejected = stubFundingApi(new Error('request expired'));
	let view = await mountSend(rejected);
	await type(view.$('input[placeholder^="bc1"]'), buildBip21({ address: ADDR, funding: REQUEST }));
	await settle(400);
	await click(sendButton(view));
	await settle(50);
	assert.ok(rejected.calls.some(([m, p]) => m === 'POST' && p === '/send'), 'the plain payment followed the rejection');
	assert.match(view.text(), /Direct funding not taken \(request expired\)/);
	await view.unmount();

	const signed = stubFundingApi({ status: 'SIGNED_PENDING', spentTxid: 'a'.repeat(64) });
	view = await mountSend(signed);
	await type(view.$('input[placeholder^="bc1"]'), buildBip21({ address: ADDR, funding: REQUEST }));
	await settle(400);
	await click(sendButton(view));
	await settle(50);
	assert.equal(signed.calls.some(([m, p]) => m === 'POST' && p === '/send'), false, 'the witness is out: a plain send would pay twice');
	assert.match(view.text(), /signed and on its way/);
	await view.unmount();
});

test('a lightning-first wallet opens on Lightning and pays addresses from its channel', async () => {
	const api = stubApi({ channels: [{ ...OPEN_CHANNEL, peerPubkey: '03' + '22'.repeat(32) }] });
	const view = await render(ToastProvider, {
		children: createElement(SendTab, {
			id: 'w1',
			api,
			info: { onchainBalanceSats: 0, channelCount: 1 },
			rec: { id: 'w1', network: 'mainnet', lfbw: { enabled: true, primaryPubkey: '03' + '22'.repeat(32), setup: 'ready' } },
			tick: 0,
			bump: () => {}
		})
	});
	await settle(50);
	const pills = view.$$('.pill').map((b) => b.textContent.trim());
	assert.ok(pills.includes('Bitcoin address'), pills.join(','));
	assert.equal(pills.includes('Keysend'), false, 'keysend belongs to the Advanced view');
	assert.ok(view.$$('.pill').find((b) => b.textContent.trim() === 'Lightning').className.includes('active'), 'opens on Lightning');
	await view.unmount();
});

// A BOLT11 spec vector (no amount in the hrp; the daemon's decode names it).
const SPEC_INVOICE =
	'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql';
const LFBW_PK = '03' + '22'.repeat(32);

/** A lightning-first wallet's daemon: a home channel, and funds on the way. */
function stubLfbwApi({ amountSats, utxos = [], balance, liquidity } = {}) {
	const calls = [];
	const home = { ...OPEN_CHANNEL, peerPubkey: LFBW_PK, localBalanceSats: 100_000, remoteBalanceSats: 400_000 };
	return {
		calls,
		get: async (path) => {
			calls.push(['GET', path]);
			if (path === '/channels') return [home];
			if (path === '/balance') return balance ?? { onchain: 100_000, lightning: 100_000, total: 200_000, splicingSats: 0 };
			if (path === '/liquidity') return liquidity ?? { sendableSats: 100_000, totalLocalBalanceSats: 100_000 };
			if (path === '/utxos') return utxos;
			if (path === '/fees/estimates') return { fast: 18, normal: 7, slow: 2 };
			return null;
		},
		post: async (path, body) => {
			calls.push(['POST', path, body]);
			if (path === '/invoice/decode') {
				return { amountSats, payeeNodeKey: '02' + 'ab'.repeat(32), description: 'Rent', timestamp: Math.floor(Date.now() / 1000), expiry: 3600, warnings: [] };
			}
			if (path === '/invoice/estimate-fee') return { estimatedFeeSats: 3, successProbabilityPct: 90, hopCount: 2 };
			if (path === '/invoice/pay-safe') return { status: 'COMPLETED', feeSats: 3 };
			return null;
		}
	};
}

async function mountLfbwSend(api) {
	const view = await render(ToastProvider, {
		children: createElement(SendTab, {
			id: 'w1',
			api,
			info: { onchainBalanceSats: 100_000, channelCount: 1 },
			rec: { id: 'w1', network: 'mainnet', lfbw: { enabled: true, primaryPubkey: LFBW_PK, setup: 'ready' } },
			tick: 0,
			bump: () => {}
		})
	});
	await settle(50);
	return view;
}

test('a lightning-first wallet says what is arriving when an invoice exceeds Can send but not Total, and keeps it', async () => {
	const api = stubLfbwApi({ amountSats: 150_000, utxos: [{ txid: 'a'.repeat(64), vout: 0, valueSats: 100_000, height: 908_000 }] });
	const view = await mountLfbwSend(api);
	try {
		const box = view.$('textarea[placeholder^="lnbc"]');
		await type(box, SPEC_INVOICE);
		await settle(600);
		const note = view.$('[data-testid="arriving-funds"]');
		assert.ok(note, 'the arriving note is on screen');
		assert.match(note.textContent, /50,000 sats more than you can send right now/);
		assert.match(note.textContent, /100,000 sats are moving into your channel, about one block from now/);
		assert.equal(view.$('textarea[placeholder^="lnbc"]').value, SPEC_INVOICE, 'the invoice stays in the box');
		const pay = view.$$('button').find((b) => /^Pay/.test(b.textContent.trim()));
		assert.equal(pay.disabled, true, 'nothing is attempted against funds that are not there yet');
		assert.equal(view.$('[data-testid="over-total"]'), null);
	} finally {
		await view.unmount();
	}
});

test('a lightning-first wallet refuses an invoice above Total outright', async () => {
	const api = stubLfbwApi({ amountSats: 250_000 });
	const view = await mountLfbwSend(api);
	try {
		await type(view.$('textarea[placeholder^="lnbc"]'), SPEC_INVOICE);
		await settle(600);
		assert.equal(view.$('[data-testid="arriving-funds"]'), null);
		const over = view.$('[data-testid="over-total"]');
		assert.ok(over);
		assert.match(over.textContent, /more than this wallet holds in total/);
		assert.equal(view.$$('button').find((b) => /^Pay/.test(b.textContent.trim())).disabled, true);
	} finally {
		await view.unmount();
	}
});

test('a lightning-first wallet pays an invoice within Can send without a note', async () => {
	const api = stubLfbwApi({ amountSats: 50_000 });
	const view = await mountLfbwSend(api);
	try {
		await type(view.$('textarea[placeholder^="lnbc"]'), SPEC_INVOICE);
		await settle(600);
		assert.equal(view.$('[data-testid="arriving-funds"]'), null);
		assert.equal(view.$('[data-testid="over-total"]'), null);
		assert.equal(view.$$('button').find((b) => /^Pay/.test(b.textContent.trim())).disabled, false);
	} finally {
		await view.unmount();
	}
});
