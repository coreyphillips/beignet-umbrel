'use strict';

/**
 * The shapes the dashboard reads (manager/ui/src/lib/assets-api.js), built
 * from the library's records and the host's own rows. Nothing here does I/O.
 *
 * Amounts of an asset are decimal strings going out and bigint inside. Sats
 * are numbers.
 */
const { STATES, ANCHOR_SATS, NOMINAL_RATE } = require('./adapter');

const TERMINAL = Object.freeze(['complete', 'failed', 'cancelled']);
const isTerminal = (state) => TERMINAL.includes(state);

const typeName = (type) => (type === 1 || type === 'collectible' ? 'collectible' : 'normal');

/**
 * A mint's state on the dashboard. It is complete once the wallet holds the
 * assets and their proofs; publishing those proofs to the proof server comes
 * after, and a server that will not take them is a failure the row carries,
 * not a state it waits in.
 */
function deriveMint(state, confirmations) {
	const B = STATES.Batch;
	if (state === B.SeedlingCancelled || state === B.SproutCancelled) return 'failed';
	if (state < B.Broadcast) return 'pending';
	if (state === B.Broadcast) return confirmations >= 1 ? 'confirming' : 'broadcast';
	if (state === B.Confirmed) return 'proofs';
	return 'complete';
}

/** A send's or a burn's state. Proofs are built once the transaction is deep enough. */
function deriveTransfer(state, confirmations) {
	const S = STATES.Send;
	if (state === S.Cancelled) return 'failed';
	if (state < S.Broadcast) return 'pending';
	if (state < S.TransferProofs) return confirmations >= 1 ? 'confirming' : 'broadcast';
	if (state === S.TransferProofs) return 'proofs';
	return 'complete';
}

/** A receive's state. `need` is the depth the proof is fetched at. */
function deriveReceive(state, confirmations, need) {
	const R = STATES.Receive;
	if (state === R.Registered) return 'waiting';
	if (state === R.Located) return confirmations >= need ? 'proofs' : 'confirming';
	if (state === R.Verified) return 'proofs';
	return 'complete';
}

/** A row as the host stores it. `ref` is the batch, parcel or address it follows. */
function newRow({ id, kind, ref, created, ...fields }) {
	return {
		id,
		kind,
		ref,
		state: 'pending',
		failure: null,
		assets: [],
		txid: null,
		feeSats: null,
		vbytes: null,
		satsPerVbyte: null,
		anchorSats: null,
		address: null,
		courier: null,
		blockHeight: null,
		seenHeight: null,
		at: { created, broadcast: null, confirmed: null, proof: null, completed: null },
		clientRef: null,
		...fields
	};
}

/**
 * A stored row as the dashboard reads it, with what only the chain tip can say.
 * `watched` is the set of receive rows the loop looked at on its last pass,
 * or null before there has been one.
 */
function rowView(row, { tip = 0, cfg, now = Date.now(), watched = null }) {
	const confirmations = row.blockHeight && tip >= row.blockHeight ? tip - row.blockHeight + 1 : 0;
	// An address nobody has paid is looked at for a while and then left alone.
	// The dashboard says so, and offers to look, rather than wait in silence.
	let watching = null;
	if (row.kind === 'receive' && row.state === 'waiting') {
		watching = watched ? watched.has(row.id) : (row.at.created || 0) >= now - cfg.receiveWindowMs;
	}
	let stuck = false;
	if (!isTerminal(row.state) && row.kind !== 'receive' && row.txid && confirmations === 0 && row.at.broadcast) {
		stuck =
			cfg.stuckAfterBlocks != null
				? row.seenHeight != null && tip - row.seenHeight >= cfg.stuckAfterBlocks
				: now - (row.sentAgainAt || row.at.broadcast) > cfg.stuckAfterMs;
	}
	return {
		id: row.id,
		kind: row.kind,
		state: row.state,
		failed: row.state === 'failed',
		failure: row.failure || null,
		assets: row.assets || [],
		txid: row.txid || null,
		feeSats: row.feeSats,
		satsPerVbyte: row.satsPerVbyte,
		vbytes: row.vbytes,
		anchorSats: row.anchorSats,
		address: row.address || null,
		courier: row.courier || null,
		paymentHash: row.paymentHash || null,
		confirmations,
		confirmationsRequired: cfg.minConfirmations,
		blockHeight: row.blockHeight || null,
		stuck,
		watching,
		// When the sender said they gave the recipient the proof as a file.
		handedOver: row.kind === 'send' && row.handedOver ? row.handedOver : null,
		at: { ...row.at },
		clientRef: row.clientRef || null
	};
}

