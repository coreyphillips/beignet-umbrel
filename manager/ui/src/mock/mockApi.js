// Demo-mode backend: an in-memory stand-in for the manager API and the
// per-wallet beignet daemons, so the dashboard can be explored with zero
// backend (enable with ?demo, VITE_DEMO=1, or sessionStorage beignet-demo=1).
// Field names mirror exactly what the real endpoints return and the UI reads.

import {
	bech32Decode,
	bech32Encode,
	classifyAddress,
	convertBits,
	parseBolt11Hrp
} from '../lib/payment-uri.js';

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

// A string's own hex, the same every time it is asked for. Anything the mock
// derives from a pasted invoice has to be stable, or the same paste decodes
// differently twice and the demo looks broken rather than fake.
function derivedHex(seed, length) {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) h = ((h ^ seed.charCodeAt(i)) * 16777619) >>> 0;
	let out = '';
	while (out.length < length) {
		h = (h * 1103515245 + 12345) >>> 0;
		out += HEX[(h >> 4) & 15] + HEX[(h >> 12) & 15] + HEX[(h >> 20) & 15] + HEX[(h >> 28) & 15];
	}
	return out.slice(0, length);
}

// signet shares testnet's address prefix, and is here because parseBolt11Hrp
// can hand back 'signet' from an lntbs invoice. Without it the lookup missed and
// fell through to mainnet, so a signet invoice decoded as network 'bc'.
const SEGWIT_HRP = { mainnet: 'bc', testnet: 'tb', signet: 'tb', regtest: 'bcrt' };
const BOLT11_HRP = { mainnet: 'lnbc', testnet: 'lntb', signet: 'lntbs', regtest: 'lnbcrt' };

// beignet 0.6.0 carries HTLCs on NORMAL channels and on a channel paying through
// its splice, which is the same rule the Send tab and /liquidity below use.
const htlcUsable = (c) => c.htlcUsable ?? c.state === 'NORMAL';

// beignet prices a v2 funding contribution in sat/kw, and the dashboard talks in
// sat/vB. One vbyte is four weight units.
const SATVB_TO_PERKW_MOCK = 250;

// Peers whose alias belongs to an implementation that advertises dual funding, so
// a max open toward one is priced the v2 way and toward the rest the v1 way, and
// both answers are visitable in the demo.
const DUAL_FUND_ALIASES = new Set(['ACINQ', 'endurance']);

const SECOND = 1000;
/** Seconds since the epoch, which is what a BOLT11 timestamp is counted in. */
const inSeconds = (ms) => Math.floor(ms / SECOND);

// The dashboard checks a pasted address against its own checksum before it will
// put it in a send form, so the demo has to hand out addresses that pass one.
// A random 20-byte witness program, encoded the way the daemon encodes it.
function demoAddress(network = 'mainnet') {
	const program = Array.from({ length: 20 }, () => Math.floor(rnd() * 256));
	return bech32Encode(SEGWIT_HRP[network] || 'bc', [0].concat(convertBits(program, 8, 5, true)));
}

// Likewise for invoices: the amount rides in the human readable part, in nano
// bitcoin (a satoshi is ten of them), and the body is bech32 rather than hex,
// which is not the same alphabet.
function demoInvoice(network = 'mainnet', amountSats = null) {
	const hrp = (BOLT11_HRP[network] || 'lnbc') + (amountSats ? `${amountSats * 10}n` : '');
	return bech32Encode(hrp, Array.from({ length: 220 }, () => Math.floor(rnd() * 32)));
}

/**
 * The invoice behind a string, if one of the demo wallets minted it, and which
 * wallet that was. The payee matters: the daemon warns about an invoice only
 * when it is your own node's, because that is the case where the reader is also
 * the one who can do something about it.
 */
function mintedInvoice(bolt11) {
	if (!bolt11) return null;
	for (const [walletId, state] of Object.entries(store.state)) {
		const hit = state.invoices.find((inv) => inv.bolt11 === bolt11);
		if (hit) return { invoice: hit, walletId };
	}
	return null;
}

/**
 * The offer equivalent of mintedInvoice: an offer one demo wallet published has
 * to decode in another, since paying across the demo wallets is the point of
 * there being more than one.
 */
function mintedOffer(encoded) {
	if (!encoded) return null;
	for (const [walletId, state] of Object.entries(store.state)) {
		const hit = state.offers.find((o) => o.encoded === encoded);
		if (hit) return { offer: hit, walletId };
	}
	return null;
}

