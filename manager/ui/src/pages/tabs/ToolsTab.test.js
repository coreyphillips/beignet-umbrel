/**
 * Run with: npm test (from manager/ui).
 *
 * The Tools tab signs with the node key and verifies signatures. The part
 * worth pinning is not the round trip, it is the honesty of the verdicts: a
 * verification names WHOSE key signed and tells the reader to compare it
 * against who they expected, and no verdict survives an edit to the text it
 * judged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { click, render, settle, type } from '../../../test/render.mjs';
import { ToastProvider } from '../../components/Toast.jsx';
import ToolsTab from './ToolsTab.jsx';

const PUBKEY = '02' + 'a'.repeat(64);
const SIGNATURE = 'd'.repeat(104);

function stubApi({ valid = true, knownNode = true } = {}) {
	const calls = [];
	return {
		calls,
		get: async (path) => (path === '/channels' ? [{ channelId: 'c'.repeat(64), state: 'NORMAL', htlcUsable: true, localBalanceSats: 300_000 }] : null),
		post: async (path, body) => {
			calls.push([path, body]);
			if (path === '/invoice/pay-safe') return { status: 'COMPLETED', feeSats: 0, paymentHash: 'b'.repeat(64), preimage: 'f'.repeat(64) };
			if (path === '/message/sign') return { signature: SIGNATURE, pubkey: PUBKEY };
			if (path === '/message/verify') {
				return valid
					? { valid: true, pubkey: PUBKEY, knownNode }
					: { valid: false, pubkey: null, knownNode: false };
			}
			throw new Error(`unexpected POST ${path}`);
		}
	};
}

const mountTools = (api, props = {}) =>
	render(ToastProvider, { children: createElement(ToolsTab, { id: 'w1', api, rec: { network: 'mainnet' }, ...props }) });

test('signing shows the signature and whose key made it', async () => {
	const api = stubApi();
	const view = await mountTools(api);

	const signBtn = view.$$('button').find((b) => b.textContent.trim() === 'Sign with node key');
	assert.ok(signBtn.disabled, 'nothing to sign yet');

	await type(view.$('textarea[placeholder="The text to sign"]'), 'I control this node');
	await click(signBtn);
	await settle(50);

	assert.deepEqual(api.calls[0], ['/message/sign', { message: 'I control this node' }]);
	assert.match(view.text(), new RegExp(SIGNATURE.slice(0, 20)), 'the signature is on screen');
	assert.match(view.text(), /this node's identity key/);

	// Edit the message: the signature no longer signs what the box holds.
	await type(view.$('textarea[placeholder="The text to sign"]'), 'I control this node!');
	await settle(10);
	assert.doesNotMatch(
		view.text(),
		new RegExp(SIGNATURE.slice(0, 20)),
		'a signature never stands over words it does not sign'
	);
	await view.unmount();
});

test('a valid verification names the signer and says to check it', async () => {
	const api = stubApi({ valid: true, knownNode: false });
	const view = await mountTools(api);

	await type(view.$('textarea[placeholder="The text that was signed"]'), 'hello');
	await type(view.$('input[placeholder^="d7yxk3"]'), ` ${SIGNATURE} `);
	await click(view.$$('button').find((b) => b.textContent.trim() === 'Verify'));
	await settle(50);

	const posted = api.calls.find(([p]) => p === '/message/verify');
	assert.equal(posted[1].signature, SIGNATURE, 'pasted whitespace is trimmed');
	assert.match(view.text(), /valid/);
	assert.match(view.text(), /Check that this is the node you expected/);
	assert.match(view.text(), /not announced in the network graph/);

	// The verdict is about one exact message; an edit retires it.
	await type(view.$('textarea[placeholder="The text that was signed"]'), 'hello.');
	await settle(10);
	assert.doesNotMatch(view.text(), /Check that this is the node you expected/);
	await view.unmount();
});

test('an invalid signature is refused with both possible reasons', async () => {
	const api = stubApi({ valid: false });
	const view = await mountTools(api);

	await type(view.$('textarea[placeholder="The text that was signed"]'), 'hello');
	await type(view.$('input[placeholder^="d7yxk3"]'), 'garbage');
	await click(view.$$('button').find((b) => b.textContent.trim() === 'Verify'));
	await settle(50);

	assert.match(view.text(), /Not a valid signature over this message/);
	assert.match(view.text(), /message is not exactly the text that was signed/);
	await view.unmount();
});

/** The manager's LNURL routes, answering as lnurl.js does. */
function stubLnurlManager(link) {
	const calls = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init = {}) => {
		const body = init.body ? JSON.parse(init.body) : null;
		calls.push({ url: String(url), body });
		const answer = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
		if (String(url).endsWith('/lnurl/resolve')) return answer(link);
		if (String(url).endsWith('/lnurl/pay')) {
			return answer({ bolt11: 'lnbc1fetched', paymentHash: 'b'.repeat(64), successAction: { tag: 'aes', description: 'Your voucher code' } });
		}
		if (String(url).endsWith('/lnurl/success')) return answer({ tag: 'aes', description: 'Your voucher code', message: 'CODE-1234' });
		return answer(null);
	};
	return { calls, restore: () => (globalThis.fetch = realFetch) };
}