/** An asset as a row names it. */
function brief(reg, amount) {
	const type = typeName(reg.type);
	return {
		key: reg.groupKey || reg.assetId,
		assetId: reg.assetId,
		name: reg.name || null,
		type,
		decimalDisplay: type === 'collectible' ? null : Number.isInteger(reg.decimalDisplay) ? reg.decimalDisplay : 0,
		...(amount !== undefined ? { amount: String(amount) } : {})
	};
}

/** A record the wallet can still spend from. */
const isLive = (record) => !record.spent && !record.spentExternally && !record.watchOnly;

/** Units held per asset ID: all of them, and the part no unconfirmed send is using. */
function heldByAsset(records) {
	const out = new Map();
	for (const r of records) {
		if (!isLive(r)) continue;
		const e = out.get(r.assetId) || { total: 0n, free: 0n, groupKey: r.groupKey || null };
		const amount = BigInt(r.amount);
		e.total += amount;
		if (!r.reservedBy) e.free += amount;
		out.set(r.assetId, e);
	}
	return out;
}

const sumRows = (rows, key, kinds, states) =>
	rows
		.filter((r) => kinds.includes(r.kind) && states.includes(r.state))
		.flatMap((r) => r.assets || [])
		.filter((a) => a.key === key)
		.reduce((sum, a) => sum + BigInt(a.amount || '0'), 0n);

/**
 * Every asset the wallet holds. An asset in a group is one entry, keyed by
 * the group key, with the balance of all its issuances; `assetId` is the
 * issuance the wallet holds most of.
 *
 * `registry` maps asset ID to what the host has learnt of it, `groups` maps
 * group key to whether this wallet can issue more, `rows` are stored rows.
 */
