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
import { decodeFundingEnvelope, encodeFundingEnvelope } from '../lib/funding-envelope.js';

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

function walletState({ blockHeight, channels, txs, payments, utxos, invoices, offers, peers, recovery }) {
	return {
		blockHeight,
		channels,
		txs,
		payments,
		utxos,
		invoices,
		offers,
		peers,
		addressN: 0,
		// The node-level recovery picture (GET /recovery/status's `node`),
		// only read for wallets whose record carries a recovery mode.
		recovery: {
			gate: 'confirmed',
			lastDurableSequence: '0',
			awaitingDurabilityCount: 0,
			fenced: false,
			backfillLost: false,
			startupRepairPending: false,
			channelStatuses: {},
			// The best Recovery Capsule a storage peer returned (0.9.3+).
			capsule: null,
			...(recovery || {})
		}
	};
}

// The demo's guardian set (the Recovery Protocol's crash-v1 profile is three
// guardians, two of which must answer): the user's own Umbrel guardian, an
// LSP's onion guardian and an independent one, the reference arrangement.
const DEMO_GUARDIANS = [
	// A friend's Umbrel serving as a guardian at its Lightning address (#699).
	`${hex(64)}@bolt8://02${hex(64)}@${hex(28)}friendumbrelexample.onion:9101`,
	`${hex(64)}@http://${hex(28)}guardianexample.onion`,
	`${hex(64)}@https://guardian.example.net`
];

// The box was backed up a week ago, so wallets older than that read as backed
// up and the ones made since read as waiting for the next archive.
const DEMO_BACKUP_AT = new Date(now - 7 * DAY).toISOString();

const store = {
	settings: {
		defaultNetwork: 'mainnet',
		defaultElectrum: { host: 'umbrel.local', port: 50001, tls: false },
		recoveryGuardians: DEMO_GUARDIANS.slice(),
		lastBackupAt: DEMO_BACKUP_AT
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
			// Strict quorum: every channel step waits for two guardians, and
			// a restore elsewhere resumes the channels and fences this device.
			recovery: { mode: 'quorum', guardians: DEMO_GUARDIANS.slice() },
			// Serves as a guardian for other beignet nodes in turn (#699).
			guardianServe: true,
			// The primary node of the lightning-first demo wallets below: it
			// fronts their inbound capacity (JIT receive) and relays their
			// payment requests.
			liquidityProvider: true,
			// Settles offline receives for its lightning-first wallets (FFOR).
			ffor: { settle: { enabled: true, maxBudgetMsat: null, maxEpochBlocks: null, feeBaseMsat: 0, feePpm: 0 } },
			createdAt: now - 90 * DAY
		},
		{
			// A sibling that stays online and keeps receipts for the others
			// (FFOR witness) and answers BOLT 12 requests for them (issuer).
			id: 'demo-witness',
			name: 'Witness',
			network: 'mainnet',
			status: 'running',
			electrum: { host: 'umbrel.local', port: 50001, tls: false },
			tor: false,
			announce: false,
			recovery: { mode: 'off', guardians: [] },
			ffor: { witness: { enabled: true, maxMailboxes: null, maxBytes: null }, issuer: { enabled: true } },
			createdAt: now - 20 * DAY
		},
		{
			// Lightning-first: one balance, one channel with Main, deposits
			// that move into it by themselves.
			id: 'demo-lfbw',
			name: 'Spending',
			network: 'mainnet',
			status: 'running',
			electrum: { host: 'umbrel.local', port: 50001, tls: false },
			tor: false,
			announce: false,
			lfbw: {
				enabled: true,
				mode: 'internal',
				primaryWalletId: 'demo-main',
				primaryUri: null,
				primaryPubkey: null, // filled in once node ids exist below
				trusted: true,
				initialChannelSats: 200000,
				initialChannelOpened: true,
				setup: 'ready',
				setupError: null,
				setupAt: new Date(now - 5 * DAY).toISOString()
			},
			createdAt: now - 5 * DAY
		},
		{
			// Lightning-first, created a minute ago against a primary that did
			// not answer in time: the overview offers a retry.
			id: 'demo-lfbw-setup',
			name: 'New phone',
			network: 'mainnet',
			status: 'running',
			electrum: { host: 'umbrel.local', port: 50001, tls: false },
			tor: false,
			announce: false,
			lfbw: {
				enabled: true,
				mode: 'internal',
				primaryWalletId: 'demo-main',
				primaryUri: null,
				primaryPubkey: null,
				trusted: true,
				initialChannelSats: 0,
				initialChannelOpened: false,
				setup: 'failed',
				setupError: 'wallet "Main" did not become healthy in time',
				setupAt: null
			},
			createdAt: now - 60000
		},
		{
			id: 'demo-savings',
			name: 'Savings',
			network: 'mainnet',
			status: 'running',
			electrum: { host: 'umbrel.local', port: 50001, tls: false },
			tor: false,
			announce: false,
			// The on-chain only demo: imported two days ago, and its history
			// reaches back years anyway, because recovery reads the chain.
			onchainOnly: true,
			createdAt: now - 2 * DAY
		},
		{
			id: 'demo-testnet',
			name: 'Testnet playground',
			network: 'testnet',
			status: 'running',
			electrum: { host: 'testnet.aranguren.org', port: 51001, tls: false },
			tor: false,
			announce: false,
			// Checkpoints via peer storage: no guardians, no setup.
			recovery: { mode: 'peer-storage', guardians: [] },
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
		},
		{
			// The seed of this wallet was restored on another device, which
			// took the channels over: this copy is fenced, permanently, and
			// the header badge says so.
			id: 'demo-fenced',
			name: 'Old phone',
			network: 'mainnet',
			status: 'running',
			electrum: { host: 'umbrel.local', port: 50001, tls: false },
			tor: false,
			announce: false,
			recovery: { mode: 'quorum', guardians: DEMO_GUARDIANS.slice() },
			createdAt: now - 200 * DAY
		},
		{
			// Just imported with the same guardians a lost device used: the
			// daemon found the namespace on them and is holding for the
			// restore (the manager reports restore-required; every daemon
			// route but the recovery surface answers NODE_RESTORE_PENDING).
			id: 'demo-restore',
			name: 'Restored phone',
			network: 'mainnet',
			status: 'restore-required',
			electrum: { host: 'umbrel.local', port: 50001, tls: false },
			tor: false,
			announce: false,
			recovery: { mode: 'quorum', guardians: DEMO_GUARDIANS.slice() },
			createdAt: now - 60000
		},
		{
			// Imported with peer storage after a laptop died: empty, and the
			// peer it reconnected to returned the checkpoint its previous life
			// left there. The card on its page offers the restore (0.9.3+).
			id: 'demo-capsule',
			name: 'Restored laptop',
			network: 'mainnet',
			status: 'running',
			electrum: { host: 'umbrel.local', port: 50001, tls: false },
			tor: false,
			announce: false,
			recovery: { mode: 'peer-storage', guardians: [] },
			createdAt: now - 120000
		},
		{
			// The same import with the question answered (the previous device
			// is stopped): the daemon applies the checkpoint by itself, and
			// the Backup row narrates it (beignet #690).
			id: 'demo-autorestore',
			name: 'Restored phone (automatic)',
			network: 'mainnet',
			status: 'running',
			electrum: { host: 'umbrel.local', port: 50001, tls: false },
			tor: false,
			announce: false,
			recovery: { mode: 'peer-storage', guardians: [], autoApply: true },
			createdAt: now - 30000
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
	[650000, 45, 'FORCE_CLOSED', false, 'endurance'],
	// A close the peer made, long since swept: the quiet end of a channel.
	[900000, 52, 'CLOSED', false, 'Kraken']
]);
// True to life: eclair splices, LND does not, and the daemon reads it off each
// peer's init (beignet 0.8.2+). The WalletOfSatoshi channel demos the Channels
// tab hiding its splice buttons on an explicit no; the unannounced peer's
// channel says nothing, the shape an old daemon or a disconnected peer leaves.
mainChannels[0].peerSupportsSplicing = true;
mainChannels[1].peerSupportsSplicing = false;
// The close story (beignet 0.9.0+ closeStatus): Sparky was closed
// cooperatively by this wallet and is sweeping its outputs; endurance is the
// watchdog force close whose commitment the daemon put out but has not seen
// confirm, so the detail view offers Rebroadcast.
mainChannels[4].closeStatus = {
	closer: 'cooperative',
	reason: 'user',
	closingTxid: hex(64),
	broadcast: true,
	confirmationHeight: 908214 - 863,
	resolution: 'sweeping'
};
mainChannels[5].closeStatus = {
	closer: 'local',
	reason: 'REESTABLISH_TIMEOUT_FORCE_CLOSED',
	closingTxid: hex(64),
	broadcast: true,
	confirmationHeight: 0,
	resolution: 'pending'
};
mainChannels[6].closeStatus = {
	closer: 'remote',
	closingTxid: hex(64),
	broadcast: true,
	confirmationHeight: 908214 - 2200,
	resolution: 'resolved'
};

