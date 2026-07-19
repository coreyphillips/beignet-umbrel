// Demo-mode backend: an in-memory stand-in for the manager API and the
// per-wallet beignet daemons, so the dashboard can be explored with zero
// backend (enable with ?demo, VITE_DEMO=1, or sessionStorage beignet-demo=1).
// Field names mirror exactly what the real endpoints return and the UI reads.

const HEX = '0123456789abcdef';
let seedCounter = 7;
function rnd() {
	// Deterministic-ish PRNG so the demo looks stable across reloads.
	seedCounter = (seedCounter * 1103515245 + 12345) % 2147483648;
	return seedCounter / 2147483648;
}
function hex(n) {
	let s = '';
	for (let i = 0; i < n; i++) s += HEX[Math.floor(rnd() * 16)];
	return s;
}
function pubkey() {
	return (rnd() > 0.5 ? '02' : '03') + hex(64);
}
function pick(arr) {
	return arr[Math.floor(rnd() * arr.length)];
}
function between(min, max) {
	return Math.floor(min + rnd() * (max - min));
}

const WORDS =
	'abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake aware away awesome awful awkward axis'.split(
		' '
	);
function mnemonic(count = 24) {
	return Array.from({ length: count }, () => pick(WORDS)).join(' ');
}

const now = Date.now();
const DAY = 86400000;

function makeChannels(specs) {
	return specs.map(([capacitySats, localPct, state, isPrivate]) => {
		const localBalanceSats = Math.round((capacitySats * localPct) / 100);
		return {
			channelId: hex(64),
			peerPubkey: pubkey(),
			capacitySats,
			localBalanceSats,
			remoteBalanceSats: capacitySats - localBalanceSats,
			state,
			// beignet 0.6.0: NORMAL channels carry HTLCs; mid-splice channels
			// only when the pay-through flags are set on them explicitly.
			htlcUsable: state === 'NORMAL',
			isPrivate: !!isPrivate
		};
	});
}

function makeTxs(count, heightBase) {
	return Array.from({ length: count }, (_, i) => {
		const received = rnd() > 0.42;
		const confirmed = i > 1;
		const feeSats = received ? null : between(120, 3200);
		return {
			txid: hex(64),
			type: received ? 'received' : 'sent',
			valueSats: between(4000, 900000) * (received ? 1 : -1),
			feeSats,
			// The real endpoint returns these two and the list never showed them.
			satsPerVbyte: received ? null : between(2, 40),
			address: 'bc1q' + hex(38),
			confirmed,
			height: confirmed ? heightBase - i * between(2, 40) : null,
			timestamp: now - i * between(3, 30) * 3600000,
			confirmTimestamp: confirmed ? now - i * between(3, 30) * 3600000 + 900000 : null
		};
	});
}

function makePayments(count) {
	return Array.from({ length: count }, (_, i) => {
		const incoming = rnd() > 0.5;
		const status = i === 2 ? 'FAILED' : i === 0 ? 'PENDING' : 'COMPLETED';
		const createdAt = now - i * between(2, 20) * 3600000;
		return {
			paymentHash: hex(64),
			direction: incoming ? 'INCOMING' : 'OUTGOING',
			amountSats: between(210, 250000),
			feeSats: incoming ? null : between(0, 42),
			status,
			// A failed payment knows why, and the list only ever said "FAILED".
			...(status === 'FAILED'
				? {
						failureCode: 15,
						failureDescription:
							'No route to the destination with enough liquidity. Try a smaller amount, or open a channel with more outbound.'
				  }
				: {}),
			// Proof of payment, for the ones that went through.
			...(status === 'COMPLETED' && !incoming ? { preimage: hex(64) } : {}),
			...(status === 'COMPLETED' ? { route: { totalHops: between(2, 5) } } : {}),
			createdAt,
			completedAt: status === 'COMPLETED' ? createdAt + between(1, 9) * 1000 : null
		};
	});
}

function makeUtxos(count, heightBase) {
	return Array.from({ length: count }, (_, i) => ({
		txid: hex(64),
		vout: Math.floor(rnd() * 3),
		address: 'bc1q' + hex(38),
		valueSats: between(20000, 1200000),
		height: i === 0 ? null : heightBase - between(10, 4000)
	}));
}