function assetViews({ records, registry, groups = new Map(), rows = [], channels = [] }) {
	const byKey = new Map();
	// What each asset has in channels: `channels` are the host's own entries
	// (lightning.js channelList), the ones whose assets have left the chain.
	const inChannels = new Map();
	for (const c of channels) {
		if (!c.counted || !c.key) continue;
		const sum = inChannels.get(c.key) || { local: 0n, sendable: 0n, receivable: 0n, assetId: c.assetId, groupKey: c.groupKey || null };
		sum.local += c.local;
		sum.sendable += c.sendable;
		sum.receivable += c.receivable;
		inChannels.set(c.key, sum);
	}
	for (const r of records) {
		if (!isLive(r)) continue;
		const reg = registry.get(r.assetId);
		const groupKey = r.groupKey || (reg && reg.groupKey) || null;
		const key = groupKey || r.assetId;
		const entry = byKey.get(key) || { key, groupKey, members: new Map(), anchors: new Set(), sample: r };
		const member = entry.members.get(r.assetId) || 0n;
		entry.members.set(r.assetId, member + BigInt(r.amount));
		entry.anchors.add(r.anchorOutPoint);
		byKey.set(key, entry);
	}
	// An asset this wallet holds only in a channel is held all the same.
	for (const [key, sum] of inChannels) {
		if (!byKey.has(key)) byKey.set(key, { key, groupKey: sum.groupKey, members: new Map(), anchors: new Set(), sample: {}, only: sum.assetId });
	}
	const out = [];
	for (const entry of byKey.values()) {
		const primaryId = entry.members.size ? [...entry.members.entries()].sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1))[0][0] : entry.only;
		const reg = registry.get(primaryId) || {};
		const type = typeName(reg.type !== undefined ? reg.type : entry.sample.type);
		const held = [...entry.members.values()].reduce((a, b) => a + b, 0n);
		// Units in a send or burn that has not been written into the records yet.
		const leaving = sumRows(rows, entry.key, ['send', 'burn'], ['pending', 'broadcast', 'confirming']);
		const onchain = held > leaving ? held - leaving : 0n;
		const family = [...registry.values()].filter((r) => (entry.groupKey ? r.groupKey === entry.groupKey : r.assetId === primaryId));
		const mintedHere = family.some((r) => r.mintedHere);
		const issuedKnown = family.filter((r) => r.issued != null);
		const supplyKnown = entry.groupKey ? mintedHere : !!(reg.mintedHere || reg.supplyKnown);
		const issued = issuedKnown.length ? issuedKnown.reduce((sum, r) => sum + BigInt(r.issued), 0n).toString() : null;
		const ln = inChannels.get(entry.key) || { local: 0n, sendable: 0n, receivable: 0n };
		out.push({
			key: entry.key,
			assetId: primaryId,
			groupKey: entry.groupKey,
			name: reg.name || entry.sample.name || null,
			type,
			decimalDisplay: type === 'collectible' ? null : Number.isInteger(reg.decimalDisplay) ? reg.decimalDisplay : 0,
			balance: {
				total: (onchain + ln.local).toString(),
				onchain: onchain.toString(),
				pendingIn: sumRows(rows, entry.key, ['receive'], ['confirming', 'proofs']).toString(),
				pendingOut: sumRows(rows, entry.key, ['send'], ['pending', 'broadcast', 'confirming', 'proofs']).toString(),
				channelLocal: ln.local.toString(),
				lightningSendable: ln.sendable.toString(),
				lightningReceivable: ln.receivable.toString()
			},
			lockedSats: entry.anchors.size * ANCHOR_SATS,
			anchors: entry.anchors.size,
			canReissue: !!(entry.groupKey && groups.get(entry.groupKey)),
			mintedHere,
			supply: {
				issued: supplyKnown ? issued : null,
				burned: sumRows(rows, entry.key, ['burn'], ['proofs', 'complete']).toString(),
				known: supplyKnown && issued != null
			},
			genesis: { outpoint: null, height: null, timestamp: null, ...(reg.point || {}) }
		});
	}
	return out.sort((a, b) => (a.type === b.type ? String(a.name || '').localeCompare(String(b.name || '')) : a.type === 'normal' ? -1 : 1));
}

/**
 * The receives worth a look at the chain. One that has been paid is followed
 * until it is finished, however old it is and however many there are: it is
 * money on its way in. One that has not is looked at while it is younger
 * than `windowMs`, the newest `max` of them.
 */
function activeReceives(records, { now, windowMs, max }) {
	const R = STATES.Receive;
	const newest = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);
	const open = records.filter((r) => r.state < R.Complete);
	const paid = open.filter((r) => r.state >= R.Located).sort(newest);
	const unpaid = open
		.filter((r) => r.state < R.Located && (r.createdAt || 0) >= now - windowMs)
		.sort(newest)
		.slice(0, max);
	return [...paid, ...unpaid];
}

/* ---------------------------------------------------------------- channels */

const CHANNEL_OVER = Object.freeze(['CLOSED', 'FORCE_CLOSED']);

/**
 * A channel's state as the dashboard and the manager read it. `state` is the
 * engine's own word, absent while the engine has no channel yet.
 *
 * Three of the words are the host's. A channel is OPENING until the library
 * has confirmed it, whatever the engine calls it by then: it cannot carry a
 * payment before. And a closed channel is CLOSING, or FORCE_CLOSING, until
 * its assets are back on-chain: until then it is not over, and the manager
 * counts every state but CLOSED and FORCE_CLOSED as a live channel.
 */
function channelWord({ state, confirmed, recovery }) {
	if (!state || state === 'NONE' || state.startsWith('SENT_')) return 'OPENING';
	if (state === 'NORMAL') return confirmed ? 'NORMAL' : 'OPENING';
	if (state === 'CLOSED') return recovery === 'pending' ? 'CLOSING' : 'CLOSED';
	if (state === 'FORCE_CLOSED') return recovery === 'pending' ? 'FORCE_CLOSING' : 'FORCE_CLOSED';
	return state;
}

