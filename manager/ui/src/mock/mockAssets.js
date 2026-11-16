// Demo-mode Taproot Assets: an in-memory stand-in for the app's assets host
// (the /x/assets routes of a wallet's API), dispatched from mockApi.js beside
// the FFOR sub-router. Paths and answer shapes mirror lib/assets-api.js, which
// is the contract; this file is the only other place that knows them.
//
// Three things make it more than a table of canned answers:
//
//   Everything in progress moves by the clock. A row records when it started
//   and where it has got to is worked out from the time since, on every
//   request and once a second in between, with the same event the real host
//   sends each time a step is passed. So a timeline can be watched, and a
//   page that was closed for a minute finds the mint a minute further on.
//
//   The state is kept in sessionStorage. The rest of the demo forgets on a
//   reload; this does not, because "start a mint, reload, it is still there"
//   is one of the things the Assets tab has to be seen doing.
//
//   Addresses are real bech32m and are shared between the demo wallets, so
//   one made in a wallet can be pasted into another wallet's Send and paid.

import { bech32Encode, convertBits } from '../lib/payment-uri.js';
import { MAX_UNITS, addUnits, cmpUnits, isZero, subUnits, toUnits } from '../lib/asset-amount.js';

const STORE_KEY = 'beignet-demo-assets-v1';
const HEX = '0123456789abcdef';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Every asset sits in a bitcoin output of this many sats.
const ANCHOR_SATS = 1000;
// Modelled transaction sizes: one taproot input and two outputs for a mint,
// an asset input and a bitcoin input with three outputs for a send.
const VSIZE = { mint: 154, send: 255, burn: 212, channel: 240 };
const FEE_LIMITS = { maxFeeRate: 500, maxFeeSats: 250000 };
// The vbytes' worth of fee an asset transaction is funded around.
const WORKING_VBYTES = 2000;
const PREVIEW_TTL_MS = 60 * SECOND;

// How long each step takes in the demo, in milliseconds from the start.
const MINT = { firstAt: 6000, every: 5000, proofsFor: 4000 };
const SEND = { confirmAt: 6000, proofAt: 10000, doneAt: 11000 };
const RECEIVE = { firstAt: 9000, firstAtFromSibling: 6000, every: 1600, proofAfter: 1500, doneAfter: 3000 };
const BURN = { confirmAt: 6000, doneAt: 7000 };
const RETRY_PROOF_MS = 3000;
const CHANNEL_OPEN_MS = 15000;
// A funding taken back: how long its transaction waits for a block, and its size.
const RECLAIM_CONFIRMS_MS = 6000;
const RECLAIM_VBYTES = 180;
const INVOICE_QUOTE_MS = 60 * SECOND;
const INVOICE_SETTLES_MS = 12 * SECOND;
const PAY_QUOTE_MS = 30 * SECOND;
const PAY_ANSWERS_MS = 1200;

const HRP = { mainnet: 'tapbc', testnet: 'taptb', regtest: 'taprt' };
// The chain a wallet's host reports: the network again, or which testnet. The
// demo's testnet wallets are on testnet3.
const CHAIN = { mainnet: 'mainnet', testnet: 'testnet3', regtest: 'regtest' };
const DEFAULT_UNIVERSE = {
	mainnet: { host: 'universe.lightning.finance', port: 10029, rest: 'https://universe.lightning.finance' },
	testnet: { host: 'testnet.universe.lightning.finance', port: 10029, rest: 'https://testnet.universe.lightning.finance' },
	regtest: { host: 'localhost', port: 10029, rest: 'http://localhost:8089' }
};

const EVENT_OF = {
	mint: 'assets:mint',
	receive: 'assets:receive',
	send: 'assets:transfer',
	burn: 'assets:transfer',
	'ln-receive': 'assets:invoice',
	'ln-send': 'assets:payment'
};

/**
 * A string's own hex, the same every time it is asked for. An asset ID is a
 * hash, and these are drawn as pictures, so the digits are mixed well enough
 * to look like one.
 */
function derivedHex(seed, length) {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
	let out = '';
	while (out.length < length) {
		h = (h + 0x6d2b79f5) >>> 0;
		let z = Math.imul(h ^ (h >>> 15), 1 | h);
		z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
		z = (z ^ (z >>> 14)) >>> 0;
		for (let i = 28; i >= 0; i -= 4) out += HEX[(z >>> i) & 15];
	}
	return out.slice(0, length);
}