function makeInvoices(count) {
	const descs = ['Coffee', 'Podcast boost', 'Invoice #1042', 'Consulting', 'Tip jar', ''];
	return Array.from({ length: count }, (_, i) => ({
		paymentHash: hex(64),
		amountSats: rnd() > 0.3 ? between(500, 120000) : null,
		description: pick(descs),
		status: i < 3 ? 'PAID' : 'PENDING'
	}));
}

function walletState({ blockHeight, channels, txs, payments, utxos, invoices, offers, peers }) {
	return { blockHeight, channels, txs, payments, utxos, invoices, offers, peers, addressN: 0 };
}

const store = {
	settings: {
		defaultNetwork: 'mainnet',
		defaultElectrum: { host: 'umbrel.local', port: 50001, tls: false }
	},
	wallets: [
		{
			id: 'demo-main',
			name: 'Main',
			network: 'mainnet',
			status: 'running',
			electrum: { host: 'umbrel.local', port: 50001, tls: false },
			tor: true,
			announce: true,
			onionAddress: hex(28) + 'onionexample.onion:9735',
			createdAt: now - 90 * DAY
		},
		{
			id: 'demo-savings',
			name: 'Savings',
			network: 'mainnet',
			status: 'running',
			electrum: { host: 'umbrel.local', port: 50001, tls: false },
			tor: false,
			announce: false,
			createdAt: now - 40 * DAY
		},
		{
			id: 'demo-testnet',
			name: 'Testnet playground',
			network: 'testnet',
			status: 'running',
			electrum: { host: 'testnet.aranguren.org', port: 51001, tls: false },
			tor: false,
			announce: false,
			createdAt: now - 12 * DAY
		}
	],
	state: {}
};

store.state['demo-main'] = walletState({
	blockHeight: 908214,
	channels: makeChannels([
		[2000000, 62, 'NORMAL'],
		[5000000, 38, 'NORMAL'],
		[1200000, 81, 'AWAITING_FUNDING_CONFIRMED'],
		[750000, 22, 'NORMAL', true]
	]),
	txs: makeTxs(25, 908214),
	payments: makePayments(40),
	utxos: makeUtxos(6, 908214),
	invoices: makeInvoices(8),
	offers: [
		{ offerId: hex(64), description: 'Donations', amountSats: null, encoded: 'lno1' + hex(120) },
		{ offerId: hex(64), description: 'Monthly dues', amountSats: 21000, encoded: 'lno1' + hex(120) }
	],
	peers: [
		{ pubkey: pubkey(), host: '84.21.100.4', port: 9735, state: 'connected' },
		{ pubkey: pubkey(), host: 'ln.acinq.co', port: 9735, state: 'connected' },
		{ pubkey: pubkey(), host: '192.168.4.20', port: 9736, state: 'connected' }
	]
});
store.state['demo-savings'] = walletState({
	blockHeight: 908214,
	channels: [],
	txs: makeTxs(9, 908214),
	payments: [],
	utxos: makeUtxos(3, 908214),
	invoices: [],
	offers: [],
	peers: []
});
store.state['demo-testnet'] = walletState({
	blockHeight: 3411502,
	// One channel mid-splice, so the splice-in-progress states are visitable
	// in the playground wallet.
	channels: (() => {
		const chans = makeChannels([
			[500000, 50, 'NORMAL'],
			[137295, 96, 'SPLICING']
		]);
		// Mid-splice the live balance stays pre-splice; the daemon reports the
		// settle-to figure separately (the mainnet numbers this mirrors), and
		// with 0.6.0 the channel pays through its splice.
		chans[1].pendingSpliceLocalBalanceSats = 211746;
		chans[1].htlcUsable = true;
		chans[1].payThroughSplice = true;
		return chans;
	})(),
	txs: makeTxs(6, 3411502),
	payments: makePayments(7),
	utxos: makeUtxos(2, 3411502),
	invoices: makeInvoices(3),
	offers: [],
	peers: [{ pubkey: pubkey(), host: '127.0.0.1', port: 9737, state: 'connected' }]
});

const nodeIds = {};
function nodeId(id) {
	if (!nodeIds[id]) nodeIds[id] = pubkey();
	return nodeIds[id];
}

