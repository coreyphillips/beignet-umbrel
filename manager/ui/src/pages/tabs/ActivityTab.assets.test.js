/**
 * Run with: npm test (from manager/ui).
 *
 * Taproot Assets in the on-chain history. A transaction that carries an asset
 * is an ordinary taproot spend to the wallet's own list, so nothing there
 * says what it was for, and Bump fee was offered for it like any other. A
 * replacement has a new id, and the asset's proof is waiting on the old one:
 * the row is named for what it did, leads to its asset, and has no Bump fee.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { click, render, settle } from '../../../test/render.mjs';
import { ToastProvider } from '../../components/Toast.jsx';
import ActivityTab from './ActivityTab.jsx';

const SEND = 'a'.repeat(64);
const MINT = 'b'.repeat(64);
const PLAIN = 'c'.repeat(64);
const RECEIVE = 'd'.repeat(64);
const BURN = 'e'.repeat(64);

const tx = (txid, extra = {}) => ({
	txid,
	type: 'sent',
	valueSats: -1_400,
	feeSats: 400,
	satsPerVbyte: 2,
	address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
	confirmed: false,
	height: null,
	timestamp: Date.now() - 60_000,
	...extra
});

const TXS = [
	tx(SEND),
	tx(PLAIN, { valueSats: -20_000 }),
	tx(MINT, { confirmed: true, height: 908_000 }),
	tx(RECEIVE, { type: 'received', valueSats: 1_000, feeSats: null, satsPerVbyte: null }),
	tx(BURN, { confirmed: true, height: 907_990 })
];

const busd = { key: 'key-busd', assetId: '1'.repeat(64), name: 'BUSD', type: 'normal', decimalDisplay: 2 };
const ROWS = [
	{ id: 'r1', kind: 'send', state: 'broadcast', failed: false, txid: SEND, assets: [{ ...busd, amount: '30000' }] },
	{ id: 'r2', kind: 'mint', state: 'complete', failed: false, txid: MINT, assets: [{ ...busd, amount: '100000000' }] },
	{ id: 'r3', kind: 'receive', state: 'confirming', failed: false, txid: RECEIVE, assets: [{ ...busd, amount: '500' }] },
	{ id: 'r4', kind: 'burn', state: 'complete', failed: false, txid: BURN, assets: [{ ...busd, amount: '50000' }] },
	{ id: 'r5', kind: 'ln-send', state: 'complete', failed: false, txid: null, assets: [{ ...busd, amount: '100' }] }
];

const realFetch = globalThis.fetch;
test.beforeEach(() => {
	// The manager's part of the page: no direct-funding fallbacks here.
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: [] }) });
});
test.afterEach(() => {
	globalThis.fetch = realFetch;
});

/** A wallet's daemon: every pending transaction is one it would bump. */
function daemon({ rows = ROWS } = {}) {
	const asked = [];
	return {
		asked,
		get: async (path) => {
			asked.push(path);
			if (path === '/transactions') return TXS;
			if (path === '/transactions/boostable') {
				const pending = TXS.filter((t) => !t.confirmed);
				return { rbf: pending.filter((t) => t.type === 'sent'), cpfp: pending.filter((t) => t.type === 'received') };
			}
			if (path.startsWith('/x/assets/activity')) {
				if (rows instanceof Error) throw rows;
				return { rows, nextBefore: null };
			}
			return [];
		},
		post: async () => ({})
	};
}

async function mount({
	api = daemon(),
	config = { assetsAvailable: true },
	rec = { network: 'mainnet', assets: { enabled: true, holdsAssets: true } },
	assets = { status: { holdsAssets: true, lockedSats: 1000, pending: { sends: 1 } }, error: null, loading: false },
	go
} = {}) {
	const view = await render(ToastProvider, {
		children: createElement(ActivityTab, { id: 'w1', api, info: { blockHeight: 908_214 }, rec, tick: 0, bump: () => {}, config, assets, go })
	});
	await settle(50);
	return view;
}

