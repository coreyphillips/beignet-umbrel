/**
 * Run with: npm test (from manager/ui).
 *
 * The lightning-first overview: setup state with a Retry that asks the
 * manager, the figures and the arriving-sats notes off the daemon, the home
 * channel with its Close, and the direct-funding minimum.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { click, render, settle, type } from '../../../../test/render.mjs';
import { ToastProvider } from '../../../components/Toast.jsx';
import LfbwOverviewTab from './LfbwOverviewTab.jsx';

const PK = '03' + '22'.repeat(32);
const HOME = {
	channelId: 'c'.repeat(64),
	peerPubkey: PK,
	state: 'NORMAL',
	htlcUsable: true,
	capacitySats: 500_000,
	localBalanceSats: 200_000,
	remoteBalanceSats: 300_000
};

const realFetch = globalThis.fetch;
test.afterEach(() => {
	globalThis.fetch = realFetch;
});

/** The manager, answering the wallet list and recording a setup retry. */
function stubManager({ primaryStatus = 'running', setupResult, channelizeResult } = {}) {
	const calls = [];
	globalThis.fetch = async (url, opts = {}) => {
		calls.push([opts.method || 'GET', url]);
		let result;
		if (url === '/api/wallets') result = [{ id: 'p1', name: 'Main', status: primaryStatus, network: 'mainnet' }];
		else if (url === '/api/wallets/w1/lfbw/setup') result = setupResult;
		else if (url === '/api/wallets/w1/lfbw/channelize') result = channelizeResult;
		else result = null;
		return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
	};
	return calls;
}

function stubApi({ channels = [HOME], utxos = [], peers = [{ pubkey: PK, state: 'connected' }], balance, liquidity, dfConfig } = {}) {
	const calls = [];
	return {
		calls,
		get: async (path) => {
			calls.push(['GET', path]);
			if (path === '/balance') return balance ?? { onchain: 0, lightning: 200_000, total: 200_000, splicingSats: 0 };
			if (path === '/liquidity') return liquidity ?? { sendableSats: 190_000, totalLocalBalanceSats: 200_000 };
			if (path === '/channels') return channels;
			if (path === '/utxos') return utxos;
			if (path === '/peers') return peers;
			if (path === '/direct-funding/config') {
				return dfConfig ?? { lspPubkey: PK, lspHost: '127.0.0.1', lspPort: 9101, targetInboundSat: 0, trusted: true, allowSplice: true, minAmountSat: 5000 };
			}
			throw new Error(`unexpected GET ${path}`);
		},
		post: async (path, body) => {
			calls.push(['POST', path, body]);
			if (path === '/channel/close') return { ok: true };
			if (path === '/direct-funding/configure') return { lspPubkey: PK, lspHost: '127.0.0.1', lspPort: 9101, targetInboundSat: 0, trusted: true, allowSplice: true, minAmountSat: Math.max(5000, body.minAmountSat) };
			throw new Error(`unexpected POST ${path}`);
		}
	};
}

const rec = (lf = {}) => ({
	id: 'w1',
	network: 'mainnet',
	lfbw: { enabled: true, mode: 'internal', primaryWalletId: 'p1', primaryPubkey: PK, trusted: true, setup: 'ready', ...lf }
});

async function mount(api, r) {
	const view = await render(ToastProvider, {
		children: createElement(LfbwOverviewTab, { id: 'w1', api, info: null, rec: r, tick: 0, bump: () => {} })
	});
	await settle(50);
	return view;
}

test('a failed setup says why and Retry asks the manager to run it again', async () => {
	const calls = stubManager({ setupResult: { lfbw: { setup: 'ready' } } });
	const view = await mount(stubApi({ channels: [] }), rec({ setup: 'failed', setupError: 'primary node "Main" is not running' }));
	try {
		assert.match(view.text(), /Could not finish setting up the primary node: primary node "Main" is not running/);
		await click(view.$$('button').find((b) => b.textContent.trim() === 'Retry setup'));
		await settle(50);
		assert.ok(calls.some(([m, u]) => m === 'POST' && u === '/api/wallets/w1/lfbw/setup'));
		assert.match(view.text(), /Primary node connected/);
	} finally {
		await view.unmount();
	}
});