function onchainBalance(id) {
	return store.state[id].utxos.reduce((a, u) => a + u.valueSats, 0);
}
function lightningBalance(id) {
	// Faithful to beignet 0.6.0: live channels count in full; a channel paying
	// through its splice counts at the conservative side of its two fundings.
	return store.state[id].channels.reduce((a, c) => {
		if (c.state === 'NORMAL' || c.state === 'AWAITING_REESTABLISH')
			return a + c.localBalanceSats;
		if (c.state === 'SPLICING' && c.payThroughSplice)
			return (
				a +
				Math.min(
					c.localBalanceSats,
					c.pendingSpliceLocalBalanceSats ?? c.localBalanceSats
				)
			);
		return a;
	}, 0);
}
function splicingBalance(id) {
	// Faithful to beignet 0.6.0: the in-transit remainder for pay-through
	// splices, the whole settle-to balance for parked ones.
	return store.state[id].channels
		.filter((c) => c.state === 'SPLICING')
		.reduce((a, c) => {
			const pending = c.pendingSpliceLocalBalanceSats ?? c.localBalanceSats;
			if (c.payThroughSplice)
				return a + Math.max(0, pending - c.localBalanceSats);
			return a + pending;
		}, 0);
}

// ---------- Event bus (demo replacement for the SSE stream) ----------

const listeners = new Map(); // walletId -> Set<fn>
let eventTimer = null;

function emit(walletId, name, data) {
	const set = listeners.get(walletId);
	if (set) set.forEach((fn) => fn(name, data));
}

function startAmbientEvents() {
	if (eventTimer) return;
	eventTimer = setInterval(() => {
		const running = store.wallets.filter((w) => w.status === 'running');
		if (!running.length) return;
		const w = pick(running);
		const st = store.state[w.id];
		if (rnd() > 0.35) {
			const amountSats = between(500, 90000);
			st.payments.unshift({
				paymentHash: hex(64),
				direction: 'INCOMING',
				amountSats,
				feeSats: null,
				status: 'COMPLETED',
				createdAt: Date.now(),
				completedAt: Date.now()
			});
			const ch = st.channels.find((c) => c.state === 'NORMAL' && c.remoteBalanceSats > amountSats);
			if (ch) {
				ch.localBalanceSats += amountSats;
				ch.remoteBalanceSats -= amountSats;
			}
			emit(w.id, 'payment:received', { amountSats });
		} else {
			emit(w.id, 'peer:connect', {});
		}
	}, 45000);
}

export const mockEvents = {
	subscribe(walletId, fn) {
		if (!listeners.has(walletId)) listeners.set(walletId, new Set());
		listeners.get(walletId).add(fn);
		startAmbientEvents();
		return () => listeners.get(walletId)?.delete(fn);
	}
};

// ---------- Request handling ----------

const latency = () => new Promise((r) => setTimeout(r, 150 + rnd() * 250));

function err(message, code = 'DEMO') {
	const e = new Error(message);
	e.code = code;
	return e;
}

function publicRecord(w) {
	// The manager never returns seeds; mirror its record shape.
	const { ...rec } = w;
	return rec;
}

const ELECTRUM_PRESETS = [
	{ id: 'electrs', label: 'Umbrel Electrs', host: 'umbrel.local', port: 50001, tls: false, note: 'Electrs app on this Umbrel' },
	{ id: 'fulcrum', label: 'Umbrel Fulcrum', host: 'umbrel.local', port: 50002, tls: true, note: 'Fulcrum app on this Umbrel' }
];

