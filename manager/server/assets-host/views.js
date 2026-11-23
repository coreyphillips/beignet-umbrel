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
		// What is to be known about a row that is neither done nor failed for
		// it: { code, message }, on the rows that have one.
		...(row.notice ? { notice: row.notice } : {}),
		assets: row.assets || [],
		txid: row.txid || null,
		feeSats: row.feeSats,
		satsPerVbyte: row.satsPerVbyte,
		vbytes: row.vbytes,
		anchorSats: row.anchorSats,
		address: row.address || null,
		courier: row.courier || null,
		paymentHash: row.paymentHash || null,
		// A Lightning payment that went in parts: how many went out, and how
		// many its quote was given for where fewer did.
		...(row.parts > 1 ? { parts: row.parts } : {}),
		...(row.planned > (row.parts || 1) ? { planned: row.planned } : {}),
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
function assetViews({ records, registry, groups = new Map(), rows = [], channels = [], limits = null, anchorValues = null }) {
	const byKey = new Map();
	// What each asset has in channels: `channels` are the host's own entries
	// (lightning.js channelList), the ones whose assets have left the chain.
	// A payment is sent over the channels of one peer, in parts when one
	// channel cannot carry it, so what can be sent is what the best peer's
	// channels can send together. An invoice is received through one
	// channel, so what can be received is the most one of them can take,
	// never a sum. `limits` is the library's word on both, by asset: it also
	// knows which peers are there.
	const inChannels = new Map();
	const byPeer = new Map();
	for (const c of channels) {
		if (!c.counted || !c.key) continue;
		const sum = inChannels.get(c.key) || { local: 0n, sendable: 0n, receivable: 0n, assetId: c.assetId, groupKey: c.groupKey || null };
		sum.local += c.local;
		const peer = `${c.key}|${c.peerPubkey}`;
		const out = (byPeer.get(peer) || 0n) + (c.sendable || 0n);
		byPeer.set(peer, out);
		if (out > sum.sendable) sum.sendable = out;
		if (c.receivable > sum.receivable) sum.receivable = c.receivable;
		inChannels.set(c.key, sum);
	}
	if (limits) {
		for (const [key, sum] of inChannels) {
			const limit = limits.get(key) || { maxSend: 0n, maxReceive: 0n };
			if (limit.maxSend < sum.sendable) sum.sendable = limit.maxSend;
			if (limit.maxReceive < sum.receivable) sum.receivable = limit.maxReceive;
		}
	}
	// The inputs of a channel's funding stay in the on-chain records, set
	// aside under the funding's name, until it has confirmed. What of them
	// goes into the channel is counted there, and not here a second time.
	// What they hold beyond that is the funding's change: it stays on-chain.
	const inFunding = new Map();
	for (const c of channels) {
		if (!c.counted || !c.key) continue;
		for (const a of c.assets || []) inFunding.set(`funding:${c.id}|${a.assetId}`, BigInt(a.amount));
	}
	for (const r of records) {
		if (!isLive(r)) continue;
		const reg = registry.get(r.assetId);
		const groupKey = r.groupKey || (reg && reg.groupKey) || null;
		const key = groupKey || r.assetId;
		const entry = byKey.get(key) || { key, groupKey, members: new Map(), anchors: new Set(), sample: r };
		const member = entry.members.get(r.assetId) || 0n;
		let amount = BigInt(r.amount);
		const slot = r.reservedBy ? `${r.reservedBy}|${r.assetId}` : null;
		if (slot && inFunding.has(slot)) {
			const left = inFunding.get(slot);
			const taken = amount < left ? amount : left;
			amount -= taken;
			inFunding.set(slot, left - taken);
		}
		entry.members.set(r.assetId, member + amount);
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
		const largest = [...entry.members.values()].reduce((a, b) => (b > a ? b : a), 0n);
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
				// The most that can go into one new channel: a channel is funded
				// with one issuance, so it is what is held of the largest one.
				channelable: (largest < onchain ? largest : onchain).toString(),
				pendingIn: sumRows(rows, entry.key, ['receive'], ['confirming', 'proofs']).toString(),
				pendingOut: sumRows(rows, entry.key, ['send'], ['pending', 'broadcast', 'confirming', 'proofs']).toString(),
				channelLocal: ln.local.toString(),
				lightningSendable: ln.sendable.toString(),
				lightningReceivable: ln.receivable.toString()
			},
			// The bitcoin on the outputs that hold it, as their proofs say, and
			// the 1,000 sat of an ordinary anchor where that is not read yet.
			lockedSats: [...entry.anchors].reduce((sum, outPoint) => sum + (anchorValues && Number.isFinite(anchorValues.get(outPoint)) ? anchorValues.get(outPoint) : ANCHOR_SATS), 0),
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

// FAILED is an open that came to nothing after it was answered: no channel.
const CHANNEL_OVER = Object.freeze(['CLOSED', 'FORCE_CLOSED', 'FAILED']);
// The engine's states of a channel on its way to being one, past the first
// messages: its funding negotiated or signed, and not yet usable.
const CHANNEL_FUNDING = Object.freeze(['AWAITING_FUNDING_CONFIRMED', 'AWAITING_CHANNEL_READY', 'DUAL_FUNDING_V2', 'AWAITING_TX_SIGNATURES']);
// The words of a channel that is on its way out and not over yet.
const CHANNEL_CLOSING = Object.freeze(['CLOSING', 'FORCE_CLOSING', 'SHUTTING_DOWN', 'NEGOTIATING_CLOSING']);
// The words of a live channel that cannot be closed together with its peer,
// only without it: one the engine gave up.
const CHANNEL_NO_COOPERATIVE = Object.freeze(['ERRORED']);

/**
 * A channel's state as the dashboard and the manager read it. `state` is the
 * engine's own word (its ChannelState), absent while the engine has no
 * channel yet. Every word the engine has, and what is said for it:
 *
 *   none, NONE, SENT_OPEN, SENT_ACCEPT, SENT_FUNDING_CREATED,
 *   SENT_FUNDING_SIGNED, AWAITING_FUNDING_CONFIRMED, AWAITING_CHANNEL_READY,
 *   DUAL_FUNDING_V2, AWAITING_TX_SIGNATURES
 *                          OPENING
 *   NORMAL                 OPENING until the library has confirmed the
 *                          funding, CLOSING once a close is asked for,
 *                          NORMAL otherwise
 *   AWAITING_REESTABLISH   as NORMAL: the word the channel would have with
 *                          its peer there. That the peer is away is said
 *                          beside the word (`peerConnected` on the row), and
 *                          the channel carries nothing meanwhile
 *   SHUTTING_DOWN, NEGOTIATING_CLOSING
 *                          the engine's word: on its way out
 *   CLOSED                 CLOSING until its assets are back on-chain
 *   FORCE_CLOSED           FORCE_CLOSING until its assets are back on-chain
 *   ERRORED                the engine's word, whatever else is said of the
 *                          channel: one the engine gave up. Live, carrying
 *                          nothing, and closed only without its peer
 *   SPLICING               the engine's word: not something an asset channel
 *                          does, so live and carrying nothing
 *   anything else          the word as it is: live, carrying nothing, for
 *                          the dashboard to show as it stands
 *
 * So OPENING, CLOSING, FORCE_CLOSING and MISSING are the host's own words.
 * A channel is OPENING until its funding has confirmed and the library has
 * confirmed it: it cannot carry a payment before. A channel whose close has
 * been asked for is CLOSING from that moment, also while the engine still
 * calls it NORMAL. And a closed channel is CLOSING, or FORCE_CLOSING, until
 * its assets are back on-chain: until then it is not over, and the manager
 * counts every state but those of CHANNEL_OVER as a live channel. Only the
 * library saying the recovery is complete makes it over. No word on it, or
 * a word this host has not met, does not.
 *
 * MISSING is a channel the wallet's records say the node held, signed for,
 * and that the node does not hold, with no close on record: what a restore
 * from a backup leaves. It is no open under way and it carries nothing. It
 * is a live channel all the same, with its last known balance.
 *
 * ERRORED is a channel the node gave up whose funding transaction is on
 * chain: a failed channel, closed without its peer. One the node gave up
 * before its funding was on chain is no failed channel. Nothing is on chain
 * to close, so it is an open under way until the library ends it.
 */
function channelWord({ state, confirmed, recovery, engine, signed }) {
	if (engine === 'missing' && signed) return 'MISSING';
	if (!state || state === 'NONE' || state.startsWith('SENT_') || CHANNEL_FUNDING.includes(state)) return 'OPENING';
	if (state === 'ERRORED' && !confirmed) return 'OPENING';
	if (state === 'NORMAL' || state === 'AWAITING_REESTABLISH') return !confirmed ? 'OPENING' : recovery && recovery !== 'none' ? 'CLOSING' : 'NORMAL';
	if (state === 'CLOSED') return recovery === 'complete' ? 'CLOSED' : 'CLOSING';
	if (state === 'FORCE_CLOSED') return recovery === 'complete' ? 'FORCE_CLOSED' : 'FORCE_CLOSING';
	return state;
}

/**
 * The units a channel holds: what it was funded with, over every issuance.
 * The two balances add up to less while a payment is in flight, since its
 * units are on neither side until it settles or fails, and a channel does
 * not shrink for that. An entry with no funding on record (a channel only
 * the host's notes still know) is the sum of its last balances.
 */
function channelCapacity(c) {
	// An open that failed holds nothing: this is what was asked for.
	if (typeof c.capacity === 'bigint') return c.capacity;
	const funded = (c.assets || []).reduce((sum, a) => sum + BigInt(a.amount || 0), 0n);
	return funded > 0n ? funded : c.local + c.remote;
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
		// Why an open that failed did, as { code, message }. Null for a channel.
		failure: c.failure || null,
		// False while the channel's peer is away, or the two have not yet
		// agreed where the channel stands: it carries nothing meanwhile.
		peerConnected: c.peerConnected !== false,
		asset: brief(reg || { assetId: c.assetId, groupKey: c.groupKey, name: null, type: 'normal', decimalDisplay: 0 }),
		capacity: channelCapacity(c).toString(),
		localBalance: c.local.toString(),
		remoteBalance: c.remote.toString(),
		sendable: c.sendable.toString(),
		receivable: c.receivable.toString(),
		// Where the wallet's node says: how many more payments this side's
		// bitcoin in the channel carries, and the peer's to this wallet. At 0
		// that way carries nothing, and `sendable` or `receivable` reads 0.
		...(Number.isInteger(c.sendablePayments) ? { sendablePayments: c.sendablePayments } : {}),
		...(Number.isInteger(c.receivablePayments) ? { receivablePayments: c.receivablePayments } : {}),
		// While a close waits out the delay of a force close: the block
		// height after which what is in the channel comes back on-chain.
		...(Number.isInteger(c.waitsUntil) ? { recoveryWaitsUntil: c.waitsUntil } : {}),
		channelSats: c.fundingSats,
		// Where the wallet's node says: this wallet's side of the channel's
		// bitcoin, in sats. It is the wallet's, and comes home when the
		// channel closes.
		...(Number.isSafeInteger(c.localSats) && c.localSats >= 0 ? { localSats: c.localSats } : {}),
		// The funding transaction, once there is one. While it has not
		// confirmed, `reclaimable` says its bitcoin can be taken back, which
		// ends the open (POST /channels/reclaim), and `reclaimTxid` names the
		// transaction that was last sent to do so.
		fundingTxid: c.fundingTxid || null,
		reclaimable: !!c.reclaimable,
		reclaimTxid: c.reclaimTxid || null,
		// Only while above zero: how many results of earlier payments on this
		// channel the wallet has not taken in. A payment through it is refused
		// with OUTCOMES_UNDELIVERED until it has.
		...(Number.isInteger(c.undeliveredOutcomes) && c.undeliveredOutcomes > 0 ? { undeliveredOutcomes: c.undeliveredOutcomes } : {})
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
/** `status.lightning.feeCoins` as the dashboard reads it: amounts as strings of sats, or null. */
function feeCoinsView(said) {
	if (!said || typeof said !== 'object') return null;
	const sats = (value) => (/^\d+$/.test(String(value)) ? String(value) : '0');
	const possible = said.possible === true;
	return {
		possible,
		neededSats: sats(said.neededSats),
		largestConfirmedSats: sats(said.largestConfirmedSats),
		ready: Number.isSafeInteger(said.ready) && said.ready >= 0 ? said.ready : 0,
		budgetRemainingSats: sats(said.budgetRemainingSats),
		reason: !possible && typeof said.reason === 'string' ? said.reason : null
	};
}

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
		// How many asset channels are not over, closing ones included, or
		// null while that cannot be said. The manager remembers the last
		// number it was told, for a wallet that is stopped.
		assetChannels: Number.isInteger(summary.liveChannels) ? summary.liveChannels : null,
		lockedSats: summary.lockedSats || 0,
		anchorCount: summary.anchorCount || 0,
		startup: startup || null,
		// 'off' for a wallet that was not asked for asset channels, and for
		// one whose engine or library cannot carry them whatever was asked.
		// `warning` is there only when something of the wallet's channels
		// needs saying: a sentence, as `backup.importError` is. `warnings`
		// is the same said one by one, each with its code. `unavailable` is
		// there when the mode is off for a reason of the node's own, such as
		// its not offering asset channels to its peers: { code, message,
		// reason }, the reason being the node's word for it, or null.
		// `feeCoins` is whether the node could prepare, now, the coin that
		// pays the miner fee of an on-chain claim of an asset channel, and
		// from what: { possible, neededSats, largestConfirmedSats, ready,
		// budgetRemainingSats, reason }, or null when nobody can say.
		lightning: {
			mode: lightning.mode === 'full' ? 'full' : 'off',
			usableChannels: lightning.usableChannels || 0,
			feeCoins: feeCoinsView(lightning.feeCoins),
			...(lightning.unavailable && lightning.mode !== 'full'
				? {
						unavailable: {
							code: String(lightning.unavailable.code),
							message: String(lightning.unavailable.message),
							reason: lightning.unavailable.reason ? String(lightning.unavailable.reason) : null
						}
					}
				: {}),
			...(lightning.warning ? { warning: lightning.warning } : {}),
			...(Array.isArray(lightning.warnings) && lightning.warnings.length ? { warnings: lightning.warnings.map((w) => ({ code: String(w.code), text: String(w.text) })) } : {})
		},
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
	CHANNEL_CLOSING,
	CHANNEL_NO_COOPERATIVE,
	channelWord,
	channelView,
	isNominal,
	rateText,
	satsOf,
	statusView
};