const hostOfRest = (rest) => {
	try {
		return new URL(rest).host;
	} catch (_) {
		return String(rest || '').replace(/^[a-z+]+:\/\//i, '').split('/')[0];
	}
};

/**
 * The demo assets backend.
 *
 * `ctx` is what it needs from the rest of the mock, injected so this file
 * imports nothing from mockApi.js (which imports this):
 *
 *   wallets()            the demo wallet records
 *   spendable(id)        on-chain sats the wallet can pay fees with
 *   spend(id, sats)      take sats out of the wallet's coins
 *   height(id)           the wallet's block height
 *   fees()               { fast, normal, slow }
 *   emit(id, name, data) the demo event stream
 *   err(message, code)   an error shaped like the API's
 *   storage              sessionStorage, or null to keep nothing
 *   clock()              the time, for tests that move it by hand
 *   ticker               false to leave out the once-a-second advance
 *   lightning            whether asset channels are offered at all
 *   priced               false when no channel peer sets a bitcoin price,
 *                        as between two wallets of this app
 */
export function createAssetsMock(ctx) {
	const now = () => (ctx.clock ? ctx.clock() : Date.now());
	const fail = (message, code, extra) => {
		const e = ctx.err ? ctx.err(message, code) : Object.assign(new Error(message), { code });
		if (extra) Object.assign(e, extra);
		return e;
	};
	const notFound = (message, code = 'ASSET_NOT_FOUND') => fail(message, code, { status: 404 });

	// Read back from the session, or seeded at the foot of this function once
	// everything the seed uses has been defined.
	let state = load();
	let timer = null;

	/* ------------------------------------------------------------ storage */

	function load() {
		try {
			const raw = ctx.storage && ctx.storage.getItem(STORE_KEY);
			const parsed = raw ? JSON.parse(raw) : null;
			return parsed && parsed.v === 1 ? parsed : null;
		} catch (_) {
			return null;
		}
	}

	function save() {
		try {
			if (ctx.storage) ctx.storage.setItem(STORE_KEY, JSON.stringify(state));
		} catch (_) {
			/* a full or absent store only costs the memory across a reload */
		}
	}

	const nextId = (prefix) => `${prefix}-${(++state.n).toString(36)}-${derivedHex(`${prefix}:${state.n}:${now()}`, 8)}`;

	/* -------------------------------------------------------------- state */

	function walletRecord(id) {
		return (ctx.wallets() || []).find((w) => w.id === id) || { id, network: 'mainnet' };
	}

	function S(id) {
		if (!state.wallets[id]) {
			state.wallets[id] = {
				assets: {},
				rows: [],
				addresses: [],
				channels: [],
				invoices: [],
				previews: {},
				quotes: {},
				idem: {},
				backup: { exportedAt: null, dirty: false },
				proofServerDown: false,
				// The host itself, when it is not simply up: see HOST_MODES.
				host: null
			};
		}
		return state.wallets[id];
	}

	const networkOf = (id) => walletRecord(id).network || 'mainnet';
	const chainOf = (id) => CHAIN[networkOf(id)] || networkOf(id);
	const required = (id) => (networkOf(id) === 'regtest' ? 1 : 6);
	const lightningMode = (id) => (ctx.lightning === false || walletRecord(id).onchainOnly ? 'off' : 'full');

	function proofServer(id) {
		const w = walletRecord(id);
		const custom = w.assets && w.assets.universe;
		const d = DEFAULT_UNIVERSE[networkOf(id)] || DEFAULT_UNIVERSE.mainnet;
		const rest = custom ? custom.rest : d.rest;
		const courier = custom ? custom.courier : `universerpc://${d.host}:${d.port}`;
		const host = custom ? String(custom.courier || '').replace(/^[a-z+]+:\/\//i, '') || hostOfRest(rest) : `${d.host}:${d.port}`;
		const down = S(id).proofServerDown || /down|offline|unreachable/i.test(host);
		return {
			host,
			courier,
			rest,
			defaultHost: `${d.host}:${d.port}`,
			isDefault: !custom,
			reachable: !down,
			lastError: down ? 'connection refused' : null,
			viaTor: w.networkMode === 'tor'
		};
	}

	/** Every asset any demo wallet knows of: the demo's proof server. */
	function universe() {
		const all = {};
		for (const s of Object.values(state.wallets)) {
			for (const rec of Object.values(s.assets)) {
				const known = all[rec.key];
				if (!known || (rec.mintedHere && !known.mintedHere)) all[rec.key] = rec;
			}
		}
		return all;
	}

	function findInUniverse(idOrKey) {
		const wanted = String(idOrKey || '').toLowerCase();
		return Object.values(universe()).find((a) => a.key === wanted || a.assetId === wanted || a.groupKey === wanted) || null;
	}

	const brief = (a, amount) => ({
		key: a.key,
		assetId: a.assetId,
		name: a.name,
		type: a.type,
		decimalDisplay: a.decimalDisplay,
		...(amount !== undefined ? { amount } : {})
	});

	function channelTotals(id, key) {
		let local = 0n;
		let sendable = 0n;
		let receivable = 0n;
		for (const c of S(id).channels) {
			if (c.asset.key !== key || c.state === 'CLOSED') continue;
			local += toUnits(c.localBalance) ?? 0n;
			if (c.state === 'NORMAL') {
				sendable += toUnits(c.sendable) ?? 0n;
				receivable += toUnits(c.receivable) ?? 0n;
			}
		}
		return { local: local.toString(), sendable: sendable.toString(), receivable: receivable.toString() };
	}

	function pubAsset(id, rec) {
		const s = S(id);
		const moving = (kind, states) =>
			s.rows
				.filter((r) => r.kind === kind && states.includes(r.state) && !r.failed)
				.flatMap((r) => r.assets)
				.filter((a) => a.key === rec.key)
				.reduce((sum, a) => addUnits(sum, a.amount), '0');
		const ch = channelTotals(id, rec.key);
		return {
			key: rec.key,
			assetId: rec.assetId,
			groupKey: rec.groupKey,
			name: rec.name,
			type: rec.type,
			decimalDisplay: rec.decimalDisplay,
			balance: {
				total: addUnits(rec.onchain, ch.local),
				onchain: rec.onchain,
				pendingIn: moving('receive', ['confirming', 'proofs']),
				pendingOut: moving('send', ['pending', 'broadcast', 'confirming', 'proofs']),
				channelLocal: ch.local,
				lightningSendable: ch.sendable,
				lightningReceivable: ch.receivable
			},
			lockedSats: rec.anchors * ANCHOR_SATS,
			anchors: rec.anchors,
			canReissue: !!rec.canReissue,
			mintedHere: !!rec.mintedHere,
			supply: { ...rec.supply },
			genesis: { ...rec.genesis }
		};
	}

	const held = (id) =>
		Object.values(S(id).assets).filter((a) => !isZero(a.onchain) || !isZero(channelTotals(id, a.key).local));

	/**
	 * A channel as the host lists it on GET /channels, key for key
	 * (assets-host/views.js channelView). A funding can be taken back while
	 * this wallet's open has made its transaction and no block has taken it.
	 */
	const pubChannel = (c) => ({
		channelId: c.channelId,
		pendingChannelId: c.pendingChannelId || c.channelId,
		peerPubkey: c.peerPubkey,
		peerAlias: c.peerAlias || null,
		state: c.state,
		asset: c.asset,
		capacity: c.capacity,
		localBalance: c.localBalance,
		remoteBalance: c.remoteBalance,
		sendable: c.sendable,
		receivable: c.receivable,
		channelSats: c.channelSats,
		fundingTxid: c.fundingTxid || null,
		reclaimable: c.state === 'OPENING' && !!c.fundingTxid,
		reclaimTxid: c.reclaimTxid || null
	});

	const pubRow = (row) => {
		const out = {};
		for (const [k, v] of Object.entries(row)) if (!k.startsWith('_')) out[k] = v;
		// Whether the wallet is still looking at an unpaid address by itself:
		// true or false for a receive that is waiting, null for anything else.
		if (row.kind && row.at) out.watching = row.kind === 'receive' && row.state === 'waiting' ? !row._unwatched : null;
		return out;
	};

	function newRow(id, kind, fields) {
		const t = now();
		const row = {
			id: nextId(kind),
			kind,
			state: 'pending',
			failed: false,
			failure: null,
			assets: [],
			txid: null,
			feeSats: null,
			satsPerVbyte: null,
			anchorSats: null,
			address: null,
			courier: null,
			paymentHash: null,
			confirmations: 0,
			confirmationsRequired: required(id),
			stuck: false,
			at: { created: t, broadcast: null, confirmed: null, proof: null, completed: null },
			clientRef: null,
			_t0: t,
			...fields
		};
		S(id).rows.unshift(row);
		return row;
	}

	/* ------------------------------------------------------------ advance */

	function credit(id, identity, amount, { minted = false, at = now() } = {}) {
		const s = S(id);
		let rec = s.assets[identity.key];
		if (!rec) {
			const known = findInUniverse(identity.key) || identity;
			rec = s.assets[identity.key] = {
				key: identity.key,
				assetId: identity.assetId,
				groupKey: identity.groupKey || null,
				name: identity.name,
				type: identity.type,
				decimalDisplay: identity.decimalDisplay ?? null,
				onchain: '0',
				anchors: 0,
				canReissue: false,
				mintedHere: false,
				supply: known.supply ? { ...known.supply } : { issued: null, burned: '0', known: false },
				genesis: known.genesis ? { ...known.genesis } : { outpoint: `${derivedHex(`gen:${identity.assetId}`, 64)}:0`, height: null, timestamp: at },
				meta: known.meta || null,
				issuances: (known.issuances || []).map((i) => ({ ...i, heldHere: false })),
				proofs: { count: 0, depth: minted ? 0 : 3 }
			};
		}
		rec.onchain = addUnits(rec.onchain, amount);
		rec.anchors += 1;
		rec.proofs.count += 1;
		s.backup.dirty = true;
		return rec;
	}

	function completeMint(id, row) {
		const s = S(id);
		row._seedlings.forEach((seedling, i) => {
			const a = row.assets[i];
			const existing = s.assets[a.key];
			const rec = credit(id, { ...a, groupKey: seedling.groupKey || null }, a.amount, { minted: true, at: row.at.completed });
			rec.mintedHere = true;
			rec.canReissue = !!seedling.groupKey;
			rec.meta = existing?.meta || seedling.meta || null;
			const issuedBefore = existing && existing.supply.known ? existing.supply.issued : '0';
			rec.supply = { issued: addUnits(issuedBefore, a.amount), burned: existing?.supply.burned || '0', known: true };
			if (!existing) {
				rec.genesis = { outpoint: `${row.txid}:0`, height: row.blockHeight || ctx.height(id), timestamp: row.at.confirmed };
				rec.issuances = [];
			}
			rec.issuances.push({ assetId: a.assetId, amount: a.amount, at: row.at.completed, heldHere: true });
			ctx.emit(id, 'assets:balance', { key: a.key });
		});
	}

	function stepRow(id, row, t) {
		const s = S(id);
		const need = row.confirmationsRequired;
		// Held where it is: a transaction no block takes, an address nobody
		// looks at, a proof the server said no to. What releases it is being
		// asked (rebroadcast, check, offer again).
		if (row._stuck || row._unwatched || row._refused) return;
		// A seeded row starts its clock the first time its wallet is looked at,
		// so it is always found at the same point however long the page sat.
		if (row._lazy != null) {
			if (!s.seen) return;
			const start = t - row._lazy;
			row._t0 = start;
			if (row.kind === 'receive') row._paidAt = start;
			row.at.created = start;
			if (row.kind !== 'receive') row.at.broadcast = start;
			delete row._lazy;
		}
		if (row.kind === 'mint') {
			const e = t - row._t0;
			if (e < MINT.firstAt) return;
			row.confirmations = Math.min(need, 1 + Math.floor((e - MINT.firstAt) / MINT.every));
			row.at.confirmed = row.at.confirmed || row._t0 + MINT.firstAt;
			row.blockHeight = row.blockHeight || ctx.height(id) + 1;
			if (row.confirmations < need) {
				row.state = 'confirming';
				return;
			}
			const reachedAt = row._t0 + MINT.firstAt + (need - 1) * MINT.every;
			if (t < reachedAt + MINT.proofsFor) {
				row.state = 'proofs';
				return;
			}
			row.state = 'complete';
			row.at.proof = row.at.completed = reachedAt + MINT.proofsFor;
			completeMint(id, row);
			row._done = true;
			return;
		}
		if (row.kind === 'send') {
			const e = t - row._t0;
			if (e < SEND.confirmAt) return;
			row.confirmations = Math.max(Number(row.confirmations) || 0, 1);
			row.at.confirmed = row.at.confirmed || row._t0 + SEND.confirmAt;
			row.blockHeight = row.blockHeight || ctx.height(id) + 1;
			row.state = 'proofs';
			if (e < SEND.proofAt) return;
			if (row._courierDown) {
				row.failure = { code: 'COURIER_UNREACHABLE', message: 'The proof server is not answering', retrying: true };
				return;
			}
			row.failure = null;
			row.at.proof = row.at.proof || row._t0 + SEND.proofAt;
			if (e < SEND.doneAt) return;
			row.state = 'complete';
			row.at.completed = row._t0 + SEND.doneAt;
			s.backup.dirty = true;
			row._done = true;
			ctx.emit(id, 'assets:balance', { key: row.assets[0].key });
			return;
		}
		if (row.kind === 'burn') {
			const e = t - row._t0;
			if (e < BURN.confirmAt) return;
			row.confirmations = 1;
			row.at.confirmed = row.at.confirmed || row._t0 + BURN.confirmAt;
			row.blockHeight = row.blockHeight || ctx.height(id) + 1;
			row.state = 'proofs';
			if (e < BURN.doneAt) return;
			row.state = 'complete';
			row.at.proof = row.at.completed = row._t0 + BURN.doneAt;
			const rec = s.assets[row.assets[0].key];
			if (rec && rec.supply.known) rec.supply.burned = addUnits(rec.supply.burned || '0', row.assets[0].amount);
			s.backup.dirty = true;
			row._done = true;
			ctx.emit(id, 'assets:balance', { key: row.assets[0].key });
			return;
		}
		if (row.kind === 'receive') {
			// Nobody is on the other end of a demo address, so one that no
			// sibling wallet pays is paid by nobody in particular.
			if (row._paidAt == null) row._paidAt = row._t0;
			const firstAt = row._firstAt || RECEIVE.firstAt;
			const e = t - row._paidAt;
			if (e < firstAt) return;
			row.confirmations = Math.min(need, 1 + Math.floor((e - firstAt) / RECEIVE.every));
			row.txid = row.txid || derivedHex(`recv:${row.id}`, 64);
			row.anchorSats = ANCHOR_SATS;
			row.at.confirmed = row.at.confirmed || row._paidAt + firstAt;
			row.blockHeight = row.blockHeight || ctx.height(id) + 1;
			if (row.confirmations < need) {
				row.state = 'confirming';
				return;
			}
			row.state = 'proofs';
			let reachedAt = row._paidAt + firstAt + (need - 1) * RECEIVE.every;
			if (row._proofLate) {
				if (row._retryAt == null || t < row._retryAt + RETRY_PROOF_MS) {
					row.failure = {
						code: 'PROOF_UNAVAILABLE',
						message: 'The proof server does not have the proof for this transfer yet',
						retrying: true
					};
					return;
				}
				reachedAt = row._retryAt + RETRY_PROOF_MS - RECEIVE.proofAfter;
			}
			row.failure = null;
			if (t < reachedAt + RECEIVE.proofAfter) return;
			row.at.proof = row.at.proof || reachedAt + RECEIVE.proofAfter;
			if (!row._proofLate && t < reachedAt + RECEIVE.doneAfter) return;
			row.state = 'complete';
			row.at.completed = row._proofLate ? row.at.proof : reachedAt + RECEIVE.doneAfter;
			credit(id, row._identity || row.assets[0], row.assets[0].amount, { at: row.at.completed });
			row._done = true;
			ctx.emit(id, 'assets:balance', { key: row.assets[0].key });
			return;
		}
		if (row.kind === 'ln-receive') {
			if (t < row._t0 + INVOICE_SETTLES_MS) return;
			const invoice = s.invoices.find((i) => i.paymentHash === row.paymentHash);
			const ch = s.channels.find((c) => c.channelId === row._channelId);
			const amount = row.assets[0].amount;
			if (ch) {
				ch.localBalance = addUnits(ch.localBalance, amount);
				ch.remoteBalance = subUnits(ch.remoteBalance, amount);
				ch.sendable = addUnits(ch.sendable, amount);
				ch.receivable = subUnits(ch.receivable, amount);
			}
			if (invoice) invoice.status = 'PAID';
			row.state = 'complete';
			row.at.completed = row._t0 + INVOICE_SETTLES_MS;
			row._done = true;
			ctx.emit(id, 'assets:balance', { key: row.assets[0].key });
			// The daemon says it too, as it says every settled invoice, and marks it.
			const settled = { paymentHash: row.paymentHash, amountSats: invoice ? invoice.amountSats : 354, auxiliary: true };
			ctx.emit(id, 'payment:received', settled);
			ctx.emit(id, 'invoice:settled', { ...settled, bolt11: invoice ? invoice.bolt11 : null });
		}
	}

	function advance(id) {
		const s = S(id);
		const t = now();
		let changed = false;
		for (const row of s.rows) {
			if (row._done) continue;
			const before = `${row.state}:${row.confirmations}:${row.failure ? 1 : 0}:${row.at.proof || 0}`;
			stepRow(id, row, t);
			const after = `${row.state}:${row.confirmations}:${row.failure ? 1 : 0}:${row.at.proof || 0}`;
			if (before === after) continue;
			changed = true;
			ctx.emit(id, EVENT_OF[row.kind], { row: pubRow(row) });
			if (row.kind === 'send' && row.at.proof && before.endsWith(':0')) ctx.emit(id, 'assets:proof-delivery', { row: pubRow(row) });
		}
		for (const c of s.channels) {
			if (c.state !== 'OPENING') continue;
			// A funding that was taken back: its bitcoin is this wallet's again
			// once that transaction is in a block, the open is over, and the
			// asset never left the wallet.
			if (c._reclaimAt) {
				if (t < c._reclaimAt + RECLAIM_CONFIRMS_MS) continue;
				const rec = s.assets[c.asset.key];
				if (rec) rec.onchain = addUnits(rec.onchain, c.localBalance);
				c.state = 'CLOSED';
				c.localBalance = '0';
				changed = true;
				ctx.emit(id, 'assets:channel', { channelId: c.channelId, state: c.state });
				ctx.emit(id, 'assets:balance', { key: c.asset.key });
				continue;
			}
			// `_stuck` is a funding no block takes (the `open-stuck` state).
			if (c._stuck || t < c._openedAt + CHANNEL_OPEN_MS) continue;
			c.state = 'NORMAL';
			c.sendable = c.localBalance;
			c.receivable = c.remoteBalance;
			changed = true;
			ctx.emit(id, 'assets:channel', { channelId: c.channelId, state: c.state });
		}
		for (const key of Object.keys(s.previews)) if (s.previews[key].expiresAt + MINUTE < t) delete s.previews[key];
		if (changed) save();
	}

	function advanceAll() {
		for (const id of Object.keys(state.wallets)) advance(id);
	}

	function startTicker() {
		if (timer || ctx.ticker === false) return;
		timer = setInterval(advanceAll, SECOND);
		// Never the reason a test process stays alive.
		if (timer && typeof timer.unref === 'function') timer.unref();
	}

	/* --------------------------------------------------------------- fees */

	function feeFor(kind, feeRate) {
		const estimate = (ctx.fees && ctx.fees()) || { fast: 18 };
		const rate = Number.isFinite(Number(feeRate)) && Number(feeRate) > 0 ? Math.floor(Number(feeRate)) : estimate.fast;
		const vbytes = VSIZE[kind];
		const sats = rate * vbytes;
		if (rate > FEE_LIMITS.maxFeeRate || sats > FEE_LIMITS.maxFeeSats) {
			throw fail(`A fee rate of ${rate} sat/vB is above this wallet's limit of ${FEE_LIMITS.maxFeeRate} sat/vB for asset transactions`, 'FEE_TOO_HIGH');
		}
		return { sats, vbytes, feeRate: rate };
	}

	// As the host does (errors.js): an asset transaction is built around the
	// fee for 2,000 vbytes, and what is not spent comes back as change. So a
	// wallet can hold the cost and still be short, and it is told both figures.
	function shortOfBitcoin(said, { totalSats, fee, anchorSats, spendableSats }) {
		const onHandSats = fee.feeRate * WORKING_VBYTES + fee.sats;
		if (spendableSats >= totalSats && spendableSats >= onHandSats) return null;
		const details = { needed: totalSats, spendable: spendableSats, feeSats: fee.sats, anchorSats };
		if (onHandSats > totalSats) details.onHandSats = onHandSats;
		return fail(`${said} needs ${Math.max(totalSats, onHandSats)} sats on-chain and the wallet has ${spendableSats}`, 'INSUFFICIENT_BTC', { details });
	}

	/* ---------------------------------------------------------- addresses */

	function encodeAddress(id, n, identity, amount) {
		const material = derivedHex(`tap:${id}:${n}:${identity.assetId}:${amount}`, 300);
		const bytes = [];
		for (let i = 0; i < material.length; i += 2) bytes.push(parseInt(material.slice(i, i + 2), 16));
		return bech32Encode(HRP[networkOf(id)] || 'tapbc', convertBits(bytes, 8, 5, true), 'bech32m');
	}

	function identityFor(id, key) {
		const own = S(id).assets[key] || Object.values(S(id).assets).find((a) => a.assetId === key || a.groupKey === key);
		const known = own || findInUniverse(key);
		if (!known) throw notFound('No asset with that ID is known to this wallet or its proof server');
		return {
			key: known.key,
			assetId: known.assetId,
			groupKey: known.groupKey || null,
			name: known.name,
			type: known.type,
			decimalDisplay: known.decimalDisplay ?? null
		};
	}

	function requireAmount(amount, identity) {
		if (identity.type === 'collectible') return '1';
		const units = toUnits(String(amount ?? ''));
		if (units === null || units <= 0n || units > MAX_UNITS) throw fail('The amount must be a whole number of units above zero', 'BAD_AMOUNT');
		return units.toString();
	}

	/* ------------------------------------------------------------- routes */

	/* ----------------------------------------------- a host that is not up */

	// What a healthy wallet never shows, so the demo and the tests can:
	//   failed      the host could not start. Its status says why, and every
	//               other route refuses with ASSETS_UNAVAILABLE.
	//   unloaded    the engine has no assets module at all: every route,
	//               status included, refuses with EXTENSION_UNAVAILABLE.
	//   starting    up, and still checking its proofs: ready is false.
	//   restarting  the wallet is going down under it: ASSETS_STOPPING.
	const HOST_MODES = ['failed', 'unloaded', 'starting', 'restarting'];
	const HOST_FAILED = 'The proof store could not be opened: its file is from a newer version of the app';
	const STARTUP = { done: 3, total: 12 };

	/** Refuse `sub` the way the wallet would in the state its host is in. */
	function refuseWhileDown(id, sub) {
		const mode = S(id).host;
		if (!mode) return;
		if (mode === 'unloaded') throw fail('Extension "assets" is not available', 'EXTENSION_UNAVAILABLE', { status: 503 });
		if (mode === 'restarting') throw fail('The wallet is restarting. Try again in a moment.', 'ASSETS_STOPPING', { status: 503 });
		if (sub === '/status') return;
		if (mode === 'failed') throw fail(HOST_FAILED, 'ASSETS_UNAVAILABLE', { status: 503 });
		throw fail('Assets are still starting. Try again in a moment.', 'ASSETS_STARTING', { status: 503 });
	}

	function setHost(id, mode) {
		S(id).host = HOST_MODES.includes(mode) ? mode : null;
	}

	// The demo's switch, read from the page's own address for the wallet the
	// address is about: /w/demo-main/assets?assets-demo=failed. It sticks like
	// everything else here, so the views can be walked, and `ok` puts it back.
	/**
	 * Four states the demo does not reach by itself, put on a wallet by the
	 * address bar (`?assets-demo=`) or by a test. Each is added once.
	 */
	const SEEDS = {
		// A send no block has taken for two hours, at a rate under the going one.
		stuck(id) {
			const s = S(id);
			if (s.rows.some((r) => r._stuck)) return false;
			const from = s.rows.find((r) => r.assets.length && r.assets[0].type !== 'collectible');
			if (!from) return false;
			const t = now();
			s.rows.unshift({
				...newRowFor(id, 'send'),
				state: 'broadcast',
				assets: [{ ...from.assets[0], amount: '1' }],
				txid: derivedHex(`seed-stuck:${id}`, 64),
				feeSats: 2 * VSIZE.send,
				satsPerVbyte: 2,
				anchorSats: ANCHOR_SATS,
				courier: proofServer(id).host,
				stuck: true,
				at: { created: t - 2 * HOUR, broadcast: t - 2 * HOUR, confirmed: null, proof: null, completed: null },
				_t0: t - 2 * HOUR,
				_stuck: true
			});
			return true;
		},
		// A mint that finished, whose proof the proof server has not taken.
		'proof-refused'(id) {
			const s = S(id);
			if (s.rows.some((r) => r._unpublished)) return false;
			const row = s.rows.find((r) => r.kind === 'mint' && r.state === 'complete' && !r.failed);
			if (!row) return false;
			row.failure = { code: 'PROOF_REFUSED', message: 'The proof server did not accept the proof: it takes none from outside', retrying: true };
			row._unpublished = true;
			return true;
		},
		// A send six blocks deep whose proof the proof server answered "no" to.
		'send-refused'(id) {
			const s = S(id);
			if (s.rows.some((r) => r._refused)) return false;
			const from = s.rows.find((r) => r.assets.length && r.assets[0].type !== 'collectible');
			if (!from) return false;
			const t = now();
			s.rows.unshift({
				...newRowFor(id, 'send'),
				state: 'proofs',
				assets: [{ ...from.assets[0], amount: '1' }],
				txid: derivedHex(`seed-refused:${id}`, 64),
				feeSats: 18 * VSIZE.send,
				satsPerVbyte: 18,
				anchorSats: ANCHOR_SATS,
				courier: proofServer(id).host,
				confirmations: 6,
				blockHeight: ctx.height(id) - 5,
				failure: { code: 'PROOF_REFUSED', message: 'The proof server did not take the proof: invalid split commitment proof (HTTP 500)', retrying: true },
				at: { created: t - HOUR, broadcast: t - HOUR, confirmed: t - 50 * MINUTE, proof: null, completed: null },
				_t0: t - HOUR,
				_refused: true
			});
			return true;
		},
		// An address made nine days ago that nobody paid, past the seven days it is checked for.
		unwatched(id) {
			const s = S(id);
			if (s.rows.some((r) => r._unwatched)) return false;
			const from = s.rows.find((r) => r.assets.length && r.assets[0].type !== 'collectible');
			if (!from) return false;
			const t = now();
			s.rows.unshift({
				...newRowFor(id, 'receive'),
				state: 'waiting',
				assets: [{ ...from.assets[0], amount: from.assets[0].amount }],
				address: encodeAddress(id, s.addresses.length + 901, from._identity || from.assets[0], from.assets[0].amount),
				courier: proofServer(id).host,
				at: { created: t - 9 * DAY, broadcast: null, confirmed: null, proof: null, completed: null },
				_identity: from._identity || from.assets[0],
				_t0: t - 9 * DAY,
				_unwatched: true
			});
			return true;
		},
		// An open whose funding transaction has sat an hour without a block, at
		// a rate under the going one. Its bitcoin can be taken back.
		'open-stuck'(id) {
			const s = S(id);
			if (s.channels.some((c) => c._stuck)) return false;
			const amount = '50000';
			const rec = Object.values(s.assets).find((a) => a.type !== 'collectible' && cmpUnits(a.onchain, amount) >= 0);
			if (!rec) return false;
			rec.onchain = subUnits(rec.onchain, amount);
			const channelId = derivedHex(`seed-stuck-open:${id}`, 64);
			s.channels.unshift({
				channelId,
				peerPubkey: `03${derivedHex('seed-peer:stuck-open', 64)}`,
				peerAlias: 'Meridian edge',
				state: 'OPENING',
				asset: brief(rec),
				capacity: amount,
				localBalance: amount,
				remoteBalance: '0',
				sendable: '0',
				receivable: '0',
				channelSats: 100000,
				fundingTxid: derivedHex(`funding:${channelId}`, 64),
				_unpriced: true,
				_openedAt: now() - HOUR,
				_fundingRate: 2,
				_stuck: true
			});
			return true;
		},
		// A channel on the wallet's record that its node does not hold: what a
		// restore from a backup leaves. It carries nothing from then on.
		'channel-missing'(id) {
			const c = S(id).channels.find((x) => x.state === 'NORMAL');
			if (!c) return false;
			c.state = 'MISSING';
			c.sendable = '0';
			c.receivable = '0';
			return true;
		}
	};

	// The host's own sentence for it, as its status says it.
	const CHANNEL_MISSING_TEXT =
		"An asset channel is on record that the wallet's node does not hold, as happens after a restore from a backup. It cannot be used or closed from this wallet, and its balance is the last one known. This wallet cannot bring the assets in it back by itself.";
	const channelWarningsOf = (s) => {
		const said = s.channels.some((c) => c.state === 'MISSING') ? [{ code: 'CHANNEL_MISSING', text: CHANNEL_MISSING_TEXT }] : [];
		return said.length ? { warning: said.map((w) => w.text).join(' '), warnings: said } : {};
	};

	function putState(id, what) {
		// Once: the address bar goes on saying `?assets-demo=stuck` after the
		// stuck send was broadcast again, and that is not a request for another.
		const s = S(id);
		if (!SEEDS[what] || (s.seeded && s.seeded[what]) || !SEEDS[what](id)) return false;
		s.seeded = { ...(s.seeded || {}), [what]: true };
		save();
		return true;
	}

	function readSwitch() {
		try {
			const loc = globalThis.location;
			const m = loc && /^\/w\/([^/?#]+)/.exec(loc.pathname || '');
			const want = m && new URLSearchParams(loc.search || '').get('assets-demo');
			if (!want) return;
			const s = S(decodeURIComponent(m[1]));
			const before = `${s.host}:${s.proofServerDown}`;
			if (want === 'ok') {
				s.host = null;
				s.proofServerDown = false;
			} else if (want === 'proof-server-down') {
				s.host = null;
				s.proofServerDown = true;
			} else if (HOST_MODES.includes(want)) {
				s.host = want;
			} else if (SEEDS[want]) {
				putState(decodeURIComponent(m[1]), want);
			}
			if (before !== `${s.host}:${s.proofServerDown}`) save();
		} catch (_) {
			/* no address to read, nothing switched */
		}
	}

	function status(id) {
		const s = S(id);
		if (s.host === 'failed' || s.host === 'starting') {
			// As the host answers before it has anything to count: its
			// settings, and nothing of what the wallet holds.
			return {
				phase: s.host,
				ready: false,
				error: s.host === 'failed' ? HOST_FAILED : null,
				network: networkOf(id),
				hrp: HRP[networkOf(id)] || 'tapbc',
				chain: { name: chainOf(id), height: s.host === 'failed' ? 0 : ctx.height(id), minConfirmations: required(id) },
				pending: { mints: 0, sends: 0, receives: 0, burns: 0 },
				holdsAssets: false,
				lockedSats: 0,
				anchorCount: 0,
				startup: s.host === 'starting' ? { ...STARTUP } : null,
				lightning: { mode: 'off', usableChannels: 0 },
				proofServer: { ...proofServer(id), reachable: null, lastError: null },
				backup: { exportedAt: null, dirty: false },
				limits: { ...FEE_LIMITS }
			};
		}
		// A send whose proof was handed over as a file is not still happening.
		const settled = (r) => r.kind === 'send' && r.state === 'proofs' && !!r.handedOver;
		const active = (kind) =>
			s.rows.filter((r) => r.kind === kind && !r._done && !r.failed && r.state !== 'waiting' && r.state !== 'cancelled' && !settled(r)).length;
		const anchors = Object.values(s.assets).reduce((n, a) => n + a.anchors, 0);
		const mode = lightningMode(id);
		return {
			// Degraded: everything works, and a proof has not reached the proof server.
			phase: s.rows.some((r) => r._unpublished) ? 'degraded' : 'ready',
			ready: true,
			error: null,
			network: networkOf(id),
			hrp: HRP[networkOf(id)] || 'tapbc',
			chain: { name: chainOf(id), height: ctx.height(id), minConfirmations: required(id) },
			pending: { mints: active('mint'), sends: active('send'), receives: active('receive'), burns: active('burn') },
			holdsAssets: held(id).length > 0,
			lockedSats: anchors * ANCHOR_SATS,
			anchorCount: anchors,
			startup: null,
			lightning: { mode, usableChannels: mode === 'off' ? 0 : s.channels.filter((c) => c.state === 'NORMAL').length, ...(mode === 'off' ? {} : channelWarningsOf(s)) },
			proofServer: proofServer(id),
			backup: { ...s.backup },
			limits: { ...FEE_LIMITS }
		};
	}

	function balances(id) {
		const anchors = Object.values(S(id).assets).reduce((n, a) => n + a.anchors, 0);
		return {
			assets: held(id)
				.map((rec) => pubAsset(id, rec))
				.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'normal' ? -1 : 1)),
			btc: { anchorSats: anchors * ANCHOR_SATS, anchorCount: anchors, spendableSats: ctx.spendable(id) }
		};
	}

	function assetDetail(id, key) {
		const s = S(id);
		const rec = s.assets[key] || Object.values(s.assets).find((a) => a.assetId === key || a.groupKey === key);
		if (!rec || !held(id).includes(rec)) throw notFound('This wallet does not hold that asset');
		return { ...pubAsset(id, rec), meta: rec.meta || null, proofs: { ...rec.proofs }, issuances: rec.issuances.map((i) => ({ ...i })) };
	}

	function activity(id, q) {
		let rows = S(id).rows.slice().sort((a, b) => b.at.created - a.at.created);
		const key = q.get('key');
		if (key) rows = rows.filter((r) => r.assets.some((a) => a.key === key || a.assetId === key));
		if (q.get('kind')) rows = rows.filter((r) => r.kind === q.get('kind'));
		if (q.get('pending')) rows = rows.filter((r) => !r._done && r.state !== 'cancelled' && !(r.failed && r._dismissed));
		const before = Number(q.get('before'));
		if (Number.isFinite(before) && before > 0) rows = rows.filter((r) => r.at.created < before);
		const limit = Math.max(1, Math.min(200, parseInt(q.get('limit'), 10) || 50));
		const page = rows.slice(0, limit);
		return { rows: page.map(pubRow), nextBefore: rows.length > limit ? page[page.length - 1].at.created : null };
	}

	function lookup(body) {
		const found = findInUniverse(String(body?.id || '').trim().toLowerCase());
		if (!found) throw notFound('No asset with that ID was found on the proof server');
		return {
			asset: {
				key: found.key,
				assetId: found.assetId,
				groupKey: found.groupKey || null,
				name: found.name,
				type: found.type,
				decimalDisplay: found.decimalDisplay ?? null,
				supply: { ...found.supply }
			}
		};
	}

	function mintQuote(id, body) {
		const count = Math.max(1, parseInt(body?.count, 10) || 1);
		const fee = feeFor('mint', body?.feeRate);
		const spendableSats = ctx.spendable(id);
		const totalSats = fee.sats + ANCHOR_SATS;
		const onHandSats = fee.feeRate * WORKING_VBYTES + fee.sats;
		const quote = { feeSats: fee.sats, vsize: fee.vbytes, anchorSats: ANCHOR_SATS, totalSats, spendableSats, sufficient: spendableSats >= Math.max(totalSats, onHandSats), count };
		if (!quote.sufficient && onHandSats > totalSats) quote.onHandSats = onHandSats;
		return quote;
	}

	function mint(id, body, key) {
		const seedlings = Array.isArray(body?.seedlings) ? body.seedlings : [];
		if (seedlings.length === 0) throw fail('A mint needs at least one asset', 'INVALID_PARAMS');
		const fee = feeFor('mint', body.feeRate);
		if (body.maxFeeSats != null && fee.sats > Number(body.maxFeeSats)) {
			throw fail(`The fee is ${fee.sats} sats, above the ${body.maxFeeSats} this request allows`, 'FEE_TOO_HIGH');
		}
		const names = new Set();
		const s = S(id);
		const prepared = seedlings.map((seedling) => {
			const name = String(seedling.name || '').trim();
			const type = seedling.type === 'collectible' ? 'collectible' : 'normal';
			if (!name || new TextEncoder().encode(name).length > 64) throw fail('An asset needs a name of up to 64 bytes', 'INVALID_PARAMS');
			if (names.has(name)) throw fail(`This transaction already has an asset called ${name}`, 'INVALID_PARAMS');
			names.add(name);
			const amount = type === 'collectible' ? '1' : requireAmount(seedling.amount, { type });
			const mode = seedling.group?.mode || 'none';
			let groupKey = null;
			let decimalDisplay = type === 'collectible' ? null : Number.isInteger(seedling.decimalDisplay) ? seedling.decimalDisplay : 0;
			if (mode === 'existing') {
				const parent = Object.values(s.assets).find((a) => a.groupKey === seedling.group.groupKey && a.canReissue);
				if (!parent) throw fail('This wallet cannot mint more of that asset', 'INVALID_PARAMS');
				groupKey = parent.groupKey;
				decimalDisplay = parent.decimalDisplay;
			}
			return { name, type, amount, decimalDisplay, mode, groupKey, meta: seedling.meta || null };
		});
		const total = fee.sats + ANCHOR_SATS;
		const short = shortOfBitcoin('Minting', { totalSats: total, fee, anchorSats: ANCHOR_SATS, spendableSats: ctx.spendable(id) });
		if (short) throw short;
		ctx.spend(id, total);
		const txid = derivedHex(`mint:${id}:${state.n}:${now()}`, 64);
		const assets = prepared.map((p, i) => {
			const assetId = derivedHex(`asset:${txid}:${i}:${p.name}`, 64);
			if (p.mode === 'new') p.groupKey = `02${derivedHex(`group:${assetId}`, 64)}`;
			return {
				key: p.groupKey || assetId,
				assetId,
				name: p.mode === 'existing' ? Object.values(s.assets).find((a) => a.groupKey === p.groupKey).name : p.name,
				type: p.type,
				decimalDisplay: p.decimalDisplay,
				amount: p.amount
			};
		});
		const t = now();
		const row = newRow(id, 'mint', {
			state: 'broadcast',
			assets,
			txid,
			feeSats: fee.sats,
			satsPerVbyte: fee.feeRate,
			anchorSats: ANCHOR_SATS,
			clientRef: key || null,
			_seedlings: prepared.map((p) => ({ groupKey: p.groupKey, meta: metaOf(p.meta) }))
		});
		row.at.broadcast = t;
		ctx.emit(id, 'assets:mint', { row: pubRow(row) });
		return { row: pubRow(row) };
	}

	function metaOf(meta) {
		if (!meta || meta.data == null || meta.data === '') return null;
		const text = String(meta.data);
		return { type: meta.type === 'json' ? 'json' : 'text', text, bytes: new TextEncoder().encode(text).length };
	}

	function createAddress(id, body) {
		const identity = identityFor(id, String(body?.key || '').toLowerCase());
		const amount = requireAmount(body?.amount, identity);
		const s = S(id);
		const ps = proofServer(id);
		const encoded = encodeAddress(id, s.addresses.length + 1, identity, amount);
		const row = newRow(id, 'receive', {
			state: 'waiting',
			assets: [brief(identity, amount)],
			address: encoded,
			courier: ps.host,
			_identity: identity
		});
		const address = {
			id: nextId('addr'),
			encoded,
			assetId: identity.assetId,
			groupKey: identity.groupKey,
			amount,
			// What the wallet makes: version 1, proofs through a universe server.
			version: 1,
			courier: ps.courier,
			createdAt: row.at.created,
			_key: identity.key,
			_rowId: row.id
		};
		s.addresses.unshift(address);
		state.book[encoded] = { walletId: id, addressId: address.id };
		ctx.emit(id, 'assets:receive', { row: pubRow(row) });
		return { address: pubRow(address), row: pubRow(row) };
	}

	function resolveAddress(id, raw) {
		const text = String(raw || '').trim().toLowerCase();
		const hrp = text.slice(0, text.lastIndexOf('1'));
		const theirs = Object.keys(HRP).find((n) => HRP[n] === hrp);
		if (!theirs) throw fail('That is not a Taproot Assets address', 'BAD_ADDRESS');
		if (theirs !== networkOf(id)) {
			throw fail(`That address is for ${theirs}, and this wallet is on ${networkOf(id)}`, 'WRONG_NETWORK');
		}
		const entry = state.book[text];
		if (!entry) {
			throw fail('The demo can only read Taproot Assets addresses made in one of its own wallets. Make one on another demo wallet’s Assets tab and paste it here', 'BAD_ADDRESS');
		}
		const address = S(entry.walletId).addresses.find((a) => a.id === entry.addressId);
		return { text, entry, address };
	}

	function decodeAddress(id, body) {
		const { entry, address } = resolveAddress(id, body?.address);
		const theirs = proofServer(entry.walletId);
		const mine = Object.values(S(id).assets).find((a) => a.key === address._key);
		const identity = findInUniverse(address._key);
		return {
			network: networkOf(id),
			assetId: address.assetId,
			groupKey: address.groupKey,
			amount: address.amount,
			type: identity?.type || 'normal',
			version: address.version,
			courier: { uri: address.courier, host: theirs.host, known: true },
			asset: mine && held(id).includes(mine) ? pubAsset(id, mine) : null,
			own: entry.walletId === id
		};
	}

	function findRow(id, rowOrAddressId) {
		const s = S(id);
		const address = s.addresses.find((a) => a.id === rowOrAddressId);
		const row = s.rows.find((r) => r.id === (address ? address._rowId : rowOrAddressId));
		if (!row) throw notFound('Nothing with that id is known to this wallet', 'NOT_FOUND');
		return row;
	}

	function buildPreview(id, kind, { identity, amount, feeRate, courier, extra }) {
		const s = S(id);
		const rec = s.assets[identity.key];
		const onchain = rec ? rec.onchain : '0';
		if (!rec || !held(id).includes(rec)) throw notFound('This wallet does not hold that asset');
		if (cmpUnits(amount, onchain) > 0) {
			throw fail('This wallet does not hold that much of the asset on-chain', 'INSUFFICIENT_ASSET_BALANCE', {
				details: { needed: amount, available: onchain }
			});
		}
		const fee = feeFor(kind, feeRate);
		const anchorSats = kind === 'send' ? ANCHOR_SATS : 0;
		const totalSats = fee.sats + anchorSats;
		const spendableSats = ctx.spendable(id);
		const short = shortOfBitcoin('This', { totalSats, fee, anchorSats, spendableSats });
		if (short) throw short;
		// One open preview per wallet, whatever it is of: preparing a burn
		// drops an open send preview, and the reverse.
		for (const pid of Object.keys(s.previews)) delete s.previews[pid];
		const preview = {
			previewId: nextId('preview'),
			expiresAt: now() + PREVIEW_TTL_MS,
			asset: brief(identity),
			amount,
			change: subUnits(onchain, amount),
			fee,
			btc: { anchorSats, totalSats, spendableSats },
			courier: courier || null,
			warnings: courier && courier.reachable === false ? ['COURIER_UNREACHABLE'] : [],
			_kind: kind,
			...extra
		};
		s.previews[preview.previewId] = preview;
		return pubRow(preview);
	}

	function takePreview(id, kind, previewId) {
		const s = S(id);
		const preview = s.previews[previewId];
		if (!preview || preview._kind !== kind || preview.expiresAt < now()) {
			if (preview) delete s.previews[previewId];
			throw fail('That preview has expired. Prepare it again', 'PREVIEW_EXPIRED');
		}
		delete s.previews[previewId];
		return preview;
	}

	function prepareSend(id, body) {
		const { text, entry, address } = resolveAddress(id, body?.address);
		if (entry.walletId === id) throw fail('That is one of this wallet’s own addresses', 'OWN_ADDRESS');
		const identity = identityFor(id, address._key);
		const theirs = proofServer(entry.walletId);
		return buildPreview(id, 'send', {
			identity,
			amount: address.amount,
			feeRate: body.feeRate,
			courier: { uri: address.courier, host: theirs.host, reachable: theirs.reachable },
			extra: { _address: text, _to: entry }
		});
	}

	function commitSend(id, body, key) {
		const preview = takePreview(id, 'send', body?.previewId);
		const s = S(id);
		const rec = s.assets[preview.asset.key];
		ctx.spend(id, preview.btc.totalSats);
		rec.onchain = subUnits(rec.onchain, preview.amount);
		const t = now();
		const row = newRow(id, 'send', {
			state: 'broadcast',
			assets: [brief(rec, preview.amount)],
			txid: derivedHex(`send:${id}:${state.n}:${t}`, 64),
			feeSats: preview.fee.sats,
			satsPerVbyte: preview.fee.feeRate,
			anchorSats: preview.btc.anchorSats,
			address: preview._address,
			courier: preview.courier.host,
			clientRef: key || null,
			_courierDown: preview.courier.reachable === false
		});
		row.at.broadcast = t;

		// The other end is a demo wallet too, so the asset arrives there.
		const to = preview._to;
		advance(to.walletId);
		const theirs = S(to.walletId);
		const theirAddress = theirs.addresses.find((a) => a.id === to.addressId);
		let incoming = theirs.rows.find((r) => r.id === theirAddress._rowId);
		if (!incoming || incoming.state !== 'waiting') {
			// Already paid once: a second payment to the same address is a
			// second receive.
			const identity = identityFor(to.walletId, theirAddress._key);
			const first = incoming;
			incoming = {
				...newRowFor(to.walletId, 'receive'),
				state: 'waiting',
				assets: [brief(identity, theirAddress.amount)],
				address: theirAddress.encoded,
				courier: first?.courier || proofServer(to.walletId).host,
				_identity: identity
			};
			theirs.rows.unshift(incoming);
		}
		incoming._paidAt = t;
		incoming._firstAt = RECEIVE.firstAtFromSibling;
		incoming.txid = row.txid;
		// A proof the server never got is one the recipient cannot fetch.
		if (row._courierDown) incoming._proofLate = true;

		ctx.emit(id, 'assets:transfer', { row: pubRow(row) });
		ctx.emit(id, 'assets:balance', { key: rec.key });
		return { row: pubRow(row) };
	}

	/** A row not yet filed anywhere, for a wallet other than the one asking. */
	function newRowFor(id, kind) {
		const t = now();
		return {
			id: nextId(kind),
			kind,
			state: 'pending',
			failed: false,
			failure: null,
			assets: [],
			txid: null,
			feeSats: null,
			satsPerVbyte: null,
			anchorSats: null,
			address: null,
			courier: null,
			paymentHash: null,
			confirmations: 0,
			confirmationsRequired: required(id),
			stuck: false,
			handedOver: null,
			at: { created: t, broadcast: null, confirmed: null, proof: null, completed: null },
			clientRef: null,
			_t0: t
		};
	}

	function prepareBurn(id, body) {
		const identity = identityFor(id, String(body?.key || body?.assetId || '').toLowerCase());
		const amount = requireAmount(body?.amount, identity);
		return buildPreview(id, 'burn', { identity, amount, feeRate: body.feeRate });
	}

	function commitBurn(id, body, key) {
		const s = S(id);
		const open = s.previews[body?.previewId];
		if (open && String(body.confirmAmount) !== open.amount) {
			throw fail('The amount to confirm does not match the amount that was previewed', 'INVALID_PARAMS');
		}
		const preview = takePreview(id, 'burn', body?.previewId);
		const rec = s.assets[preview.asset.key];
		ctx.spend(id, preview.btc.totalSats);
		rec.onchain = subUnits(rec.onchain, preview.amount);
		const t = now();
		const row = newRow(id, 'burn', {
			state: 'broadcast',
			assets: [brief(rec, preview.amount)],
			txid: derivedHex(`burn:${id}:${state.n}:${t}`, 64),
			feeSats: preview.fee.sats,
			satsPerVbyte: preview.fee.feeRate,
			anchorSats: 0,
			clientRef: key || null
		});
		row.at.broadcast = t;
		ctx.emit(id, 'assets:transfer', { row: pubRow(row) });
		ctx.emit(id, 'assets:balance', { key: rec.key });
		return { row: pubRow(row) };
	}

	function cancelPreview(id, body) {
		delete S(id).previews[body?.previewId];
		return { cancelled: true };
	}

	function testProofServer(id, body) {
		const rest = String(body?.rest || '').trim();
		if (!rest) throw fail('A proof server address is needed to test it', 'INVALID_PARAMS');
		const host = hostOfRest(rest);
		if (/down|offline|unreachable|invalid/i.test(host)) return { reachable: false, network: null, ms: null, error: 'connection refused' };
		// A proof server does not say which network it serves, so the answer
		// carries none: reachable, and how long it took.
		return { reachable: true, network: null, ms: 120 + (derivedHex(host, 2).charCodeAt(0) % 9) * 23, error: null };
	}

	/* ---------------------------------------------------------- lightning */

	// A demo price: what one whole unit of an asset costs in sats.
	function satsPerWhole(identity) {
		return 400 + (parseInt(derivedHex(`rate:${identity.key}`, 4), 16) % 1600);
	}

	function toSats(identity, amount) {
		const scale = 10n ** BigInt(identity.decimalDisplay || 0);
		const sats = ((toUnits(amount) ?? 0n) * BigInt(satsPerWhole(identity))) / scale;
		return Number(sats > 0n ? sats : 1n);
	}

	function toAssetUnits(identity, sats, perWhole = satsPerWhole(identity)) {
		const scale = 10n ** BigInt(identity.decimalDisplay || 0);
		const units = (BigInt(Math.max(1, Math.floor(sats))) * scale) / BigInt(perWhole);
		return (units > 0n ? units : 1n).toString();
	}

	const rateText = (identity, perWhole = satsPerWhole(identity)) => `1 ${identity.name} = ${perWhole.toLocaleString('en-US')} sats`;

	function requireLightning(id) {
		if (lightningMode(id) === 'off') throw fail('This wallet has no Lightning, so it has no asset channels', 'LIGHTNING_UNAVAILABLE');
	}

	function usableChannel(id, key, direction, amount, only = () => true) {
		const field = direction === 'in' ? 'receivable' : 'sendable';
		return S(id).channels.find((c) => c.asset.key === key && c.state === 'NORMAL' && only(c) && cmpUnits(c[field], amount) >= 0) || null;
	}

	// A peer that is another wallet sets no bitcoin price: an invoice through
	// its channel is for the asset alone, one unit to the sat on its face. The
	// demo's edge peer prices; a channel opened here from the dialog does not.
	const unpriced = (c) => ctx.priced === false || !!c._unpriced;

	// What starts on the peer's side of a new channel, so it can pay back: the
	// reserve it must keep and the bitcoin two asset payments travel with.
	const CHANNEL_PUSH_SATS = 1708;

	function channelQuote(id, body) {
		requireLightning(id);
		const identity = identityFor(id, String(body?.key || '').toLowerCase());
		requireAmount(body?.amount, identity);
		const fee = feeFor('channel', body?.feeRate);
		const channelSats = 100000;
		const totalSats = channelSats + fee.sats;
		const spendableSats = ctx.spendable(id);
		return { channelSats, pushSats: CHANNEL_PUSH_SATS, feeSats: fee.sats, totalSats, spendableSats, sufficient: spendableSats >= totalSats };
	}

	function openChannel(id, body) {
		requireLightning(id);
		const identity = identityFor(id, String(body?.key || '').toLowerCase());
		const amount = requireAmount(body?.amount, identity);
		const quote = channelQuote(id, body);
		const s = S(id);
		const rec = s.assets[identity.key];
		if (!rec || cmpUnits(amount, rec.onchain) > 0) throw fail('This wallet does not hold that much of the asset on-chain', 'INSUFFICIENT_ASSET_BALANCE');
		if (!quote.sufficient) {
			throw fail(`Opening needs ${quote.totalSats} sats on-chain and the wallet has ${quote.spendableSats}`, 'INSUFFICIENT_BTC', {
				details: { needed: quote.totalSats, spendable: quote.spendableSats }
			});
		}
		const pubkey = String(body?.peer?.pubkey || '');
		if (!/^0[23][0-9a-f]{64}$/i.test(pubkey)) throw fail('A peer public key is needed to open a channel', 'INVALID_PARAMS');
		if (/^0[23]0{8}/.test(pubkey)) throw fail('That peer does not take asset channels', 'PEER_NO_ASSET_CHANNELS');
		ctx.spend(id, quote.totalSats);
		rec.onchain = subUnits(rec.onchain, amount);
		const channelId = derivedHex(`chan:${id}:${state.n}:${now()}`, 64);
		const channel = {
			channelId,
			peerPubkey: pubkey,
			peerAlias: body.peer.alias || null,
			state: 'OPENING',
			asset: brief(identity),
			capacity: amount,
			localBalance: amount,
			remoteBalance: '0',
			sendable: '0',
			receivable: '0',
			channelSats: quote.channelSats,
			fundingTxid: derivedHex(`funding:${channelId}`, 64),
			_unpriced: true,
			_openedAt: now(),
			_fundingRate: feeFor('channel', body?.feeRate).feeRate
		};
		s.channels.unshift(channel);
		ctx.emit(id, 'assets:channel', { channelId: channel.channelId, state: channel.state });
		ctx.emit(id, 'assets:balance', { key: rec.key });
		return { pendingChannelId: channel.channelId, phase: 'funding' };
	}

	function closeChannel(id, body) {
		const s = S(id);
		const c = s.channels.find((x) => x.channelId === body?.channelId);
		if (!c) throw notFound('This wallet has no asset channel with that id', 'CHANNEL_NOT_FOUND');
		if (c.state === 'MISSING') {
			throw fail("This channel is on record, but the wallet's node does not hold it, as happens after a restore from a backup. It cannot be closed from this wallet.", 'CHANNEL_MISSING');
		}
		// As the host: an open whose funding is signed and not yet on the chain
		// cannot be closed. Its bitcoin can be taken back instead.
		if (pubChannel(c).reclaimable) {
			throw fail(
				'This channel is still being opened, and its funding transaction is already signed. It can be closed once it is on the chain. If that transaction will not confirm, its bitcoin can be taken back instead, which ends the open.',
				'CHANNEL_OPENING',
				{ status: 409, details: { reclaimable: true } }
			);
		}
		c.state = 'CLOSED';
		const rec = s.assets[c.asset.key];
		if (rec) rec.onchain = addUnits(rec.onchain, c.localBalance);
		c.localBalance = '0';
		ctx.emit(id, 'assets:channel', { channelId: c.channelId, state: c.state });
		ctx.emit(id, 'assets:balance', { key: c.asset.key });
		return { channelId: c.channelId, closing: true, force: !!body.force };
	}

	/**
	 * Taking a funding back (POST /channels/reclaim): a transaction that
	 * spends the same bitcoin back to this wallet at a higher fee. The
	 * host's answer and its refusals, word for word (assets-host/lightning.js
	 * reclaimFunding). A replacement has to pay more than what it replaces,
	 * so a rate that is not above the funding's, or above the one sent
	 * before, is the transaction the network does not take.
	 */
	function reclaimFunding(id, body) {
		const s = S(id);
		const c = s.channels.find((x) => x.channelId === body?.channelId && x.state !== 'CLOSED');
		if (!c) throw notFound('This wallet has no asset channel with that id.', 'CHANNEL_NOT_FOUND');
		if (!pubChannel(c).reclaimable) {
			throw fail(
				c.state === 'NORMAL'
					? 'The funding of this channel is on the chain, so there is nothing to take back. Close the channel instead.'
					: 'The funding of this channel cannot be taken back. That can be done only for a channel this wallet is opening with its own bitcoin, once its funding transaction is made and while it has not confirmed.',
				'CHANNEL_NOT_RECLAIMABLE',
				{ status: 409 }
			);
		}
		const given = body?.feeRate;
		let rate = ((ctx.fees && ctx.fees()) || { fast: 18 }).fast;
		if (given !== undefined && given !== null && given !== '') {
			rate = Number(given);
			if (!Number.isFinite(rate) || rate <= 0) throw fail('The fee rate must be a number of sats per vbyte above zero.', 'INVALID_PARAMS');
			if (rate > FEE_LIMITS.maxFeeRate) {
				throw fail(`That fee rate is above the ${FEE_LIMITS.maxFeeRate} sat/vB this wallet allows for an asset transaction.`, 'FEE_TOO_HIGH', {
					status: 400,
					details: { maxFeeRate: FEE_LIMITS.maxFeeRate }
				});
			}
		}
		if (rate <= Math.max(Number(c._fundingRate) || 0, Number(c._reclaimRate) || 0)) {
			throw fail(
				'The transaction that takes the funding back could not be made or sent. If the funding transaction is already on the network, it takes a fee rate above the one that transaction pays.',
				'CHANNEL_RECLAIM_FAILED',
				{ status: 502 }
			);
		}
		c.reclaimTxid = derivedHex(`reclaim:${c.channelId}:${rate}`, 64);
		c._reclaimRate = rate;
		c._reclaimAt = now();
		ctx.emit(id, 'assets:channel', { channelId: c.channelId, state: c.state });
		return { channelId: c.channelId, pendingChannelId: c.pendingChannelId || c.channelId, txid: c.reclaimTxid, feeSats: Math.ceil(rate * RECLAIM_VBYTES), feeRate: rate };
	}

	function invoiceQuote(id, body) {
		requireLightning(id);
		const identity = identityFor(id, String(body?.key || '').toLowerCase());
		const amount = requireAmount(body?.amount, identity);
		const s = S(id);
		const channels = s.channels.filter((c) => c.asset.key === identity.key && c.state === 'NORMAL');
		const maxReceivable = channels.reduce((m, c) => (cmpUnits(c.receivable, m) > 0 ? c.receivable : m), '0');
		const ch = usableChannel(id, identity.key, 'in', amount);
		if (!ch) {
			throw fail('No asset channel can receive that much', 'INSUFFICIENT_INBOUND', { details: { maxReceivable } });
		}
		const plain = unpriced(ch);
		const quote = {
			quoteId: nextId('rfq'),
			peerPubkey: ch.peerPubkey,
			peerAlias: ch.peerAlias,
			assetAmount: amount,
			amountSats: plain ? Number(amount) : toSats(identity, amount),
			rateText: plain ? '' : rateText(identity),
			priced: !plain,
			expiresAt: now() + INVOICE_QUOTE_MS,
			maxReceivable,
			_channelId: ch.channelId,
			_key: identity.key
		};
		s.quotes[quote.quoteId] = quote;
		return pubRow(quote);
	}

	function createInvoice(id, body) {
		requireLightning(id);
		const s = S(id);
		const quote = s.quotes[body?.quoteId];
		if (!quote || quote.expiresAt < now()) throw fail('That price has expired. Ask for a new one', 'QUOTE_EXPIRED');
		const identity = identityFor(id, quote._key);
		const paymentHash = derivedHex(`inv:${id}:${quote.quoteId}`, 64);
		const data = [];
		const material = derivedHex(`bolt11:${paymentHash}`, 220);
		for (const ch of material) data.push(parseInt(ch, 16) * 2);
		const hrp = { mainnet: 'lnbc', testnet: 'lntb', regtest: 'lnbcrt' }[networkOf(id)] || 'lnbc';
		const bolt11 = bech32Encode(`${hrp}${quote.amountSats * 10}n`, data);
		const row = newRow(id, 'ln-receive', {
			state: 'waiting',
			assets: [brief(identity, quote.assetAmount)],
			paymentHash,
			_channelId: quote._channelId
		});
		const invoice = {
			bolt11,
			paymentHash,
			assetAmount: quote.assetAmount,
			amountSats: quote.amountSats,
			rateText: quote.rateText,
			priced: quote.priced,
			expiresAt: quote.expiresAt,
			invoiceExpiresAt: now() + HOUR,
			description: String(body?.description || ''),
			asset: brief(identity),
			status: 'OPEN',
			createdAt: now()
		};
		s.invoices.unshift(invoice);
		delete s.quotes[quote.quoteId];
		return { ...invoice, row: pubRow(row) };
	}

	// `moved` is the demo's peer changing its price: a hundredth fewer sats
	// for each whole unit, so the same invoice costs a little more of the asset.
	function payQuote(id, body, moved = false) {
		requireLightning(id);
		const identity = identityFor(id, String(body?.key || '').toLowerCase());
		// No digits before the separator is an invoice that names no amount.
		const m = /^ln(?:bcrt|bc|tb)(\d*)([munp]?)1/i.exec(String(body?.bolt11 || ''));
		if (!m) throw fail('That is not a Lightning invoice', 'BAD_INVOICE');
		const perBtc = { '': 1e8, m: 1e5, u: 100, n: 0.1, p: 0.0001 };
		const amountSats = m[1] ? Math.round(Number(m[1]) * perBtc[m[2].toLowerCase()]) : Number(body.amountSats) || 0;
		if (!(amountSats > 0)) throw fail('This invoice names no amount, so one is needed', 'AMOUNT_REQUIRED');
		const perWhole = satsPerWhole(identity) - (moved ? Math.max(1, Math.round(satsPerWhole(identity) / 100)) : 0);
		const sendable = channelTotals(id, identity.key).sendable;
		// A peer that prices is asked first. One that does not takes the
		// invoice at its face: a unit to the sat.
		let assetAmount = toAssetUnits(identity, amountSats, perWhole);
		let ch = usableChannel(id, identity.key, 'out', assetAmount, (c) => !unpriced(c));
		if (!ch) {
			const face = String(Math.max(1, Math.floor(amountSats)));
			const other = usableChannel(id, identity.key, 'out', face, unpriced);
			if (other) {
				ch = other;
				assetAmount = face;
			}
		}
		if (!ch) throw fail('No asset channel can send that much', 'INSUFFICIENT_OUTBOUND', { details: { sendable } });
		const plain = unpriced(ch);
		const quote = {
			quoteId: nextId('rfq'),
			assetAmount,
			amountSats,
			rateText: plain ? '' : rateText(identity, perWhole),
			priced: !plain,
			peerAlias: ch.peerAlias,
			expiresAt: now() + PAY_QUOTE_MS,
			sendable,
			_channelId: ch.channelId,
			_key: identity.key
		};
		S(id).quotes[quote.quoteId] = quote;
		return pubRow(quote);
	}

	function pay(id, body, key) {
		requireLightning(id);
		const s = S(id);
		const quote = s.quotes[body?.quoteId];
		if (!quote || quote.expiresAt < now()) {
			// The price ran out, and the demo's peer asks a little more the next
			// time, so the page has a changed price to show. An invoice with no
			// amount of its own is priced for the amount the first quote was for.
			const fresh = payQuote(id, { bolt11: body?.bolt11, key: body?.key || quote?._key, amountSats: quote?.amountSats }, true);
			throw fail('The price changed before the payment was made', 'QUOTE_CHANGED', { details: { quote: fresh } });
		}
		if (body.maxAssetAmount != null && cmpUnits(quote.assetAmount, body.maxAssetAmount) > 0) {
			throw fail('The price changed before the payment was made', 'QUOTE_CHANGED', { details: { quote: pubRow(quote) } });
		}
		const identity = identityFor(id, quote._key);
		const ch = s.channels.find((c) => c.channelId === quote._channelId);
		delete s.quotes[quote.quoteId];
		return new Promise((resolve) => {
			setTimeout(() => {
				ch.localBalance = subUnits(ch.localBalance, quote.assetAmount);
				ch.remoteBalance = addUnits(ch.remoteBalance, quote.assetAmount);
				ch.sendable = subUnits(ch.sendable, quote.assetAmount);
				ch.receivable = addUnits(ch.receivable, quote.assetAmount);
				const paymentHash = derivedHex(`pay:${id}:${quote.quoteId}`, 64);
				const row = newRow(id, 'ln-send', {
					state: 'complete',
					assets: [brief(identity, quote.assetAmount)],
					paymentHash,
					feeSats: 2,
					clientRef: key || null,
					_done: true
				});
				row.at.completed = now();
				save();
				ctx.emit(id, 'assets:payment', { row: pubRow(row) });
				ctx.emit(id, 'assets:balance', { key: identity.key });
				// The daemon's own word on it, marked as one an asset channel carried.
				ctx.emit(id, 'payment:sent', { paymentHash, amountSats: 354, feeSats: 2, auxiliary: true });
				resolve({ status: 'COMPLETED', paymentHash, assetAmount: quote.assetAmount, feeSats: 2, failureDescription: null });
			}, ctx.ticker === false ? 0 : PAY_ANSWERS_MS);
		});
	}

	/* --------------------------------------------- proofs handed over by file */

	// The demo's proof file says who it pays and with what, and only the demo
	// can read it. A real one is the asset's whole history, which the wallet
	// verifies against the chain before it takes anything from it.
	function exportProof(id, rowId) {
		const row = findRow(id, rowId);
		if (row.kind !== 'send') throw fail('Only a send has a proof file to hand to someone.', 'NO_PROOF_FILE');
		if (!['proofs', 'complete'].includes(row.state)) {
			throw fail(`The proof file exists once the transaction is ${row.confirmationsRequired} blocks deep.`, 'PROOF_NOT_READY', { status: 409 });
		}
		const a = row.assets[0];
		const text = JSON.stringify({ demoProof: 1, address: row.address || null, txid: row.txid, assetId: a.assetId, amount: a.amount });
		return {
			id: row.id,
			fileName: `proof-${a.assetId.slice(0, 8)}-${row.txid.slice(0, 8)}.assetproof`,
			file: btoa(text),
			bytes: text.length,
			assetId: a.assetId,
			address: row.address || null,
			txid: row.txid
		};
	}

	function importProof(id, body) {
		const text = typeof body?.file === 'string' ? body.file.trim() : '';
		if (!text) throw fail('A proof file is needed.', 'BAD_PROOF_FILE');
		let proof = null;
		try {
			proof = JSON.parse(atob(text));
		} catch {
			/* not one of the demo's */
		}
		if (!proof || proof.demoProof !== 1) throw fail('That file is not a Taproot Assets proof file this wallet can read.', 'BAD_PROOF_FILE');
		advance(id);
		const s = S(id);
		const mine = s.rows.filter((r) => r.kind === 'receive' && proof.address && r.address === proof.address);
		if (!mine.length) {
			throw notFound('This proof is not for an address this wallet made. It has to be the file of a payment to this wallet.', 'PROOF_NOT_OURS');
		}
		const row = mine.find((r) => r.txid === proof.txid && r.state !== 'waiting');
		if (!row) {
			if (mine.some((r) => r.state === 'waiting')) {
				throw fail('The payment this proof is for is not in a block yet. Import the file once its transaction has confirmed.', 'PAYMENT_NOT_SEEN', {
					status: 409
				});
			}
			throw fail('This proof is for a different payment than the one this wallet found for that address.', 'PROOF_OTHER_PAYMENT', { status: 409 });
		}
		if (row.state === 'complete') return { result: 'already', row: pubRow(row) };
		if (row.state === 'confirming') {
			// Kept, and used when the transaction is deep enough.
			delete row._proofLate;
			row._handed = true;
			save();
			return { result: 'kept', waitingFor: 'confirmations', reason: null, row: pubRow(row) };
		}
		const t = now();
		delete row._proofLate;
		row.failure = null;
		row.state = 'complete';
		row.at.proof = row.at.proof || t;
		row.at.completed = t;
		credit(id, row._identity || row.assets[0], row.assets[0].amount, { at: t });
		row._done = true;
		s.backup.dirty = true;
		save();
		ctx.emit(id, 'assets:receive', { row: pubRow(row) });
		ctx.emit(id, 'assets:balance', { key: row.assets[0].key });
		return { result: 'complete', row: pubRow(row) };
	}

	/* ----------------------------------------------------------- dispatch */

	const IDEMPOTENT = new Set(['/mint', '/send/prepare', '/send/commit', '/burn/prepare', '/burn/commit', '/channels/open', '/channels/reclaim', '/pay']);

	function handle(id, sub, q, method, body, key) {
		if (method === 'GET') {
			if (sub === '/status') return status(id);
			if (sub === '/balances') return balances(id);
			if (sub === '/asset') return assetDetail(id, String(q.get('key') || '').toLowerCase());
			if (sub === '/activity') return activity(id, q);
			if (sub === '/proofs/export') return exportProof(id, q.get('id'));
			if (sub === '/channels') return { channels: S(id).channels.filter((c) => c.state !== 'CLOSED').map(pubChannel) };
			if (sub === '/invoices') return { invoices: S(id).invoices.map((i) => ({ ...i })) };
			return undefined;
		}
		if (method !== 'POST') return undefined;
		switch (sub) {
			case '/lookup':
				return lookup(body);
			case '/mint/quote':
				return mintQuote(id, body);
			case '/mint':
				return mint(id, body, key);
			case '/addresses':
				return createAddress(id, body);
			case '/addresses/decode':
				return decodeAddress(id, body);
			case '/addresses/check': {
				// One look at the chain. The demo's old address was paid while
				// nobody was looking, so the look finds it.
				const row = findRow(id, body?.id);
				if (row._unwatched) {
					delete row._unwatched;
					row._paidAt = now() - (row._firstAt || RECEIVE.firstAt);
					stepRow(id, row, now());
					save();
				}
				return { row: pubRow(row) };
			}
			case '/proofs/retry': {
				const row = findRow(id, body?.id);
				if (row._proofLate && row._retryAt == null) row._retryAt = now();
				// The demo's proof server takes an issuance proof the second time.
				if (row._unpublished) {
					delete row._unpublished;
					row.failure = null;
					save();
				}
				// And a transfer's: the send then finishes like any other.
				if (row._refused) {
					delete row._refused;
					row.failure = null;
					row._t0 = now() - SEND.proofAt;
					save();
				}
				// A server that was down and is back takes the proof it missed.
				if (row._courierDown && !S(id).proofServerDown) {
					delete row._courierDown;
					save();
				}
				return { row: pubRow(row) };
			}
			case '/proofs/import':
				return importProof(id, body);
			case '/proofs/handed-over': {
				const row = findRow(id, body?.id);
				if (row.kind !== 'send') throw fail('Only a send has a proof file to hand to someone.', 'NO_PROOF_FILE');
				if (row.state === 'complete') return { row: pubRow(row) };
				if (row.state !== 'proofs') {
					throw fail(`The proof file exists once the transaction is ${row.confirmationsRequired} blocks deep.`, 'PROOF_NOT_READY', { status: 409 });
				}
				row.handedOver = body?.handedOver === false ? null : row.handedOver || now();
				save();
				ctx.emit(id, 'assets:transfer', { row: pubRow(row) });
				return { row: pubRow(row) };
			}
			case '/send/prepare':
				return prepareSend(id, body);
			case '/send/commit':
				return commitSend(id, body, key);
			case '/send/cancel':
			case '/burn/cancel':
				return cancelPreview(id, body);
			case '/burn/prepare':
				return prepareBurn(id, body);
			case '/burn/commit':
				return commitBurn(id, body, key);
			case '/transfers/rebroadcast': {
				const row = findRow(id, body?.id);
				if (row.state !== 'broadcast' || row.failed) {
					throw fail('That transaction is not waiting for a block, so there is nothing to broadcast again', 'NOT_BROADCAST', { status: 409 });
				}
				// The same transaction, sent again. An hour is counted from here
				// before it is called stuck again, and the demo's network takes it.
				row.stuck = false;
				if (row._stuck) {
					delete row._stuck;
					row._t0 = now();
				}
				save();
				return { row: pubRow(row) };
			}
			case '/proof-server/test':
				return testProofServer(id, body);
			case '/channels/quote':
				return channelQuote(id, body);
			case '/channels/open':
				return openChannel(id, body);
			case '/channels/close':
				return closeChannel(id, body);
			case '/channels/reclaim':
				// As the host: taking a funding back is asked for once, by its key.
				if (!key) {
					throw fail('This request needs an X-Idempotency-Key header, so that sending it twice does not take the same funding back twice.', 'IDEMPOTENCY_KEY_REQUIRED', { status: 400 });
				}
				return reclaimFunding(id, body);
			case '/invoices/quote':
				return invoiceQuote(id, body);
			case '/invoices':
				return createInvoice(id, body);
			case '/pay/quote':
				return payQuote(id, body);
			case '/pay':
				return pay(id, body, key);
			default:
				return undefined;
		}
	}

	/**
	 * Answer one request, or undefined for a route that is not one of these.
	 * `route` is the wallet API path ("/x/assets/status"), `query` its query
	 * string, and `headers` whatever the caller sent, read for the
	 * idempotency key.
	 */
	function request(id, route, query, method = 'GET', body, headers) {
		if (route !== '/x/assets' && !route.startsWith('/x/assets/')) return undefined;
		startTicker();
		readSwitch();
		S(id).seen = true;
		advance(id);
		const sub = route.slice('/x/assets'.length) || '/';
		refuseWhileDown(id, sub);
		const q = new URLSearchParams(query || '');
		const key = headers && (headers['X-Idempotency-Key'] || headers['x-idempotency-key']);
		const s = S(id);
		if (key && IDEMPOTENT.has(sub) && s.idem[`${sub}:${key}`]) return JSON.parse(s.idem[`${sub}:${key}`]);
		const answer = handle(id, sub, q, method, body || {}, key);
		if (answer === undefined) return undefined;
		const remember = (value) => {
			if (key && IDEMPOTENT.has(sub)) s.idem[`${sub}:${key}`] = JSON.stringify(value);
			if (method === 'POST') save();
			return value;
		};
		return answer && typeof answer.then === 'function' ? answer.then(remember) : remember(answer);
	}

	/* --------------------------------------------------------------- seed */

	function seed() {
		const ids = new Set((ctx.wallets() || []).map((w) => w.id));
		const t = now();
		const define = ({ name, type = 'normal', decimals = null, grouped = false, issued = null, burned = '0', mints = 1, bornDaysAgo = 30, meta = null, height = 900000 }) => {
			const assetId = derivedHex(`seed-asset:${name}`, 64);
			const groupKey = grouped ? `02${derivedHex(`seed-group:${name}`, 64)}` : null;
			const born = t - bornDaysAgo * DAY;
			const issuances = [];
			if (issued != null) {
				const each = (toUnits(issued) ?? 0n) / BigInt(mints);
				for (let i = 0; i < mints; i++) {
					const amount = i === mints - 1 ? ((toUnits(issued) ?? 0n) - each * BigInt(mints - 1)).toString() : each.toString();
					issuances.push({ assetId: i === 0 ? assetId : derivedHex(`seed-asset:${name}:${i}`, 64), amount, at: born + i * 9 * DAY });
				}
			}
			return {
				key: groupKey || assetId,
				assetId,
				groupKey,
				name,
				type,
				decimalDisplay: type === 'collectible' ? null : decimals,
				supply: { issued, burned, known: issued != null },
				genesis: { outpoint: `${derivedHex(`seed-genesis:${name}`, 64)}:0`, height: height - bornDaysAgo * 144, timestamp: born },
				meta: meta ? { type: meta.type, text: meta.text, bytes: new TextEncoder().encode(meta.text).length } : null,
				issuances
			};
		};
		const hold = (id, def, onchain, { mintedHere = false, anchors = 1, proofs = 3, depth = 3 } = {}) => {
			S(id).assets[def.key] = {
				...def,
				supply: { ...def.supply },
				genesis: { ...def.genesis },
				issuances: def.issuances.map((i) => ({ ...i, heldHere: mintedHere })),
				onchain,
				anchors,
				canReissue: mintedHere && !!def.groupKey,
				mintedHere,
				proofs: { count: proofs, depth: mintedHere ? 0 : depth }
			};
		};
		const past = (id, kind, def, amount, agoMs, extra = {}) => {
			const created = t - agoMs;
			const onchain = !kind.startsWith('ln-');
			const row = {
				...newRowFor(id, kind),
				state: 'complete',
				assets: [brief(def, amount)],
				txid: onchain ? derivedHex(`seed-tx:${id}:${kind}:${def.name}:${agoMs}`, 64) : null,
				feeSats: kind === 'receive' ? null : onchain ? 7 * VSIZE[kind === 'mint' ? 'mint' : kind === 'burn' ? 'burn' : 'send'] : 2,
				satsPerVbyte: kind === 'receive' || !onchain ? null : 7,
				anchorSats: onchain && kind !== 'burn' ? ANCHOR_SATS : null,
				paymentHash: onchain ? null : derivedHex(`seed-hash:${id}:${def.name}:${agoMs}`, 64),
				confirmations: onchain ? required(id) : 0,
				courier: kind === 'receive' || kind === 'send' ? proofServer(id).host : null,
				at: {
					created,
					broadcast: onchain && kind !== 'receive' ? created : null,
					confirmed: onchain ? created + 11 * MINUTE : null,
					proof: onchain ? created + 62 * MINUTE : null,
					completed: onchain ? created + 62 * MINUTE : created + 3 * SECOND
				},
				blockHeight: onchain ? 900000 - Math.floor(agoMs / (10 * MINUTE)) : null,
				_t0: created,
				_done: true,
				...extra
			};
			S(id).rows.push(row);
			return row;
		};

		const busd = define({
			name: 'BUSD',
			decimals: 2,
			grouped: true,
			issued: '100000000',
			burned: '50000',
			mints: 2,
			bornDaysAgo: 41,
			meta: { type: 'text', text: 'Beignet dollars: a demo currency for trying out Taproot Assets.' }
		});
		const points = define({ name: 'Club Points', decimals: 0, issued: '1000000', bornDaysAgo: 120 });
		// 2^53 + 1 units: the first amount a JS number cannot hold. If any
		// step between here and the screen goes through a number, the last
		// digit shows 2.
		const pico = define({ name: 'Pico', decimals: 8, issued: MAX_UNITS.toString(), bornDaysAgo: 12 });
		const ticket = define({
			name: 'Genesis Ticket #7',
			type: 'collectible',
			issued: '1',
			bornDaysAgo: 75,
			meta: { type: 'json', text: '{\n  "event": "Genesis Meetup",\n  "seat": 7,\n  "row": "A"\n}' }
		});
		const poster = define({ name: 'Beignet Poster', type: 'collectible', issued: '1', bornDaysAgo: 9 });

		if (ids.has('demo-main')) {
			const id = 'demo-main';
			hold(id, busd, '1250000', { mintedHere: true, anchors: 2, proofs: 7 });
			hold(id, points, '4200', { proofs: 4, depth: 3 });
			hold(id, pico, '9007199254740993', { mintedHere: true, proofs: 1 });
			hold(id, ticket, '1', { proofs: 5, depth: 4 });
			hold(id, poster, '1', { mintedHere: true, proofs: 1 });
			S(id).channels.push({
				channelId: derivedHex('seed-channel:demo-main:busd', 64),
				peerPubkey: `02${derivedHex('seed-peer:busd', 64)}`,
				peerAlias: 'Lightning Labs edge',
				state: 'NORMAL',
				fundingTxid: derivedHex('seed-funding:demo-main:busd', 64),
				asset: brief(busd),
				capacity: '550000',
				localBalance: '240000',
				remoteBalance: '310000',
				sendable: '240000',
				receivable: '310000',
				channelSats: 100000
			});
			past(id, 'mint', busd, '75000000', 41 * DAY);
			past(id, 'mint', busd, '25000000', 32 * DAY);
			past(id, 'send', busd, '98200000', 30 * DAY);
			past(id, 'receive', points, '4200', 26 * DAY);
			past(id, 'receive', ticket, '1', 19 * DAY);
			past(id, 'mint', pico, '9007199254740993', 12 * DAY);
			past(id, 'mint', poster, '1', 9 * DAY);
			past(id, 'burn', busd, '50000', 6 * DAY);
			past(id, 'ln-receive', busd, '2500', 2 * DAY);
			past(id, 'ln-send', busd, '1250', 26 * HOUR);
			// Backed up three days ago, and the Lightning payments since then
			// moved the channel: the stale-backup note.
			S(id).backup = { exportedAt: new Date(t - 3 * DAY).toISOString(), dirty: true };
		}

		if (ids.has('demo-testnet')) {
			const id = 'demo-testnet';
			const tusd = define({ name: 'tUSD', decimals: 2, grouped: true, issued: '50000000', bornDaysAgo: 8, height: 3411000 });
			const tpoints = define({ name: 'Test Points', decimals: 0, issued: '21000000', bornDaysAgo: 5, height: 3411000 });
			hold(id, tusd, '500000', { mintedHere: true, proofs: 2 });
			hold(id, tpoints, '1500', { proofs: 2, depth: 1 });
			past(id, 'mint', tusd, '50000000', 8 * DAY);
			past(id, 'receive', tpoints, '1500', 4 * DAY);
			// One on its way in: found at two confirmations, and moving.
			const arriving = {
				...newRowFor(id, 'receive'),
				state: 'waiting',
				assets: [brief(tpoints, '250')],
				address: null,
				courier: proofServer(id).host,
				_identity: tpoints,
				_lazy: RECEIVE.firstAt + 1.5 * RECEIVE.every
			};
			S(id).rows.unshift(arriving);
			// And one whose transaction confirmed and whose proof has not come.
			const late = {
				...newRowFor(id, 'receive'),
				state: 'proofs',
				assets: [brief(tusd, '12500')],
				txid: derivedHex('seed-late-proof', 64),
				anchorSats: ANCHOR_SATS,
				courier: proofServer(id).host,
				confirmations: 6,
				failure: {
					code: 'PROOF_UNAVAILABLE',
					message: 'The proof server does not have the proof for this transfer yet',
					retrying: true
				},
				at: { created: t - 3 * HOUR, broadcast: null, confirmed: t - 150 * MINUTE, proof: null, completed: null },
				_identity: tusd,
				_t0: t - 3 * HOUR,
				_paidAt: t - 3 * HOUR,
				_proofLate: true
			};
			S(id).rows.unshift(late);
		}

		if (ids.has('demo-savings')) {
			const id = 'demo-savings';
			const gold = define({ name: 'Gold Gram', decimals: 3, issued: '5000000', bornDaysAgo: 60 });
			hold(id, gold, '31103', { proofs: 3, depth: 2 });
			past(id, 'receive', gold, '31103', 2 * DAY);
			// A mint found part way through its confirmations.
			const silverTx = derivedHex('seed-mint:silver', 64);
			const silverId = derivedHex(`asset:${silverTx}:0:Silver Ounce`, 64);
			S(id).rows.unshift({
				...newRowFor(id, 'mint'),
				state: 'confirming',
				assets: [{ key: silverId, assetId: silverId, name: 'Silver Ounce', type: 'normal', decimalDisplay: 3, amount: '250000' }],
				txid: silverTx,
				feeSats: 18 * VSIZE.mint,
				satsPerVbyte: 18,
				anchorSats: ANCHOR_SATS,
				confirmations: 2,
				_seedlings: [{ groupKey: null, meta: null }],
				_lazy: MINT.firstAt + 1.5 * MINT.every
			});
			S(id).backup = { exportedAt: new Date(t - 2 * HOUR).toISOString(), dirty: false };
		}

		if (ids.has('demo-lfbw')) {
			const id = 'demo-lfbw';
			hold(id, points, '350', { proofs: 2, depth: 4 });
			past(id, 'receive', points, '350', 3 * DAY);
			S(id).backup = { exportedAt: new Date(t - 5 * HOUR).toISOString(), dirty: false };
		}
	}

	/* ------------------------------------------------------------- public */

	if (!state) {
		state = { v: 1, n: 0, wallets: {}, book: {} };
		seed();
		save();
	}

	// The daemon's word for each state of an asset channel on GET /channels.
	const DAEMON_STATE = { OPENING: 'AWAITING_FUNDING_CONFIRMED', NORMAL: 'NORMAL', CLOSING: 'NEGOTIATING_CLOSING', FORCE_CLOSING: 'FORCE_CLOSED' };

	/**
	 * This wallet's asset channels as its daemon lists them on GET /channels:
	 * beside the bitcoin ones, marked `auxiliary`, with the sats that carry
	 * the asset. Reading it moves nothing and marks nothing as seen.
	 */
	function daemonChannels(id) {
		if (!state.wallets[id]) return [];
		return state.wallets[id].channels
			.filter((c) => c.state !== 'CLOSED' && c.state !== 'MISSING')
			.map((c) => {
				const capacitySats = Number(c.channelSats) || 0;
				const remoteBalanceSats = Math.min(capacitySats, CHANNEL_PUSH_SATS);
				const daemonState = DAEMON_STATE[c.state] || c.state;
				return {
					channelId: c.channelId,
					peerPubkey: c.peerPubkey,
					alias: c.peerAlias || null,
					capacitySats,
					localBalanceSats: capacitySats - remoteBalanceSats,
					remoteBalanceSats,
					state: daemonState,
					htlcUsable: daemonState === 'NORMAL',
					isPrivate: true,
					auxiliary: true
				};
			});
	}

	// The sats an asset payment carries beside the asset, as the daemon counts them.
	const CARRIER_SATS = 354;

	/**
	 * This wallet's asset payments as its daemon lists them on GET /payments:
	 * beside the bitcoin ones, marked `auxiliary`. One out counts the sats
	 * that carried it, one in the face value of its invoice.
	 */
	function daemonPayments(id) {
		if (!state.wallets[id]) return [];
		const s = state.wallets[id];
		return s.rows
			.filter((r) => (r.kind === 'ln-send' || r.kind === 'ln-receive') && r.state === 'complete' && r.paymentHash)
			.map((r) => {
				const invoice = r.kind === 'ln-receive' ? s.invoices.find((i) => i.paymentHash === r.paymentHash) : null;
				return {
					paymentHash: r.paymentHash,
					direction: r.kind === 'ln-send' ? 'OUTGOING' : 'INCOMING',
					amountSats: r.kind === 'ln-send' ? CARRIER_SATS : invoice ? invoice.amountSats : CARRIER_SATS,
					feeSats: r.kind === 'ln-send' ? r.feeSats : null,
					status: 'COMPLETED',
					createdAt: r.at.created,
					completedAt: r.at.completed || r.at.created,
					auxiliary: true
				};
			});
	}

	/** This wallet's asset invoices as its daemon lists them on GET /invoices, marked `auxiliary`. */
	function daemonInvoices(id) {
		if (!state.wallets[id]) return [];
		const t = now();
		return state.wallets[id].invoices.map((i) => ({
			bolt11: i.bolt11,
			paymentHash: i.paymentHash,
			amountSats: i.amountSats,
			description: i.description,
			expiry: Math.round((i.invoiceExpiresAt - i.createdAt) / 1000),
			createdAt: Math.round(i.createdAt / 1000),
			status: i.status === 'PAID' ? 'PAID' : i.invoiceExpiresAt < t ? 'EXPIRED' : 'PENDING',
			auxiliary: true
		}));
	}

	return {
		request,
		daemonChannels,
		daemonPayments,
		daemonInvoices,
		/** What the wallet record's `assets` block says, for the manager routes. */
		recordOf: (id) => ({
			enabled: true,
			universe: (walletRecord(id).assets && walletRecord(id).assets.universe) || null,
			holdsAssets: held(id).length > 0,
			phase: S(id).host === 'failed' ? 'failed' : S(id).host === 'starting' ? 'starting' : S(id).host ? null : 'ready',
			error: S(id).host === 'failed' ? HOST_FAILED : null
		}),
		/** For tests and the demo's switch: put a wallet's host in one of HOST_MODES, or null for up. */
		setHost,
		/** For tests and the demo's switch: 'stuck', 'proof-refused', 'send-refused' or 'unwatched' on this wallet. */
		seed: putState,
		/** For tests: this wallet's proof server stops answering, or answers again. */
		setProofServer(id, down) {
			S(id).proofServerDown = !!down;
		},
		/** A backup was just exported: every wallet's proofs are in it. */
		backedUp(at) {
			for (const [id, s] of Object.entries(state.wallets)) {
				s.backup = { exportedAt: at, dirty: false };
				ctx.emit(id, 'assets:backup', { exportedAt: at, dirty: false });
			}
			save();
		},
		/** For tests: move every row on to where the clock says it is. */
		advance: advanceAll,
		/** For tests: forget everything, storage included. */
		reset() {
			try {
				if (ctx.storage) ctx.storage.removeItem(STORE_KEY);
			} catch (_) {
				/* nothing to forget */
			}
		},
		stop() {
			clearInterval(timer);
			timer = null;
		}
	};
}
