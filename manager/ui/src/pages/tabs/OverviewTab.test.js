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

// The Backup row in the Node status card: the channel backup tier, stated
// plainly from the daemon's recovery status (see lib/recovery.js for the
// full table; these pin the row's presence and wording on the page).
const recoveryNode = (extra = {}) => ({
	gate: 'confirmed',
	durability: 'quorum',
	startupRepairPending: false,
	lastDurableSequence: '1284',
	awaitingDurabilityCount: 0,
	fenced: false,
	backfillLost: false,
	channels: [],
	...extra
});

function backupRow(r) {
	return r.$$('tr').find((tr) => /^Backup/.test(tr.textContent.trim()));
}

test('the Backup row states the tier: seed only, quorum, fenced', async () => {
	const off = await render(wrapped, {
		...props([ch('NORMAL')]),
		recovery: { mode: 'off', state: 'disabled', node: null, guardians: [] }
	});
	try {
		await settle(50);
		const row = backupRow(off);
		assert.ok(row, 'a Lightning wallet has a Backup row');
		assert.match(row.textContent, /Seed only \(channels close on restore\)/);
		assert.ok(row.querySelector('.badge.yellow'), 'seed only on a Lightning wallet is a yellow');
	} finally {
		await off.unmount();
	}
	const quorum = await render(wrapped, {
		...props([ch('NORMAL')]),
		recovery: { mode: 'quorum', state: 'running', node: recoveryNode(), guardians: [] }
	});
	try {
		await settle(50);
		assert.match(backupRow(quorum).textContent, /Continuity: quorum, durable to seq 1284/);
		assert.ok(backupRow(quorum).querySelector('.badge.green'));
	} finally {
		await quorum.unmount();
	}
	const fenced = await render(wrapped, {
		...props([ch('NORMAL')]),
		recovery: { mode: 'quorum', state: 'fenced', node: recoveryNode({ fenced: true, gate: 'fenced' }), guardians: [] }
	});
	try {
		await settle(50);
		assert.match(backupRow(fenced).textContent, /Another device took over/);
		assert.ok(backupRow(fenced).querySelector('.badge.red'));
	} finally {
		await fenced.unmount();
	}
});

test('the Backup row narrates the automatic checkpoint restore', async () => {
	const settling = await render(wrapped, {
		...props([]),
		recovery: {
			mode: 'peer-storage',
			state: 'running',
			node: recoveryNode({ durability: 'local', gate: 'disabled' }),
			guardians: [],
			capsules: { candidates: 1, best: null },
			autoApply: { enabled: true, phase: 'settling', settleUntil: 1 }
		}
	});
	try {
		await settle(50);
		assert.match(backupRow(settling).textContent, /Checkpoint found, about to apply it/);
		assert.match(backupRow(settling).textContent, /Waiting a moment for the other peers/);
		assert.ok(backupRow(settling).querySelector('.badge.yellow'));
	} finally {
		await settling.unmount();
	}
	const applied = await render(wrapped, {
		...props([ch('NORMAL')]),
		recovery: {
			mode: 'peer-storage',
			state: 'running',
			node: recoveryNode({ durability: 'local', gate: 'disabled' }),
			guardians: [],
			capsules: { candidates: 0, best: null },
			autoApply: { enabled: true, phase: 'applied' }
		}
	});
	try {
		await settle(50);
		assert.match(backupRow(applied).textContent, /Restored from a peer checkpoint/);
		assert.match(backupRow(applied).textContent, /came back from it, held/);
		assert.ok(backupRow(applied).querySelector('.badge.blue'));
	} finally {
		await applied.unmount();
	}
});

test('an engine without the route reads as seed only, and a status not yet answered as a dash', async () => {
	const old = await render(wrapped, { ...props([ch('NORMAL')]), recovery: { state: 'unsupported' } });
	try {
		await settle(50);
		assert.match(backupRow(old).textContent, /Seed only/);
	} finally {
		await old.unmount();
	}
	const pending = await render(wrapped, { ...props([ch('NORMAL')]), recovery: null });
	try {
		await settle(50);
		assert.match(backupRow(pending).textContent, /^Backup\s*-$/);
	} finally {
		await pending.unmount();
	}
});

test('an on-chain only wallet has no Backup row', async () => {
	const r = await render(wrapped, {
		...props([]),
		rec: { onchainOnly: true },
		recovery: { mode: 'off', state: 'disabled', node: null, guardians: [] }
	});
	try {
		await settle(50);
		assert.equal(backupRow(r), undefined);
	} finally {
		await r.unmount();
	}
});

// A liquidity provider's exposure is the one figure its owner cannot see
// anywhere else: what the daemon is willing to front and what it has
// committed (GET /jit/status, beignet 0.10+).
test('a liquidity provider gets a card with its exposure, caps and dependents', async () => {
	const api = stubApi({ channels: [ch('NORMAL')] });
	const get = api.get;
	api.get = async (path) => {
		if (path === '/jit/status') {
			return {
				enabled: true,
				client: { maxFlatFeeSat: 10000, maxFeePpm: 50000 },
				lsp: {
					flatFeeSat: 0,
					feePpm: 0,
					maxClientFundingSats: 1_000_000,
					maxConcurrentFundings: 3,
					maxTotalFundingSats: null,
					maxLiveIntentsPerPeer: 2,
					maxLiveIntents: 100,
					reservedSats: 50_000,
					frontedSats: 590_000,
					liveIntents: 2,
					heldParts: 1,
					fundingsInFlight: 1
				}
			};
		}
		return get(path);
	};
	const r = await render(ToastProvider, {
		children: createElement(OverviewTab, {
			...props([ch('NORMAL')]),
			api,
			rec: { liquidityProvider: true, lfbwDependents: [{ id: 'l1', name: 'Spending' }] }
		})
	});
	try {
		await settle(50);
		const text = r.text();
		assert.match(text, /Liquidity provider/);
		assert.match(text, /primary node of "Spending"/);
		assert.match(text, /Fronted so far/);
		assert.match(text, /Committed now/);
		assert.match(text, /1 funding in flight/);
		assert.match(text, /1 payment held/);
		assert.match(text, /1,000,000 sats per client/);
		assert.match(text, /no lifetime budget/);
	} finally {
		await r.unmount();
	}
});

test('a wallet that is not a provider has no such card', async () => {
	const r = await render(ToastProvider, { children: createElement(OverviewTab, props([ch('NORMAL')])) });
	try {
		await settle(50);
		assert.doesNotMatch(r.text(), /Liquidity provider/);
	} finally {
		await r.unmount();
	}
});
