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
		post: async (path, body) => {
			calls.push([path, body]);
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

const mountTools = (api) =>
	render(ToastProvider, { children: createElement(ToolsTab, { api }) });

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
