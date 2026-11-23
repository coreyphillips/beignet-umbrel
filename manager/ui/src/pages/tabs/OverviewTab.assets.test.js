/**
 * Run with: npm test (from manager/ui).
 *
 * Taproot Assets on the Overview. The page keeps one summary of a wallet's
 * assets (WalletPage) and hands it to every tab. The Overview says what it
 * means for the balances: the sats sitting under the assets, which are the
 * wallet's and are not in the on-chain figure, and the first few holdings
 * with the way to the rest. A wallet without assets sees none of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { click, render, settle } from '../../../test/render.mjs';
import { ToastProvider } from '../../components/Toast.jsx';
import OverviewTab from './OverviewTab.jsx';

const holding = (name, total, extra = {}) => ({
	key: `key-${name.toLowerCase()}`,
	assetId: name.charCodeAt(0).toString(16).padStart(2, '0').repeat(32),
	groupKey: null,
	name,
	type: 'normal',
	decimalDisplay: 0,
	balance: { total, onchain: total, pendingIn: '0', pendingOut: '0' },
	lockedSats: 1000,
	anchors: 1,
	...extra
});

function setup({
	holdings = [],
	balance = { onchain: 10_000, lightning: 0, total: 10_000 },
	status,
	config = { assetsAvailable: true },
	rec = { onchainOnly: true, assets: { enabled: true, holdsAssets: true } }
}) {
	const asked = [];
	const went = [];
	const props = {
		id: 'w1',
		api: {
			get: async (path) => {
				asked.push(path);
				if (path === '/balance') return balance;
				if (path === '/x/assets/balances') {
					return { assets: holdings, btc: { anchorSats: 0, anchorCount: 0, spendableSats: 10_000 } };
				}
				if (path === '/fees/estimates') return { fast: 18, normal: 7, slow: 2 };
				return null;
			},
			post: async () => ({})
		},
		info: { onchainBalanceSats: 10_000, blockHeight: 1 },
		health: { status: 'ready', electrumConnected: true },
		rec,
		tick: 0,
		config,
		assets: { status, error: null, loading: false },
		go: (to, options) => went.push([to, options])
	};
	return { props, asked, went };
}

const wrapped = (p) => createElement(ToastProvider, null, createElement(OverviewTab, p));
const onchainTile = (r) => r.$$('.stat').find((s) => s.querySelector('.stat-label')?.textContent === 'On-chain');

test('sats locked with assets are said under the on-chain balance, with what they are', async () => {
	const { props } = setup({ status: { lockedSats: 3000, holdsAssets: true }, holdings: [holding('Alpha', '10')] });
	const r = await render(wrapped, props);
	try {
		const sub = onchainTile(r).querySelector('.stat-sub');
		assert.ok(sub, 'the on-chain tile has a second line');
		assert.match(sub.textContent, /^\+ 3,000 sats locked with assets/);
		assert.equal(sub.querySelector('.help-btn').getAttribute('aria-label'), 'About sats locked with assets');
		assert.match(sub.textContent, /They come back when the asset is sent or burned\./);
	} finally {
		await r.unmount();
	}
});

test('a Lightning wallet is told the same, under the same tile', async () => {
	const { props } = setup({
		status: { lockedSats: 1000, holdsAssets: true },
		holdings: [holding('Alpha', '10')],
		rec: { assets: { enabled: true, holdsAssets: true } }
	});
	const r = await render(wrapped, props);
	try {
		assert.match(onchainTile(r).querySelector('.stat-sub').textContent, /^\+ 1,000 sats locked with assets/);
	} finally {
		await r.unmount();
	}
});

test('a wallet with nothing locked says nothing about locked sats', async () => {
	const { props } = setup({ status: { lockedSats: 0, holdsAssets: false } });
	const r = await render(wrapped, props);
	try {
		assert.equal(r.$('[data-testid="overview-locked-sats"]'), null);
		assert.equal(onchainTile(r).querySelector('.stat-sub'), null);
	} finally {
		await r.unmount();
	}
});

test('the first three holdings are listed, each a way into its asset, with the way to the rest', async () => {
	const holdings = [
		holding('Alpha', '1250'),
		holding('Beta', '30000', { decimalDisplay: 2 }),
		holding('Ticket', '1', { type: 'collectible', decimalDisplay: null }),
		holding('Delta', '7'),
		holding('Epsilon', '9')
	];
	const { props, went } = setup({ status: { lockedSats: 5000, holdsAssets: true }, holdings });
	const r = await render(wrapped, props);
	try {
		await settle(30);
		const rows = r.$$('[data-testid="overview-assets"] li');
		assert.equal(rows.length, 3);
		assert.match(rows[0].textContent, /^Alpha\s*1,250$/);
		assert.match(rows[1].textContent, /^Beta\s*300\.00$/);
		assert.match(rows[2].textContent, /^Ticket\s*Collectible$/, 'one of one is named, not counted');
		assert.equal(rows[0].querySelectorAll('.asset-avatar').length, 1);
		assert.equal(r.$('[data-testid="overview-assets-more"]').textContent, 'and 2 more');

		await click(rows[1].querySelector('button'));
		assert.deepEqual(went.pop(), ['assets', { query: { asset: 'key-beta' } }]);
		const all = r.$('[data-testid="overview-assets-all"]');
		assert.equal(all.textContent.trim(), 'View all');
		await click(all);
		assert.deepEqual(went.pop(), ['assets', {}]);
	} finally {
		await r.unmount();
	}
});

test('three holdings or fewer leave nothing more to count', async () => {
	const { props } = setup({
		status: { lockedSats: 2000, holdsAssets: true },
		holdings: [holding('Alpha', '10'), holding('Beta', '20')]
	});
	const r = await render(wrapped, props);
	try {
		await settle(30);
		assert.equal(r.$$('[data-testid="overview-assets"] li').length, 2);
		assert.equal(r.$('[data-testid="overview-assets-more"]'), null);
	} finally {
		await r.unmount();
	}
});

test('a wallet that holds no assets gets no card, and its holdings are never asked for', async () => {
	const { props, asked } = setup({ status: { lockedSats: 0, holdsAssets: false }, holdings: [] });
	const r = await render(wrapped, props);
	try {
		await settle(30);
		assert.equal(r.$('[data-testid="overview-assets"]'), null);
		assert.equal(r.$('[data-testid="overview-assets-all"]'), null);
		assert.ok(!asked.includes('/x/assets/balances'));
	} finally {
		await r.unmount();
	}
});

test('nothing about assets shows where the app has no assets host, or the wallet has them switched off', async () => {
	const status = { lockedSats: 4000, holdsAssets: true };
	const cases = [
		{ config: { assetsAvailable: false } },
		{ config: null },
		{ rec: { onchainOnly: true, assets: { enabled: false, holdsAssets: true } } }
	];
	for (const extra of cases) {
		const { props, asked } = setup({ status, holdings: [holding('Alpha', '10')], ...extra });
		const r = await render(wrapped, props);
		try {
			await settle(30);
			assert.equal(r.$('[data-testid="overview-locked-sats"]'), null, JSON.stringify(extra));
			assert.equal(r.$('[data-testid="overview-assets-all"]'), null, JSON.stringify(extra));
			assert.doesNotMatch(r.text(), /locked with assets/);
			assert.ok(!asked.includes('/x/assets/balances'), JSON.stringify(extra));
		} finally {
			await r.unmount();
		}
	}
});

/* ------------------------------------------- the bitcoin in asset channels */

