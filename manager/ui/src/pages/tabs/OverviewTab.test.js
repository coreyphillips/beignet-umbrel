/**
 * Run with: npm test (from manager/ui).
 *
 * The Overview page's channel counts, pinned where they lied in the field:
 * both /info's channelCount and the liquidity snapshot's channelCount include
 * every channel the node has ever had, closed ones forever. Every count on
 * this page must be of channels that still operate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { render, settle } from '../../../test/render.mjs';
import { ToastProvider } from '../../components/Toast.jsx';
import OverviewTab from './OverviewTab.jsx';

const LIQUIDITY = {
	channelCount: 6, // lifetime-inclusive, faithfully wrong
	activeChannelCount: 3,
	totalLocalBalanceSats: 400_000,
	totalRemoteBalanceSats: 800_000,
	totalCapacitySats: 1_200_000,
	reserveSats: 12_000,
	sendableSats: 388_000,
	outboundLiquidityPct: 33,
	inboundLiquidityPct: 67,
	recommendations: []
};

function stubApi({ channels }) {
	return {
		get: async (path) => {
			if (path === '/balance') return { onchain: 10_000, lightning: 400_000, total: 410_000 };
			if (path.startsWith('/node/uri')) return { uri: 'pubkey@127.0.0.1:9735' };
			if (path === '/liquidity') return LIQUIDITY;
			if (path === '/fees') return { recommendation: 'NORMAL', estimatedOpenChannelCostSats: 2140 };
			if (path === '/fees/estimates') return { fast: 18, normal: 7, slow: 2 };
			if (path === '/channels') return channels;
			return null;
		},
		post: async () => ({})
	};
}

const ch = (state) => ({
	channelId: 'c'.repeat(64),
	peerPubkey: '02' + 'a'.repeat(64),
	capacitySats: 400_000,
	localBalanceSats: 100_000,
	remoteBalanceSats: 300_000,
	state
});

function props(channels) {
	return {
		id: 'w1',
		api: stubApi({ channels }),
		// The daemon figure counts all six ever-existing channels.
		info: { channelCount: 6, peerCount: 3, onchainBalanceSats: 10_000, lightningBalanceSats: 400_000, blockHeight: 1, listening: true },
		health: { status: 'ready', electrumConnected: true, graphNodes: 1, graphChannels: 1 },
		rec: {},
		tick: 0
	};
}

const wrapped = (p) => createElement(ToastProvider, null, createElement(OverviewTab, p));

test('channel counts are of open channels, not every channel ever', async () => {
	const channels = [
		ch('NORMAL'),
		ch('NORMAL'),
		ch('NORMAL'),
		ch('AWAITING_FUNDING_CONFIRMED'),
		ch('CLOSED'),
		ch('FORCE_CLOSED')
	];
	const r = await render(wrapped, props(channels));
	try {
		// The stat tile first paints the /info fallback and springs to the open
		// count once /channels lands; let the animation reach its target.
		await settle(1200);
		const text = r.text();
		// The Channels stat tile: 4 open, never the daemon's lifetime 6. The
		// tile is the element whose label is Channels; scope to it so the graph
		// row ("N nodes / M channels") cannot satisfy the assertion.
		const tile = r
			.$$('.stat')
			.find((s) => /Channels/i.test(s.querySelector('.stat-label')?.textContent || ''));
		assert.ok(tile, 'channels stat tile exists');
		assert.match(tile.querySelector('.stat-value').textContent, /^4/);
		// The liquidity footer denominator counts open channels too.
		assert.match(text, /3\/4 channels active/);
		assert.doesNotMatch(text, /3\/6 channels active/);
	} finally {
		await r.unmount();
	}
});

test('a wallet whose channels all closed reads as having none', async () => {
	const r = await render(wrapped, props([ch('CLOSED'), ch('FORCE_CLOSED')]));
	try {
		await settle(1200);
		const tile = r
			.$$('.stat')
			.find((s) => /Channels/i.test(s.querySelector('.stat-label')?.textContent || ''));
		assert.match(tile.querySelector('.stat-value').textContent, /^0/);
		// The liquidity card must not dress two corpses as a liquidity bar.
		assert.match(r.text(), /No channels yet/);
	} finally {
		await r.unmount();
	}
});