function managerRequest(path, method, body) {
	if (path === '/config') {
		return {
			defaultNetwork: store.settings.defaultNetwork,
			defaultElectrum: store.settings.defaultElectrum,
			hasDefaultElectrum: !!store.settings.defaultElectrum,
			supportedNetworks: ['mainnet', 'testnet', 'regtest'],
			electrumPresets: ELECTRUM_PRESETS,
			torAvailable: true,
			onionAvailable: true
		};
	}
	if (path === '/settings') {
		if (method === 'PUT') {
			Object.assign(store.settings, body);
			return store.settings;
		}
		return store.settings;
	}
	if (path === '/wallets' && method === 'GET') return store.wallets.map(publicRecord);
	if (path === '/wallets' && method === 'POST') {
		const id = 'demo-' + hex(6);
		const w = {
			id,
			name: body.name || 'New wallet',
			network: body.network || store.settings.defaultNetwork,
			status: 'running',
			electrum: body.electrum || store.settings.defaultElectrum || { host: '', port: 50001, tls: false },
			tor: !!body.tor,
			announce: !!body.announce,
			createdAt: Date.now()
		};
		store.wallets.push(w);
		store.state[id] = walletState({
			blockHeight: 908214,
			channels: [],
			txs: [],
			payments: [],
			utxos: [],
			invoices: [],
			offers: [],
			peers: []
		});
		return { record: publicRecord(w), mnemonic: mnemonic(body.wordCount || 24) };
	}
	if (path === '/wallets/import' && method === 'POST') {
		const words = String(body.mnemonic || '').trim().split(/\s+/);
		if (words.length !== 12 && words.length !== 24) throw err('Recovery phrase must be 12 or 24 words');
		const id = 'demo-' + hex(6);
		const w = {
			id,
			name: body.name || 'Imported wallet',
			network: body.network || store.settings.defaultNetwork,
			status: 'running',
			electrum: body.electrum || store.settings.defaultElectrum || { host: '', port: 50001, tls: false },
			tor: !!body.tor,
			announce: !!body.announce,
			createdAt: Date.now()
		};
		store.wallets.push(w);
		store.state[id] = walletState({
			blockHeight: 908214,
			channels: [],
			txs: makeTxs(4, 908214),
			payments: [],
			utxos: makeUtxos(2, 908214),
			invoices: [],
			offers: [],
			peers: []
		});
		return publicRecord(w);
	}

	const m = path.match(/^\/wallets\/([^/]+)(?:\/(.+))?$/);
	if (!m) throw err(`Unknown demo endpoint ${path}`, 'NOT_FOUND');
	const w = store.wallets.find((x) => x.id === m[1]);
	if (!w) throw err('Wallet not found', 'NOT_FOUND');
	// m[2] still carries any query string (e.g. "errors?since=123").
	const [sub, subQuery] = (m[2] || '').split('?');

	if (!sub) {
		if (method === 'GET') return publicRecord(w);
		if (method === 'PATCH') {
			if (body.name) w.name = body.name;
			if (body.electrum) w.electrum = body.electrum;
			if (body.tor !== undefined) w.tor = !!body.tor;
			if (body.announce !== undefined) w.announce = !!body.announce;
			return publicRecord(w);
		}
		if (method === 'DELETE') {
			store.wallets = store.wallets.filter((x) => x.id !== w.id);
			delete store.state[w.id];
			return { deleted: true };
		}
	}
	if (sub === 'start') {
		w.status = 'starting';
		setTimeout(() => {
			w.status = 'running';
			emit(w.id, 'node:ready', {});
		}, 1500);
		return publicRecord(w);
	}
	if (sub === 'stop') {
		w.status = 'stopped';
		return publicRecord(w);
	}
	// Both return the same shapes as the real manager: a flat array of log lines,
	// and a list of node errors captured off the daemon's event stream.
	if (sub === 'logs') return demoLogLines(w).concat(errorLogLines(w.id));
	if (sub === 'errors') {
		// The real endpoint filters by timestamp, and a caller watching an open
		// relies on it to ignore anything from an earlier attempt.
		const since = parseInt(new URLSearchParams(subQuery || '').get('since'), 10);
		const all = demoNodeErrors().concat(runtimeErrors[w.id] || []);
		return Number.isFinite(since) ? all.filter((e) => e.timestamp >= since) : all;
	}
	throw err(`Unknown demo endpoint ${path}`, 'NOT_FOUND');
}

// Peers commonly refuse channels below a minimum. Demo opens under this are
// rejected, so the failure path is reachable without a real peer.
const DEMO_MIN_CHANNEL_SATS = 400000;

// A previously failed channel open, so the Logs tab has something to show.
const DEMO_ERROR_AT = Date.now() - 45000;

const runtimeErrors = {};

function recordError(id, entry) {
	(runtimeErrors[id] = runtimeErrors[id] || []).push(entry);
}

function errorLogLines(id) {
	return (runtimeErrors[id] || []).map(
		(e) => `[${new Date(e.timestamp).toISOString()}] node error [${e.code}] ${e.message}`
	);
}

function demoNodeErrors() {
	return [
		{
			code: 'CHANNEL_ERROR',
			message: 'Remote error: invalid funding_amount=100000 sat (min=400000 sat)',
			channelId: '3f72ef8ddbb7c08cb9d8b945855aba6b99ccf15b156c80d1c2c2e1e1a0e12c58',
			timestamp: DEMO_ERROR_AT
		}
	];
}

