/**
 * Run with: npm test (from manager/ui).
 *
 * On-chain only mode, as the tabs see it: rec.onchainOnly puts the Lightning
 * apparatus away rather than disabling it in place. These pin the three tabs
 * whose shape the flag changes, and the honesty of the Send tab's refusal: a
 * wallet that has sworn off Lightning must not promise an invoice will "move
 * across once a channel is usable".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { render, settle, type } from '../../../test/render.mjs';
import { ToastProvider } from '../../components/Toast.jsx';
import SendTab from './SendTab.jsx';
import ReceiveTab from './ReceiveTab.jsx';
import ActivityTab from './ActivityTab.jsx';

const REC = { network: 'mainnet', onchainOnly: true };
// An offer, not an invoice: BOLT11 carries a checksum the parser enforces
// before the rail hand-off ever runs, and a fabricated invoice dies there.
// An offer is shape-checked only, so it reaches the refusal under test.
const OFFER = `lno1${'qwerty0123456789'.repeat(6)}`;

function stubApi() {
	return {
		get: async (path) => {
			if (path === '/channels') return [];
			if (path === '/fees/estimates') return { fast: 18, normal: 7, slow: 2 };
			if (path === '/utxos') return [];
			if (path === '/transactions') return [];
			if (path === '/payments') return [];
			return null;
		},
		post: async (path) => {
			if (path === '/address/new') return { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' };
			if (path === '/tx/quote') return { satsPerVbyte: 7, feeSats: 3367, vsize: 481 };
			throw new Error(`unexpected POST ${path}`);
		}
	};
}

const mount = (Tab, extra = {}) =>
	render(ToastProvider, {
		children: createElement(Tab, {
			id: 'w1',
			api: stubApi(),
			info: { onchainBalanceSats: 1_000_000, channelCount: 0 },
			rec: REC,
			tick: 0,
			bump: () => {},
			...extra
		})
	});

test('the Send tab is the on-chain card alone, and refuses invoices honestly', async () => {
	const view = await mount(SendTab);
	await settle(50);

	assert.doesNotMatch(view.text(), /Lightning|Keysend/, 'no rail pills, no lightning card');
	assert.ok(view.$('input[placeholder^="bc1"]'), 'the on-chain card is the tab');

	// A pasted offer is refused for the true reason: the wallet is on-chain
	// only, not "waiting for a channel" it will never have.
	await type(view.$('input[placeholder^="bc1"]'), OFFER);
	await settle(50);
	assert.match(view.text(), /on-chain only, so it cannot pay it/);
	assert.match(view.text(), /Edit dialog/, 'and says where Lightning switches on');
	assert.doesNotMatch(view.text(), /once a channel is usable/);
	await view.unmount();
});

test('the Receive tab offers no invoice card and no invoice list', async () => {
	const view = await mount(ReceiveTab);
	await settle(50);

	assert.doesNotMatch(view.text(), /Lightning invoice|Recent invoices|Create invoice/);
	assert.ok(view.$('.qr'), 'the address QR is the whole tab');
	await view.unmount();
});

test('the Activity tab has no Lightning view to switch to', async () => {
	const view = await mount(ActivityTab);
	await settle(50);

	const pills = view.$$('.pill').map((p) => p.textContent.trim());
	assert.deepEqual(pills, ['On-chain', 'Coins'], 'two views, neither Lightning');
	await view.unmount();
});