/**
 * An invoice as the daemon reports it, status derived rather than stored.
 *
 * The daemon works status out on every read: PAID when an incoming payment for
 * the hash completed, EXPIRED once createdAt plus expiry has passed, PENDING
 * otherwise. Storing it meant the mock never emitted EXPIRED at all, and the
 * deliberately three-day-old seeded invoice was labelled PAID.
 *
 * createdAt is seconds, which is what a BOLT11 timestamp is and what the daemon
 * carries. The mock held milliseconds and divided them back down in decode,
 * which was self-consistent and wrong against the real thing: an "expires in"
 * column would have read correctly here and shown 1970 on an Umbrel.
 */
function invoiceInfo(inv) {
	const status = inv.paid
		? 'PAID'
		: inSeconds(Date.now()) > inv.createdAt + inv.expiry
		? 'EXPIRED'
		: 'PENDING';
	return {
		bolt11: inv.bolt11,
		paymentHash: inv.paymentHash,
		amountSats: inv.amountSats,
		description: inv.description,
		expiry: inv.expiry,
		createdAt: inv.createdAt,
		status
	};
}

/** What paying this invoice would move, the payer's own figure included. */
function invoiceAmount(bolt11, given) {
	const minted = mintedInvoice(String(bolt11 || '').trim());
	if (minted?.invoice.amountSats) return minted.invoice.amountSats;
	if (!minted) {
		const hrp = parseBolt11Hrp(String(bolt11 || '').trim());
		if (hrp.ok && hrp.amountMsat != null) return Number(hrp.amountMsat / 1000n);
	}
	// An invoice that names no amount leaves it to the payer.
	return Math.floor(Number(given) || 0);
}