const tile = (r, label) => r.$$('.stat').find((s) => s.querySelector('.stat-label')?.textContent === label);
const lightningWallet = { assets: { enabled: true, holdsAssets: true } };

test('the bitcoin in asset channels is said under the Lightning balance, and is in no figure', async () => {
	const { props } = setup({
		status: { lockedSats: 0, holdsAssets: true },
		rec: lightningWallet,
		balance: { onchain: 10_000, lightning: 2_000, total: 12_000, assetChannelSats: 98_292 }
	});
	const r = await render(wrapped, props);
	try {
		const line = r.$('[data-testid="overview-asset-channel-sats"]');
		assert.ok(line, 'a line says where the bitcoin went');
		assert.ok(tile(r, 'Lightning').contains(line), 'under the Lightning figure');
		assert.match(line.textContent, /^\+ 98,292 sats in asset channels/);
		assert.equal(r.$('[data-testid="overview-asset-channel-closing-sats"]'), null);
		const sub = tile(r, 'Lightning').querySelector('.stat-sub');
		assert.equal(sub.querySelector('.help-btn').getAttribute('aria-label'), 'About bitcoin in asset channels');
		assert.match(sub.textContent, /They come home when the channel closes\. While a channel is closing, its bitcoin is on its way home/);
		// The tile has room for the figure only: when it comes home is said in the help.
		assert.doesNotMatch(line.textContent, /^\+ 98,292 sats in asset channels, comes home/);
		// A quiet line: the figures themselves are the engine's, untouched.
		assert.match(tile(r, 'Lightning').querySelector('.stat-value').textContent, /^2,000/);
		assert.match(tile(r, 'Total').querySelector('.stat-value').textContent, /^12,000/);
	} finally {
		await r.unmount();
	}
});

test('the bitcoin of a channel that is closing is said as on its way back', async () => {
	const { props } = setup({
		status: { lockedSats: 0, holdsAssets: true },
		rec: lightningWallet,
		balance: { onchain: 10_000, lightning: 0, total: 10_000, assetChannelSats: 98_292, assetChannelClosingSats: 40_000 }
	});
	const r = await render(wrapped, props);
	try {
		assert.match(r.$('[data-testid="overview-asset-channel-sats"]').textContent, /^\+ 98,292 sats in asset channels/);
		assert.match(
			r.$('[data-testid="overview-asset-channel-closing-sats"]').textContent,
			/^\+ 40,000 sats on their way home from a closing asset channel/
		);
	} finally {
		await r.unmount();
	}
});

test('a wallet without asset channels, or on an engine that does not say, has no such line', async () => {
	const { props } = setup({ status: { lockedSats: 0, holdsAssets: true }, rec: lightningWallet });
	const r = await render(wrapped, props);
	try {
		assert.equal(r.$('[data-testid="overview-asset-channel-sats"]'), null);
		assert.equal(r.$('[data-testid="overview-asset-channel-closing-sats"]'), null);
		assert.equal(tile(r, 'Lightning').querySelector('.stat-sub'), null, 'the Lightning tile is as it was');
	} finally {
		await r.unmount();
	}
});
