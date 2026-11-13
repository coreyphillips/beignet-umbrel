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

// The balance tiles go in two pairs, so a narrow column (beside the wallet
// sidebar, or with large balances) breaks the row two by two, never three
// and one, and the cards under it stack instead of running off the edge.
test('the balance tiles go in pairs and the cards in a flow that can stack', async () => {
	const r = await render(wrapped, props([ch('NORMAL')]));
	try {
		await settle(50);
		const pairs = r.$$('.stat-row > .stat-pair');
		assert.deepEqual(
			pairs.map((p) => [...p.querySelectorAll('.stat-label')].map((l) => l.textContent)),
			[
				['On-chain', 'Lightning'],
				['Total', 'Channels']
			]
		);
		const flow = r.$$('.card-flow > .card').map((c) => c.querySelector('h3')?.firstChild?.textContent);
		assert.deepEqual(flow.slice(0, 2), ['Node status', 'Liquidity']);
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
		// Its four tiles go in pairs like the balances, so large lifetime
		// figures break the row two by two instead of running past the card.
		const card = r.$$('.card').find((c) => /^Liquidity provider/.test(c.querySelector('h3')?.textContent || ''));
		assert.deepEqual(
			[...card.querySelectorAll('.stat-row > .stat-pair')].map((p) =>
				[...p.querySelectorAll('.stat-label')].map((l) => l.textContent)
			),
			[
				['Fronted so far', 'Committed now'],
				['Live intents', 'Fee']
			]
		);
	} finally {
		await r.unmount();
	}
});

// A provider that serves swaps: what it has committed, per direction,
// against its caps (GET /swaps/status, beignet 0.15+; both directions 0.16+).
const SWAP_DIRECTION = {
	enabled: true,
	fee: { flatFeeSat: '100', feePpm: 1000 },
	limits: { minSwapSat: '10000', maxSwapSat: '1000000', maxTotalExposureSat: '5000000', maxConcurrentSwaps: 8 },
	counts: { CREATED: 1, FUNDED: 2, SETTLED: 14 },
	exposedSat: '350000',
	exposedCount: 2
};

test('a provider serving swaps gets a card with each direction it serves', async () => {
	const api = stubApi({ channels: [ch('NORMAL')] });
	const get = api.get;
	api.get = async (path) => {
		if (path === '/swaps/status') {
			return {
				...SWAP_DIRECTION,
				submarine: {
					...SWAP_DIRECTION,
					counts: { PAYING: 1, CLAIM_CONFIRMED: 3, EXPOSED: 1 },
					exposedSat: '120000',
					exposedCount: 1
				}
			};
		}
		if (path === '/jit/status') return { enabled: true, lsp: null };
		return get(path);
	};
	const r = await render(ToastProvider, {
		children: createElement(OverviewTab, {
			...props([ch('NORMAL')]),
			api,
			rec: { liquidityProvider: true, swaps: { enabled: true, submarine: true } }
		})
	});
	try {
		await settle(50);
		const text = r.text();
		assert.match(text, /Swaps/);
		assert.match(text, /Lightning to on-chain \(reverse\)/);
		assert.match(text, /2 swaps in flight/);
		assert.match(text, /1 created · 2 funded · 14 settled/);
		assert.match(text, /On-chain to Lightning \(submarine\)/);
		assert.match(text, /1 swap in flight/);
		assert.match(text, /1 paying · 3 claim confirmed · 1 exposed/);
		assert.match(text, /1 exposed/);
		assert.match(text, /check the Logs tab/);
		// One budget serves both directions, so the caps are printed once,
		// over the sum of the two committed figures, and not under either.
		assert.match(text, /Both directions together/);
		assert.match(text, /470,000satsover 3 swaps, both directions/);
		assert.match(text, /Caps5,000,000satsat once, 8 swaps at most/);
		// The slots go by the unresolved rows the daemon counts (3 reverse, 2
		// submarine), not by the 3 that have principal at risk.
		assert.match(text, /Room left4,530,000sats3 more swaps of the 8, either direction/);
		assert.match(text, /One budget covers both directions, not one each/);
		assert.match(text, /2 swaps in flight, of the shared budget/);
		assert.match(text, /1 swap in flight, of the shared budget/);
		// The range and the fee are amounts the tile breaks between, not one
		// unbroken run of text that holds its column wider than the card.
		const tiles = [...r.container.querySelectorAll('.stat')];
		const size = tiles.find((t) => /^Swap size/.test(t.textContent));
		assert.equal(size.querySelector('.stat-value').className, 'stat-value wraps');
		assert.deepEqual(
			[...size.querySelectorAll('.stat-amount')].map((a) => a.textContent),
			['10,000sats', '1,000,000sats']
		);
		const fee = tiles.find((t) => /^Fee/.test(t.textContent));
		assert.deepEqual(
			[...fee.querySelectorAll('.stat-amount')].map((a) => a.textContent),
			['100sats', '1,000ppm']
		);
		assert.match(fee.textContent, /^Fee100sats\+1,000ppmtaken from each swap$/);
	} finally {
		await r.unmount();
	}
});

