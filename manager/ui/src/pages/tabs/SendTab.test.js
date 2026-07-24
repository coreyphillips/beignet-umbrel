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

/** A daemon that records what it was asked, and answers plausibly. */
function stubApi() {
	const calls = [];
	return {
		calls,
		get: async (path) => {
			calls.push(['GET', path]);
			if (path === '/channels') return [];
			if (path === '/fees/estimates') return { fast: 18, normal: 7, slow: 2 };
			if (path === '/utxos') return [];
			return null;
		},
		post: async (path, body) => {
			calls.push(['POST', path, body]);
			if (path === '/tx/quote') return { satsPerVbyte: 7, feeSats: 3367, vsize: 481 };
			if (path === '/send') return { txid: 'a'.repeat(64) };
			throw new Error(`unexpected POST ${path}`);
		}
	};
}

async function mountSend(api) {
	return render(ToastProvider, {
		children: createElement(SendTab, {
			id: 'w1',
			api,
			info: { onchainBalanceSats: BALANCE, channelCount: 0 },
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