const rowOf = (view, txid) => view.$$('tbody tr').find((tr) => tr.querySelector(`td[title="${txid}"]`));
const bumpIn = (tr) => [...tr.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Bump fee') || null;

test('a transaction that carries an asset is named for what it did', async () => {
	const view = await mount();
	try {
		assert.match(rowOf(view, SEND).textContent, /Asset send/);
		assert.match(rowOf(view, MINT).textContent, /Asset mint/);
		assert.match(rowOf(view, RECEIVE).textContent, /Asset receive/);
		assert.match(rowOf(view, BURN).textContent, /Asset burn/);
		assert.doesNotMatch(rowOf(view, PLAIN).textContent, /Asset/, 'an ordinary payment is left alone');
		assert.equal(view.$$('.badge.asset').length, 4);
	} finally {
		await view.unmount();
	}
});

test('a pending asset transaction has no Bump fee, and one line says why', async () => {
	const view = await mount();
	try {
		for (const txid of [SEND, RECEIVE]) {
			const tr = rowOf(view, txid);
			assert.equal(bumpIn(tr), null, 'no fee bump for an asset transaction');
			assert.equal(
				tr.querySelector('[data-testid="tx-no-bump"]').textContent,
				'Asset transactions cannot be fee bumped yet.'
			);
		}
		// An ordinary pending payment keeps its button, and no such line.
		assert.ok(bumpIn(rowOf(view, PLAIN)));
		assert.equal(rowOf(view, PLAIN).querySelector('[data-testid="tx-no-bump"]'), null);
		// A confirmed one has nothing left to bump, so nothing to explain.
		assert.equal(rowOf(view, MINT).querySelector('[data-testid="tx-no-bump"]'), null);
		assert.equal(view.$$('[data-testid="tx-no-bump"]').length, 2);
	} finally {
		await view.unmount();
	}
});

test('opening it says which asset moved and leads to it in the Assets tab', async () => {
	const went = [];
	const view = await mount({ go: (to, options) => went.push([to, options]) });
	try {
		await click(rowOf(view, SEND));
		await settle(20);
		const text = view.text();
		assert.match(text, /Asset send/);
		assert.equal(document.querySelector('[data-testid="tx-asset"]').textContent, '300.00 BUSD');
		assert.match(text, /pending, waiting for a block\s*Asset transactions cannot be fee bumped yet\./);
		const link = document.querySelector('[data-testid="tx-asset-link"]');
		assert.equal(link.textContent.trim(), 'View in Assets');
		await click(link);
		assert.deepEqual(went, [['assets', { query: { asset: 'key-busd' } }]]);
	} finally {
		await view.unmount();
	}
});

test('an ordinary transaction opens without a word about assets', async () => {
	const view = await mount({ go: () => {} });
	try {
		await click(rowOf(view, PLAIN));
		await settle(20);
		assert.equal(document.querySelector('[data-testid="tx-asset"]'), null);
		assert.equal(document.querySelector('[data-testid="tx-asset-link"]'), null);
		const detail = view.$('.detail').textContent;
		assert.match(detail, /pending, waiting for a block/);
		assert.doesNotMatch(detail, /Asset|cannot be fee bumped/);
	} finally {
		await view.unmount();
	}
});

test('where the app has no assets host, or the wallet has assets off, the rows are never asked for', async () => {
	const cases = [
		{ config: { assetsAvailable: false } },
		{ config: null },
		{ rec: { network: 'mainnet', assets: { enabled: false, holdsAssets: true } } }
	];
	for (const extra of cases) {
		const api = daemon();
		const view = await mount({ api, ...extra });
		try {
			assert.equal(view.$$('.badge.asset').length, 0, JSON.stringify(extra));
			assert.equal(view.$$('[data-testid="tx-no-bump"]').length, 0);
			assert.ok(!api.asked.some((p) => p.startsWith('/x/assets')), 'no asset route is called');
			// Every pending transaction is an ordinary one again.
			assert.ok(bumpIn(rowOf(view, SEND)));
			assert.ok(bumpIn(rowOf(view, PLAIN)));
		} finally {
			await view.unmount();
		}
	}
});

test('a wallet with no asset rows is the page it always was', async () => {
	const view = await mount({
		api: daemon({ rows: [] }),
		rec: { network: 'mainnet', assets: { enabled: true, holdsAssets: false } },
		assets: { status: { holdsAssets: false, lockedSats: 0, pending: {} }, error: null, loading: false }
	});
	try {
		assert.equal(view.$$('.badge.asset').length, 0);
		assert.ok(bumpIn(rowOf(view, SEND)));
		assert.ok(bumpIn(rowOf(view, RECEIVE)));
		assert.equal(view.$('[data-testid="bump-held"]'), null);
	} finally {
		await view.unmount();
	}
});

test('when a wallet with assets cannot say which transactions are theirs, no fee bump is offered', async () => {
	const view = await mount({ api: daemon({ rows: Object.assign(new Error('The assets host is not running'), { code: 'UNAVAILABLE' }) }) });
	try {
		for (const txid of [SEND, PLAIN, RECEIVE]) assert.equal(bumpIn(rowOf(view, txid)), null);
		assert.match(view.$('[data-testid="bump-held"]').textContent, /^Bump fee is held back for now\./);
		assert.match(view.$('[data-testid="bump-held"]').textContent, /a transaction that carries an asset must not be replaced\.$/);
	} finally {
		await view.unmount();
	}
});

test('a wallet without assets is not held up when the asset rows cannot be read', async () => {
	const view = await mount({
		api: daemon({ rows: new Error('The assets host is not running') }),
		rec: { network: 'mainnet', assets: { enabled: true, holdsAssets: false } },
		assets: { status: null, error: new Error('down'), loading: false }
	});
	try {
		assert.ok(bumpIn(rowOf(view, SEND)));
		assert.ok(bumpIn(rowOf(view, PLAIN)));
		assert.equal(view.$('[data-testid="bump-held"]'), null);
	} finally {
		await view.unmount();
	}
});