test('a reverse-only provider shows one direction, and swaps off shows no card', async () => {
	const api = stubApi({ channels: [ch('NORMAL')] });
	const get = api.get;
	api.get = async (path) => {
		if (path === '/swaps/status') return { ...SWAP_DIRECTION, submarine: { enabled: false } };
		if (path === '/jit/status') return { enabled: true, lsp: null };
		return get(path);
	};
	const one = await render(ToastProvider, {
		children: createElement(OverviewTab, {
			...props([ch('NORMAL')]),
			api,
			rec: { liquidityProvider: true, swaps: { enabled: true } }
		})
	});
	try {
		await settle(50);
		assert.match(one.text(), /Lightning to on-chain \(reverse\)/);
		assert.doesNotMatch(one.text(), /On-chain to Lightning/);
		// Nothing to share with, so the one direction carries the caps itself.
		assert.doesNotMatch(one.text(), /Both directions together/);
		assert.match(one.text(), /Caps5,000,000satsat once, 8 swaps at most/);
	} finally {
		await one.unmount();
	}
	const calls = [];
	const quiet = { ...api, get: async (path) => (calls.push(path), get(path)) };
	const none = await render(ToastProvider, {
		children: createElement(OverviewTab, {
			...props([ch('NORMAL')]),
			api: quiet,
			rec: { liquidityProvider: true, swaps: { enabled: false } }
		})
	});
	try {
		await settle(50);
		assert.doesNotMatch(none.text(), /Committed now.*swaps? in flight/);
		assert.ok(!calls.includes('/swaps/status'), 'the status is not even asked for');
	} finally {
		await none.unmount();
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

// The "Connect to this node" card follows the wallet's network mode (umbrel
// #193): the ways in it offers, the one it opens on, and the port peers dial.
const NODE = '02' + 'b'.repeat(64);
const ONION = `${'o'.repeat(56)}.onion:9102`;

function connectProps(rec) {
	const p = props([ch('NORMAL')]);
	return { ...p, info: { ...p.info, nodeId: NODE }, rec };
}

const ways = (r) => Array.from(r.$('[data-testid="connect-ways"]').querySelectorAll('button')).map((b) => b.textContent.trim());
const shown = (r) => r.$('[data-testid="connect-ways"]').parentElement.querySelector('.copy, .mono, input, code')?.value || r.$('[data-testid="connect-ways"]').parentElement.textContent;

test('a hybrid wallet that announces both offers three ways in and opens on its public address', async () => {
	const r = await render(
		wrapped,
		connectProps({
			networkMode: 'hybrid',
			announce: true,
			publicHost: 'node.example.com',
			publicAddress: 'node.example.com:19102',
			publicPort: 19102,
			listenPort: 9102,
			onionAddress: ONION
		})
	);
	try {
		await settle(50);
		assert.deepEqual(ways(r), ['Clearnet', 'Tor', 'Local network']);
		assert.match(shown(r), new RegExp(`${NODE}@node\\.example\\.com:19102`));
		assert.match(r.$('[data-testid="connect-hint"]').textContent, /forwarded on your router/);
	} finally {
		await r.unmount();
	}
});

test('a tor wallet offers Tor and the home network; a wallet that does not announce opens on the home network and says why', async () => {
	const tor = await render(wrapped, connectProps({ networkMode: 'tor', announce: true, onionAddress: ONION, publicPort: 19102, listenPort: 9102 }));
	try {
		await settle(50);
		assert.deepEqual(ways(tor), ['Tor', 'Local network']);
		assert.match(shown(tor), new RegExp(`${NODE}@${ONION}`));
	} finally {
		await tor.unmount();
	}
	const quiet = await render(wrapped, connectProps({ networkMode: 'hybrid', announce: false, publicHost: '203.0.113.4', publicPort: 19102, listenPort: 9102 }));
	try {
		await settle(50);
		assert.deepEqual(ways(quiet), ['Clearnet', 'Tor', 'Local network']);
		// Nothing announced: the first way with an address is the home network,
		// at the host port the app publishes, not the container's listen port.
		assert.match(shown(quiet), new RegExp(`${NODE}@localhost:19102`));
		assert.doesNotMatch(shown(quiet), /@localhost:9102\b/);
		const clearnet = Array.from(quiet.$('[data-testid="connect-ways"]').querySelectorAll('button')).find((b) => b.textContent.trim() === 'Clearnet');
		const { click } = await import('../../../test/render.mjs');
		await click(clearnet);
		assert.match(quiet.$('[data-testid="connect-hint"]').textContent, /Announcing is off/);
	} finally {
		await quiet.unmount();
	}
});

test('every way in with an address shows a QR of it, and a way without one shows none', async () => {
	const r = await render(
		wrapped,
		connectProps({
			networkMode: 'hybrid',
			announce: true,
			publicHost: 'node.example.com',
			publicAddress: 'node.example.com:19102',
			publicPort: 19102,
			listenPort: 9102,
			onionAddress: ONION
		})
	);
	try {
		await settle(50);
		const { click } = await import('../../../test/render.mjs');
		const card = () => r.$('[data-testid="connect-ways"]').parentElement;
		const button = (label) =>
			Array.from(r.$('[data-testid="connect-ways"]').querySelectorAll('button')).find((b) => b.textContent.trim() === label);
		const drawn = new Set();
		for (const label of ['Clearnet', 'Tor', 'Local network']) {
			await click(button(label));
			const svg = card().querySelector('.qr svg');
			assert.ok(svg, `${label} has a QR`);
			drawn.add(svg.innerHTML);
		}
		// One code per address: picking another way redraws it.
		assert.equal(drawn.size, 3);
	} finally {
		await r.unmount();
	}
	const tor = await render(wrapped, connectProps({ networkMode: 'tor', announce: true, listenPort: 9102 }));
	try {
		await settle(50);
		assert.match(shown(tor), /Not available yet/);
		assert.equal(tor.$('[data-testid="connect-ways"]').parentElement.querySelector('.qr'), null);
	} finally {
		await tor.unmount();
	}
});

test('the Iroh phone link shows its pairing URI, QR and IP visibility help', async () => {
	const value = `${NODE}@iroh:${'b'.repeat(64)}?relay=https%3A%2F%2Frelay.example%2F`;
	const p = connectProps({ networkMode: 'tor', announce: false, iroh: { enabled: true } });
	p.info = { ...p.info, irohAvailable: true, irohUri: value };
	const r = await render(wrapped, p);
	try {
		assert.equal(ways(r)[0], 'Iroh phone link');
		assert.ok(shown(r).includes(value));
		const card = r.$('[data-testid="connect-ways"]').parentElement;
		assert.ok(card.querySelector('.qr svg'));
		assert.match(r.$('[data-testid="connect-hint"]').textContent, /relay can see this Umbrel's IP/);
	} finally { await r.unmount(); }
});


test('an oversized Iroh QR preserves the page and its copyable pairing address', async () => {
	const value = `${NODE}@iroh:${'b'.repeat(64)}?relay=${encodeURIComponent('https://relay.example/' + '/'.repeat(1800))}`;
	const p = connectProps({ networkMode: 'tor', announce: false, iroh: { enabled: true } });
	p.info = { ...p.info, irohAvailable: true, irohUri: value };
	const r = await render(wrapped, p);
	try {
		assert.ok(shown(r).includes(value));
		assert.match(r.text(), /too long for a QR code/);
		assert.ok(r.$('[data-testid="connect-ways"]'));
	} finally { await r.unmount(); }
});

// Relay only (beignet #1982) is switched beside the link it is about, in the
// "Connect to this node" card, and only after a dialog that says what it
// does and that the wallet restarts.
const IROH_URI = `${NODE}@iroh:${'b'.repeat(64)}?relay=https%3A%2F%2Frelay.example%2F`;

function irohProps({ relayOnly = false, available = true, info = {} } = {}) {
	const p = connectProps({ id: 'w1', networkMode: 'tor', announce: false, iroh: { enabled: true, ...(relayOnly ? { relayOnly: true } : {}) } });
	p.info = { ...p.info, irohAvailable: true, irohUri: IROH_URI, ...info };
	p.config = { irohAvailable: true, irohRelayOnlyAvailable: available };
	return p;
}

/** Record every manager call the card makes, answering each with `answer`. */
function captureFetch(answer = { ok: true, data: {} }) {
	const real = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, opts = {}) => {
		calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
		return { ok: answer.ok !== false, status: answer.ok === false ? 400 : 200, json: async () => answer };
	};
	return { calls, restore: () => { globalThis.fetch = real; } };
}

test('the Iroh link carries a Relay only switch, off by default, on an engine that has it', async () => {
	const r = await render(wrapped, irohProps());
	try {
		const box = r.$('[data-testid="iroh-relay-only"]');
		assert.ok(box, 'the switch is in the card');
		assert.equal(box.checked, false);
		assert.equal(box.disabled, false);
		assert.ok(r.$('[data-testid="connect-ways"]').parentElement.contains(box), 'inside the Connect card');
		assert.equal(r.$('[data-testid="iroh-relay-only-mode"]'), null);
	} finally { await r.unmount(); }
	// An engine without it offers no switch, and neither does another way in.
	const old = await render(wrapped, irohProps({ available: false }));
	try {
		assert.equal(old.$('[data-testid="iroh-relay-only"]'), null);
	} finally { await old.unmount(); }
	const other = await render(wrapped, irohProps());
	try {
		const { click } = await import('../../../test/render.mjs');
		const local = Array.from(other.$('[data-testid="connect-ways"]').querySelectorAll('button')).find((b) => b.textContent.trim() === 'Local network');
		await click(local);
		assert.equal(other.$('[data-testid="iroh-relay-only"]'), null);
	} finally { await other.unmount(); }
});

test('turning Relay only on asks first, sends that key alone and refreshes the wallet', async () => {
	const { click } = await import('../../../test/render.mjs');
	const net = captureFetch();
	let bumped = 0;
	const r = await render(wrapped, { ...irohProps(), bump: () => { bumped += 1; } });
	try {
		await click(r.$('[data-testid="iroh-relay-only"]'));
		// Nothing is sent until the dialog is confirmed.
		assert.equal(net.calls.length, 0);
		assert.match(r.text(), /Turn on Relay only/);
		const notes = r.$('[data-testid="iroh-relay-only-notes"]').textContent;
		assert.match(notes, /relay's operator still sees this Umbrel's IP address/);
		assert.match(notes, /that is n0/);
		assert.match(notes, /does not take an address back/);
		// What the switch does not cover is said before it is turned on: the
		// node id in the link, and the peers a wallet dials directly.
		assert.match(notes, /carries this wallet's Lightning node id/);
		assert.match(notes, /reached from the internet/);
		assert.match(notes, /Use Tor mode for a link you post publicly/);
		assert.match(notes, /switches itself off/);
		assert.match(notes, /12 seconds/);
		assert.match(r.text(), /This restarts the wallet/);
		await click(r.$('[data-testid="iroh-relay-only-confirm"]'));
		await settle(50);
		assert.deepEqual(net.calls, [{ url: '/api/wallets/w1', method: 'PATCH', body: { iroh: { relayOnly: true } } }]);
		assert.equal(bumped, 1);
		await settle(400);
		assert.equal(r.$('[data-testid="iroh-relay-only-confirm"]'), null, 'the dialog closed');
	} finally {
		net.restore();
		await r.unmount();
	}
});

test('cancelling the Relay only dialog changes nothing', async () => {
	const { click } = await import('../../../test/render.mjs');
	const net = captureFetch();
	const r = await render(wrapped, irohProps());
	try {
		await click(r.$('[data-testid="iroh-relay-only"]'));
		const cancel = r.$$('button').find((b) => b.textContent.trim() === 'Cancel');
		await click(cancel);
		await settle(50);
		assert.equal(net.calls.length, 0);
		assert.equal(r.$('[data-testid="iroh-relay-only"]').checked, false);
	} finally {
		net.restore();
		await r.unmount();
	}
});

test('a relay-only wallet shows the switch on with the mode the daemon reports, and turning it off warns', async () => {
	const { click } = await import('../../../test/render.mjs');
	const net = captureFetch();
	const r = await render(wrapped, irohProps({ relayOnly: true, info: { irohRelayOnly: true, irohRelayOnlyMode: 'loopback-pin' } }));
	try {
		assert.equal(r.$('[data-testid="iroh-relay-only"]').checked, true);
		assert.match(r.$('[data-testid="iroh-relay-only-mode"]').textContent, /loopback-pin/);
		assert.ok(shown(r).includes(IROH_URI));
		assert.match(r.$('[data-testid="connect-hint"]').textContent, /cannot learn this Umbrel's IP address/);
		await click(r.$('[data-testid="iroh-relay-only"]'));
		assert.match(r.text(), /Turn off Relay only/);
		assert.match(r.text(), /can then learn this Umbrel's IP address/);
		await click(r.$('[data-testid="iroh-relay-only-confirm"]'));
		await settle(50);
		assert.deepEqual(net.calls, [{ url: '/api/wallets/w1', method: 'PATCH', body: { iroh: { relayOnly: false } } }]);
	} finally {
		net.restore();
		await r.unmount();
	}
});

// Relay only covers Iroh, and the link carries the wallet's node id: what
// still ties that id to an address is boxed under the link, one box each.
test('a relay-only link warns, apart from its hint, about what still gives the address away', async () => {
	const live = { irohRelayOnly: true, irohRelayOnlyMode: 'loopback-pin' };
	const warnings = (r) => r.$$('[data-testid="connect-warning"]').map((el) => el.textContent);
	const hybrid = irohProps({ relayOnly: true, info: live });
	hybrid.rec = { ...hybrid.rec, networkMode: 'hybrid', announce: true, publicHost: '203.0.113.4', publicAddress: '203.0.113.4:19102', publicPort: 19102, listenPort: 9102 };
	const r = await render(wrapped, hybrid);
	try {
		assert.ok(shown(r).includes(IROH_URI), 'the link is still offered');
		const boxes = warnings(r);
		assert.equal(boxes.length, 2);
		assert.match(boxes[0], /announces its public address/);
		assert.match(boxes[1], /Hybrid mode/);
		assert.match(boxes[1], /Use Tor mode for a link you post publicly/);
		assert.doesNotMatch(r.$('[data-testid="connect-hint"]').textContent, /announces its public address/);
		assert.ok(r.$('[data-testid="connect-ways"]').parentElement.contains(r.$('[data-testid="connect-warning"]')), 'inside the Connect card');
	} finally { await r.unmount(); }
	// Tor mode with announcing off has nothing to warn about, and neither has
	// a link that is not offered as private.
	const tor = await render(wrapped, irohProps({ relayOnly: true, info: live }));
	try {
		assert.ok(shown(tor).includes(IROH_URI));
		assert.deepEqual(warnings(tor), []);
	} finally { await tor.unmount(); }
	const direct = irohProps();
	direct.rec = { ...direct.rec, networkMode: 'hybrid' };
	const d = await render(wrapped, direct);
	try {
		assert.deepEqual(warnings(d), []);
	} finally { await d.unmount(); }
});

test('a relay-only link is not shown while the daemon answering has not started with it', async () => {
	const r = await render(wrapped, irohProps({ relayOnly: true }));
	try {
		assert.ok(!shown(r).includes(IROH_URI), 'no link is offered as private on the record alone');
		assert.match(r.$('[data-testid="connect-hint"]').textContent, /has not started with it yet/);
		assert.equal(r.$('[data-testid="connect-ways"]').parentElement.querySelector('.qr'), null);
	} finally { await r.unmount(); }
});

test('the card stays on the Iroh link while the wallet restarts into Relay only', async () => {
	const { click } = await import('../../../test/render.mjs');
	const { useState } = await import('react');
	const net = captureFetch();
	// What the page hands the card once it refetches: the record says relay
	// only, and the restarting daemon has no link yet. Another way in still has
	// one, which is where the card would open if nothing had been picked.
	const published = (p) => ({ ...p, rec: { ...p.rec, publicPort: 19102, listenPort: 9102 } });
	const before = published(irohProps());
	const after = published(irohProps({ relayOnly: true, info: { irohUri: undefined } }));
	const Page = () => {
		const [p, setP] = useState(before);
		return createElement(ToastProvider, null, createElement(OverviewTab, { ...p, bump: () => setP(after) }));
	};
	const r = await render(Page, {});
	try {
		assert.ok(shown(r).includes(IROH_URI), 'opens on the Iroh link');
		await click(r.$('[data-testid="iroh-relay-only"]'));
		await click(r.$('[data-testid="iroh-relay-only-confirm"]'));
		await settle(400);
		const box = r.$('[data-testid="iroh-relay-only"]');
		assert.ok(box, 'the switch is still on the card');
		assert.equal(box.checked, true);
		assert.ok(!shown(r).includes(IROH_URI), 'no link while the wallet comes back');
		assert.match(r.$('[data-testid="connect-hint"]').textContent, /Starting the Iroh listener/);
		assert.match(r.$('[data-testid="connect-hint"]').textContent, /12 seconds/);
	} finally {
		net.restore();
		await r.unmount();
	}
	// The page remounts the card when the wallet restarts, so a fresh card has
	// to open there too, with nothing picked.
	const fresh = await render(wrapped, after);
	try {
		assert.equal(fresh.$('[data-testid="iroh-relay-only"]')?.checked, true);
		assert.match(fresh.$('[data-testid="connect-hint"]').textContent, /Starting the Iroh listener/);
	} finally { await fresh.unmount(); }
	// A link that switched itself off is not on its way: the card opens on a
	// way that works, and the Iroh way says why when it is picked.
	const off = await render(wrapped, published(irohProps({ relayOnly: true, info: { irohUri: undefined, irohListenError: { code: 'IROH_RELAY_ONLY_VIOLATED', message: 'Iroh relay-only cannot be kept: the endpoint holds 1 routable address(es).' } } })));
	try {
		assert.equal(off.$('[data-testid="iroh-relay-only"]'), null, 'opens on another way');
		assert.match(shown(off), new RegExp(`${NODE}@localhost:19102`));
		const iroh = Array.from(off.$('[data-testid="connect-ways"]').querySelectorAll('button')).find((b) => b.textContent.trim() === 'Iroh phone link');
		await click(iroh);
		assert.match(off.$('[data-testid="connect-hint"]').textContent, /relay-only cannot be kept/);
		assert.equal(off.$('[data-testid="iroh-relay-only"]').checked, true);
	} finally { await off.unmount(); }
});

test('a refused change stays in the dialog and says why', async () => {
	const { click } = await import('../../../test/render.mjs');
	const net = captureFetch({ ok: false, error: { code: 'IROH_RELAY_ONLY_UNSUPPORTED', message: 'The bundled engine cannot keep the Iroh link on the relay.' } });
	let bumped = 0;
	const r = await render(wrapped, { ...irohProps(), bump: () => { bumped += 1; } });
	try {
		await click(r.$('[data-testid="iroh-relay-only"]'));
		await click(r.$('[data-testid="iroh-relay-only-confirm"]'));
		await settle(50);
		assert.equal(bumped, 0);
		assert.ok(r.$('[data-testid="iroh-relay-only-confirm"]'), 'the dialog is still open');
		assert.match(document.body.textContent, /cannot keep the Iroh link on the relay/);
	} finally {
		net.restore();
		await r.unmount();
	}
});

test('a wallet left relay-only on an engine without the switch can still turn it off', async () => {
	const r = await render(wrapped, irohProps({ relayOnly: true, available: false, info: { irohUri: undefined } }));
	try {
		const box = r.$('[data-testid="iroh-relay-only"]');
		assert.ok(box);
		assert.equal(box.checked, true);
		assert.equal(box.disabled, false);
		assert.match(r.$('[data-testid="connect-hint"]').textContent, /bundled engine cannot provide it/);
	} finally { await r.unmount(); }
});
