/**
 * Run with: npm test (from manager/ui).
 *
 * A payment that was meant to be a direct funding and is not looks like every
 * other send: same shape, same change output, same row. The reason exists in
 * the answer the payer's daemon gave and nowhere else, so the row is where it
 * has to be readable afterwards (umbrel #121).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { click, render, settle } from '../../../test/render.mjs';
import { ToastProvider } from '../../components/Toast.jsx';
import ActivityTab from './ActivityTab.jsx';

const FELL_BACK = 'a'.repeat(64);
const ORDINARY = 'b'.repeat(64);
const NODE = '02' + 'cd'.repeat(32);

const TXS = [
	{
		txid: FELL_BACK,
		type: 'sent',
		valueSats: -50_000,
		feeSats: 300,
		satsPerVbyte: 3,
		address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
		confirmed: false,
		height: null,
		timestamp: Date.now() - 60_000
	},
	{
		txid: ORDINARY,
		type: 'sent',
		valueSats: -20_000,
		feeSats: 200,
		satsPerVbyte: 2,
		address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
		confirmed: true,
		height: 908_000,
		timestamp: Date.now() - 3_600_000
	}
];

const FALLBACK = {
	timestamp: Date.now() - 59_000,
	reason: 'receiver declined the offer',
	address: TXS[0].address,
	amountSats: 50_000,
	nodeId: NODE,
	requestId: 'd'.repeat(32),
	txid: FELL_BACK
};

const realFetch = globalThis.fetch;
test.beforeEach(() => {
	// The fallbacks come from the manager, not the daemon: the daemon was asked
	// for an ordinary send and made one.
	globalThis.fetch = async (url) => ({
		ok: true,
		status: 200,
		json: async () => ({
			ok: true,
			result: String(url).endsWith('/direct-funding/fallbacks') ? [FALLBACK] : []
		})
	});
});
test.afterEach(() => {
	globalThis.fetch = realFetch;
});

const api = {
	get: async (path) => {
		if (path === '/transactions') return TXS;
		return [];
	},
	post: async () => ({})
};

async function mount() {
	const view = await render(ToastProvider, {
		children: createElement(ActivityTab, {
			id: 'w1',
			api,
			info: { blockHeight: 908_214 },
			rec: { network: 'mainnet' },
			tick: 0,
			bump: () => {}
		})
	});
	await settle(50);
	return view;
}

test('the row of a payment that was meant to be a direct funding says so', async () => {
	const view = await mount();
	try {
		const rows = view.$$('tbody tr');
		assert.match(rows[0].textContent, /direct funding not taken/);
		assert.doesNotMatch(rows[1].textContent, /direct funding not taken/, 'an ordinary send is left alone');
	} finally {
		await view.unmount();
	}
});

test('opening it gives the reason, and which request was being paid', async () => {
	const view = await mount();
	try {
		await click(view.$$('tbody tr')[0]);
		await settle(20);
		const text = view.text();
		assert.match(text, /meant to be a direct funding/);
		assert.match(text, /That did not happen \(receiver declined the offer\)/);
		assert.match(text, /recipient node 02cdcd…cdcdcd/);
		assert.match(text, /request dddddd…dddddd/);
	} finally {
		await view.unmount();
	}
});

test('a transaction with no fallback against it is shown as it always was', async () => {
	const view = await mount();
	try {
		await click(view.$$('tbody tr')[1]);
		await settle(20);
		assert.doesNotMatch(view.text(), /meant to be a direct funding/);
	} finally {
		await view.unmount();
	}
});
