/**
 * Run with: npm test (from manager/ui).
 *
 * The Receive tab's offline-receive card against a stubbed daemon: an ACTIVE
 * epoch lists its vouchers with their states, creating an invoice for a slot
 * posts the slot and shows the code, and a wallet with no opted-in sibling
 * is told where to turn the role on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { click, render, settle } from '../../test/render.mjs';
import { ToastProvider } from './Toast.jsx';
import OfflineReceiveCard from './OfflineReceiveCard.jsx';

const CH = 'ab'.repeat(32);
const PEER = '02' + 'cd'.repeat(32);
const BOLT11 = `lnbc500u1${'q'.repeat(80)}`;

function stubManager(candidates) {
	globalThis.fetch = async (url) => ({
		ok: true,
		status: 200,
		json: async () => ({ ok: true, result: /ffor\/candidates$/.test(url) ? candidates : null })
	});
}

function stubApi({ epochs }) {
	const calls = [];
	return {
		calls,
		get: async (path) => {
			calls.push(['GET', path]);
			if (path === '/ffor/epochs') return epochs;
			if (path === '/channels') return [{ channelId: CH, peerPubkey: PEER, state: 'NORMAL', remoteBalanceSats: 400000 }];
			throw new Error(`unexpected GET ${path}`);
		},
		post: async (path, body) => {
			calls.push(['POST', path, body]);
			if (path === '/ffor/invoice') return { bolt11: BOLT11, paymentHash: 'ef'.repeat(32), k: body.k, amountMsat: '50000000' };
			throw new Error(`unexpected POST ${path}`);
		}
	};
}

const active = {
	channelId: CH,
	role: 'R',
	state: 'ACTIVE',
	epochId: 'e1',
	settlementDeadline: 1100,
	slots: [
		{ k: 1, amountMsat: '50000000', state: 'settled' },
		{ k: 2, amountMsat: '50000000', state: 'unissued' }
	]
};

async function mount(api) {
	const view = await render(ToastProvider, {
		children: createElement(OfflineReceiveCard, { id: 'w1', api, rec: { id: 'w1' }, tick: 0, info: { blockHeight: 1000 } })
	});
	await settle(400);
	return view;
}

test('an active epoch lists the vouchers, and creating an invoice for a slot shows its code', async () => {
	stubManager([{ id: 's1', name: 'Main', nodeId: PEER, running: true }]);
	const api = stubApi({ epochs: [active] });
	const view = await mount(api);
	try {
		sessionStorage.clear();
		assert.match(view.text(), /receiving offline/);
		assert.match(view.text(), /1 of 2 vouchers paid so far/);
		assert.match(view.text(), /Paid while away/);
		assert.match(view.text(), /Waiting for an invoice/);
		await click(view.$('[data-testid="ffor-mint-2"]'));
		await settle(300);
		const minted = api.calls.find(([m, p]) => m === 'POST' && p === '/ffor/invoice');
		assert.equal(minted[2].channelId, CH);
		assert.equal(minted[2].k, 2);
		assert.ok(view.$('.qr'), 'the invoice is shown as a code');
		assert.match(view.text(), /Payable while this wallet is off/);
	} finally {
		await view.unmount();
	}
});

test('with no epoch and no opted-in sibling, the card says where to turn the role on', async () => {
	stubManager([]);
	const api = stubApi({ epochs: [] });
	const view = await mount(api);
	try {
		assert.ok(view.$('[data-testid="ffor-no-peer"]'));
		assert.match(view.text(), /turn on "Settle offline receives"/);
	} finally {
		await view.unmount();
	}
});

test('with an opted-in sibling on an open channel, the form plans the book and starts it', async () => {
	stubManager([{ id: 's1', name: 'Main', nodeId: PEER, running: true }]);
	const api = stubApi({ epochs: [] });
	api.post = async (path, body) => {
		api.calls.push(['POST', path, body]);
		return {};
	};
	const view = await mount(api);
	try {
		const { type } = await import('../../test/render.mjs');
		await type(view.$('[data-testid="ffor-amount"]'), '50000');
		await settle(100);
		assert.match(view.text(), /250,000 sats in 5 vouchers/);
		assert.match(view.text(), /Return by block 2008/);
		await click(view.$$('button').find((b) => /Start receiving offline/.test(b.textContent)));
		await settle(200);
		const started = api.calls.find(([m, p]) => m === 'POST' && p === '/ffor/epoch/start');
		assert.equal(started[2].channelId, CH);
		assert.deepEqual(started[2].voucherAmountsMsat, Array(5).fill('50000000'));
		assert.equal(started[2].settlementDeadline, 2008);
		assert.deepEqual(started[2].witnessPeers, []);
	} finally {
		await view.unmount();
	}
});