test('ready: the figures, the primary named from the wallet list, the home channel, and the arriving notes', async () => {
	stubManager();
	const api = stubApi({
		balance: { onchain: 72_000, lightning: 200_000, total: 272_000, splicingSats: 0 },
		utxos: [{ valueSats: 12_000, height: 100 }, { valueSats: 60_000, height: null }]
	});
	const view = await mount(api, rec());
	try {
		const text = view.text();
		assert.match(text, /Total balance/);
		assert.match(text, /Can send/);
		assert.match(text, /Main/, 'the primary is named from the manager, not the gossip graph');
		assert.match(text, /connected/);
		assert.match(text, /zero-conf trusted/);
		assert.match(text, /500,000 sats/);
		assert.match(text, /60,000 sats are arriving on-chain/);
		assert.match(text, /12,000 sats are waiting: amounts under 25,000 sats/);
		assert.match(text, /Smallest direct funding accepted: 5,000 sats/);
		assert.match(text, /Paired senders grow your existing channel/);
		assert.equal(api.calls.some(([m, p]) => m === 'GET' && p.startsWith('/graph/node')), false, 'an internal primary is not looked up in the graph');
	} finally {
		await view.unmount();
	}
});

test('Close asks for confirmation, then cooperatively closes the home channel', async () => {
	stubManager();
	const api = stubApi();
	const view = await mount(api, rec());
	try {
		await click(view.$$('button').find((b) => b.textContent.trim() === 'Close'));
		assert.match(view.text(), /moves back into Lightning by itself once it confirms/);
		await click(view.$$('button').find((b) => b.textContent.trim() === 'Close channel'));
		await settle(50);
		const close = api.calls.find(([m, p]) => m === 'POST' && p === '/channel/close');
		assert.deepEqual(close[2], { channelId: HOME.channelId });
	} finally {
		await view.unmount();
	}
});

test('the direct-funding minimum is edited in place and the clamped readback is shown', async () => {
	stubManager();
	const api = stubApi();
	const view = await mount(api, rec());
	try {
		await click(view.$$('button').find((b) => b.textContent.trim() === 'Edit'));
		await type(view.$('input[style]'), '100');
		await click(view.$$('button').find((b) => b.textContent.trim() === 'Save'));
		await settle(50);
		const posted = api.calls.find(([m, p]) => m === 'POST' && p === '/direct-funding/configure');
		assert.deepEqual(posted[2], { minAmountSat: 100 });
		assert.match(view.text(), /raised to the floor/);
		assert.match(view.text(), /Smallest direct funding accepted: 5,000 sats/);
	} finally {
		await view.unmount();
	}
});

test('a stopped primary wallet is said so beside the connection badge', async () => {
	stubManager({ primaryStatus: 'stopped' });
	const view = await mount(stubApi({ peers: [] }), rec());
	try {
		await settle(50);
		assert.match(view.text(), /offline/);
		assert.match(view.text(), /wallet stopped/);
	} finally {
		await view.unmount();
	}
});

test('a deposit held for the fee is explained, and "Move now anyway" asks the manager for one pass past it', async () => {
	const calls = stubManager({ channelizeResult: { at: 1, action: 'splice-in', amountSats: 28_000 } });
	const api = stubApi({
		balance: { onchain: 30_000, lightning: 200_000, total: 230_000, splicingSats: 0 },
		utxos: [{ valueSats: 30_000, height: 100 }]
	});
	const view = await mount(api, rec({ lastChannelize: { at: 1, action: 'wait', reason: 'fee-too-high', feeSats: 2400, amountSats: 28_000 } }));
	try {
		assert.match(view.text(), /waiting for the fee rate to come down, or for more to arrive: moving them now would pay about 2,400 sats/);
		const button = view.$$('button').find((b) => b.textContent.trim() === 'Move now anyway');
		assert.ok(button);
		await click(button);
		await settle(50);
		assert.ok(calls.some(([m, u]) => m === 'POST' && u === '/api/wallets/w1/lfbw/channelize'));
		assert.match(view.text(), /Moving 28,000 sats into your channel/);
	} finally {
		await view.unmount();
	}
	// No fee wait, no button: a deposit that simply moves needs no override.
	stubManager();
	const plain = await mount(api, rec({ lastChannelize: { at: 1, action: 'splice-in', amountSats: 28_000 } }));
	try {
		assert.equal(plain.$$('button').find((b) => b.textContent.trim() === 'Move now anyway'), undefined);
	} finally {
		await plain.unmount();
	}
});