/** A channel as GET /channels lists it. `c` is one of the host's entries, `reg` what it knows of the asset. */
function channelView(c, reg) {
	return {
		// The engine's id once it has one. Until then the id the open was given.
		channelId: c.channelId || c.id,
		pendingChannelId: c.id,
		peerPubkey: c.peerPubkey,
		peerAlias: c.peerAlias || null,
		state: c.word,
		asset: brief(reg || { assetId: c.assetId, groupKey: c.groupKey, name: null, type: 'normal', decimalDisplay: 0 }),
		capacity: (c.local + c.remote).toString(),
		localBalance: c.local.toString(),
		remoteBalance: c.remote.toString(),
		sendable: c.sendable.toString(),
		receivable: c.receivable.toString(),
		channelSats: c.fundingSats
	};
}

/** Whether a peer's rate is the nominal one, a unit to the sat: no price at all. */
function isNominal(rate) {
	return !!rate && BigInt(rate.coefficient) === NOMINAL_RATE.coefficient * 10n ** BigInt(rate.scale || 0);
}

/**
 * A peer's price as a sentence: "1 coin = 2,500 sats". `rate` is asset
 * units per bitcoin as { coefficient, scale }. Empty for the nominal rate,
 * which is not a price.
 */
function rateText(reg, rate) {
	if (!rate || isNominal(rate) || BigInt(rate.coefficient) <= 0n) return '';
	const decimals = reg && Number.isInteger(reg.decimalDisplay) ? reg.decimalDisplay : 0;
	// Sats for one whole unit, to three decimal places, without a float.
	const thousandths = (100_000_000n * 10n ** BigInt(decimals) * 10n ** BigInt(rate.scale || 0) * 1000n) / BigInt(rate.coefficient);
	const wholes = (thousandths / 1000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	const part = (thousandths % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
	const sats = part ? `${wholes}.${part}` : wholes;
	return `1 ${(reg && reg.name) || 'unit'} = ${sats} ${sats === '1' ? 'sat' : 'sats'}`;
}

/** Millisatoshis as whole sats, rounded up: what an invoice of that many costs to pay. */
const satsOf = (msat) => Number((BigInt(msat) + 999n) / 1000n);

/** The status object, for GET /status, GET /extensions and the status event. */
function statusView({ cfg, phase, error = null, tip = 0, summary = {}, startup = null, proofServer = {}, backup = {}, lightning = {} }) {
	const universe = cfg.defaultUniverse;
	return {
		phase,
		ready: phase === 'ready' || phase === 'degraded',
		error: error || null,
		network: cfg.network,
		hrp: cfg.hrp,
		// `name` says which chain: the network again, or which testnet. Null
		// while a testnet wallet has not found out.
		chain: { name: cfg.tapNetwork || null, height: tip || 0, minConfirmations: cfg.minConfirmations },
		pending: { mints: 0, sends: 0, receives: 0, burns: 0, ...(summary.pending || {}) },
		holdsAssets: !!summary.holdsAssets,
		lockedSats: summary.lockedSats || 0,
		anchorCount: summary.anchorCount || 0,
		startup: startup || null,
		// 'off' for a wallet that was not asked for asset channels, and for
		// one whose engine or library cannot carry them whatever was asked.
		lightning: { mode: lightning.mode === 'full' ? 'full' : 'off', usableChannels: lightning.usableChannels || 0 },
		proofServer: {
			host: universe ? universe.host : null,
			courier: universe ? universe.courier : null,
			rest: universe ? universe.rest : null,
			isDefault: universe ? !!universe.isDefault : true,
			reachable: proofServer.reachable === undefined ? null : proofServer.reachable,
			lastError: proofServer.lastError || null,
			viaTor: !!proofServer.viaTor
		},
		backup: {
			exportedAt: backup.exportedAt || null,
			dirty: !!backup.dirty,
			...(backup.importError ? { importError: backup.importError } : {})
		},
		limits: { ...cfg.limits }
	};
}

module.exports = {
	TERMINAL,
	isTerminal,
	typeName,
	deriveMint,
	deriveTransfer,
	deriveReceive,
	newRow,
	rowView,
	brief,
	isLive,
	heldByAsset,
	assetViews,
	activeReceives,
	CHANNEL_OVER,
	channelWord,
	channelView,
	isNominal,
	rateText,
	satsOf,
	statusView
};