test('the LNURL card pays a fixed-amount link and opens its sealed message', async () => {
	const mgr = stubLnurlManager({
		session: 's1',
		tag: 'pay',
		domain: 'shop.example',
		lightningAddress: null,
		description: 'One voucher',
		minSats: 2100,
		maxSats: 2100,
		commentAllowed: 0
	});
	const api = stubApi();
	const view = await mountTools(api);
	try {
		await type(view.$('textarea[placeholder^="lnurl1"]'), 'lnurlp://shop.example/pay');
		await settle(600);
		assert.match(view.text(), /shop\.example/);
		assert.match(view.text(), /One voucher/);
		assert.equal(view.$$('.amount-input').length, 0, 'a fixed amount is not asked for');

		await click(view.$$('button').find((b) => b.textContent.trim() === 'Pay 2,100 sats'));
		await settle(100);
		assert.deepEqual(mgr.calls.find((c) => c.url.endsWith('/lnurl/pay')).body, { session: 's1', amountSats: 2100, comment: '' });
		assert.deepEqual(api.calls.find(([p]) => p === '/invoice/pay-safe')[1], { bolt11: 'lnbc1fetched' });
		assert.match(view.text(), /Payment COMPLETED/);

		// Sealed with the preimage (LUD-10): opened by the manager, on request.
		assert.doesNotMatch(view.text(), /CODE-1234/);
		await click(view.$$('button').find((b) => b.textContent.trim() === 'Show it'));
		await settle(50);
		assert.deepEqual(mgr.calls.find((c) => c.url.endsWith('/lnurl/success')).body, { session: 's1', preimage: 'f'.repeat(64) });
		assert.match(view.text(), /CODE-1234/);
	} finally {
		await view.unmount();
		mgr.restore();
	}
});

test('the LNURL card turns away what is not an LNURL, and an on-chain wallet cannot pay one', async () => {
	const mgr = stubLnurlManager({ session: 's2', tag: 'pay', domain: 'getalby.com', lightningAddress: 'corey@getalby.com', description: 'x', minSats: 1, maxSats: 10, commentAllowed: 0 });
	const view = await mountTools(stubApi(), { rec: { network: 'mainnet', onchainOnly: true } });
	try {
		await type(view.$('textarea[placeholder^="lnurl1"]'), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
		await settle(600);
		assert.match(view.text(), /not an LNURL or a Lightning address/);
		assert.ok(!mgr.calls.some((c) => c.url.endsWith('/lnurl/resolve')), 'nothing is fetched for it');

		await type(view.$('textarea[placeholder^="lnurl1"]'), 'corey@getalby.com');
		await settle(600);
		assert.match(view.text(), /on-chain only, so it cannot pay over Lightning/);
		assert.ok(!view.$$('button').some((b) => /^Pay/.test(b.textContent.trim())));
	} finally {
		await view.unmount();
		mgr.restore();
	}
});