store.state['demo-main'] = walletState({
	blockHeight: 908214,
	recovery: { lastDurableSequence: '1284' },
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
const savingsTxs = makeTxs(9, 908214);
// Imported two days ago, history back to 2023: recovery reads the chain, so
// everything the seed ever did is here, long predating the wallet record.
savingsTxs.forEach((t, i) => {
	if (i === 0) return; // the newest stays recent
	t.timestamp = now - (i * 130 + between(0, 60)) * DAY;
	if (t.confirmTimestamp) t.confirmTimestamp = t.timestamp + 900000;
});
store.state['demo-savings'] = walletState({
	blockHeight: 908214,
	channels: [],
	txs: savingsTxs,
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
// Fenced: the startup gate proved a newer epoch, so this copy holds its one
// channel frozen; the other device owns it now.
store.state['demo-fenced'] = walletState({
	blockHeight: 908214,
	recovery: { gate: 'fenced', fenced: true, lastDurableSequence: '402' },
	channels: makeChannels([[1000000, 40, 'NORMAL', false, 'ACINQ']]),
	txs: makeTxs(4, 908214),
	payments: makePayments(5),
	utxos: makeUtxos(1, 908214),
	invoices: [],
	offers: [],
	peers: []
});

const capsulePeer = pubkey();
store.state['demo-capsule'] = walletState({
	blockHeight: 908214,
	recovery: {
		gate: 'disabled',
		capsule: {
			writerEpoch: '1',
			latestSequence: '412',
			inline: true,
			channelCount: 2,
			guardians: [],
			fromPeer: capsulePeer,
			receivedAt: now - 30000
		}
	},
	channels: [],
	txs: makeTxs(5, 908214),
	payments: [],
	utxos: makeUtxos(1, 908214),
	invoices: [],
	offers: [],
	peers: [{ pubkey: capsulePeer, host: 'ln.acinq.co', port: 9735, state: 'connected', alias: 'ACINQ' }]
});

// The checkpoint recovery the dashboard offers: the capsule's embedded SCB
// goes to the SCB restore, the channels come back as closing (the peer
// closes them on reestablish, the DLP path) and the funds land on-chain.
function runDemoScbRecovery(w, st) {
	const r = st.recovery;
	const capsule = r.capsule;
	const chans = makeChannels([
		[1500000, 58, 'FORCE_CLOSED', false, 'ACINQ'],
		[600000, 35, 'FORCE_CLOSED', false, 'Bitrefill']
	]);
	st.channels = chans;
	chans.forEach((c) => {
		r.channelStatuses[c.channelId] = 'local_data_loss';
		recordChannelEvent(w.id, { event: 'channel:closed', channelId: c.channelId });
	});
	r.capsule = null;
	setTimeout(() => {
		// The peer's close confirms and our side of it comes home.
		const txid = hex(64);
		const valueSats = 1500000 * 0.58 + 600000 * 0.35 - 1200;
		const address = demoAddress(w.network);
		const tx = { txid, type: 'received', valueSats: Math.round(valueSats), feeSats: null, satsPerVbyte: null, address, confirmed: false, height: null, timestamp: Date.now(), confirmTimestamp: null };
		st.txs.unshift(tx);
		st.utxos.unshift({ txid, vout: 0, address, valueSats: tx.valueSats, height: null });
		emit(w.id, 'transaction:received', { ...tx });
	}, 6000);
	return { recovering: chans.map((c) => c.channelId), skipped: [], channelCount: capsule.channelCount };
}

// The daemon's own restore, scripted from the first look at the status
// route: settling (waiting on the other peers), applying, applied with the
// channels back and held, one of them not carried by the checkpoint.
const autoPeer = pubkey();
store.state['demo-autorestore'] = walletState({
	blockHeight: 908214,
	recovery: {
		gate: 'disabled',
		capsule: {
			writerEpoch: '1',
			latestSequence: '96',
			inline: true,
			channelCount: 2,
			guardians: [],
			fromPeer: autoPeer,
			receivedAt: now - 5000
		},
		autoApply: { phase: 'settling', settleUntil: now + 8000, lastReason: null }
	},
	channels: [],
	txs: makeTxs(3, 908214),
	payments: [],
	utxos: [],
	invoices: [],
	offers: [],
	peers: [{ pubkey: autoPeer, host: 'ln.acinq.co', port: 9735, state: 'connected', alias: 'ACINQ' }]
});
let autoRestoreScripted = false;
function runDemoAutoRestore(w, st) {
	if (autoRestoreScripted) return;
	autoRestoreScripted = true;
	const r = st.recovery;
	setTimeout(() => {
		r.autoApply = { phase: 'applying', settleUntil: null, lastReason: null };
		emit(w.id, 'recovery:capsule-retrieved', { fromPeer: autoPeer, writerEpoch: '1', latestSequence: '96', inline: true, channelCount: 2, candidates: 1 });
		emit(w.id, 'recovery:restore-progress', { type: 'capsule:selecting', detail: 'selecting the newest of 1 checkpoint' });
	}, 8000);
	setTimeout(() => {
		const chans = makeChannels([
			[1500000, 58, 'NORMAL', false, 'ACINQ'],
			[600000, 35, 'FORCE_CLOSED', false, 'Bitrefill']
		]);
		st.channels = chans;
		r.channelStatuses[chans[0].channelId] = 'reestablishing';
		r.channelStatuses[chans[1].channelId] = 'local_data_loss';
		r.capsule = null;
		r.autoApply = { phase: 'applied', settleUntil: null, lastReason: null };
		// Kept apart from `restore`, which the status route reads as the
		// guardian hold.
		r.capsuleEvent = { type: 'capsule:uncovered', detail: `${chans[1].channelId.slice(0, 12)} (Bitrefill) was past the checkpoint's size and closes safely` };
		emit(w.id, 'recovery:restore-progress', r.capsuleEvent);
		setTimeout(() => {
			r.capsuleEvent = { type: 'restore:complete', detail: 'restored database installed and the node rebuilt on it; 2 channel(s) resumed' };
			emit(w.id, 'recovery:restore-progress', r.capsuleEvent);
		}, 1500);
		emit(w.id, 'recovery:restored', { exact: true, tier: 2, restartRequired: false, resumed: true, framesApplied: 96, guardiansRepaired: 0, epoch: '1' });
		recordChannelEvent(w.id, { event: 'channel:closed', channelId: chans[1].channelId });
	}, 12000);
	setTimeout(() => {
		const c = st.channels[0];
		if (c) r.channelStatuses[c.channelId] = 'active';
	}, 20000);
}

// The exact restore from the checkpoint the card offers (beignet 0.9.3+,
// with #462/#463 landed): the daemon installs the restored database and
// holds for a restart, the manager restarts the wallet, the channels come
// back held (beignet #469) and reconcile as their peers are reached.
function runDemoCapsuleRestore(w, st) {
	const r = st.recovery;
	const capsule = r.capsule;
	r.capsule = null;
	emit(w.id, 'recovery:restore-progress', { type: 'capsule:selecting', detail: 'selecting the newest of 1 checkpoint' });
	emit(w.id, 'recovery:restore-progress', { type: 'capsule:installed', detail: 'restored database installed; restart the daemon to resume 2 channels' });
	emit(w.id, 'recovery:restored', { exact: true, tier: 2, restartRequired: true, framesApplied: 412, guardiansRepaired: 0, epoch: '1' });
	w.status = 'restarting';
	setTimeout(() => {
		const chans = makeChannels([
			[1500000, 58, 'NORMAL', false, 'ACINQ'],
			[600000, 35, 'NORMAL', false, 'Bitrefill']
		]);
		st.channels = chans;
		chans.forEach((c) => {
			r.channelStatuses[c.channelId] = 'reestablishing';
		});
		w.status = 'running';
		emit(w.id, 'node:ready', {});
	}, 4000);
	setTimeout(() => {
		st.channels.forEach((c) => {
			r.channelStatuses[c.channelId] = 'active';
		});
	}, 12000);
	return { tier: 2, restartRequired: true, channelCount: capsule.channelCount, writerEpoch: capsule.writerEpoch, latestSequence: capsule.latestSequence };
}

store.state['demo-restore'] = walletState({
	blockHeight: 908214,
	channels: [],
	txs: [],
	payments: [],
	utxos: [],
	invoices: [],
	offers: [],
	peers: []
});

// The guardian restore, scripted in the engine's order: the progress events
// in sequence, then the node boots with its channels quarantined, the gate
// confirms, and the channels land one at a time, one of them on the DLP path
// (the peer proved this state stale; it closes safely). Resolves the way the
// real POST does, once the node is up.
const RESTORE_SCRIPT = [
	['heads:read', '3 usable heads, 0 possibly stale'],
	['head:adopted', 'adopted epoch 2 sequence 1291'],
	['epoch:cas-retry', 'attempt 1 collected 1 of 2 certificates'],
	['epoch:acquired', 'epoch 3 acquired with 2 certificates over sequence 1291'],
	['frames:downloaded', '9 records through sequence 1291'],
	['restore:exactness', 'the certified head declares quorum durability, so restored channels resume'],
	['restore:complete', 'restored 9 frames under epoch 3']
];
function runDemoRestore(w, st) {
	return new Promise((resolve) => {
		const r = st.recovery;
		r.restore = { inProgress: true };
		RESTORE_SCRIPT.forEach(([type, detail], i) => {
			setTimeout(() => {
				r.restore.lastEvent = { type, detail };
				emit(w.id, 'recovery:restore-progress', { type, detail });
			}, 700 * (i + 1));
		});
		const chans = makeChannels([
			[2000000, 62, 'NORMAL', false, 'ACINQ'],
			[900000, 40, 'NORMAL', false, 'WalletOfSatoshi.com'],
			[500000, 55, 'NORMAL', true]
		]);
		setTimeout(() => {
			// The node is up: the manager's next poll reads running, the
			// restore key leaves the status, and the channels wait behind the
			// quarantined gate.
			r.restore = undefined;
			r.gate = 'quarantined';
			r.lastDurableSequence = '1291';
			st.channels = chans;
			st.peers = [
				{ pubkey: chans[0].peerPubkey, host: 'ln.acinq.co', port: 9735, state: 'connected', alias: 'ACINQ' },
				{ pubkey: chans[1].peerPubkey, host: '84.21.100.4', port: 9735, state: 'connected', alias: 'WalletOfSatoshi.com' }
			];
			chans.forEach((c) => {
				r.channelStatuses[c.channelId] = 'quarantined';
			});
			w.status = 'running';
			const info = { exact: true, framesApplied: 9, guardiansRepaired: 0, epoch: '3' };
			emit(w.id, 'recovery:restored', info);
			resolve(info);
		}, 700 * (RESTORE_SCRIPT.length + 2));
		const t0 = 700 * (RESTORE_SCRIPT.length + 4);
		setTimeout(() => {
			r.gate = 'confirmed';
			r.channelStatuses[chans[0].channelId] = 'reestablishing';
			emit(w.id, 'recovery:durable', { through: '1291' });
		}, t0);
		setTimeout(() => {
			r.channelStatuses[chans[0].channelId] = 'active';
			r.channelStatuses[chans[1].channelId] = 'replay_required';
		}, t0 + 1500);
		setTimeout(() => {
			r.channelStatuses[chans[1].channelId] = 'active';
			r.channelStatuses[chans[2].channelId] = 'reestablishing';
		}, t0 + 3000);
		setTimeout(() => {
			// The unannounced peer proved this side stale: never broadcast,
			// the peer closes, the funds come back on-chain.
			r.channelStatuses[chans[2].channelId] = 'local_data_loss';
			chans[2].state = 'ERRORED';
			recordChannelEvent(w.id, { event: 'channel:closed', channelId: chans[2].channelId });
		}, t0 + 4500);
	});
}

// Durable channel history, mirroring the manager's channel-events log: the
// real manager records lifecycle events off the daemon's stream and serves
// them back at /wallets/:id/channel-events for the detail view's History
// section. Seeded so the demo's closed channels have a story: the force-closed
// one tells the reestablish-watchdog incident (beignet #212) that motivated
// the feature.
const channelEvents = {};
// FFOR offline receive: the settlement role's defaults and, per wallet, the
// epoch views in both roles, exactly the daemon's shape (seeded below).
const FFOR_SETTLE_DEFAULTS = { enabled: false, maxBudgetMsat: null, maxEpochBlocks: null, feeBaseMsat: 0, feePpm: 0 };
const FFOR_WITNESS_DEFAULTS = { enabled: false, maxMailboxes: null, maxBytes: null };
const FFOR_ISSUER_DEFAULTS = { enabled: false };
const fforBlockOf = (w) => ({
	settle: { ...FFOR_SETTLE_DEFAULTS, ...((w.ffor && w.ffor.settle) || {}) },
	witness: { ...FFOR_WITNESS_DEFAULTS, ...((w.ffor && w.ffor.witness) || {}) },
	issuer: { ...FFOR_ISSUER_DEFAULTS, ...((w.ffor && w.ffor.issuer) || {}) }
});
const fforEpochs = {};
// Witness mailboxes and issuer manifests, per hosting wallet.
const fforMailboxes = {};
const fforManifests = {};

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
	const kraken = chans[6];
	channelEvents['demo-main'] = [
		{ timestamp: now - 90 * day, event: 'channel:opening', channelId: kraken.channelId, fundingTxid: hex(64) },
		{ timestamp: now - 90 * day + 1500000, event: 'channel:ready', channelId: kraken.channelId },
		{ timestamp: now - 16 * day, event: 'channel:force-closing', channelId: kraken.channelId, initiator: 'remote' },
		{ timestamp: now - 16 * day + 600000, event: 'channel:closed', channelId: kraken.channelId },
		{ timestamp: now - 15 * day, event: 'channel:resolved', channelId: kraken.channelId },
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

// Direct fundings that degraded into an ordinary payment, mirroring the
// manager's own durable log: the payer's card records one when the daemon
// refuses the funding, and the Activity tab reads it back onto the payment it
// became. Seeded on Main so the annotated row is there to be found, which is
// the whole complaint behind it (umbrel #121): on the row alone, a degraded
// direct funding and an ordinary send are the same transaction.
const fundingFallbacks = {};
// The steps of each direct funding a demo wallet paid, keyed wallet:request, as
// the manager serves them from the daemon's logs (umbrel #147).
const fundingSteps = {};
{
	const paid = store.state['demo-main'].txs.find((t) => t.type === 'sent');
	const requestId = hex(32);
	const began = paid.timestamp - 125_000;
	// The slow refusal the steps exist to explain: the onion route's dial timed
	// out, the relay took the offer and never answered, and the window closed.
	const steps = [
		{ timestamp: began, action: 'df_send_started', data: { requestId, amountSat: String(Math.abs(paid.valueSats)), resumed: false } },
		{ timestamp: began + 30_100, action: 'df_lane_skipped', data: { transportType: 2, reason: 'lane_not_established', error: 'connection timed out after 30000ms' } },
		{ timestamp: began + 120_400, action: 'df_lane_skipped', data: { transportType: 3, reason: 'no_frame_exchanged', error: 'offer timed out' } },
		{ timestamp: began + 120_450, action: 'df_send_refused', data: { requestId, reason: 'The recipient did not take the direct funding.' } }
	];
	fundingSteps[`demo-main:${requestId}`] = steps;
	fundingFallbacks['demo-main'] = [
		{
			timestamp: paid.timestamp + 1000,
			reason: 'The recipient did not take the direct funding.',
			address: paid.address,
			amountSats: Math.abs(paid.valueSats),
			nodeId: pubkey(),
			requestId,
			txid: paid.txid,
			steps
		}
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
/** The guardian id a serving demo wallet reports, stable per wallet. */
function guardianIdOf(id) {
	let h = 0;
	for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return (h.toString(16).padStart(8, '0') + hex(56)).slice(0, 64);
}

function nodeId(id) {
	if (!nodeIds[id]) nodeIds[id] = pubkey();
	return nodeIds[id];
}

// The lightning-first demo wallets, seeded once node ids exist: their home
// channel's peer IS Main, so the overview names it and the Send tab's
// splice-out and the Receive tab's JIT invoice have a channel to work with.
for (const w of store.wallets) {
	if (w.lfbw && w.lfbw.mode === 'internal') w.lfbw.primaryPubkey = nodeId(w.lfbw.primaryWalletId);
}
// Spending was re-pointed from Savings to Main an hour ago: the channel
// with Savings stays open until it is moved (umbrel #86).
store.wallets.find((w) => w.id === 'demo-lfbw').lfbw.previousPrimary = {
	pubkey: nodeId('demo-savings'),
	walletId: 'demo-savings',
	at: now - 60 * 60 * 1000
};
store.state['demo-lfbw'] = walletState({
	blockHeight: 908214,
	channels: (() => {
		const chans = makeChannels([
			[500000, 40, 'NORMAL', true],
			[150000, 80, 'NORMAL', true]
		]);
		chans[0].peerPubkey = nodeId('demo-main');
		chans[0].peerSupportsSplicing = true;
		chans[1].peerPubkey = nodeId('demo-savings');
		return chans;
	})(),
	txs: makeTxs(5, 908214),
	payments: makePayments(6),
	// One deposit under the channelize floor, waiting for more; one arriving.
	utxos: [
		{ txid: hex(64), vout: 0, address: demoAddress('mainnet'), valueSats: 12000, height: 908100 },
		{ txid: hex(64), vout: 1, address: demoAddress('mainnet'), valueSats: 60000, height: null }
	],
	invoices: [],
	offers: [],
	peers: [{ pubkey: nodeId('demo-main'), host: '127.0.0.1', port: 9101, state: 'connected' }]
});
// Spending is receiving offline right now (FFOR): a book of three 50,000 sat
// vouchers on its home channel with Main, one paid while it was away, one
// shared, one still to hand out; and the book before it, closed on the last
// start with two of two paid, which the return panel reports.
seedFforEpoch({
	receiverId: 'demo-lfbw',
	settlerId: 'demo-main',
	channelId: store.state['demo-lfbw'].channels[0].channelId,
	state: 'ACTIVE',
	amountsSats: [50000, 50000, 50000],
	slotStates: ['settled', 'exposed', 'unissued'],
	settlementDeadline: 908214 + 900,
	voucherExpiry: 908214 + 900 + 1152,
	startedAt: 908214 - 120,
	witnessPeers: [nodeId('demo-witness')],
	witnesses: [{ witnessNodeId: nodeId('demo-witness'), mailboxId: hex(64), retentionUntil: 908214 + 900 + 1152 + 288, acknowledged: true }]
});
fforMailboxes['demo-witness'] = [{ mailboxId: fforEpochsOf('demo-lfbw')[0].witnesses[0].mailboxId, state: 'PROVISIONED', slots: 3, records: 1, retentionUntil: 908214 + 900 + 1152 + 288, provisionedAt: now - 2 * 60 * 60 * 1000 }];
store.wallets.find((w) => w.id === 'demo-lfbw').fforReturn = {
	at: now - 2 * 60 * 1000,
	channelId: store.state['demo-lfbw'].channels[0].channelId,
	action: 'closed',
	preimagesKnown: [1, 2],
	witnesses: [],
	epoch: {
		state: 'CLOSED',
		epochId: hex(64),
		slots: [
			{ k: 1, amountMsat: '25000000', paymentHash: hex(64), state: 'settled' },
			{ k: 2, amountMsat: '25000000', paymentHash: hex(64), state: 'settled' }
		],
		activationMismatch: false
	},
	error: null
};
store.state['demo-witness'] = walletState({
	blockHeight: 908214,
	channels: (() => {
		const chans = makeChannels([[2000000, 50, 'NORMAL', false]]);
		chans[0].peerPubkey = nodeId('demo-main');
		return chans;
	})(),
	txs: makeTxs(2, 908214),
	payments: makePayments(2),
	utxos: [],
	invoices: [],
	offers: [],
	peers: [{ pubkey: nodeId('demo-main'), host: '127.0.0.1', port: 9101, state: 'connected' }]
});
store.state['demo-lfbw-setup'] = walletState({
	blockHeight: 908214,
	channels: [],
	txs: [],
	payments: [],
	utxos: [],
	invoices: [],
	offers: [],
	peers: []
});
// The receiver-side direct-funding policy each wallet's daemon holds. A
// lightning-first wallet arms it at setup; anyone else serves no offers.
const directFundingPolicies = {};
function directFundingPolicy(w) {
	if (!directFundingPolicies[w.id]) {
		const lf = w.lfbw && w.lfbw.enabled && w.lfbw.setup === 'ready' ? w.lfbw : null;
		directFundingPolicies[w.id] = lf
			? {
					lspPubkey: lf.primaryPubkey,
					lspHost: '127.0.0.1',
					lspPort: 9101,
					targetInboundSat: lf.mode === 'external' ? 100000 : 0,
					trusted: !!lf.trusted,
					allowSplice: true,
					minAmountSat: 5000
			  }
			: { lspPubkey: null, lspHost: null, lspPort: null, targetInboundSat: 0, trusted: false, allowSplice: false, minAmountSat: 5000 };
	}
	return directFundingPolicies[w.id];
}
const trustedPeers = {};
function lfbwDependentsOf(w) {
	return store.wallets
		.filter((o) => o.id !== w.id && o.lfbw && o.lfbw.enabled && o.lfbw.mode === 'internal' && o.lfbw.primaryWalletId === w.id)
		.map((o) => ({ id: o.id, name: o.name }));
}
const JIT_DEFAULTS = { flatFeeSat: 0, feePpm: 0, maxClientFundingSats: 1000000, maxConcurrentFundings: 3, maxTotalFundingSats: null };
const SWAP_DEFAULTS = {
	enabled: false,
	flatFeeSat: 500,
	feePpm: 1000,
	minSat: 10000,
	maxSat: 1000000,
	maxExposureSat: 5000000,
	maxConcurrent: 8,
	submarine: false,
	claimSafetyBlocks: 24,
	paymentMaxFeePpm: 5000
};

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
			return a + Math.min(c.localBalanceSats, c.pendingSpliceLocalBalanceSats ?? c.localBalanceSats);
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
			// Under a guardian mode every channel step is a journal frame the
			// guardians certify; the watermark moves with the payment.
			if (isGuardianMode(w.recovery?.mode) && st.recovery.gate === 'confirmed') {
				st.recovery.lastDurableSequence = String(BigInt(st.recovery.lastDurableSequence) + 2n);
				emit(w.id, 'recovery:durable', { through: st.recovery.lastDurableSequence });
			}
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
	rec.onionAddress = w.announce ? w.onionAddress ?? null : null;
	rec.recovery = {
		mode: w.recovery?.mode || 'off',
		guardians: (w.recovery?.guardians || []).slice(),
		autoApply: !!w.recovery?.autoApply
	};
	rec.lastStartError = w.lastStartError || null;
	rec.guardianServe = !!w.guardianServe && !w.onchainOnly;
	// Backed up with the box, unless the wallet was made after the last
	// archive was written (which is every wallet created in the demo).
	const backedUp = w.lastBackupAt ?? (w.createdAt < Date.parse(DEMO_BACKUP_AT) ? DEMO_BACKUP_AT : null);
	rec.lastBackupAt = backedUp;
	rec.backupStale = !backedUp;
	// Lightning-first fields, in the manager's shape.
	rec.nodeId = w.onchainOnly ? null : nodeId(w.id);
	rec.listenPort = w.onchainOnly ? null : 9101 + store.wallets.indexOf(w);
	rec.reach = !w.onchainOnly && rec.onionAddress ? { host: rec.onionAddress.split(':')[0], port: rec.listenPort } : null;
	rec.lfbw = w.lfbw ? { ...w.lfbw, lastChannelize: w.lfbwLast || null } : null;
	rec.liquidityProvider = !!w.liquidityProvider && !w.onchainOnly;
	rec.jit = { ...JIT_DEFAULTS, ...(w.jit || {}) };
	rec.swaps = { ...SWAP_DEFAULTS, ...(w.swaps || {}) };
	rec.lfbwDependents = lfbwDependentsOf(w);
	// FFOR offline receive: the settlement role, the last return, and whether
	// a peer contradicted an ACTIVE epoch (enforce on-chain).
	rec.ffor = fforBlockOf(w);
	rec.fforReturn = w.fforReturn || null;
	rec.fforEnforce = w.fforEnforce || null;
	rec.fforEnforced = w.fforEnforced || null;
	rec.fforSetup = w.fforSetup || null;
	rec.fforIssuance = w.fforIssuance || {};
	return rec;
}

// The manager's lightning-first rules, mirrored so the create form's and
// the edit dialog's refusals are demoable.
function normalizeLfbw(input, w) {
	if (!input || !input.enabled) return null;
	if (input.primaryWalletId) {
		const peer = store.wallets.find((x) => x.id === input.primaryWalletId);
		if (!peer) throw err('The selected primary node does not exist', 'BAD_LFBW_PEER');
		if (w && peer.id === w.id) throw err('A wallet cannot be its own primary node', 'BAD_LFBW_PEER');
		if (peer.network !== (w ? w.network : input.network)) {
			throw err(`The selected primary node is on ${peer.network}, not ${w ? w.network : input.network}`, 'BAD_LFBW_PEER');
		}
		if (peer.onchainOnly) throw err('The selected primary node is on-chain only; a primary must run Lightning', 'BAD_LFBW_PEER');
		if (peer.lfbw && peer.lfbw.enabled) throw err("A lightning-first wallet cannot be another wallet's primary node", 'BAD_LFBW_PEER');
		peer.liquidityProvider = true;
		const sats = parseInt(input.initialChannelSats, 10);
		const same = w && w.lfbw && w.lfbw.enabled && w.lfbw.mode === 'internal' && w.lfbw.primaryWalletId === peer.id;
		return {
			enabled: true,
			mode: 'internal',
			primaryWalletId: peer.id,
			primaryUri: null,
			primaryPubkey: nodeId(peer.id),
			trusted: input.trusted === undefined ? true : !!input.trusted,
			initialChannelSats: sats > 0 ? sats : 0,
			initialChannelOpened: same ? !!w.lfbw.initialChannelOpened : false,
			setup: same ? w.lfbw.setup : 'pending',
			setupError: same ? w.lfbw.setupError : null,
			setupAt: same ? w.lfbw.setupAt : null
		};
	}
	const m = String(input.primaryUri || '').trim().match(/^([0-9a-fA-F]{66})@([^:\s]+):(\d+)$/);
	if (!m) throw err('External node URI must be pubkey@host:port', 'BAD_LFBW_PEER');
	return {
		enabled: true,
		mode: 'external',
		primaryWalletId: null,
		primaryUri: `${m[1].toLowerCase()}@${m[2]}:${m[3]}`,
		primaryPubkey: m[1].toLowerCase(),
		trusted: input.trusted === undefined ? true : !!input.trusted,
		initialChannelSats: 0,
		initialChannelOpened: false,
		setup: 'pending',
		setupError: null,
		setupAt: null
	};
}

// Setup runs in the background after create (and on Retry): pending for a
// beat, then ready, with the starting channel landing on the way.
function runDemoLfbwSetup(w) {
	const lf = w.lfbw;
	if (!lf) return Promise.resolve();
	lf.setup = 'pending';
	lf.setupError = null;
	return new Promise((resolve) => setTimeout(() => {
		resolve();
		if (!store.wallets.includes(w) || !w.lfbw) return;
		const st = store.state[w.id];
		if (lf.mode === 'internal' && lf.initialChannelSats > 0 && !lf.initialChannelOpened) {
			const c = makeChannels([[lf.initialChannelSats, 0, 'NORMAL', true]])[0];
			c.peerPubkey = lf.primaryPubkey;
			c.remoteBalanceSats = lf.initialChannelSats;
			c.localBalanceSats = 0;
			st.channels.push(c);
			lf.initialChannelOpened = true;
			emit(w.id, 'channel:ready', {});
		}
		if (lf.primaryPubkey && !st.peers.some((p) => p.pubkey === lf.primaryPubkey)) {
			st.peers.push({ pubkey: lf.primaryPubkey, host: '127.0.0.1', port: 9101, state: 'connected' });
		}
		lf.setup = 'ready';
		lf.setupAt = new Date().toISOString();
		delete directFundingPolicies[w.id];
	}, 2500));
}

// The manager's channel backup rules, mirrored so the dialogs' refusals are
// demoable: settings hold a guardian draft (up to three, saved as far as it
// got), a wallet needs the full three to enable a guardian mode, a wallet
// pins the set it first enables one with, and strict quorum is never left.
const RECOVERY_MODES = ['off', 'peer-storage', 'async-remote', 'quorum'];
const isGuardianMode = (m) => m === 'async-remote' || m === 'quorum';
function guardianEntryOk(g) {
	const at = String(g).indexOf('@');
	if (at !== 64 || !/^[0-9a-f]{64}$/i.test(String(g).slice(0, 64))) return false;
	const url = String(g).slice(65);
	// An HTTP guardian service, or a beignet node hosting one (beignet #699).
	return /^https?:\/\//.test(url) || /^bolt8:\/\/[0-9a-f]{66}@[^\s@/]+:\d+$/i.test(url);
}
const isNodeUri = (t) => /^[0-9a-fA-F]{66}@[^:\s@/]+:\d{1,5}$/.test(String(t || '').trim());
function validateGuardianDraft(list) {
	const entries = (Array.isArray(list) ? list : []).map((g) => String(g || '').trim()).filter(Boolean);
	if (entries.length > 3) {
		throw err(`a guardian set is at most 3 entries; got ${entries.length}`, 'BAD_GUARDIANS');
	}
	for (const g of entries) {
		if (!guardianEntryOk(g)) throw err(`guardian entry "${g}" is not <64-hex pubkey>@<http(s) url>`, 'BAD_GUARDIANS');
	}
	return entries;
}
function normalizeRecovery(mode, existing, autoApply) {
	const current = existing || { mode: 'off', guardians: [] };
	// The automatic checkpoint restore is a peer-storage answer: kept while
	// the mode stays peer storage, dropped the moment it leaves (beignet #690).
	const wanted = autoApply === undefined ? current.autoApply === true : autoApply === true;
	const withAuto = (r) => (r.mode === 'peer-storage' && wanted ? { ...r, autoApply: true } : r);
	if (mode === undefined) return withAuto({ mode: current.mode || 'off', guardians: (current.guardians || []).slice() });
	if (!RECOVERY_MODES.includes(mode)) throw err(`Unknown channel backup mode "${mode}".`, 'BAD_RECOVERY_MODE');
	if (current.mode === 'quorum' && mode !== 'quorum') {
		throw err(
			'A wallet that has used strict quorum cannot move to a weaker setting: its journal refuses to run without the quorum barrier. Keep quorum, or create a new wallet.',
			'RECOVERY_QUORUM_STICKY'
		);
	}
	let guardians = (current.guardians || []).slice();
	if (isGuardianMode(mode) && guardians.length === 0) {
		guardians = store.settings.recoveryGuardians.slice();
		if (guardians.length !== 3) {
			throw err(
				guardians.length === 0
					? 'Guardian modes need three guardians. Set them in Settings first.'
					: `Guardian modes need three guardians. Settings has ${guardians.length}: add the rest first.`,
				'NO_GUARDIANS'
			);
		}
	}
	return withAuto({ mode, guardians });
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
			onionAvailable: true,
			engineVersion: '0.12.0',
			recoveryAvailable: true,
			recoveryGuardians: store.settings.recoveryGuardians.slice(),
			lastBackupAt: store.settings.lastBackupAt,
			lfbwAvailable: true,
			jitQuoteAvailable: true,
			offlineReceiveAvailable: true,
			recoveryAutoApplyAvailable: true,
			guardianHostingAvailable: true,
			guardianRotationAvailable: true,
			fforAvailable: true
		};
	}
	if ((path === '/backup/inspect' || path === '/backup/restore') && method === 'POST') {
		const archive = readDemoArchive(body);
		const wallets = archive.wallets.map((w) => ({
			...w,
			action: store.wallets.some((x) => x.id === w.id) ? 'present' : 'restore',
			duplicateOf: null
		}));
		const restorable = wallets.filter((w) => w.action === 'restore');
		const summary = { createdAt: archive.createdAt, app: archive.app, engine: archive.engine, settings: true };
		if (path === '/backup/inspect') return { ...summary, wallets, conflicts: [] };
		for (const { action, duplicateOf, ...w } of restorable) {
			// Stopped, as the manager leaves a restored wallet, and with an
			// empty state: the chain is where its history comes back from.
			store.wallets.push({ ...w, status: 'stopped', electrum: { ...store.settings.defaultElectrum }, createdAt: Date.now(), lastBackupAt: archive.createdAt });
			store.state[w.id] = walletState({ blockHeight: 908214, channels: [], txs: [], payments: [], utxos: [], invoices: [], offers: [], peers: [] });
		}
		return { ...summary, restored: restorable, skipped: wallets.filter((w) => w.action !== 'restore') };
	}
	if (path === '/recovery/resolve-guardian' && method === 'POST') {
		// The daemon opens a bolt8 session to the node and asks its guardian
		// for its id (#699). A sibling wallet on this box answers with the id
		// its own /guardian/status reports; anyone else gets a fresh one.
		const uri = String(body?.uri || '').trim();
		if (!isNodeUri(uri)) throw err('uri required (<node id>@host:port)', 'INVALID_PARAMS');
		const [node, address] = uri.split('@');
		const sibling = store.wallets.find((w) => w.guardianServe && !w.onchainOnly && nodeId(w.id) === node.toLowerCase());
		if (!sibling && /:1$/.test(address)) throw err(`no guardian answered at bolt8://${node}@${address}: guardian request timed out`, 'GUARDIAN_UNREACHABLE');
		const guardianId = sibling ? guardianIdOf(sibling.id) : hex(64);
		const url = `bolt8://${node.toLowerCase()}@${address.toLowerCase()}`;
		return { guardianId, url, entry: `${guardianId}@${url}`, guardianSetIds: sibling ? [hex(64)] : [], maxCiphertextBytes: 4194304 };
	}
	if (path === '/guardians/candidates') {
		return store.wallets
			.filter((w) => w.guardianServe && !w.onchainOnly)
			.map((w) => {
				const rec = publicRecord(w);
				return {
					id: w.id,
					name: w.name,
					network: w.network,
					nodeId: rec.nodeId,
					running: w.status === 'running',
					onionUri: rec.onionAddress ? `${rec.nodeId}@${rec.onionAddress}` : null,
					localUri: `${rec.nodeId}@127.0.0.1:${rec.listenPort}`
				};
			});
	}
	if (path === '/settings') {
		if (method === 'PUT') {
			const patch = { ...body };
			if (patch.recoveryGuardians !== undefined) {
				patch.recoveryGuardians = validateGuardianDraft(patch.recoveryGuardians);
			}
			Object.assign(store.settings, patch);
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
			announce: !!body.announce && !body.onchainOnly,
			onchainOnly: !!body.onchainOnly,
			recovery: normalizeRecovery(body.onchainOnly ? 'off' : body.recoveryMode, null, body.recoveryAutoApply),
			guardianServe: !!body.guardianServe && !body.onchainOnly,
			createdAt: Date.now()
		};
		w.lfbw = body.onchainOnly ? null : normalizeLfbw(body.lfbw ? { ...body.lfbw, network: w.network } : null, null);
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
		runDemoLfbwSetup(w);
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
			announce: !!body.announce && !body.onchainOnly,
			onchainOnly: !!body.onchainOnly,
			recovery: normalizeRecovery(body.onchainOnly ? 'off' : body.recoveryMode, null, body.recoveryAutoApply),
			guardianServe: !!body.guardianServe && !body.onchainOnly,
			createdAt: Date.now()
		};
		// With the guardians a lost device used, the daemon finds the seed's
		// namespace on them and holds for the restore.
		if (isGuardianMode(w.recovery.mode)) w.status = 'restore-required';
		w.lfbw = body.onchainOnly ? null : normalizeLfbw(body.lfbw ? { ...body.lfbw, network: w.network } : null, null);
		store.wallets.push(w);
		if (w.status === 'running') runDemoLfbwSetup(w);
		store.state[id] = walletState({
			blockHeight: 908214,
			channels: [],
			// An import recovers whatever the seed has done, from before this
			// wallet existed: history is read off the chain, not begun at
			// import.
			txs: makeTxs(12, 908214, w.network),
			payments: [],
			utxos: makeUtxos(2, 908214, w.network),
			invoices: [],
			offers: [],
			peers: []
		});
		// The real route answers { record }, with no seed echoed back.
		return { record: publicRecord(w) };
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
			// Validated first, so a refused mode leaves the record untouched.
			const recovery = normalizeRecovery(body.recoveryMode, w.recovery, body.recoveryAutoApply);
			const dependents = lfbwDependentsOf(w);
			if (body.onchainOnly === true && !w.onchainOnly && dependents.length > 0) {
				const e = err(`This wallet cannot be made on-chain only: it is the primary node of ${dependents.map((d) => `"${d.name}"`).join(', ')}.`, 'PRIMARY_IN_USE');
				e.details = { dependents };
				throw e;
			}
			if (body.liquidityProvider === false && w.liquidityProvider && dependents.length > 0) {
				const e = err(`This wallet cannot stop providing liquidity: it is the primary node of ${dependents.map((d) => `"${d.name}"`).join(', ')}.`, 'PRIMARY_IN_USE');
				e.details = { dependents };
				throw e;
			}
			const nextLfbw = body.lfbw !== undefined ? normalizeLfbw(body.lfbw, w) : undefined;
			if (body.name) w.name = body.name;
			if (body.electrum) w.electrum = body.electrum;
			if (body.tor !== undefined) w.tor = !!body.tor;
			if (body.announce !== undefined) w.announce = !!body.announce;
			if (body.onchainOnly !== undefined) {
				w.onchainOnly = !!body.onchainOnly;
				if (w.onchainOnly) w.announce = false;
			}
			if (body.guardianServe !== undefined) w.guardianServe = !!body.guardianServe;
			if (w.onchainOnly) w.guardianServe = false;
			w.recovery = recovery;
			if (nextLfbw !== undefined) {
				const was = w.lfbw;
				w.lfbw = w.onchainOnly ? null : nextLfbw;
				// The manager remembers the old primary while a channel with it
				// exists (umbrel #86); switching back forgets it.
				if (w.lfbw && was && was.enabled && was.primaryPubkey) {
					if (w.lfbw.primaryPubkey === was.primaryPubkey) w.lfbw.previousPrimary = was.previousPrimary || null;
					else if (was.previousPrimary && was.previousPrimary.pubkey === w.lfbw.primaryPubkey) w.lfbw.previousPrimary = null;
					else w.lfbw.previousPrimary = { pubkey: was.primaryPubkey, walletId: was.mode === 'internal' ? was.primaryWalletId : null, at: Date.now() };
				}
				if (w.lfbw && (!was || was.setup !== 'ready' || w.lfbw.setup !== 'ready')) runDemoLfbwSetup(w);
			}
			if (body.liquidityProvider !== undefined) w.liquidityProvider = !!body.liquidityProvider;
			if (body.ffor) {
				const block = fforBlockOf(w);
				const role = (name, bounds, optional) => {
					const s = body.ffor[name];
					if (s === undefined) return;
					if (s === null || typeof s !== 'object') throw err(`ffor.${name} must be an object`, 'BAD_FFOR');
					if ('enabled' in s) block[name].enabled = !!s.enabled;
					for (const k of bounds) {
						if (!(k in s)) continue;
						if (s[k] === null || s[k] === '') {
							if (optional.includes(k)) block[name][k] = null;
							else throw err(`${k} must be a whole number`, 'BAD_FFOR');
							continue;
						}
						const n = Number(s[k]);
						if (!Number.isInteger(n) || n < 0) throw err(`${k} must be a whole number`, 'BAD_FFOR');
						block[name][k] = n;
					}
				};
				role('settle', ['maxBudgetMsat', 'maxEpochBlocks', 'feeBaseMsat', 'feePpm'], ['maxBudgetMsat', 'maxEpochBlocks']);
				role('witness', ['maxMailboxes', 'maxBytes'], ['maxMailboxes', 'maxBytes']);
				role('issuer', [], []);
				if (block.issuer.enabled && !block.witness.enabled) throw err('The issuer runs on a receipt witness: turn on the witness too.', 'BAD_FFOR');
				if ((block.settle.enabled || block.witness.enabled) && w.onchainOnly) throw err('An on-chain only wallet runs no Lightning listener, so it cannot serve offline receives.', 'FFOR_NEEDS_LIGHTNING');
				w.ffor = block;
			}
			if (w.onchainOnly && w.ffor) w.ffor = { settle: { ...w.ffor.settle, enabled: false }, witness: { ...w.ffor.witness, enabled: false }, issuer: { enabled: false } };
			if (body.swaps) {
				const swaps = { ...SWAP_DEFAULTS, ...(w.swaps || {}) };
				if ('enabled' in body.swaps) swaps.enabled = !!body.swaps.enabled;
				if ('submarine' in body.swaps) swaps.submarine = !!body.swaps.submarine;
				for (const k of Object.keys(SWAP_DEFAULTS)) {
					if (k === 'enabled' || k === 'submarine' || !(k in body.swaps)) continue;
					const n = Number(body.swaps[k]);
					if (body.swaps[k] === '' || !Number.isInteger(n) || n < 0) throw err(`${k} must be a whole number`, 'BAD_SWAPS');
					swaps[k] = n;
				}
				if (swaps.minSat > swaps.maxSat) throw err('minSat must not exceed maxSat', 'BAD_SWAPS');
				if (swaps.claimSafetyBlocks < 1 || swaps.claimSafetyBlocks > 2016) {
					throw err('claimSafetyBlocks must be a whole number between 1 and 2016', 'BAD_SWAPS');
				}
				w.swaps = swaps;
			}
			if (body.jit) {
				const jit = { ...JIT_DEFAULTS, ...(w.jit || {}) };
				for (const k of Object.keys(JIT_DEFAULTS)) {
					if (!(k in body.jit)) continue;
					const raw = body.jit[k];
					if (raw === null || raw === '') {
						if (k === 'maxTotalFundingSats') jit[k] = null;
						else throw err(`${k} must be a whole number`, 'BAD_JIT');
						continue;
					}
					const n = Number(raw);
					if (!Number.isInteger(n) || n < 0) throw err(`${k} must be a whole number`, 'BAD_JIT');
					jit[k] = n;
				}
				w.jit = jit;
			}
			return publicRecord(w);
		}
		if (method === 'DELETE') {
			const dependents = lfbwDependentsOf(w);
			if (dependents.length > 0) {
				const e = err(`This wallet cannot be deleted: it is the primary node of ${dependents.map((d) => `"${d.name}"`).join(', ')}. Change their primary node or delete them first.`, 'PRIMARY_IN_USE');
				e.details = { dependents };
				throw e;
			}
			store.wallets = store.wallets.filter((x) => x.id !== w.id);
			delete store.state[w.id];
			return { deleted: true };
		}
	}
	if (sub === 'lfbw/channelize' && method === 'POST') {
		// One channelize pass past the fee wait: the confirmed deposit moves
		// into the home channel by a splice, which locks a moment later.
		if (!w.lfbw || !w.lfbw.enabled) throw err('Not a lightning-first wallet', 'NOT_LFBW');
		if (w.lfbw.setup !== 'ready') throw err('The link to the primary node is not set up yet', 'LFBW_NOT_READY');
		const st = store.state[w.id];
		const confirmed = st.utxos.filter((u) => u.height > 0);
		const amountSats = confirmed.reduce((a, u) => a + u.valueSats, 0);
		const home = st.channels.find((c) => c.peerPubkey === w.lfbw.primaryPubkey && c.state === 'NORMAL');
		if (amountSats < 20000) {
			w.lfbwLast = { at: Date.now(), action: 'wait', reason: 'quote-too-small' };
			return { ...w.lfbwLast };
		}
		st.utxos = st.utxos.filter((u) => !(u.height > 0));
		if (home) {
			home.state = 'SPLICING';
			home.payThroughSplice = true;
			home.pendingSpliceLocalBalanceSats = home.localBalanceSats + amountSats - 1200;
			setTimeout(() => {
				home.state = 'NORMAL';
				home.capacitySats += amountSats - 1200;
				home.localBalanceSats = home.pendingSpliceLocalBalanceSats;
				delete home.pendingSpliceLocalBalanceSats;
				emit(w.id, 'channel:ready', {});
			}, 6000);
			w.lfbwLast = { at: Date.now(), action: 'splice-in', amountSats: amountSats - 1200 };
		} else {
			const c = makeChannels([[amountSats - 1200, 100, 'NORMAL', true]])[0];
			c.peerPubkey = w.lfbw.primaryPubkey;
			st.channels.push(c);
			w.lfbwLast = { at: Date.now(), action: 'open', amountSats: amountSats - 1200 };
		}
		return { ...w.lfbwLast };
	}
	if (sub === 'lfbw/move-home' && method === 'POST') {
		// Close every open channel with the previous primary; the payout
		// moves into the home channel once it confirms (umbrel #86).
		if (!w.lfbw || !w.lfbw.enabled) throw err('Not a lightning-first wallet', 'NOT_LFBW');
		const previous = w.lfbw.previousPrimary;
		if (!previous) throw err('This wallet has not changed its primary node', 'NO_PREVIOUS_PRIMARY');
		const st = store.state[w.id];
		const open = st.channels.filter((c) => c.peerPubkey === previous.pubkey && c.state === 'NORMAL');
		if (open.length === 0) throw err('The channel with the previous primary is already closing', 'NO_PREVIOUS_CHANNEL');
		for (const c of open) closeDemoChannel(w.id, c.channelId, false);
		return { closed: open.map((c) => c.channelId), pubkey: previous.pubkey };
	}
	if (sub === 'lfbw/close-home' && method === 'POST') {
		if (!w.lfbw || !w.lfbw.enabled) throw err('Not a lightning-first wallet', 'NOT_LFBW');
		const st = store.state[w.id];
		const c = st.channels.find((x) => x.channelId === body.channelId);
		if (!c) throw err('Channel not found', 'INVALID_PARAMS');
		if (body.turnOff) {
			// Lightning-first off first, so the payout stays on-chain; the
			// manager restarts the daemon on the new posture before closing.
			w.lfbw = null;
		}
		closeDemoChannel(w.id, c.channelId, false);
		return { closed: c.channelId, lfbwOff: !!body.turnOff, record: publicRecord(w) };
	}
	if (sub === 'recovery/rotate' && method === 'POST') {
		// The daemon registers with the new set under its current lease,
		// backfills, switches, and retires the old set (beignet #701). The
		// record follows on success; the wallet keeps running.
		if (!isGuardianMode(w.recovery?.mode)) throw err('Wallet is not in a guardian mode', 'NOT_GUARDIAN_MODE');
		if (w.status !== 'running') throw err('Wallet is not running', 'NOT_RUNNING');
		const entries = Array.isArray(body?.guardians) ? body.guardians.map((g) => String(g).trim()) : [];
		if (entries.length !== 3) throw err('Exactly three guardians are required', 'BAD_GUARDIANS');
		const before = (w.recovery.guardians || []).map((g) => String(g).slice(0, 64)).sort().join(',');
		const after = entries.map((g) => g.slice(0, 64)).sort().join(',');
		if (before === after) throw err('That is the set this wallet already has', 'BAD_GUARDIANS');
		const st = store.state[w.id];
		if (st.recovery.rotation?.inProgress) throw err('A rotation is already running', 'ROTATION_IN_PROGRESS');
		st.recovery.generation = String(BigInt(st.recovery.generation || '1') + 1n);
		st.recovery.rotation = { inProgress: false, pending: false, retirePending: false, lastEvent: { type: 'rotation:retired', detail: `generation ${st.recovery.generation}` }, followed: null };
		w.recovery = { ...w.recovery, guardians: entries };
		emit(w.id, 'recovery:rotated', { generation: st.recovery.generation });
		return { record: publicRecord(w), generation: st.recovery.generation, retired: 3 };
	}
	if (sub === 'lfbw/setup' && method === 'POST') {
		// Like the manager: the call answers once setup has run its course.
		if (!w.lfbw || !w.lfbw.enabled) throw err('Not a lightning-first wallet', 'NOT_LFBW');
		return runDemoLfbwSetup(w).then(() => publicRecord(w));
	}
	if (sub === 'start') {
		w.status = 'starting';
		setTimeout(() => {
			w.status = 'running';
			emit(w.id, 'node:ready', {});
			// The manager reconciles every open voucher book with its
			// settlement peer once the daemon is healthy (FFOR).
			for (const e of fforEpochsOf(w.id)) {
				if (e.role === 'R' && (e.state === 'ACTIVE' || e.state === 'DRAINING')) {
					setTimeout(() => {
						try {
							fforReturn(w, e.channelId);
						} catch (_) {
							/* the demo peer is gone */
						}
					}, 1500);
				}
			}
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
	if (sub === 'direct-funding/fallbacks') {
		// Direct fundings that degraded into an ordinary payment, recorded by the
		// send card and read back onto the payment's activity row.
		if (method === 'POST') {
			if (!body || !String(body.reason || '').trim()) throw err('reason is required', 'INVALID_PARAMS');
			// The timestamp is the manager's, never the browser's, exactly as the
			// real route does it.
			const entry = { ...body, reason: String(body.reason).trim(), timestamp: Date.now() };
			(fundingFallbacks[w.id] = fundingFallbacks[w.id] || []).push(entry);
			return { ...entry, persisted: true };
		}
		return (fundingFallbacks[w.id] || []).slice();
	}
	if (sub === 'direct-funding/steps') {
		const requestId = new URLSearchParams(subQuery || '').get('requestId') || '';
		return (fundingSteps[`${w.id}:${requestId.toLowerCase()}`] || []).slice();
	}
	// FFOR offline receive: the siblings that settle, and the manager's
	// reconcile with the settlement peer, run on demand.
	if (sub === 'ffor/candidates') return fforCandidatesOf(w);
	if (sub === 'ffor/return' && method === 'POST') {
		if (w.status !== 'running') throw err('The wallet is not running', 'NOT_RUNNING');
		return fforReturn(w, body && body.channelId);
	}
	if ((sub === 'ffor/epoch' || sub === 'ffor/provision') && method === 'POST') {
		if (w.status !== 'running') throw err('The wallet is not running', 'NOT_RUNNING');
		return fforSetupEpoch(w, body || {}, sub === 'ffor/provision');
	}
	if (sub === 'ffor/enforce' && method === 'POST') {
		if (w.status !== 'running') throw err('The wallet is not running', 'NOT_RUNNING');
		const res = fforRequest(w, store.state[w.id], '/ffor/enforce', '', 'POST', body || {});
		if (!res || res.ok === false) throw err((res && res.error) || 'the daemon refused the force close', 'FFOR_ENFORCE_REFUSED');
		w.fforEnforced = { at: Date.now(), channelId: body.channelId, commitmentTxid: res.commitmentTxid, preimagesKnown: res.preimagesKnown };
		w.fforEnforce = null;
		if (w.fforReturn && w.fforReturn.channelId === body.channelId) {
			w.fforReturn = { ...w.fforReturn, at: w.fforEnforced.at, outcome: 'enforced', channelState: 'FORCE_CLOSED' };
		}
		return w.fforEnforced;
	}
	throw err(`Unknown demo endpoint ${path}`, 'NOT_FOUND');
}

// ---------- FFOR offline receive (beignet #729) ----------


function fforCandidatesOf(self) {
	return store.wallets
		.filter((x) => x.id !== self.id && x.network === self.network && !x.onchainOnly && x.ffor)
		.map((x) => ({ x, b: fforBlockOf(x) }))
		.filter(({ b }) => b.settle.enabled || b.witness.enabled)
		.map(({ x, b }) => ({
			id: x.id,
			name: x.name,
			nodeId: nodeId(x.id),
			running: x.status === 'running',
			settles: b.settle.enabled,
			witnesses: b.witness.enabled,
			issues: b.witness.enabled && b.issuer.enabled
		}));
}

function fforEpochsOf(id) {
	return (fforEpochs[id] = fforEpochs[id] || []);
}

function fforSlotView(s) {
	// From beignet 0.21.5 an exposed slot carries the invoice it was minted with.
	return { k: s.k, amountMsat: s.amountMsat, paymentHash: s.paymentHash, state: s.state, ...(s.bolt11 ? { bolt11: s.bolt11 } : {}) };
}

function fforView(e) {
	return { ...e, slots: e.slots.map(fforSlotView) };
}

function fforEmitState(walletId, e) {
	emit(walletId, 'ffor:state', { channelId: e.channelId, state: e.state, epoch: fforView(e) });
	recordChannelEvent(walletId, { timestamp: Date.now(), event: 'ffor:state', channelId: e.channelId, state: e.state });
}

/** Seed an epoch on a channel between two demo wallets: R's view and S's mirror. */
function seedFforEpoch({ receiverId, settlerId, channelId, state, amountsSats, slotStates, settlementDeadline, voucherExpiry, startedAt, witnessPeers = [], witnesses = [] }) {
	const epochId = hex(64);
	const slots = amountsSats.map((sats, i) => ({
		k: i + 1,
		amountMsat: String(sats * 1000),
		paymentHash: hex(64),
		state: slotStates[i] || 'unissued',
		...(slotStates[i] === 'exposed' || slotStates[i] === 'settled' ? { bolt11: demoInvoice('mainnet', sats) } : {})
	}));
	const base = {
		channelId,
		epochId,
		peerNodeId: null,
		variant: 'D',
		budgetMsat: String(amountsSats.reduce((a, b) => a + b, 0) * 1000),
		numSlots: slots.length,
		hashChain: false,
		witnessPeers,
		settlementDeadline,
		voucherExpiry,
		feeBaseMsat: 1000,
		feeProportionalMillionths: 100,
		epochStartHeight: startedAt,
		activationHash: hex(64),
		witnesses: [],
		settledBitmap: null,
		abortReason: null,
		activationMismatch: false,
		closeSent: false
	};
	const r = { ...base, role: 'R', state, peerNodeId: nodeId(settlerId), slots, witnesses: witnesses.slice() };
	const sTable = { unissued: 'unused', exposed: 'unused', settled: 'settled', unsettled: 'unused' };
	const s = { ...base, role: 'S', state, peerNodeId: nodeId(receiverId), slots: slots.map((x) => ({ ...x, state: sTable[x.state] || 'unused' })) };
	fforEpochsOf(receiverId).push(r);
	fforEpochsOf(settlerId).push(s);
	return { r, s };
}

function fforMirror(walletId, e) {
	const peer = store.wallets.find((x) => nodeId(x.id) === e.peerNodeId);
	return peer ? fforEpochsOf(peer.id).find((x) => x.epochId === e.epochId) || null : null;
}

/** The manager's return: close cooperatively when the peer runs, credit what was paid. */
function fforReturn(w, channelId) {
	const e = fforEpochsOf(w.id).find((x) => x.role === 'R' && x.channelId === channelId);
	if (!e) throw err('no FFOR epoch on this channel', 'NOT_FOUND');
	const peer = store.wallets.find((x) => nodeId(x.id) === e.peerNodeId);
	const ch0 = store.state[w.id].channels.find((c) => c.channelId === channelId);
	const reachable = !!peer && peer.status === 'running' && !!ch0 && ch0.state === 'NORMAL';
	let action = 'nothing';
	if (reachable && e.state === 'ACTIVE') {
		// The demo: every shared invoice was paid while away.
		for (const s of e.slots) if (s.state === 'exposed') s.state = 'settled';
		for (const s of e.slots) if (s.state === 'unissued') s.state = 'unsettled';
		e.state = 'CLOSED';
		e.closeSent = true;
		const m = fforMirror(w.id, e);
		if (m) {
			m.state = 'CLOSED';
			m.slots.forEach((s, i) => (s.state = e.slots[i].state === 'settled' ? 'settled' : 'unused'));
			fforEmitState(peer.id, m);
		}
		const credited = e.slots.filter((s) => s.state === 'settled').reduce((a, s) => a + Number(s.amountMsat) / 1000, 0);
		const ch = store.state[w.id].channels.find((c) => c.channelId === channelId);
		if (ch && credited > 0) {
			ch.localBalanceSats += credited;
			ch.remoteBalanceSats = Math.max(0, ch.remoteBalanceSats - credited);
		}
		fforEmitState(w.id, e);
		action = 'closed';
	}
	const channelState = ch0 ? ch0.state : null;
	const closedChannel = channelState === 'CLOSED' || channelState === 'FORCE_CLOSED';
	const outcome =
		e.state === 'CLOSED' || e.state === 'ABORTED' ? 'closed' : e.state === 'DRAINING' ? 'draining' : closedChannel ? 'enforced' : 'unreachable';
	w.fforReturn = {
		at: Date.now(),
		channelId,
		action,
		outcome,
		channelState,
		preimagesKnown: e.slots.filter((s) => s.state === 'settled').map((s) => s.k),
		witnesses: (e.witnesses || []).map((wit) => {
			const host = store.wallets.find((x) => nodeId(x.id) === wit.witnessNodeId);
			const settled = e.slots.filter((s) => s.state === 'settled');
			return host && host.status === 'running'
				? { witnessNodeId: wit.witnessNodeId, ok: true, error: null, credited: settled.length, records: settled.map((s) => ({ k: s.k, unbarriered: false, verified: true })) }
				: { witnessNodeId: wit.witnessNodeId, ok: false, error: `witness ${String(wit.witnessNodeId).slice(0, 12)} did not answer type 55059`, credited: 0, records: [] };
		}),
		epoch: { state: e.state, epochId: e.epochId, slots: e.slots.map(fforSlotView), activationMismatch: false },
		error: null
	};
	return w.fforReturn;
}

/** The manager's setup: start, sign, provision each witness, then the issuer. */
async function fforSetupEpoch(w, body, provisionOnly) {
	const st = store.state[w.id];
	const cands = fforCandidatesOf(w);
	const witnesses = (body.witnessWalletIds || []).map((wid) => {
		const c = cands.find((x) => x.id === wid);
		if (!c || !c.witnesses) throw err(`"${wid}" is not a sibling that keeps receipts`, 'BAD_FFOR_SETUP');
		return c;
	});
	let issuer = null;
	if (body.issuer && body.issuer.walletId) {
		issuer = cands.find((x) => x.id === body.issuer.walletId);
		if (!issuer || !issuer.issues) throw err('not a sibling that issues invoices', 'BAD_FFOR_SETUP');
		if (!witnesses.some((x) => x.id === issuer.id)) throw err(`The issuer "${issuer.name}" must be one of the witnesses`, 'BAD_FFOR_SETUP');
		if (!String(body.issuer.description || '').trim()) throw err('The offer needs a description', 'BAD_FFOR_SETUP');
	}
	const setup = {
		at: Date.now(),
		running: true,
		channelId: body.channelId,
		epochId: null,
		step: provisionOnly ? 'provisioning' : 'starting',
		witnesses: witnesses.map((c) => ({ walletId: c.id, name: c.name, nodeId: c.nodeId, step: 'pending', error: null })),
		issuer: issuer ? { walletId: issuer.id, name: issuer.name, nodeId: issuer.nodeId, step: 'pending', error: null } : null,
		error: null
	};
	w.fforSetup = setup;
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	try {
		let e;
		if (!provisionOnly) {
			e = fforRequest(w, st, '/ffor/epoch/start', '', 'POST', { ...body, witnessPeers: witnesses.map((c) => c.nodeId) });
			setup.epochId = e.epochId;
			setup.step = 'activating';
			e = fforEpochsOf(w.id).find((x) => x.epochId === setup.epochId);
			while (e.state !== 'ACTIVE' && e.state !== 'ABORTED') await sleep(500);
			if (e.state === 'ABORTED') throw err(`the settlement peer aborted the book (reason ${e.abortReason})`, 'FFOR_SETUP_FAILED');
		} else {
			e = fforEpochsOf(w.id).find((x) => x.role === 'R' && x.channelId === body.channelId);
			if (!e) throw err('No epoch of this wallet on that channel', 'NOT_FOUND');
			if (e.state !== 'ACTIVE') throw err(`The epoch is ${e.state}, not ACTIVE`, 'FFOR_NOT_ACTIVE');
			setup.epochId = e.epochId;
			for (const c of witnesses) {
				if (!(e.witnessPeers || []).includes(c.nodeId)) throw err(`"${c.name}" was not named as a witness when the book was started; start a new book with it`, 'BAD_FFOR_SETUP');
			}
		}
		for (const [i, c] of witnesses.entries()) {
			setup.step = 'provisioning';
			const entry = setup.witnesses[i];
			if (e.witnesses.some((x) => x.witnessNodeId === c.nodeId && x.acknowledged)) {
				entry.step = 'acknowledged';
				continue;
			}
			entry.step = 'connecting';
			await sleep(600);
			entry.step = 'provisioning';
			await sleep(600);
			const r = fforRequest(w, st, '/ffor/witness/provision', '', 'POST', { channelId: e.channelId, witnessNodeId: c.nodeId });
			entry.mailboxId = r.mailboxId;
			entry.step = 'acknowledged';
		}
		if (issuer) {
			setup.step = 'issuing';
			await sleep(600);
			const offer = fforRequest(w, st, '/ffor/issuer/offer', '', 'POST', { issuerNodeId: issuer.nodeId, description: body.issuer.description, amountMsat: e.slots[0].amountMsat });
			setup.issuer.offerId = offer.offerId;
			setup.issuer.step = 'provisioning';
			await sleep(600);
			fforRequest(w, st, '/ffor/issuer/provision', '', 'POST', { channelId: e.channelId, issuerNodeId: issuer.nodeId, offer: offer.encoded, witnessHops: [{ nodeId: issuer.nodeId }] });
			w.fforIssuance = { ...(w.fforIssuance || {}), [e.channelId]: { epochId: e.epochId, offerId: offer.offerId, encoded: offer.encoded, issuerWalletId: issuer.id, issuerName: issuer.name, issuerNodeId: issuer.nodeId, description: body.issuer.description, at: Date.now() } };
			setup.issuer.step = 'provisioned';
		}
		setup.step = 'done';
		return setup;
	} catch (x) {
		setup.error = x.message;
		if (setup.step === 'starting' || setup.step === 'activating') setup.step = 'failed';
		throw x;
	} finally {
		setup.running = false;
	}
}

/** The daemon's /ffor/* surface for one wallet. */
function fforRequest(w, st, route, query, method, body) {
	const mine = fforEpochsOf(w.id);
	// The daemon keeps one epoch record per channel, the latest; the demo
	// keeps history, so the newest record on the channel is the one.
	const byChannel = (cid, role) => [...mine].reverse().find((x) => x.channelId === cid && (!role || x.role === role));
	switch (route) {
		case '/ffor/epochs':
			return mine.map(fforView);
		case '/ffor/settlements':
			return mine.filter((x) => x.role === 'S').map(fforView);
		case '/ffor/epoch': {
			const cid = new URLSearchParams(query || '').get('channelId') || (body && body.channelId);
			const e = byChannel(cid);
			if (!e) throw err('no FFOR epoch on this channel', 'NOT_FOUND');
			return fforView(e);
		}
		case '/ffor/epoch/start': {
			const ch = st.channels.find((c) => c.channelId === body.channelId);
			if (!ch) throw err('Channel not found', 'CHANNEL_NOT_FOUND');
			if (mine.some((x) => x.channelId === ch.channelId && !['CLOSED', 'ABORTED'].includes(x.state))) {
				throw err('a live epoch already exists on this channel', 'FFOR_REFUSED');
			}
			const peer = store.wallets.find((x) => nodeId(x.id) === ch.peerPubkey);
			if (!peer || !peer.ffor || !peer.ffor.settle || !peer.ffor.settle.enabled) {
				throw err('settlement service not offered by this peer', 'FFOR_REFUSED');
			}
			const amounts = (body.voucherAmountsMsat || []).map((m) => Math.floor(Number(m) / 1000));
			if (amounts.length === 0 || amounts.length > 483) throw err('voucherAmountsMsat must hold 1 to 483 entries', 'INVALID_PARAMS');
			const budget = amounts.reduce((a, b) => a + b, 0);
			if (budget > ch.remoteBalanceSats) throw err('S cannot cover budget_msat plus its channel reserve', 'FFOR_REFUSED');
			if (Number(body.voucherExpiry) < Number(body.settlementDeadline) + 1008) {
				throw err('voucher_expiry must sit at least 1008 blocks past settlement_deadline', 'FFOR_REFUSED');
			}
			const { r, s } = seedFforEpoch({
				receiverId: w.id,
				settlerId: peer.id,
				channelId: ch.channelId,
				state: 'NEGOTIATING',
				witnessPeers: Array.isArray(body.witnessPeers) ? body.witnessPeers : [],
				amountsSats: amounts,
				slotStates: [],
				settlementDeadline: Number(body.settlementDeadline),
				voucherExpiry: Number(body.voucherExpiry),
				startedAt: st.blockHeight
			});
			// Setup runs to ACTIVE on its own: the two sides sign the book.
			setTimeout(() => {
				if (r.state !== 'NEGOTIATING') return;
				r.state = s.state = 'VOUCHERS_COMMITTED';
				fforEmitState(w.id, r);
				setTimeout(() => {
					if (r.state !== 'VOUCHERS_COMMITTED') return;
					r.state = s.state = 'ACTIVE';
					fforEmitState(w.id, r);
					fforEmitState(peer.id, s);
				}, 2500);
			}, 2000);
			return fforView(r);
		}
		case '/ffor/epoch/abort': {
			const e = byChannel(body.channelId, 'R');
			if (!e) throw err('no FFOR epoch on this channel', 'NOT_FOUND');
			if (e.state === 'ACTIVE') throw err('an ACTIVE epoch cannot be aborted; close or recover it', 'FFOR_REFUSED');
			e.state = 'ABORTED';
			e.abortReason = Number(body.reason) || 0;
			const m = fforMirror(w.id, e);
			if (m) m.state = 'ABORTED';
			fforEmitState(w.id, e);
			return fforView(e);
		}
		case '/ffor/invoice': {
			const e = byChannel(body.channelId, 'R');
			if (!e) throw err('no FFOR epoch on this channel', 'NOT_FOUND');
			if (e.state !== 'ACTIVE') throw err(`the epoch is ${e.state}, not ACTIVE`, 'FFOR_REFUSED');
			const slot = e.slots.find((s) => s.k === Number(body.k));
			if (!slot) throw err('k is outside the book', 'INVALID_PARAMS');
			if (slot.state !== 'unissued') throw err(`slot ${slot.k} already has an invoice`, 'FFOR_REFUSED');
			slot.state = 'exposed';
			const sats = Math.floor(Number(slot.amountMsat) / 1000);
			slot.bolt11 = demoInvoice(w.network, sats);
			return { bolt11: slot.bolt11, paymentHash: slot.paymentHash, k: slot.k, amountMsat: slot.amountMsat };
		}
		case '/ffor/recover': {
			const e = byChannel(body.channelId, 'R');
			if (!e) throw err('no FFOR epoch on this channel', 'NOT_FOUND');
			const ret = fforReturn(w, body.channelId);
			return { action: ret.action, preimagesKnown: ret.preimagesKnown, witnesses: [], epoch: fforView(e) };
		}
		case '/ffor/enforce': {
			// Like the daemon: a force close carrying every known preimage,
			// answered in the force-close route's shape (a refusal inside
			// the 200), and the epoch stays ACTIVE on the record.
			const e = byChannel(body.channelId, 'R');
			if (!e) throw err('no FFOR epoch of ours on this channel', 'NOT_FOUND');
			const ch = st.channels.find((c) => c.channelId === body.channelId);
			if (!ch) return { ok: false, error: 'Channel not found' };
			if (ch.state === 'FORCE_CLOSED' || ch.state === 'CLOSED') return { ok: false, error: `Channel is already ${ch.state}` };
			ch.state = 'FORCE_CLOSED';
			recordChannelEvent(w.id, { timestamp: Date.now(), event: 'channel:force-closing', channelId: ch.channelId, initiator: 'local' });
			emit(w.id, 'channel:force-closing', { channelId: ch.channelId, initiator: 'local' });
			return { ok: true, commitmentTxid: hex(64), preimagesKnown: e.slots.filter((s) => s.state === 'settled').length };
		}
		case '/ffor/witness/provision': {
			const e = byChannel(body.channelId, 'R');
			if (!e) throw err('no FFOR epoch of ours on this channel', 'NOT_FOUND');
			if (e.state !== 'ACTIVE') throw err('witnesses are provisioned on an ACTIVE epoch', 'FFOR_REFUSED');
			const host = store.wallets.find((x) => nodeId(x.id) === body.witnessNodeId);
			const hb = host && fforBlockOf(host);
			if (!host || host.status !== 'running' || !hb.witness.enabled) throw err(`witness ${String(body.witnessNodeId).slice(0, 12)} did not answer type 55055`, 'FFOR_REFUSED');
			const known = e.witnesses.find((x) => x.witnessNodeId === body.witnessNodeId);
			if (known) return { mailboxId: known.mailboxId, retentionUntil: known.retentionUntil };
			const mailboxId = hex(64);
			const retentionUntil = e.voucherExpiry + 288;
			e.witnesses.push({ witnessNodeId: body.witnessNodeId, mailboxId, retentionUntil, acknowledged: true });
			(fforMailboxes[host.id] = fforMailboxes[host.id] || []).push({ mailboxId, state: 'PROVISIONED', slots: e.slots.length, records: 0, retentionUntil, provisionedAt: Date.now(), epochId: e.epochId });
			emit(host.id, 'ffor:witness-provisioned', { mailboxId, slots: e.slots.length, retentionUntil, peer: nodeId(w.id) });
			return { mailboxId, retentionUntil };
		}
		case '/ffor/issuer/offer': {
			if (!/^0[23][0-9a-fA-F]{64}$/.test(String(body.issuerNodeId || ''))) throw err('issuerNodeId must be a compressed node id', 'INVALID_PARAMS');
			if (!String(body.description || '').trim()) throw err('description required', 'INVALID_PARAMS');
			const offerId = hex(64);
			return { offerId, encoded: `lno1${hex(120)}` };
		}
		case '/ffor/issuer/provision': {
			const e = byChannel(body.channelId, 'R');
			if (!e) throw err('no FFOR epoch of ours on this channel', 'NOT_FOUND');
			const wit = e.witnesses.find((x) => x.witnessNodeId === body.issuerNodeId && x.acknowledged);
			if (!wit) throw err('the issuer must first be provisioned as a witness', 'FFOR_REFUSED');
			const host = store.wallets.find((x) => nodeId(x.id) === body.issuerNodeId);
			const hb = host && fforBlockOf(host);
			if (!host || !hb.issuer.enabled) throw err('issuer refused the manifest: no offer path terminates at this node', 'FFOR_REFUSED');
			(fforManifests[host.id] = fforManifests[host.id] || []).push({ mailboxId: wit.mailboxId, offerId: hex(64), state: 'ISSUING', slots: e.slots.length, issued: [], issueUntil: e.settlementDeadline });
			emit(host.id, 'ffor:issuer-provisioned', { mailboxId: wit.mailboxId, offerId: hex(64), slots: e.slots.length });
			return { mailboxId: wit.mailboxId, blindedNodeIds: [pubkey()] };
		}
		case '/ffor/witness/status': {
			const b = fforBlockOf(w);
			return { enabled: !!b.witness.enabled, mailboxes: b.witness.enabled ? (fforMailboxes[w.id] || []).map(({ epochId: _e, ...m }) => m) : [] };
		}
		case '/ffor/issuer/status': {
			const b = fforBlockOf(w);
			return { enabled: !!(b.witness.enabled && b.issuer.enabled), manifests: b.issuer.enabled ? (fforManifests[w.id] || []).slice() : [] };
		}
		default:
			return undefined;
	}
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

// GET /recovery/status in the daemon's shape (beignet 0.9.2): the daemon's
// state, the guardian set, and the node layer with a status per channel.
function recoveryStatus(w, st) {
	const mode = w.recovery?.mode || 'off';
	const capsules = {
		candidates: st.recovery.capsule ? 1 : 0,
		best: st.recovery.capsule ? { ...st.recovery.capsule } : null
	};
	if (mode === 'off') return { mode: 'off', profile: null, guardians: [], state: 'disabled', node: null, capsules };
	const guardians = (w.recovery.guardians || []).map((g) => ({
		guardianId: String(g).slice(0, 64),
		url: String(g).slice(65)
	}));
	const profile = isGuardianMode(mode) ? 'crash-v1' : null;
	const r = st.recovery;
	// Guardian-set rotation (beignet #701): the generation the journal is
	// on and whether a rotation or a retirement is still owed.
	const rotationView = isGuardianMode(mode)
		? {
				generation: r.generation || '1',
				configuredSetStale: false,
				rotation: r.rotation || { inProgress: false, pending: false, retirePending: false, lastEvent: null, followed: null }
		  }
		: {};
	if (w.status === 'restore-required' || r.restore) {
		return {
			mode,
			profile,
			...rotationView,
			guardians,
			state: r.restore?.inProgress ? 'restoring' : 'restore-required',
			node: null,
			capsules,
			restore: { inProgress: !!r.restore?.inProgress, ...(r.restore?.lastEvent ? { lastEvent: r.restore.lastEvent } : {}) }
		};
	}
	// The daemon's own checkpoint restore (beignet #690), when the owner
	// answered the import question: where it stands, and the reason when it
	// refused.
	const autoApply =
		mode === 'peer-storage'
			? { enabled: !!w.recovery?.autoApply, phase: 'idle', settleUntil: null, lastReason: null, ...(w.recovery?.autoApply ? r.autoApply || {} : {}) }
			: undefined;
	const gate = isGuardianMode(mode) ? r.gate : 'disabled';
	const channels = st.channels
		.filter((c) => c.state !== 'CLOSED' && c.state !== 'FORCE_CLOSED')
		.map((c) => ({
			channelId: c.channelId,
			status: r.channelStatuses[c.channelId] || (gate === 'quarantined' ? 'quarantined' : 'active'),
			awaitingDurability: false
		}));
	const node = {
		gate,
		durability: mode === 'peer-storage' ? 'local' : mode,
		startupRepairPending: r.startupRepairPending,
		lastDurableSequence: isGuardianMode(mode) ? r.lastDurableSequence : '0',
		awaitingDurabilityCount: r.awaitingDurabilityCount,
		fenced: r.fenced,
		backfillLost: r.backfillLost,
		// What the barrier has cost (beignet #702): only quorum mode ever
		// parks a step, and the demo's guardians sit a few hundred
		// milliseconds away over Tor.
		barrierLatency:
			mode === 'quorum'
				? { released: 412, refused: 0, sampled: 256, lastMs: 610, meanMs: 680, p50Ms: 640, p95Ms: 1150, maxMs: 2900 }
				: null,
		channels
	};
	return {
		mode,
		profile,
		...rotationView,
		guardians,
		state: node.fenced || gate === 'fenced' ? 'fenced' : 'running',
		node,
		capsules,
		...(autoApply ? { autoApply } : {}),
		...(r.capsuleEvent ? { restore: { inProgress: false, lastEvent: r.capsuleEvent } } : {})
	};
}

/**
 * Close a channel the way the daemon does: it negotiates for a moment,
 * then disappears. Shared by POST /channel/close and the manager's
 * lightning-first moves. Once the last channel with a previous primary is
 * gone, the wallet forgets that primary, as the manager does.
 */
function closeDemoChannel(id, channelId, force) {
	const st = store.state[id];
	const c = st.channels.find((x) => x.channelId === channelId);
	if (!c) throw err('Channel not found');
	c.state = force ? 'FORCE_CLOSED' : 'NEGOTIATING_CLOSING';
	c.htlcUsable = false;
	recordChannelEvent(id, {
		event: force ? 'channel:force-closing' : 'channel:pending-close',
		channelId: c.channelId,
		initiator: 'local'
	});
	setTimeout(() => {
		store.state[id].channels = store.state[id].channels.filter((x) => x.channelId !== channelId);
		recordChannelEvent(id, { event: 'channel:closed', channelId });
		emit(id, 'channel:closed', {});
		const w = store.wallets.find((x) => x.id === id);
		const previous = w && w.lfbw && w.lfbw.previousPrimary;
		if (previous && !store.state[id].channels.some((x) => x.peerPubkey === previous.pubkey)) {
			w.lfbw.previousPrimary = null;
		}
	}, 6000);
}

function walletRequest(id, path, method, body) {
	const w = store.wallets.find((x) => x.id === id);
	if (!w) throw err('Wallet not found', 'NOT_FOUND');
	const st = store.state[id];
	const [route, query] = path.split('?');
	// A daemon holding for a guardian restore has no node underneath it:
	// only its recovery surface answers, everything else is 503.
	if (w.status === 'restore-required') {
		if (route === '/recovery/status') return recoveryStatus(w, st);
		if (route === '/recovery/restore' && method === 'POST') {
			if (body?.confirm !== true) {
				throw err('Guardian restore permanently fences the previous writer; pass {"confirm": true} to proceed', 'INVALID_PARAMS');
			}
			if (st.recovery.restore?.inProgress) {
				throw err('A guardian restore is already running; watch recovery:restore-progress over SSE or poll the status route.', 'RESTORE_IN_PROGRESS');
			}
			return runDemoRestore(w, st);
		}
		throw err(
			'This daemon is holding for a guardian restore: the database is fresh and the guardian set holds its namespace.',
			'NODE_RESTORE_PENDING'
		);
	}
	if (w.status !== 'running') throw err('Wallet is not running', 'NOT_RUNNING');

	if (route.startsWith('/ffor/')) {
		const answer = fforRequest(w, st, route, query, method, body);
		if (answer !== undefined) return answer;
	}

	switch (route) {
		case '/recovery/status':
			if (w.id === 'demo-autorestore') runDemoAutoRestore(w, st);
			return recoveryStatus(w, st);
		case '/guardian/status': {
			// The guardian this wallet serves to other nodes (#699).
			if (!w.guardianServe || w.onchainOnly) return { serving: false };
			const setId = hex(64);
			return {
				serving: true,
				guardianId: guardianIdOf(w.id),
				authRequired: false,
				sessions: 2,
				sets: [
					{
						setId,
						members: [guardianIdOf(w.id), hex(64), hex(64)],
						namespaces: 2,
						bytes: 3_145_728,
						registeredAt: now - 12 * DAY
					}
				],
				limits: { maxCiphertextBytes: 4194304, maxBytesPerSet: 268435456, maxSets: 16 }
			};
		}
		case '/recovery/restore-capsule':
			if (body?.confirm !== true) {
				throw err('Restoring from a peer-storage capsule adopts channels an old device may still act on; pass {"confirm": true} to proceed', 'INVALID_PARAMS');
			}
			if (w.recovery?.mode !== 'peer-storage') throw err('Capsule restore applies in peer-storage mode only', 'CAPSULE_RESTORE_UNSUPPORTED');
			if (!st.recovery.capsule) throw err('No peer-storage capsule has been retrieved this session', 'CAPSULE_RESTORE_NO_CANDIDATES');
			if (st.channels.some((c) => c.state !== 'CLOSED' && c.state !== 'FORCE_CLOSED')) {
				throw err('The database already holds channels; a capsule restore needs an empty target', 'CAPSULE_RESTORE_TARGET_DIRTY');
			}
			return runDemoCapsuleRestore(w, st);
		case '/backup/peer-retrieved':
			if (!st.recovery.capsule) throw err('No peer-retrieved backup this session', 'NOT_FOUND');
			return { encoded: 'beignet-scb-v1:' + hex(96), createdAt: st.recovery.capsule.receivedAt, fromPeer: st.recovery.capsule.fromPeer };
		case '/restore/scb':
			if (!body?.encoded) throw err('Provide exactly one of encoded or path', 'INVALID_PARAMS');
			if (!st.recovery.capsule) throw err('SCB decode failed', 'INVALID_PARAMS');
			return runDemoScbRecovery(w, st);
		case '/recovery/restore':
			throw err(
				'Guardian restore only applies while the daemon is in the restore-required state (a fresh database whose namespace the guardian set holds). This node is already running on its own state.',
				'RESTORE_NOT_PENDING'
			);
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
					// Mirrors the wallet's channel backup rather than a constant
					// pass (the real daemon's readiness report carries no backup
					// check at all; nothing in the dashboard reads this route).
					{
						name: 'backup',
						status: w.recovery?.mode && w.recovery.mode !== 'off' ? 'PASS' : 'WARN',
						message:
							w.recovery?.mode && w.recovery.mode !== 'off'
								? `Channel backup: ${w.recovery.mode}`
								: 'Seed only; channels close on restore'
					},
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
		case '/address/new': {
			st.addressN += 1;
			const address = demoAddress(w.network);
			// Remembered so a payment from a sibling wallet to it lands here.
			st.addresses = (st.addresses || []).concat(address);
			return { address };
		}
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

		case '/receive/status':
			return { available: true, reservedChannelIds: [], requests: [] };
		case '/receive/quote': {
			const q = new URLSearchParams(query || '');
			return {
				peer: q.get('peer'),
				amountSats: Number(q.get('amountSats')),
				terms: { feeBaseMsat: 0, feePpm: 0 },
				expiresAt: Date.now() + 60000
			};
		}
		case '/receive/invoice': {
			const old = st.invoices.find((i) => i.requestId === body.requestId);
			if (old) return { ...invoiceInfo(old), offlineReceive: true };
			const inv = {
				paymentHash: hex(64),
				bolt11: demoInvoice(w.network, body.amountSats),
				amountSats: body.amountSats,
				description: body.description || '',
				createdAt: inSeconds(Date.now()),
				expiry: 600,
				paid: false,
				requestId: body.requestId
			};
			st.invoices.unshift(inv);
			return { ...invoiceInfo(inv), offlineReceive: true };
		}
		case '/jit/invoice': {
			// The wallet asks the LSP over the peer connection for an intercept
			// SCID and a fee quote, refusing a quote above its own ceilings
			// before any invoice exists. Here the primary answers at once.
			if (!/^0[23][0-9a-fA-F]{64}$/.test(String(body.lspPubkey || ''))) {
				throw err('lspPubkey must be a 33-byte compressed public key (66 hex chars)', 'INVALID_PARAMS');
			}
			if (!st.peers.some((p) => p.pubkey === body.lspPubkey)) {
				throw err('JIT receive needs the LSP connected as a peer', 'PEER_NOT_CONNECTED');
			}
			const amountSats = body.amountSats || null;
			if (amountSats > 1000000) {
				throw err('The LSP quoted more than this wallet accepts: max fundable is 1000000 sats', 'JIT_REFUSED');
			}
			const inv = {
				paymentHash: hex(64),
				bolt11: demoInvoice(w.network, amountSats),
				amountSats,
				description: body.description || '',
				createdAt: inSeconds(Date.now()),
				expiry: INVOICE_EXPIRY_SECONDS,
				paid: false,
				jit: true
			};
			st.invoices.unshift(inv);
			const lsp = store.wallets.find((x) => nodeId(x.id) === body.lspPubkey);
			const fees = { ...JIT_DEFAULTS, ...((lsp && lsp.jit) || {}) };
			return { ...invoiceInfo(inv), flatFeeSat: fees.flatFeeSat, feePpm: fees.feePpm };
		}
		case '/jit/quote': {
			// The price of a just-in-time receive, asked of the LSP over the
			// peer connection without registering anything (beignet #687).
			// The LSP answers what it would charge and whether it would front
			// the funding at all right now.
			const q = new URLSearchParams(query || '');
			const lspPubkey = q.get('lspPubkey') || '';
			if (!/^0[23][0-9a-fA-F]{64}$/.test(lspPubkey)) {
				throw err('lspPubkey must be a 33-byte compressed public key (66 hex chars)', 'INVALID_PARAMS');
			}
			if (!st.peers.some((p) => p.pubkey === lspPubkey)) {
				throw err('JIT receive needs the LSP connected as a peer', 'PEER_NOT_CONNECTED');
			}
			const amountSats = parseInt(q.get('amountSats'), 10) || 0;
			const target = parseInt(q.get('targetRemainingInboundSat'), 10) || 0;
			const lsp = store.wallets.find((x) => nodeId(x.id) === lspPubkey);
			const fees = { ...JIT_DEFAULTS, ...((lsp && lsp.jit) || {}) };
			const feeSats = fees.flatFeeSat + Math.floor((amountSats * fees.feePpm) / 1_000_000);
			const fundingSats = Math.min(amountSats + target + 10000, fees.maxClientFundingSats);
			const base = {
				lspPubkey,
				amountSats,
				flatFeeSat: fees.flatFeeSat,
				feePpm: fees.feePpm,
				feeSats,
				maxClientFundingSats: fees.maxClientFundingSats,
				fundingSats,
				withinCeilings: fees.flatFeeSat <= 10000 && fees.feePpm <= 50000,
				client: { maxFlatFeeSat: 10000, maxFeePpm: 50000 }
			};
			if (amountSats > fees.maxClientFundingSats) {
				return { ...base, accepted: false, fundingSats: 0, reason: `the provider fronts at most ${fees.maxClientFundingSats} sats per receive` };
			}
			if (lsp && onchainBalance(lsp.id) < fundingSats + 2000) {
				return { ...base, accepted: false, fundingSats: 0, reason: 'the provider does not hold enough on-chain funds to front this receive right now' };
			}
			return { ...base, accepted: true, reason: null };
		}
		case '/jit/status': {
			// The provider role as the daemon reports it (beignet 0.10+): the
			// caps are the owner's policy, the exposure is what is committed.
			const jit = { ...JIT_DEFAULTS, ...(w.jit || {}) };
			const dependents = lfbwDependentsOf(w);
			return {
				enabled: !!w.liquidityProvider,
				client: { maxFlatFeeSat: 10000, maxFeePpm: 50000 },
				lsp: w.liquidityProvider
					? {
							flatFeeSat: jit.flatFeeSat,
							feePpm: jit.feePpm,
							maxClientFundingSats: jit.maxClientFundingSats,
							maxConcurrentFundings: jit.maxConcurrentFundings,
							maxTotalFundingSats: jit.maxTotalFundingSats,
							maxLiveIntentsPerPeer: 2,
							maxLiveIntents: 64,
							reservedSats: 0,
							frontedSats: dependents.length * 250000,
							liveIntents: dependents.length,
							heldParts: 0,
							fundingsInFlight: 0
					  }
					: null
			};
		}
		case '/swaps/status': {
			// The swap role as the daemon reports it (beignet 0.15+, both
			// directions from 0.16.0): the caps are the owner's policy, the
			// exposure is what is committed. The demo ledger is empty.
			const swaps = { ...SWAP_DEFAULTS, ...(w.swaps || {}) };
			if (!w.liquidityProvider || !swaps.enabled) return { enabled: false };
			const direction = () => ({
				enabled: true,
				fee: { flatFeeSat: swaps.flatFeeSat, feePpm: swaps.feePpm },
				limits: {
					minSwapSat: swaps.minSat,
					maxSwapSat: swaps.maxSat,
					maxTotalExposureSat: swaps.maxExposureSat,
					maxConcurrentSwaps: swaps.maxConcurrent
				},
				counts: {},
				exposedSat: 0,
				exposedCount: 0
			});
			return {
				...direction(),
				timeouts: { refundDeltaBlocks: 144, fundingConfirmations: 1, resolutionConfirmations: 3 },
				submarine: swaps.submarine
					? {
							...direction(),
							timeouts: {
								refundDeltaBlocks: 288,
								fundingConfirmations: 1,
								resolutionConfirmations: 3,
								claimSafetyBlocks: swaps.claimSafetyBlocks,
								paymentMaxFeePpm: swaps.paymentMaxFeePpm
							}
					  }
					: { enabled: false }
			};
		}
		case '/direct-funding/config':
			return { ...directFundingPolicy(w) };
		case '/direct-funding/configure': {
			// A MERGE, never a replace: a field the body does not name keeps
			// its value, and minAmountSat clamps up to the protocol floor.
			const policy = directFundingPolicy(w);
			for (const k of ['lspPubkey', 'lspHost', 'lspPort', 'targetInboundSat', 'trusted', 'allowSplice']) {
				if (body[k] !== undefined) policy[k] = body[k];
			}
			if (body.minAmountSat !== undefined) policy.minAmountSat = Math.max(5000, parseInt(body.minAmountSat, 10) || 0);
			return { ...policy };
		}
		case '/direct-funding/request': {
			if (!directFundingPolicy(w).lspPubkey) throw err('No liquidity peer configured', 'DF_NOT_CONFIGURED');
			const expiresAt = Date.now() + 3600000;
			return {
				paymentHash: hex(64),
				expiresAt,
				request: encodeFundingEnvelope({
					nodeId: nodeId(id),
					expiresAt,
					amountSats: body.amountSats || null,
					network: w.network,
					transports: body.host ? [{ host: body.host, port: body.port || 9735 }] : []
				})
			};
		}
		case '/direct-funding/prepare': {
			// Reads the request and starts the dial a send would make. Spends
			// and records nothing; refuses what send would refuse.
			const env = decodeFundingEnvelope(String(body.request || ''));
			if (!env) throw err('request is not a direct-funding envelope', 'INVALID_PARAMS');
			if (env.expiresAt <= Date.now()) throw err('The payment request has expired', 'DF_REQUEST_EXPIRED');
			return {
				requestId: env.requestId,
				receiverNodeId: env.nodeId,
				amountSat: env.amountSats ?? null,
				expiresAt: env.expiresAt,
				connection: 'connecting',
				peerNodeId: env.nodeId
			};
		}
		case '/direct-funding/send': {
			// Rejects only before our witness leaves the device; after that it
			// resolves with the status as it stands. The demo spends a confirmed
			// coin of ours into the recipient's channel: a splice of their home
			// channel when they have one, else a new channel that confirms.
			const env = decodeFundingEnvelope(String(body.request || ''));
			if (!env) throw err('request is not a direct-funding envelope', 'INVALID_PARAMS');
			if (env.expiresAt <= Date.now()) throw err('The payment request has expired', 'DF_REQUEST_EXPIRED');
			const amount = env.amountSats ?? body.amountSats;
			if (!amount) throw err('amountSats is required when the request fixes none', 'INVALID_PARAMS');
			if (env.amountSats != null && body.amountSats && body.amountSats !== env.amountSats) {
				throw err('amountSats contradicts the amount the request fixes', 'INVALID_PARAMS');
			}
			const coin = st.utxos.find((u) => u.height > 0 && u.valueSats >= amount + 1000);
			if (!coin) throw err('No confirmed coin covers the amount plus the fee headroom', 'INSUFFICIENT_FUNDS');
			st.utxos = st.utxos.filter((u) => u !== coin);
			const fundingTxid = hex(64);
			const change = coin.valueSats - amount - 500;
			if (change > 546) st.utxos.push({ txid: fundingTxid, vout: 1, address: demoAddress(w.network), valueSats: change, height: null });
			st.txs.unshift({
				txid: fundingTxid,
				type: 'sent',
				valueSats: -(amount + 500),
				feeSats: 500,
				satsPerVbyte: 3,
				address: 'direct funding',
				height: null,
				timestamp: Date.now(),
				confirmTimestamp: null
			});
			// Credit the receiver, when it is one of the demo wallets.
			const receiver = store.wallets.find((x) => nodeId(x.id) === env.nodeId);
			const paired = !!receiver && (trustedPeers[receiver.id] || []).includes(nodeId(id));
			if (receiver && store.state[receiver.id]) {
				const rst = store.state[receiver.id];
				const primary = receiver.lfbw && receiver.lfbw.primaryPubkey;
				const home = rst.channels.find((c) => c.peerPubkey === primary && c.state === 'NORMAL');
				if (home && paired) {
					home.capacitySats += amount;
					home.localBalanceSats += amount;
					emit(receiver.id, 'transaction:received', { txid: fundingTxid, valueSats: amount, type: 'received', confirmed: false });
				} else {
					const c = makeChannels([[amount, 100, 'AWAITING_FUNDING_CONFIRMED', true]])[0];
					c.peerPubkey = primary || nodeId('demo-main');
					c.localBalanceSats = amount;
					c.remoteBalanceSats = 0;
					c.htlcUsable = false;
					rst.channels.push(c);
					setTimeout(() => {
						c.state = 'NORMAL';
						c.htlcUsable = true;
						emit(receiver.id, 'channel:ready', {});
					}, 9000);
				}
			}
			const sentAt = Date.now();
			fundingSteps[`${id}:${env.requestId}`] = [
				{ timestamp: sentAt - 1800, action: 'df_send_started', data: { requestId: env.requestId, amountSat: String(amount), resumed: false } },
				{ timestamp: sentAt, action: 'df_send_committed', data: { requestId: env.requestId, fundingTxid } },
				{ timestamp: sentAt + 400, action: 'df_send_completed', data: { requestId: env.requestId } }
			];
			return {
				offerId: hex(64),
				spentTxid: coin.txid,
				spentVout: coin.vout,
				amountSat: amount,
				fundingTxid,
				attested: true,
				receiptPreimageHex: hex(64),
				status: 'MEMPOOL_SEEN'
			};
		}
		case '/recover-fallback-funds':
			return { amountSat: 0 };
		case '/trusted-peers':
			return (trustedPeers[id] || []).map((pubkey) => ({ pubkey, trusted: true }));
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
			// The daemon records the pubkey in its zero-conf trusted set, which
			// is also what makes a direct-funding payer "paired".
			trustedPeers[id] = Array.from(new Set([...(trustedPeers[id] || []), body.pubkey]));
			return { pubkey: body.pubkey, trusted: true };
		case '/trusted-peer/remove':
			trustedPeers[id] = (trustedPeers[id] || []).filter((p) => p !== body.pubkey);
			return { pubkey: body.pubkey, trusted: false };
		case '/channel/rebroadcast-close': {
			const c = st.channels.find((x) => x.channelId === body.channelId);
			if (!c) throw err('Channel not found', 'NOT_FOUND');
			if (!c.closeStatus || !c.closeStatus.closingTxid) {
				throw err('No close transaction recorded for this channel', 'REBROADCAST_FAILED');
			}
			if (c.closeStatus.confirmationHeight > 0) {
				// What the daemon answers for a close the network already has.
				throw err('Transaction outputs already in utxo set', 'REBROADCAST_FAILED');
			}
			c.closeStatus.broadcast = true;
			return { txid: c.closeStatus.closingTxid, broadcastOk: true };
		}
		case '/channel/close':
		case '/channel/forceclose': {
			const c = st.channels.find((x) => x.channelId === body.channelId);
			if (!c) throw err('Channel not found');
			const force = route.endsWith('forceclose');
			closeDemoChannel(id, c.channelId, force);
			return { ok: true, channelId: c.channelId };
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
				const txid = hex(64);
				if (body.address) {
					// Paid out to the address named (beignet 0.10+): the coins leave
					// this wallet, which sees the splice as a send.
					st.txs.unshift({
						txid,
						type: 'sent',
						valueSats: -amt,
						feeSats: Math.round((body.feeratePerkw || 253) * 0.8),
						satsPerVbyte: Math.round((body.feeratePerkw || 253) / 250),
						address: body.address,
						height: null,
						timestamp: Date.now(),
						confirmTimestamp: null
					});
					// A sibling wallet receives it.
					const to = store.wallets.find((x) => store.state[x.id] && store.state[x.id].addresses && store.state[x.id].addresses.includes(body.address));
					if (to) {
						store.state[to.id].utxos.push({ txid, vout: 0, address: body.address, valueSats: amt, height: null });
						emit(to.id, 'transaction:received', { txid, valueSats: amt, type: 'received', confirmed: false });
					}
				} else {
					st.utxos.push({ txid, vout: 0, address: demoAddress(w.network), valueSats: amt, height: null });
				}
				return { ok: true, txid };
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

/**
 * The demo's backup archive. The real one is scrypt and AES-GCM done by the
 * manager, and there is no manager here, so this is plain JSON carrying its
 * own passphrase: it round-trips, so the export and restore flows can be
 * walked end to end, and it protects nothing, which is true of every secret
 * in demo mode.
 */
function demoArchive(passphrase, createdAt) {
	return JSON.stringify({
		demo: true,
		passphrase,
		createdAt,
		app: 'demo',
		engine: '0.12.0',
		wallets: store.wallets.map((w) => ({
			id: w.id,
			name: w.name,
			network: w.network,
			onchainOnly: !!w.onchainOnly,
			nodeId: w.onchainOnly ? null : nodeId(w.id)
		}))
	});
}

function readDemoArchive(body) {
	let parsed;
	try {
		parsed = JSON.parse(atob(String((body && body.archive) || '')));
	} catch (_) {
		parsed = null;
	}
	if (!parsed || !parsed.demo) throw err('That file is not a Beignet backup archive.', 'BAD_ARCHIVE');
	if (parsed.passphrase !== String((body && body.passphrase) || '')) {
		throw err('That passphrase does not open this archive (or the file is damaged).', 'BAD_PASSPHRASE');
	}
	return parsed;
}

/** The one response that is a file rather than JSON: the backup archive. */
export async function mockDownload(path, body) {
	await latency();
	if (path !== '/api/backup/export') throw err(`Unknown demo endpoint ${path}`, 'NOT_FOUND');
	if (String((body && body.passphrase) || '').length < 8) {
		throw err('The backup passphrase must be at least 8 characters.', 'WEAK_PASSPHRASE');
	}
	const createdAt = new Date().toISOString();
	const text = demoArchive(body.passphrase, createdAt);
	store.settings.lastBackupAt = createdAt;
	for (const w of store.wallets) w.lastBackupAt = createdAt;
	return {
		blob: new Blob([text], { type: 'application/octet-stream' }),
		filename: `beignet-backup-${createdAt.replace(/[:.]/g, '-')}.beignet`
	};
}

export async function mockRequest(path, { method = 'GET', body } = {}) {
	await latency();
	if (path.startsWith('/api/')) return managerRequest(path.slice(4), method, body);
	const m = path.match(/^\/wallets\/([^/]+)\/api(\/.*)$/);
	if (m) return walletRequest(m[1], m[2], method, body);
	throw err(`Unknown demo endpoint ${path}`, 'NOT_FOUND');
}