function demoLogLines(w) {
	const at = (offset) => new Date(DEMO_ERROR_AT + offset).toISOString();
	return [
		`[${at(-60000)}] starting on 127.0.0.1:${w.port || 3101} (network ${w.network}, electrum ${w.electrum?.host || 'electrs'}:${w.electrum?.port || 50001} tls=false)`,
		`[${at(-52000)}] Daemon listening on 127.0.0.1:${w.port || 3101}`,
		`[${at(-50000)}] healthy`,
		`[${at(-12000)}] Peer connected 03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f`,
		`[${at(-8000)}] Opening channel 100000 sat`,
		`[${at(0)}] node error [CHANNEL_ERROR] Remote error: invalid funding_amount=100000 sat (min=400000 sat)`
	];
}

function walletRequest(id, path, method, body) {
	const w = store.wallets.find((x) => x.id === id);
	if (!w) throw err('Wallet not found', 'NOT_FOUND');
	if (w.status !== 'running') throw err('Wallet is not running', 'NOT_RUNNING');
	const st = store.state[id];
	const [route, query] = path.split('?');

	switch (route) {
		case '/info':
			return {
				nodeId: nodeId(id),
				blockHeight: st.blockHeight,
				onchainBalanceSats: onchainBalance(id),
				lightningBalanceSats: lightningBalance(id),
				pendingCloseBalanceSats: 0,
				splicingBalanceSats: splicingBalance(id),
				channelCount: st.channels.length,
				peerCount: st.peers.length,
				listening: true
			};
		case '/health':
			return {
				status: 'ready',
				electrumConnected: true,
				graphNodes: 14204,
				graphChannels: 51872
			};
		case '/balance': {
			const onchain = onchainBalance(id);
			const lightning = lightningBalance(id);
			return {
				onchain,
				lightning,
				total: onchain + lightning,
				splicingSats: splicingBalance(id)
			};
		}
		case '/readiness':
			return {
				score: st.channels.length ? 82 : 45,
				ready: st.channels.length > 0,
				checks: [
					{ name: 'backup', status: 'PASS', message: 'Seed backed up' },
					{ name: 'electrum', status: 'PASS', message: 'Electrum server reachable' },
					{ name: 'channels', status: st.channels.length ? 'PASS' : 'FAIL', message: st.channels.length ? `${st.channels.length} channels open` : 'No channels open' },
					{ name: 'inbound', status: 'WARN', message: 'Limited inbound liquidity' },
					{ name: 'tor', status: w.tor ? 'PASS' : 'WARN', message: w.tor ? 'Lightning over Tor' : 'Tor not enabled' },
					{ name: 'peers', status: st.peers.length > 1 ? 'PASS' : 'WARN', message: `${st.peers.length} peers connected` }
				]
			};
		case '/liquidity': {
			const totalLocalBalanceSats = lightningBalance(id);
			const totalCapacitySats = st.channels.reduce((a, c) => a + c.capacitySats, 0);
			const totalRemoteBalanceSats = totalCapacitySats - totalLocalBalanceSats;
			const outboundLiquidityPct = totalCapacitySats
				? Math.round((totalLocalBalanceSats / totalCapacitySats) * 100)
				: 0;
			return {
				channelCount: st.channels.length,
				activeChannelCount: st.channels.filter((c) => c.state === 'NORMAL').length,
				totalLocalBalanceSats,
				totalRemoteBalanceSats,
				totalCapacitySats,
				outboundLiquidityPct,
				inboundLiquidityPct: totalCapacitySats ? 100 - outboundLiquidityPct : 0,
				recommendations:
					outboundLiquidityPct > 70
						? [{ reason: 'Most liquidity is outbound. Consider spending or splicing out to gain inbound capacity.' }]
						: []
			};
		}
		case '/fees':
			return { recommendation: 'NORMAL', estimatedOpenChannelCostSats: 2140 };
		case '/fees/estimates':
			return { fast: 18, normal: 7, slow: 2 };
		case '/tx/quote': {
			// The daemon prices this from real coin selection. Here it is modelled:
			// every UTXO is spent (the wallet consolidates), a sweep needs no change
			// output, and a channel is funded into a P2WSH, which is bigger than the
			// P2WPKH an ordinary payment pays to.
			const rate = body.satsPerVbyte || 7;
			const nIn = st.utxos.length || 1;
			const outVb = body.channelFunding ? 43 : 31;
			const changeVb = body.max ? 0 : 31;
			const vsize = Math.ceil(10.5 + nIn * 68 + outVb + changeVb);
			const feeSats = vsize * rate;
			const balance = onchainBalance(id);
			return {
				satsPerVbyte: rate,
				feeSats,
				vsize,
				...(body.max ? { maxSendSats: Math.max(0, balance - feeSats) } : {}),
				maxSatsPerVbyte: Math.floor(balance / 2 / vsize)
			};
		}
		case '/address/new':
			st.addressN += 1;
			return { address: (w.network === 'mainnet' ? 'bc1q' : 'tb1q') + hex(38) };
		case '/invoice/create': {
			const inv = {
				paymentHash: hex(64),
				bolt11: (w.network === 'mainnet' ? 'lnbc' : 'lntb') + (body.amountSats ? body.amountSats * 10 + 'n' : '') + '1' + hex(180),
				amountSats: body.amountSats || null,
				description: body.description || '',
				status: 'PENDING'
			};
			st.invoices.unshift(inv);
			return inv;
		}
		case '/invoices':
			return st.invoices;
		case '/invoice/decode':
			if (!/^ln/i.test(body.bolt11 || '')) throw err('Not a BOLT11 invoice');
			return {
				amountSats: between(1000, 60000),
				description: 'Demo invoice',
				payeeNodeKey: pubkey()
			};
		case '/payment/estimate':
			return { estimatedFeeSats: between(1, 30), successProbabilityPct: between(88, 99), hopCount: between(1, 4) };
		case '/invoice/pay-safe': {
			const amountSats = between(1000, 60000);
			const feeSats = between(0, 25);
			st.payments.unshift({
				paymentHash: hex(64),
				direction: 'OUTGOING',
				amountSats,
				feeSats,
				status: 'COMPLETED',
				createdAt: Date.now(),
				completedAt: Date.now()
			});
			const ch = st.channels.find((c) => c.state === 'NORMAL' && c.localBalanceSats > amountSats);
			if (ch) {
				ch.localBalanceSats -= amountSats + feeSats;
				ch.remoteBalanceSats += amountSats + feeSats;
			}
			setTimeout(() => emit(id, 'payment:sent', { amountSats }), 400);
			return { status: 'COMPLETED', feeSats };
		}
		case '/keysend/safe': {
			const amountSats = body.amountSats || 0;
			st.payments.unshift({
				paymentHash: hex(64),
				direction: 'OUTGOING',
				amountSats,
				feeSats: between(0, 10),
				status: 'COMPLETED',
				createdAt: Date.now(),
				completedAt: Date.now()
			});
			setTimeout(() => emit(id, 'payment:sent', { amountSats }), 400);
			return { status: 'COMPLETED' };
		}
		case '/send': {
			const amountSats = body.amountSats || 0;
			const txid = hex(64);
			st.txs.unshift({
				txid,
				type: 'sent',
				valueSats: -amountSats,
				feeSats: between(200, 2500),
				confirmed: false,
				height: null,
				timestamp: Date.now(),
				confirmTimestamp: null
			});
			if (st.utxos.length) st.utxos.shift();
			return { txid };
		}
		case '/send-max': {
			const balance = onchainBalance(id);
			if (!balance) throw err('No spendable UTXOs', 'SEND_FAILED');
			const rate = body.satsPerVbyte || 7;
			const feeSats = Math.min(balance - 1, Math.ceil(10.5 + st.utxos.length * 68 + 31) * rate);
			const txid = hex(64);
			st.txs.unshift({
				txid,
				type: 'sent',
				valueSats: -(balance - feeSats),
				feeSats,
				confirmed: false,
				height: null,
				timestamp: Date.now(),
				confirmTimestamp: null
			});
			st.utxos = [];
			return { txid, hex: hex(400) };
		}
		case '/transactions/boostable': {
			const pending = st.txs.filter((t) => !t.confirmed);
			return {
				rbf: pending.filter((t) => t.type === 'sent'),
				cpfp: pending.filter((t) => t.type === 'received')
			};
		}
		case '/tx/boost': {
			const tx = st.txs.find((t) => t.txid === body.txid && !t.confirmed);
			if (!tx) throw err(`Transaction ${body.txid} is not boostable`, 'NOT_BOOSTABLE');
			const rate = body.satsPerVbyte || 10;
			const newTxid = hex(64);
			if (tx.type === 'sent') {
				// RBF: replace the tx with a higher-fee version
				const feeSats = Math.max((tx.feeSats || 0) + 200, Math.ceil(141 * rate));
				tx.txid = newTxid;
				tx.feeSats = feeSats;
				tx.timestamp = Date.now();
				return { txid: newTxid, hex: hex(400), boostType: 'rbf', feeSats, originalTxid: body.txid };
			}
			// CPFP: a child tx spends the incoming output at a higher fee
			const feeSats = Math.ceil(141 * rate) + (tx.feeSats || 0);
			st.txs.unshift({
				txid: newTxid,
				type: 'sent',
				valueSats: -feeSats,
				feeSats,
				confirmed: false,
				height: null,
				timestamp: Date.now(),
				confirmTimestamp: null
			});
			return { txid: newTxid, hex: hex(400), boostType: 'cpfp', feeSats, originalTxid: body.txid };
		}
		case '/channels':
			return st.channels;
		case '/channel/diagnostics': {
			const cid = new URLSearchParams(query).get('channelId');
			const c = st.channels.find((x) => x.channelId === cid);
			if (!c) throw err('Channel not found', 'NOT_FOUND');
			const normal = c.state === 'NORMAL';
			const scid = '0c800000010000';
			const issues = [];
			if (!normal) issues.push(`NOT_NORMAL: Channel state is ${c.state}. Routing hints require NORMAL state.`);
			if (c.remoteBalanceSats === 0) issues.push('NO_INBOUND: Remote balance is 0. You cannot receive payments on this channel.');
			return {
				channelId: c.channelId,
				peerPubkey: c.peerPubkey,
				state: c.state,
				preReestablishState: null,
				isPeerConnected: normal,
				announceChannel: !c.isPrivate,
				announcementSigsSent: normal && !c.isPrivate,
				announcementSigsReceived: normal && !c.isPrivate,
				scidAlias: null,
				remoteScidAlias: null,
				shortChannelId: normal ? scid + '00' : null,
				effectiveScid: normal ? scid + '00' : null,
				willGenerateRoutingHint: normal,
				localBalanceSats: c.localBalanceSats,
				remoteBalanceSats: c.remoteBalanceSats,
				issues
			};
		}
		case '/channel/health': {
			const cid = new URLSearchParams(query).get('channelId');
			const c = st.channels.find((x) => x.channelId === cid);
			if (!c) throw err('Channel not found', 'NOT_FOUND');
			const total = c.localBalanceSats + c.remoteBalanceSats || 1;
			const localPct = Math.round((c.localBalanceSats / total) * 100);
			const warnings = [];
			if (localPct < 10) warnings.push('LOW_OUTBOUND_LIQUIDITY');
			if (localPct > 90) warnings.push('LOW_INBOUND_LIQUIDITY');
			return {
				channelId: c.channelId,
				state: c.state,
				localBalancePct: localPct,
				remoteBalancePct: 100 - localPct,
				htlcCount: c.state === 'NORMAL' ? 1 : 0,
				maxHtlcs: 483,
				capacitySats: c.capacitySats,
				warnings
			};
		}
		case '/channel/policy': {
			const cid = new URLSearchParams(query).get('channelId');
			const c = st.channels.find((x) => x.channelId === cid);
			if (!c) throw err('Channel not found', 'NOT_FOUND');
			return {
				channelId: c.channelId,
				feeBaseMsat: 1000,
				feeProportionalMillionths: 100,
				cltvExpiryDelta: 80,
				htlcMinimumMsat: '1000',
				htlcMaximumMsat: String(c.capacitySats * 1000),
				source: 'node-default'
			};
		}
		case '/channel/splice-quote': {
			const c = st.channels.find((x) => x.channelId === body.channelId);
			if (!c) throw err('Channel not found', 'NOT_FOUND');
			const perkw = body.feeratePerkw || 253;
			if (body.direction === 'out') {
				// Mirrors the daemon: local balance net of the peer-set reserve,
				// fee for a splice tx with no wallet inputs.
				const reserveSats = Math.max(354, Math.ceil(c.capacitySats / 100));
				const feeSats = Math.ceil((700 * perkw) / 1000);
				const spendableSats = Math.max(0, c.localBalanceSats - reserveSats);
				return {
					direction: 'out',
					feeSats,
					spendableSats,
					maxAmountSats: Math.max(0, spendableSats - feeSats),
					reserveSats
				};
			}
			const spendableSats = onchainBalance(w.id);
			const feeSats = Math.ceil((1000 * perkw) / 1000);
			return {
				direction: 'in',
				feeSats,
				spendableSats,
				maxAmountSats: Math.max(0, spendableSats - feeSats),
				inputCount: 3
			};
		}
		case '/channel/connect-and-open': {
			// Faithful to the daemon: the open returns as soon as open_channel is
			// sent, with the channel still pending under a *temporary* id. Whether
			// it funds or fails is decided afterwards.
			const c = {
				channelId: hex(64),
				peerPubkey: body.pubkey,
				capacitySats: body.amountSats,
				localBalanceSats: body.amountSats - (body.pushSats || 0),
				remoteBalanceSats: body.pushSats || 0,
				state: 'SENT_OPEN',
				isPrivate: false
			};
			st.channels.push(c);
			const drop = () => {
				st.channels = st.channels.filter((x) => x !== c);
			};
			if (body.amountSats < DEMO_MIN_CHANNEL_SATS) {
				// The peer rejects it. The channel disappears and the reason arrives
				// as a node error, which is what the real failure looks like.
				setTimeout(() => {
					drop();
					recordError(id, {
						code: 'CHANNEL_ERROR',
						message: `Remote error: invalid funding_amount=${body.amountSats} sat (min=${DEMO_MIN_CHANNEL_SATS} sat)`,
						channelId: c.channelId,
						timestamp: Date.now()
					});
				}, 3000);
				return c;
			}
			setTimeout(() => {
				// Funding built and broadcast: only now have the on-chain funds moved.
				c.state = 'AWAITING_FUNDING_CONFIRMED';
				// The permanent channel id replaces the temporary one.
				c.channelId = hex(64);
			}, 3000);
			setTimeout(() => {
				c.state = 'NORMAL';
				emit(id, 'channel:ready', {});
			}, 9000);
			return c;
		}
		case '/channel/close':
		case '/channel/forceclose': {
			const c = st.channels.find((x) => x.channelId === body.channelId);
			if (!c) throw err('Channel not found');
			c.state = route.endsWith('forceclose') ? 'FORCE_CLOSED' : 'NEGOTIATING_CLOSING';
			setTimeout(() => {
				store.state[id].channels = store.state[id].channels.filter(
					(x) => x.channelId !== body.channelId
				);
				emit(id, 'channel:closed', {});
			}, 6000);
			return { ok: true };
		}
		case '/channel/splice-in':
		case '/channel/splice-out': {
			const c = st.channels.find((x) => x.channelId === body.channelId);
			if (!c) throw err('Channel not found');
			const amt = body.amountSats || 0;
			if (route.endsWith('splice-in')) {
				c.capacitySats += amt;
				c.localBalanceSats += amt;
			} else {
				if (amt > c.localBalanceSats) throw err('Amount exceeds local balance');
				c.capacitySats -= amt;
				c.localBalanceSats -= amt;
				st.utxos.push({ txid: hex(64), vout: 0, address: 'bc1q' + hex(38), valueSats: amt, height: null });
			}
			return { ok: true };
		}
		case '/peers':
			return st.peers;
		case '/peer/connect':
			st.peers.push({ pubkey: body.pubkey, host: body.host, port: body.port, state: 'connected' });
			emit(id, 'peer:connect', {});
			return { ok: true };
		case '/peer/disconnect':
			st.peers = st.peers.filter((p) => p.pubkey !== body.pubkey);
			emit(id, 'peer:disconnect', {});
			return { ok: true };
		case '/node/uri': {
			const host = new URLSearchParams(query || '').get('host') || '127.0.0.1';
			return { uri: `${nodeId(id)}@${host}:9735` };
		}
		case '/transactions':
			return st.txs;
		case '/payments':
			return st.payments;
		case '/utxos':
			return st.utxos;
		case '/offers':
			return st.offers;
		case '/offer/create': {
			const o = {
				offerId: hex(64),
				description: body.description || '',
				amountSats: body.amountSats || null,
				encoded: 'lno1' + hex(120)
			};
			st.offers.unshift(o);
			return o;
		}
		case '/offer/pay':
			if (!/^lno/i.test(body.offer || '')) throw err('Not a BOLT12 offer');
			setTimeout(() => emit(id, 'payment:sent', {}), 400);
			return { status: 'COMPLETED' };
		default:
			throw err(`Unknown demo endpoint ${route}`, 'NOT_FOUND');
	}
}

export async function mockRequest(path, { method = 'GET', body } = {}) {
	await latency();
	if (path.startsWith('/api/')) return managerRequest(path.slice(4), method, body);
	const m = path.match(/^\/wallets\/([^/]+)\/api(\/.*)$/);
	if (m) return walletRequest(m[1], m[2], method, body);
	throw err(`Unknown demo endpoint ${path}`, 'NOT_FOUND');
}