/** Would the daemon accept this as a destination on this wallet's chain. */
function payableAddress(address, network) {
	const classified = classifyAddress(String(address || '').trim());
	return classified.ok && classified.networks.includes(network);
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
	return specs.map(([capacitySats, localPct, state, isPrivate, alias]) => {
		const localBalanceSats = Math.round((capacitySats * localPct) / 100);
		return {
			channelId: hex(64),
			peerPubkey: pubkey(),
			// Not returned by the daemon; the mock keeps it so /graph/node can
			// resolve the channel peer's alias, mirroring the gossip lookup.
			alias: alias || null,
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

// The wallet's own chain, not mainnet. Without it the testnet playground's
// history and coins carried bc1… addresses, which is a chain the wallet showing
// them cannot spend on.
function makeTxs(count, heightBase, network = 'mainnet') {
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
			address: demoAddress(network),
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

function makeUtxos(count, heightBase, network = 'mainnet') {
	return Array.from({ length: count }, (_, i) => ({
		txid: hex(64),
		vout: Math.floor(rnd() * 3),
		address: demoAddress(network),
		valueSats: between(20000, 1200000),
		height: i === 0 ? null : heightBase - between(10, 4000)
	}));
}

const INVOICE_EXPIRY_SECONDS = 3600;

// How old each seeded invoice is, in minutes, and whether it was paid. Between
// them these reach every status the table can show, now that status is derived
// from the age rather than stored: inside the hour and unpaid is PENDING, past
// it is EXPIRED, and paid stays PAID whatever the age. Ages are written out
// rather than derived from the index so a change to one does not silently empty
// a whole status of its examples.
const INVOICE_SHAPES = [
	[1, false], // just minted
	[20, false], // still open, and the one that names no amount
	[3 * 24 * 60, false], // three days old
	[5, true],
	[45, false],
	[90, true], // paid before it ran out
	[150, false],
	[10, false]
];

function makeInvoices(count, network = 'mainnet') {
	const descs = ['Coffee', 'Podcast boost', 'Invoice #1042', 'Consulting', 'Tip jar', ''];
	return Array.from({ length: count }, (_, i) => {
		// One of every shape the Send tab has to render: an ordinary invoice, one
		// that names no amount (the payer chooses), and one old enough to have
		// expired. All three are copyable out of the invoices table, so all three
		// are reachable in the demo.
		const amountSats = i === 1 ? null : rnd() > 0.3 ? between(500, 120000) : null;
		const [minutesOld, paid] = INVOICE_SHAPES[i % INVOICE_SHAPES.length];
		return {
			paymentHash: hex(64),
			bolt11: demoInvoice(network, amountSats),
			amountSats,
			description: pick(descs),
			createdAt: inSeconds(now - minutesOld * 60 * SECOND),
			expiry: INVOICE_EXPIRY_SECONDS,
			// Not a status. That is worked out on every read, so the three day old
			// one reports EXPIRED on its own rather than being labelled PAID by an
			// index, and an invoice left on screen crosses over as it ages.
			paid
		};
	});
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
		},
		{
			id: 'demo-fresh',
			name: 'Fresh channel',
			network: 'mainnet',
			status: 'running',
			electrum: { host: 'umbrel.local', port: 50001, tls: false },
			tor: false,
			announce: false,
			createdAt: now - 2 * 3600000
		}
	],
	state: {}
};

const mainChannels = makeChannels([
	[2000000, 62, 'NORMAL', false, 'ACINQ'],
	[5000000, 38, 'NORMAL', false, 'WalletOfSatoshi.com'],
	[1200000, 81, 'AWAITING_FUNDING_CONFIRMED', false, 'Bitrefill'],
	// No alias: an unannounced peer, so the list falls back to the pubkey.
	[750000, 22, 'NORMAL', true],
	// Closed history, so the channels view's Closed tab is visitable: a
	// cooperative close and a force close (the latter waiting out its CSV
	// delay). Neither counts toward balances or liquidity.
	[1500000, 30, 'CLOSED', false, 'Sparky'],
	[650000, 45, 'FORCE_CLOSED', false, 'endurance']
]);
// True to life: eclair splices, LND does not, and the daemon reads it off each
// peer's init (beignet 0.8.2+). The WalletOfSatoshi channel demos the Channels
// tab hiding its splice buttons on an explicit no; the unannounced peer's
// channel says nothing, the shape an old daemon or a disconnected peer leaves.
mainChannels[0].peerSupportsSplicing = true;
mainChannels[1].peerSupportsSplicing = false;

store.state['demo-main'] = walletState({
	blockHeight: 908214,
	channels: mainChannels,
	txs: makeTxs(25, 908214),
	payments: makePayments(40),
	utxos: makeUtxos(6, 908214),
	invoices: makeInvoices(8),
	offers: [
		{ offerId: hex(64), description: 'Donations', amountSats: null, encoded: 'lno1' + hex(120) },
		{ offerId: hex(64), description: 'Monthly dues', amountSats: 21000, encoded: 'lno1' + hex(120) }
	],
	peers: [
		{ pubkey: pubkey(), host: '84.21.100.4', port: 9735, state: 'connected', alias: 'WalletOfSatoshi.com' },
		{ pubkey: pubkey(), host: 'ln.acinq.co', port: 9735, state: 'connected', alias: 'ACINQ' },
		// No alias: a node that has not announced itself to the gossip graph, so
		// the peers table falls back to just the pubkey.
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
	txs: makeTxs(6, 3411502, 'testnet'),
	payments: makePayments(7),
	utxos: makeUtxos(2, 3411502, 'testnet'),
	invoices: makeInvoices(3, 'testnet'),
	offers: [],
	peers: [{ pubkey: pubkey(), host: '127.0.0.1', port: 9737, state: 'connected', alias: 'endurance' }]
});
// A newly opened channel funded mostly on the peer's side: the local balance
// (12,000) sits below the 20,000 reserve, so nothing is sendable yet and the
// Liquidity card shows the reserve-to-unlock state.
store.state['demo-fresh'] = walletState({
	blockHeight: 908214,
	channels: makeChannels([[2000000, 0.6, 'NORMAL']]),
	txs: makeTxs(3, 908214),
	payments: [],
	utxos: makeUtxos(1, 908214),
	invoices: [],
	offers: [],
	peers: [{ pubkey: pubkey(), host: '203.0.113.8', port: 9735, state: 'connected', alias: 'ACINQ' }]
});

// Durable channel history, mirroring the manager's channel-events log: the
// real manager records lifecycle events off the daemon's stream and serves
// them back at /wallets/:id/channel-events for the detail view's History
// section. Seeded so the demo's closed channels have a story: the force-closed
// one tells the reestablish-watchdog incident (beignet #212) that motivated
// the feature.
const channelEvents = {};

function recordChannelEvent(walletId, entry) {
	if (!channelEvents[walletId]) channelEvents[walletId] = [];
	channelEvents[walletId].push({ timestamp: Date.now(), ...entry });
}

{
	const day = 86400000;
	const chans = store.state['demo-main'].channels;
	const acinq = chans[0];
	const sparky = chans[4];
	const endurance = chans[5];
	channelEvents['demo-main'] = [
		{ timestamp: now - 41 * day, event: 'channel:opening', channelId: sparky.channelId, fundingTxid: hex(64) },
		{ timestamp: now - 41 * day + 3600000, event: 'channel:ready', channelId: sparky.channelId },
		{ timestamp: now - 30 * day, event: 'channel:opening', channelId: endurance.channelId, fundingTxid: hex(64) },
		{ timestamp: now - 30 * day + 2400000, event: 'channel:ready', channelId: endurance.channelId },
		{ timestamp: now - 25 * day, event: 'channel:opening', channelId: acinq.channelId, fundingTxid: hex(64) },
		{ timestamp: now - 25 * day + 1200000, event: 'channel:ready', channelId: acinq.channelId },
		{ timestamp: now - 6 * day, event: 'channel:pending-close', channelId: sparky.channelId, initiator: 'local' },
		{ timestamp: now - 6 * day + 1800000, event: 'channel:closed', channelId: sparky.channelId },
		{
			timestamp: now - 2 * day,
			event: 'node:error',
			channelId: endurance.channelId,
			code: 'REESTABLISH_TIMEOUT_FORCE_CLOSED',
			message: 'Channel stuck in AWAITING_REESTABLISH for > 2016 blocks, force-closing'
		},
		{ timestamp: now - 2 * day + 1000, event: 'channel:force-closing', channelId: endurance.channelId, initiator: 'local' }
	];
}

// The daemon lists a channel's peer in /peers while the connection is up; the
// channels table uses that to badge channels whose peer has dropped. Link each
// wallet's channel peers into its peers list so demo channels read as healthy,
// leaving `offlineIndex` out to demo the offline badge and Reconnect action.
function linkChannelPeers(st, { offlineIndex } = {}) {
	st.channels.forEach((c, i) => {
		if (i === offlineIndex) return;
		st.peers.push({
			pubkey: c.peerPubkey,
			host: `10.1.0.${i + 2}`,
			port: 9735,
			state: 'connected',
			...(c.alias ? { alias: c.alias } : {})
		});
	});
}
linkChannelPeers(store.state['demo-main'], { offlineIndex: 1 });
linkChannelPeers(store.state['demo-testnet']);
linkChannelPeers(store.state['demo-fresh']);

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
		const roll = rnd();
		if (roll > 0.6) {
			// A Lightning receive. It settles the newest open invoice when there
			// is one, so the Receive tab's paid receipt can actually be seen in
			// demo mode, and the event carries the payment hash the way the real
			// daemon's does, which is what the receive watcher dedupes by.
			const nowSecs = inSeconds(Date.now());
			const open = st.invoices.find((i) => !i.paid && nowSecs <= i.createdAt + i.expiry);
			const amountSats = open?.amountSats || between(500, 90000);
			const paymentHash = open ? open.paymentHash : hex(64);
			if (open) open.paid = true;
			st.payments.unshift({
				paymentHash,
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
			emit(w.id, 'payment:received', { paymentHash, amountSats });
		} else if (roll > 0.35) {
			// An on-chain receive, unconfirmed, with its UTXO so the balance
			// moves. From beignet 0.8.2 the daemon announces these over SSE
			// with the same shape /transactions answers with, so the mock does
			// too; the receive watcher's poll still covers daemons that do not.
			const txid = hex(64);
			const valueSats = between(10000, 400000);
			const address = demoAddress(w.network);
			const tx = {
				txid,
				type: 'received',
				valueSats,
				feeSats: null,
				satsPerVbyte: null,
				address,
				confirmed: false,
				height: null,
				timestamp: Date.now(),
				confirmTimestamp: null
			};
			st.txs.unshift(tx);
			st.utxos.unshift({ txid, vout: 0, address, valueSats, height: null });
			emit(w.id, 'transaction:received', { ...tx });
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

// Signatures the demo has minted, so the Verify card confirms exactly what the
// Sign card produced and refuses everything else, which is the honest half of
// what the real daemon does (it also recovers foreign signers; the demo has no
// cryptography to recover with).
const ZBASE32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';
const mintedSignatures = new Map(); // signature -> { walletId, message }
function demoSignature() {
	let sig = '';
	for (let i = 0; i < 104; i++) sig += ZBASE32[Math.floor(rnd() * 32)];
	return sig;
}

function err(message, code = 'DEMO') {
	const e = new Error(message);
	e.code = code;
	return e;
}

function publicRecord(w) {
	// The manager never returns seeds; mirror its record shape. It also only
	// reports an onion while announce is on (onionAddress() returns null
	// otherwise), so gate it the same way here: turning announce off drops the
	// advertised Tor address, and anything keyed on it disappears with it.
	const { ...rec } = w;
	rec.onionAddress = w.announce ? (w.onionAddress ?? null) : null;
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
			txs: makeTxs(4, 908214, w.network),
			payments: [],
			utxos: makeUtxos(2, 908214, w.network),
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
	if (sub === 'channel-events') {
		// Same shape as the manager's durable log: oldest first, optionally for
		// one channel.
		const channelId = new URLSearchParams(subQuery || '').get('channelId');
		const all = channelEvents[w.id] || [];
		return channelId ? all.filter((e) => e.channelId === channelId) : all.slice();
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
		},
		{
			// A payment that could not be sent because our side of the channel is
			// below the amount plus the reserve. Not a channel rejection.
			code: 'CHANNEL_ERROR',
			message: 'Insufficient balance for HTLC',
			timestamp: DEMO_ERROR_AT + 5000
		},
		{
			// Purely local: we could not open a connection to the peer. Names no
			// channel, and harms none.
			code: 'AUTO_RECONNECT_FAILED',
			message: 'Failed to reconnect 02e9a5bc...: Connection timeout',
			timestamp: DEMO_ERROR_AT + 10000
		},
		{
			// One of our own state guards, not the peer speaking.
			code: 'CHANNEL_ERROR',
			message: 'Cannot add HTLC: channel in ERRORED state',
			channelId: '55034b97024579c8afe98d7642515761b68418899d49692d8a2c168332bc9f5b',
			timestamp: DEMO_ERROR_AT + 15000
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

/**
 * A Lightning payment, and the money it says it moved.
 *
 * Returns a PaymentInfo either way, as the safe endpoints do: the failure is a
 * value rather than a throw, and the caller reads its status.
 *
 * The demo does not split a payment over several channels, so one usable channel
 * has to carry the amount and the fee. When none can, the payment fails, which
 * is the honest answer: recording it COMPLETED and leaving every balance alone,
 * as this did, is the mock telling the dashboard money moved when none did.
 */
function payOverLightning(st, id, { amountSats, bolt11, noAmount }) {
	const minted = bolt11 ? mintedInvoice(bolt11) : null;
	const paymentHash = minted?.invoice.paymentHash || hex(64);
	const failed = (failureDescription) => ({
		paymentHash,
		amountSats,
		status: 'FAILED',
		direction: 'OUTGOING',
		failureCode: 15,
		failureDescription,
		createdAt: Date.now()
	});
	if (!amountSats) return failed(noAmount);

	const feeSats = between(0, 25);
	const channel = st.channels.find(
		(c) => htlcUsable(c) && c.localBalanceSats >= amountSats + feeSats
	);
	if (!channel) {
		return failed(
			'No route to the destination with enough liquidity. Try a smaller amount, or open a channel with more outbound.'
		);
	}
	channel.localBalanceSats -= amountSats + feeSats;
	channel.remoteBalanceSats += amountSats + feeSats;
	// Paying an invoice one of the demo wallets minted settles it there.
	if (minted) minted.invoice.paid = true;

	const at = Date.now();
	const payment = {
		paymentHash,
		preimage: hex(64),
		amountSats,
		feeSats,
		status: 'COMPLETED',
		direction: 'OUTGOING',
		route: { totalHops: between(1, 4) },
		createdAt: at,
		completedAt: at
	};
	st.payments.unshift(payment);
	setTimeout(() => emit(id, 'payment:sent', { amountSats }), 400);
	return payment;
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
			// Routable means NORMAL or paying through its splice (htlcUsable),
			// matching the daemon: filtering on NORMAL alone zeroed the card for
			// the whole splice window despite sats being sendable throughout.
			const routable = st.channels.filter(
				(c) => c.state === 'NORMAL' || c.htlcUsable
			);
			const totalLocalBalanceSats = lightningBalance(id);
			// The daemon's advisor sums balances and capacity over ACTIVE channels
			// only; a closed channel's capacity is not liquidity anyone can use.
			const totalCapacitySats = routable.reduce((a, c) => a + c.capacitySats, 0);
			const totalRemoteBalanceSats = routable.reduce(
				(a, c) => a + c.remoteBalanceSats,
				0
			);
			const outboundLiquidityPct = totalCapacitySats
				? Math.round((totalLocalBalanceSats / totalCapacitySats) * 100)
				: 0;
			// BOLT channel reserve: ~1% of capacity per channel, held on each side
			// and unspendable. What you can actually send is the local balance above
			// it, summed over routable channels, which is what the daemon's canSend
			// reports. Below the reserve, sendable is zero even with a balance.
			// Mid-splice the spendable side is the conservative min of the live and
			// settle-to balances, the same ceiling the daemon's addHtlc enforces.
			const chReserve = (c) => Math.max(546, Math.round(c.capacitySats * 0.01));
			const spendable = (c) =>
				c.pendingSpliceLocalBalanceSats != null
					? Math.min(c.localBalanceSats, c.pendingSpliceLocalBalanceSats)
					: c.localBalanceSats;
			const reserveSats = routable.reduce((a, c) => a + chReserve(c), 0);
			const sendableSats = routable.reduce(
				(a, c) => a + Math.max(0, spendable(c) - chReserve(c)),
				0
			);
			return {
				channelCount: st.channels.length,
				activeChannelCount: routable.length,
				totalLocalBalanceSats,
				totalRemoteBalanceSats,
				totalCapacitySats,
				reserveSats,
				sendableSats,
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
			return { address: demoAddress(w.network) };
		case '/invoice/create': {
			const amountSats = body.amountSats || null;
			const inv = {
				paymentHash: hex(64),
				bolt11: demoInvoice(w.network, amountSats),
				amountSats,
				description: body.description || '',
				createdAt: inSeconds(Date.now()),
				expiry: INVOICE_EXPIRY_SECONDS,
				paid: false
			};
			st.invoices.unshift(inv);
			return invoiceInfo(inv);
		}
		case '/invoices':
			return st.invoices.map(invoiceInfo);
		case '/invoice/decode': {
			// The daemon reads the invoice it is given. So does this: the same
			// string must decode to the same thing every time, and an invoice one
			// demo wallet minted must decode in another, which is most of the point
			// of the demo having more than one wallet.
			const bolt11 = String(body.bolt11 || '').trim();
			const hrp = parseBolt11Hrp(bolt11);
			// The real decoder reads the data part and checks the signature over it.
			// The nearest honest thing here is the checksum, which at least refuses
			// a string that only looks like an invoice.
			if (!hrp.ok || !bech32Decode(bolt11, { maxLength: 8192 }).ok) {
				throw err('Not a BOLT11 invoice');
			}
			const minted = mintedInvoice(bolt11);
			const inv = minted?.invoice;
			const decoded = {
				network: SEGWIT_HRP[hrp.network] || 'bc',
				timestamp: inv?.createdAt ?? inSeconds(now),
				paymentHash: inv?.paymentHash || derivedHex(bolt11, 64),
				expiry: inv?.expiry ?? INVOICE_EXPIRY_SECONDS,
				minFinalCltvExpiry: 18,
				// An invoice one of these wallets minted has that wallet as its payee,
				// which is what makes the warnings below reachable at all.
				payeeNodeKey: minted ? nodeId(minted.walletId) : `02${derivedHex(`payee:${bolt11}`, 64)}`
			};
			const amountSats = inv
				? inv.amountSats
				: hrp.amountMsat == null
				? null
				: Number(hrp.amountMsat / 1000n);
			// An invoice with no amount omits the field outright, as the daemon does.
			if (amountSats != null) decoded.amountSats = amountSats;
			const description = inv ? inv.description : 'Demo invoice';
			if (description) decoded.description = description;
			// A private channel in a state that can route is what the daemon turns
			// into a routing hint (see willGenerateRoutingHint in the diagnostics
			// below), and an invoice with none is one a stranger cannot pay.
			if (minted) {
				const mintedState = store.state[minted.walletId];
				const hints = mintedState.channels.filter((c) => c.isPrivate && htlcUsable(c));
				if (hints.length > 0) {
					decoded.routingHints = hints.map((c) => [
						{
							pubkey: c.peerPubkey,
							shortChannelId: derivedHex(c.channelId, 16),
							feeBaseMsat: 1000,
							feeProportionalMillionths: 100,
							cltvExpiryDelta: 80
						}
					]);
				}
				// Word for word what beignet emits, so the dashboard's translation of
				// these strings is exercised rather than assumed.
				const warnings = [];
				if (!decoded.routingHints?.length) {
					warnings.push(
						'NO_ROUTING_HINTS: Invoice has no routing hints. Payers without a direct channel in their gossip graph will not find a route.'
					);
				}
				if (mintedState.peers.length === 0) {
					warnings.push(
						'NO_PEERS: No peers connected. Channel partner may mark channel as inactive and refuse to route.'
					);
				}
				if (warnings.length > 0) decoded.warnings = warnings;
			}
			return decoded;
		}
		case '/payment/estimate': {
			const amountSats = invoiceAmount(body.bolt11, body.amountSats);
			// Nothing can be routed until there is an amount to route.
			if (!amountSats) throw err('Unable to estimate payment (no route or invalid invoice)', 'NO_ROUTE');
			const hopCount = between(1, 4);
			const successProbabilityPct = between(88, 99);
			// The whole of PaymentEstimate, graded the way the daemon grades it. The
			// three missing fields were not read by anything today, which is what
			// made them a trap for whatever reads them next.
			return {
				estimatedFeeSats: between(1, 30),
				successProbabilityPct,
				hopCount,
				estimatedTimeMs: hopCount * 2000,
				routeQuality:
					hopCount > 4 || successProbabilityPct < 50
						? 'LOW'
						: hopCount > 2 || successProbabilityPct < 75
						? 'MEDIUM'
						: 'HIGH',
				alternativeAvailable: st.channels.filter(htlcUsable).length > 1
			};
		}
		// The two endpoints that never throw. That is the whole difference between
		// /invoice/pay and /invoice/pay-safe: the safe one catches everything and
		// returns HTTP success carrying a PaymentInfo whose status is FAILED, with
		// the reason in failureDescription. Throwing here made the branch the Send
		// tab renders for a failed payment unreachable in demo, so the one place a
		// reviewer would go to see how a failure reads never showed one.
		case '/invoice/pay-safe':
			return payOverLightning(st, id, {
				amountSats: invoiceAmount(body.bolt11, body.amountSats),
				bolt11: String(body.bolt11 || '').trim(),
				noAmount: 'This invoice names no amount, so one has to be given with the payment.'
			});
		case '/keysend/safe':
			return payOverLightning(st, id, {
				amountSats: Math.floor(Number(body.amountSats) || 0),
				noAmount: 'A keysend has to name an amount.'
			});
		case '/send': {
			// The daemon refuses a destination it cannot build an output for, which
			// is what catches a URI that reached it with its scheme still attached.
			if (!payableAddress(body.address, w.network)) throw err('Invalid address', 'SEND_FAILED');
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
			if (!payableAddress(body.address, w.network)) throw err('Invalid address', 'SEND_FAILED');
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
			// Faithful to the daemon: connected means the peer session is up, which
			// the mock tracks through the peers list (see linkChannelPeers), not
			// through the channel state.
			const peerConnected = st.peers.some((p) => p.pubkey === c.peerPubkey);
			return {
				channelId: c.channelId,
				peerPubkey: c.peerPubkey,
				state: c.state,
				preReestablishState: null,
				isPeerConnected: peerConnected,
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
				feeBaseMsat: c.policy?.feeBaseMsat ?? 1000,
				feeProportionalMillionths: c.policy?.feeProportionalMillionths ?? 100,
				cltvExpiryDelta: c.policy?.cltvExpiryDelta ?? 80,
				htlcMinimumMsat: '1000',
				htlcMaximumMsat: String(c.capacitySats * 1000),
				source: c.policy ? 'channel-override' : 'node-default'
			};
		}
		case '/channel/update-policy': {
			const c = st.channels.find((x) => x.channelId === body.channelId);
			if (!c) throw err('Channel not found', 'NOT_FOUND');
			// The daemon's own bounds, refused with its own words.
			if (body.cltvExpiryDelta < 1 || body.cltvExpiryDelta > 65535)
				throw err(
					`cltvExpiryDelta must be an integer in [1, 65535] (>= 18 recommended), got ${body.cltvExpiryDelta}`,
					'INVALID_PARAMS'
				);
			c.policy = {
				feeBaseMsat: body.feeBaseMsat,
				feeProportionalMillionths: body.feeProportionalMillionths,
				cltvExpiryDelta: body.cltvExpiryDelta
			};
			return {
				updated: 1,
				policies: [
					{
						channelId: c.channelId,
						...c.policy,
						htlcMinimumMsat: '1000',
						htlcMaximumMsat: String(c.capacitySats * 1000)
					}
				]
			};
		}
		case '/channel/funding-quote': {
			// What a max open would commit toward this peer, priced the way the
			// daemon prices it: a peer that negotiated dual funding gets the v2
			// interactive-tx arithmetic, anyone else gets the v1 sweep. A peer that
			// has not sent its init is a peer we are not connected to, and the v2
			// judgment cannot be made about it, so the answer falls back to the
			// sweep and says peerKnown false rather than guessing.
			const peerPubkey = String(body.peerPubkey || '');
			if (!/^[0-9a-f]{66}$/i.test(peerPubkey)) throw err('peerPubkey must be a 66-character hex pubkey', 'INVALID_PARAMS');
			const satsPerVbyte = body.satsPerVbyte || 7;
			const balance = onchainBalance(id);
			const wanted = peerPubkey.toLowerCase();
			const peer = st.peers.find((p) => p.pubkey.toLowerCase() === wanted);
			const peerKnown = !!peer;
			// beignet negotiates dual funding, so another of these wallets is a v2
			// peer, as is anyone running an implementation that advertises it.
			const isSiblingWallet = Object.values(nodeIds).some((k) => k.toLowerCase() === wanted);
			const dualFund = peerKnown && (isSiblingWallet || DUAL_FUND_ALIASES.has(peer.alias));
			if (dualFund) {
				// A v2 contribution is weighed per input plus the shared output, and
				// the rate is pinned in sat/kw, which is where it parts company with
				// the sweep's vsize arithmetic.
				const feeratePerKw = satsPerVbyte * SATVB_TO_PERKW_MOCK;
				const weight = 164 * (st.utxos.length || 1) + 172;
				const feeSats = Math.ceil((weight * feeratePerKw) / 1000);
				return {
					method: 'v2',
					peerKnown: true,
					satsPerVbyte,
					feeratePerKw,
					fundingSatoshis: Math.max(0, balance - feeSats),
					feeSats,
					spendableSats: balance,
					inputCount: st.utxos.length || 1
				};
			}
			const vsize = Math.ceil(10.5 + (st.utxos.length || 1) * 68 + 43);
			const feeSats = vsize * satsPerVbyte;
			return {
				method: 'v1',
				peerKnown,
				satsPerVbyte,
				fundingSatoshis: Math.max(0, balance - feeSats),
				feeSats,
				vsize,
				maxSatsPerVbyte: Math.floor(balance / 2 / vsize)
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
				// The daemon announces channel:opening under the permanent id, which
				// is where the channel's recorded history begins.
				recordChannelEvent(id, {
					event: 'channel:opening',
					channelId: c.channelId,
					fundingTxid: hex(64)
				});
			}, 3000);
			// A trusted (zero-conf) open is usable the moment the funding is
			// broadcast; a normal one waits out the demo's confirmation delay.
			setTimeout(
				() => {
					c.state = 'NORMAL';
					recordChannelEvent(id, { event: 'channel:ready', channelId: c.channelId });
					emit(id, 'channel:ready', {});
				},
				body.trusted ? 3200 : 9000
			);
			return c;
		}
		case '/trusted-peer/add':
			// The daemon records the pubkey in its zero-conf trusted set; the demo
			// only needs the call to succeed so a trusted open can proceed.
			return { ok: true };
		case '/channel/close':
		case '/channel/forceclose': {
			const c = st.channels.find((x) => x.channelId === body.channelId);
			if (!c) throw err('Channel not found');
			const force = route.endsWith('forceclose');
			c.state = force ? 'FORCE_CLOSED' : 'NEGOTIATING_CLOSING';
			recordChannelEvent(id, {
				event: force ? 'channel:force-closing' : 'channel:pending-close',
				channelId: c.channelId,
				initiator: 'local'
			});
			setTimeout(() => {
				store.state[id].channels = store.state[id].channels.filter(
					(x) => x.channelId !== body.channelId
				);
				recordChannelEvent(id, { event: 'channel:closed', channelId: body.channelId });
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
				st.utxos.push({ txid: hex(64), vout: 0, address: demoAddress(w.network), valueSats: amt, height: null });
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
		case '/graph/node': {
			// The daemon resolves the alias from the gossip graph and 404s when
			// the node never announced one. Here the peer carries its own alias,
			// so a miss (or an alias-less peer) is the same not-found path.
			const pk = new URLSearchParams(query || '').get('pubkey');
			const peer = st.peers.find((p) => p.pubkey === pk);
			const chan = st.channels.find((c) => c.peerPubkey === pk);
			const alias = peer?.alias || chan?.alias;
			if (!alias) throw err('Node not found in graph', 'NOT_FOUND');
			return { pubkey: pk, alias, color: '3399ff', channelCount: 24 };
		}
		case '/message/sign': {
			if (!body.message) throw err('message required', 'INVALID_PARAMS');
			const signature = demoSignature();
			mintedSignatures.set(signature, { walletId: id, message: body.message });
			return { signature, pubkey: nodeId(id) };
		}
		case '/message/verify': {
			if (!body.message || !body.signature)
				throw err('message and signature required', 'INVALID_PARAMS');
			const minted = mintedSignatures.get(body.signature);
			if (minted && minted.message === body.message) {
				return { valid: true, pubkey: nodeId(minted.walletId), knownNode: true };
			}
			return { valid: false, pubkey: null, knownNode: false };
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
		case '/offer': {
			// DELETE /offer?offerId=... (beignet 0.8.0). The route only exists for
			// removal, so anything else reaching it is a caller mistake.
			if (method !== 'DELETE') throw err(`Unknown demo endpoint ${route}`, 'NOT_FOUND');
			const offerId = new URLSearchParams(query || '').get('offerId');
			if (!offerId) throw err('offerId required', 'INVALID_PARAMS');
			const i = st.offers.findIndex((o) => o.offerId === offerId);
			if (i === -1) throw err('Offer not found', 'NOT_FOUND');
			st.offers.splice(i, 1);
			return { removed: true };
		}
		case '/offer/decode': {
			// An offer carries no checksum, so the shape of the string is the whole
			// of what can be checked here, exactly as the parser in the UI does it.
			const encoded = String(body.offer || '').trim();
			if (!/^lno1[a-z0-9]+$/i.test(encoded)) throw err('Not a BOLT12 offer');
			const minted = mintedOffer(encoded);
			const decoded = {
				offerId: minted ? minted.offer.offerId : derivedHex(`offer:${encoded}`, 64),
				description: minted ? minted.offer.description : 'Demo offer',
				encoded
			};
			// An offer with no amount omits the field outright, as the daemon does,
			// which is what puts the amount box in front of the payer.
			const amountSats = minted ? minted.offer.amountSats : null;
			if (amountSats != null) decoded.amountSats = amountSats;
			if (minted) decoded.issuerId = nodeId(minted.walletId);
			return decoded;
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
