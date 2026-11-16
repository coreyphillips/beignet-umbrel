'use strict';

/**
 * Asset channels: what the nine Lightning routes do, what the loop does for
 * them, and what the host answers the library's Lightning service.
 *
 * Everything here works against `host.ln`, the facade adapter.js builds over
 * the library (`createLightning`), or a fake of it in tests. A wallet whose
 * engine or library cannot carry asset channels has none: `host.ln` is null,
 * the status says lightning is off, and every route but the channel list
 * refuses with LIGHTNING_UNAVAILABLE.
 *
 * The mode
 *
 *   'full'  the manager asked for asset channels and the wallet can have
 *           them. Everything below is served.
 *   'off'   it did not, or the wallet cannot. Nothing is opened, no invoice
 *           is made or paid, and a channel a peer offers is turned down.
 *           A wallet that already has a channel still lists it, closes it
 *           and brings its assets home: the provider is attached whatever
 *           the mode, because a channel has to stay enforceable.
 *
 * The lock
 *
 *   The library's Lightning service is called back by the node while it
 *   works (a peer's answer arrives, and the open that waits for it goes on
 *   from inside that callback). So nothing of `host.ln` that can reach the
 *   node is ever called with the host's lock held, or inside a storage
 *   transaction: the lock is taken for the host's own rows and let go
 *   before the library is asked for anything.
 *
 * Opening a channel
 *
 *   The peer is connected to and asked whether it takes asset channels, and
 *   the proofs of the assets are put on the proof server, before anything
 *   is written. Then one storage transaction writes the `committed/
 *   funding:<id>` marker, the answer to the request key and the channel's
 *   note, and only then is the library told to open, under an id the host
 *   chose. A crash before that write leaves nothing. A crash after it
 *   leaves a marker the next start opens again under the same id, which the
 *   library takes as the same open and never as a second one. A funding
 *   flow the library holds with no marker was never confirmed by anyone,
 *   and the next start cancels it.
 *
 * Paying an invoice
 *
 *   The price is shown first (a quote), and paying names the quote and the
 *   most of the asset it may take. The answer to the request key and the
 *   activity row are written in one transaction before the library is told
 *   to pay, so the same key never pays twice, also across a restart.
 *
 * Rows
 *
 *   chan/<id>            what the host knows of a channel that the library
 *                        does not: who the user said the peer is, when it
 *                        was asked for, when it was over
 *   committed/funding:<id>  an open the user confirmed
 *   l-quote/<id>         a price given, until it is used or runs out
 *   inv/<paymentHash>    an invoice made, for the list of them
 *   row/ln-send-<hash>   a payment, and row/ln-receive-<hash> an invoice,
 *                        as activity
 */
const crypto = require('crypto');
const { sha256Hex } = require('./store');
const { CHANNEL_SATS, CARRIER_SATS, unhex } = require('./adapter');
const { refusal, isRefusal, mapError, isFenced, plainMessage, codeOf } = require('./errors');
const views = require('./views');
const ops = require('./ops');

// What the peer has to keep on its side of a channel, when neither the
// library nor the engine says: a hundredth of it.
const RESERVE_PERCENT = 1;
// A funding transaction's size, for a quote the wallet could not fund.
const OPEN_VBYTES_GUESS = 300;
// Channels peers have offered and that are not open yet. More are turned down.
const MAX_INBOUND_PENDING = 4;
const ACCEPTED_KEPT_MS = 2 * 60 * 1000;
const INVOICE_SECONDS = 60 * 60;
const MAX_DESCRIPTION = 200;
const MAX_INVOICES_LISTED = 100;
const INVOICE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// A force-closed channel stays in the list this long after its assets are home.
const FORCE_CLOSED_SHOWN_MS = 24 * 60 * 60 * 1000;
const CLOSED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const FAILED_PHASES = ['rejected', 'failed'];

const hexKey = (value) => String(value || '').trim().toLowerCase();
const isId = (text) => typeof text === 'string' && /^[0-9a-f]{8,128}$/.test(text);
const clone = (value) => JSON.parse(JSON.stringify(value));
const isOver = (word) => views.CHANNEL_OVER.includes(word);
const sentence = (text) => `${String(text).replace(/[.\s]+$/, '')}.`;

/* -------------------------------------------------------------------- mode */

/** 'full' when the wallet was asked for asset channels and can have them. Otherwise 'off'. */
const modeOf = (host) => (host.ln && !host.mem.lnError && host.cfg.lightning === 'full' ? 'full' : 'off');

const unavailable = () => refusal('LIGHTNING_UNAVAILABLE', 'This wallet has no Lightning for its assets, so it has no asset channels to use.', 409);
const starting = () => refusal('ASSETS_STARTING', 'Lightning is still starting. Try again in a moment.', 503);

/** The node is there and the opens a restart interrupted are settled. */
function requireStarted(host) {
	if (!host.ln.ready() || !host.mem.lnSettled) throw starting();
}

/** For a route that begins something: asset channels are on. */
function requireFull(host) {
	host.requireUp();
	if (modeOf(host) !== 'full') throw unavailable();
	requireStarted(host);
}

/** For a route that works on a channel there already is: whatever the mode. */
function requireProvider(host) {
	host.requireUp();
	if (!host.ln) throw unavailable();
	if (!host.ln.ready()) throw starting();
}

/* ---------------------------------------------------------------- channels */

/**
 * Every channel of the wallet, as the host reasons about it: the library's
 * list, with the note the host keeps beside each, and the opens the user
 * confirmed that the library has not heard of yet. Empty until the node is
 * there to ask.
 *
 *   id         the id the open was given (the pending channel id)
 *   channelId  the engine's id, once it has one
 *   word       the state the dashboard is told (views.channelWord)
 *   usable     whether it can carry a payment now
 *   over       whether it is closed and its assets are back on-chain
 *   counted    whether its assets are in it, and not on the chain
 */
function channelList(host) {
	const ln = host.ln;
	if (!ln || !ln.ready()) return [];
	const registry = host.registry();
	const keyOf = (assetId, groupKey) => groupKey || (assetId && registry.get(assetId) ? registry.get(assetId).groupKey : null) || assetId || null;
	const notes = new Map(host.rows.list('chan/').map((r) => [r.value.id, r.value]));
	const seen = new Set();
	const out = [];
	for (const c of ln.channels()) {
		seen.add(c.pendingChannelId);
		// An open that came to nothing is not a channel.
		if (!c.state && FAILED_PHASES.includes(c.phase)) continue;
		const note = notes.get(c.pendingChannelId) || {};
		const word = views.channelWord(c);
		const usable = word === 'NORMAL';
		const spare = c.local > c.reserved ? c.local - c.reserved : 0n;
		const assetId = c.assetId || note.assetId || null;
		const groupKey = c.groupKey || note.groupKey || null;
		out.push({
			id: c.pendingChannelId,
			channelId: c.channelId || note.channelId || null,
			peerPubkey: c.peerPubkey,
			peerAlias: note.peerAlias || null,
			initiator: c.initiator,
			assetId,
			groupKey,
			key: keyOf(assetId, groupKey),
			word,
			usable,
			over: isOver(word),
			counted: !!c.state && !isOver(word),
			signed: c.signed,
			phase: c.phase,
			known: true,
			local: c.local,
			remote: c.remote,
			sendable: usable ? spare : 0n,
			receivable: usable ? c.remote : 0n,
			fundingSats: c.fundingSats || note.fundingSats || 0,
			createdAt: note.createdAt || null,
			closedAt: note.closedAt || null
		});
	}
	for (const note of notes.values()) {
		if (seen.has(note.id) || note.closedAt) continue;
		// An open the user confirmed that the library has not heard of yet is
		// on its way. Anything else the library no longer lists was a channel,
		// and is over: it is never taken for an open still to be made.
		const coming = !!note.initiator && !note.channelId;
		out.push({
			id: note.id,
			channelId: note.channelId || null,
			peerPubkey: note.peerPubkey,
			peerAlias: note.peerAlias || null,
			initiator: !!note.initiator,
			assetId: note.assetId,
			groupKey: note.groupKey || null,
			key: note.key,
			word: coming ? 'OPENING' : 'CLOSED',
			usable: false,
			over: !coming,
			counted: false,
			signed: !coming,
			phase: '',
			known: false,
			local: coming ? BigInt(note.amount) : 0n,
			remote: 0n,
			sendable: 0n,
			receivable: 0n,
			fundingSats: note.fundingSats || 0,
			createdAt: note.createdAt || null,
			closedAt: null
		});
	}
	return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** How many channels are not over. A read that fails counts none, and says so nowhere: the status must not throw. */
function channelCount(host) {
	try {
		return channelList(host).filter((c) => !c.over).length;
	} catch (_) {
		return 0;
	}
}

/** The `lightning` part of the status. */
function statusOf(host) {
	let usableChannels = 0;
	try {
		usableChannels = channelList(host).filter((c) => c.usable).length;
	} catch (_) {
		usableChannels = 0;
	}
	return { mode: modeOf(host), usableChannels };
}

function listChannels(host) {
	host.requireUp();
	// A wallet that cannot have an asset channel has none, and says so: the
	// manager counts what this lists before it lets Lightning be taken away.
	if (!host.ln) return { channels: [] };
	// One that might, and cannot be asked yet, must not be read as "none".
	if (!host.ln.ready()) throw starting();
	const now = host.now();
	const shown = (c) => c.word !== 'CLOSED' && !(c.word === 'FORCE_CLOSED' && c.closedAt && now - c.closedAt >= FORCE_CLOSED_SHOWN_MS);
	return {
		channels: channelList(host)
			.filter(shown)
			.map((c) => views.channelView(c, c.key ? host.known(c.key) : null))
	};
}

/**
 * Tell whoever is listening about every channel whose state changed, and
 * note when one is over. Nothing is said the first time a generation looks:
 * that is the state it started with. A route that is about to change a
 * channel looks first, so that its own change is one that is told.
 */
async function noteChannels(host) {
	const { mem, rows } = host;
	const list = channelList(host);
	const before = mem.channelWords;
	const after = new Map();
	let changed = false;
	const tell = (channelId, state, key) => {
		changed = true;
		host.emitEvent('channel', { channelId, state });
		if (key) host.emitEvent('balance', { key });
	};
	for (const c of list) {
		after.set(c.id, { word: c.word, channelId: c.channelId || c.id, key: c.key });
		if (before && (!before.has(c.id) || before.get(c.id).word !== c.word)) tell(c.channelId || c.id, c.word, c.key);
	}
	// An open that was dropped is no channel any more.
	if (before) for (const [id, was] of before) if (!after.has(id) && !isOver(was.word)) tell(was.channelId, 'CLOSED', was.key);
	mem.channelWords = after;
	// The library's own rows changed with it, and they are in the backup.
	if (changed) host.markDirty();
	for (const c of list) {
		const note = rows.get(`chan/${c.id}`);
		const learnt = c.channelId && note && !note.channelId;
		const ended = c.over && !c.closedAt;
		if (!learnt && !ended) continue;
		await host.lock.run(() =>
			rows.tx(() => {
				const current = rows.get(`chan/${c.id}`) || { id: c.id, initiator: c.initiator, peerPubkey: c.peerPubkey, key: c.key, assetId: c.assetId, groupKey: c.groupKey, createdAt: null };
				rows.put(`chan/${c.id}`, { ...current, channelId: c.channelId || current.channelId || null, ...(ended ? { closedAt: host.now() } : {}) });
				// It is over: nothing is left for a restart to carry on.
				if (ended) rows.del(`committed/funding:${c.id}`);
			})
		);
	}
	// The note of a channel long over, once the library has let go of it too.
	const listed = new Set(list.map((c) => c.id));
	const old = host.now() - CLOSED_KEEP_MS;
	for (const { key, value } of rows.list('chan/')) {
		if (value.closedAt && value.closedAt < old && !listed.has(value.id)) await host.lock.run(() => rows.del(key));
	}
}

/* ----------------------------------------------------------------- opening */

function readPeer(peer) {
	const p = peer && typeof peer === 'object' ? peer : {};
	const pubkey = hexKey(p.pubkey);
	if (!/^0[23][0-9a-f]{64}$/.test(pubkey)) {
		throw refusal('INVALID_PARAMS', 'A peer is named by its node public key: 66 characters, starting with 02 or 03.');
	}
	const where = p.host === undefined || p.host === null ? '' : String(p.host).trim();
	if (!where) return { pubkey, host: null, port: null, alias: aliasOf(p) };
	const port = p.port === undefined || p.port === null || p.port === '' ? 9735 : Number(p.port);
	if (where.length > 253 || /[\s/@]/.test(where)) throw refusal('INVALID_PARAMS', 'A peer is reached at a host name or an address, with nothing else around it.');
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw refusal('INVALID_PARAMS', 'A port is a number from 1 to 65535.');
	return { pubkey, host: where, port, alias: aliasOf(p) };
}

const aliasOf = (p) => (typeof p.alias === 'string' && p.alias.trim() ? p.alias.trim().slice(0, 64) : null);

function insufficientAsset(needed, total, free) {
	return refusal(
		'INSUFFICIENT_ASSET_BALANCE',
		total >= needed
			? 'Part of this asset is in a send that has not confirmed yet. Wait for it to confirm, then try again.'
			: 'This wallet does not hold that much of the asset on-chain. Only what is on-chain can go into a new channel.',
		409,
		{ needed: needed.toString(), available: free.toString() }
	);
}

/**
 * What opening a channel with `body.amount` of `body.key` takes: which
 * issuances the units come from, and the bitcoin. Reads, and asks the
 * library what the funding transaction would cost; changes nothing.
 */
async function planOpen(host, body, feeRate) {
	const amount = ops.parseUnits(body.amount);
	const key = hexKey(body.key);
	const registry = host.registry();
	const keyOf = (r) => r.groupKey || (registry.get(r.assetId) || {}).groupKey || r.assetId;
	const mine = (await host.tap.stores.assets.listAssets()).filter((r) => views.isLive(r) && (keyOf(r) === key || r.assetId === key));
	if (!key || mine.length === 0) throw refusal('ASSET_NOT_FOUND', 'This wallet does not hold that asset.', 404);
	const held = views.heldByAsset(mine);
	const reg = host.known(key, held) || { assetId: mine[0].assetId, groupKey: mine[0].groupKey || null, name: mine[0].name || null, type: mine[0].type, decimalDisplay: 0 };
	if (views.typeName(reg.type) === 'collectible') {
		throw refusal('INVALID_PARAMS', 'A collectible cannot go into a channel: a channel holds an amount, and a collectible is one of one.');
	}
	// From the issuance with the most free units down, until the amount is covered.
	const order = [...held.entries()].sort((a, b) => (a[1].free === b[1].free ? 0 : a[1].free > b[1].free ? -1 : 1));
	const assets = [];
	let left = amount;
	for (const [assetId, h] of order) {
		const take = h.free < left ? h.free : left;
		if (take > 0n) assets.push({ assetId, amount: take.toString() });
		left -= take;
		if (left === 0n) break;
	}
	if (left > 0n) {
		const sum = (field) => order.reduce((total, [, h]) => total + h[field], 0n);
		throw insufficientAsset(amount, sum('total'), sum('free'));
	}
	const groupKey = reg.groupKey || null;
	const spendableSats = await host.settledSpendable();
	let quoted = null;
	try {
		quoted = await host.ln.quoteFunding({ assets: assets.map((a) => ({ assetId: a.assetId, amount: BigInt(a.amount) })), groupKey, fundingSats: CHANNEL_SATS, feeRate });
	} catch (err) {
		if (isFenced(err)) throw err;
		// A wallet short of bitcoin is answered with the figures. Anything
		// else the library refuses is the caller's to hear.
		const mapped = mapError(err);
		if (!isRefusal(mapped) || mapped.extensionCode !== 'INSUFFICIENT_BTC') throw mapped;
	}
	const feeSats = quoted ? quoted.feeSats : Math.ceil(OPEN_VBYTES_GUESS * feeRate);
	if (feeSats > host.cfg.limits.maxFeeSats) {
		throw refusal('FEE_TOO_HIGH', `Opening would pay ${feeSats} sats to miners, above the ${host.cfg.limits.maxFeeSats} this wallet allows for an asset transaction.`, 400, {
			feeSats,
			maxFeeSats: host.cfg.limits.maxFeeSats
		});
	}
	const reserve = quoted && Number.isInteger(quoted.reserveSats) && quoted.reserveSats >= 0 ? quoted.reserveSats : Math.ceil((CHANNEL_SATS * RESERVE_PERCENT) / 100);
	const totalSats = CHANNEL_SATS + feeSats;
	return {
		key: reg.groupKey || reg.assetId,
		reg,
		amount,
		assets,
		groupKey,
		channelSats: CHANNEL_SATS,
		// What starts on the peer's side, so that it can pay back: the reserve
		// it has to keep, and the bitcoin two asset payments travel with.
		pushSats: reserve + 2 * CARRIER_SATS,
		feeSats,
		totalSats,
		spendableSats,
		sufficient: !!quoted && spendableSats >= totalSats,
		feeRate
	};
}

async function channelQuote(host, body) {
	requireFull(host);
	const feeRate = await host.feeRate(body.feeRate);
	const plan = await planOpen(host, body, feeRate);
	return {
		channelSats: plan.channelSats,
		pushSats: plan.pushSats,
		feeSats: plan.feeSats,
		totalSats: plan.totalSats,
		spendableSats: plan.spendableSats,
		sufficient: plan.sufficient
	};
}

/**
 * Put the proof of every output of the asset that may go into the channel
 * on the wallet's proof server. The peer checks where the assets came from
 * before it signs anything, and that server is where it asks.
 */
async function publishProvenance(host, plan) {
	const universe = host.cfg.defaultUniverse;
	if (!universe) {
		throw refusal('NO_PROOF_SERVER', 'This wallet has no proof server, and a peer looks an asset up there before it takes it into a channel. Nothing was opened.', 409);
	}
	const ids = new Set(plan.assets.map((a) => a.assetId));
	const records = (await host.tap.stores.assets.listAssets()).filter((r) => views.isLive(r) && !r.reservedBy && ids.has(r.assetId));
	const courier = host.courierFor(universe.courier);
	for (const r of records) {
		try {
			const file = await host.tap.freighter.exportProof(unhex(r.assetId), unhex(r.scriptKey), r.anchorOutPoint);
			await courier.deliverProof({ assetId: r.assetId, scriptKey: r.scriptKey, anchorOutPoint: r.anchorOutPoint }, file);
		} catch (err) {
			if (isFenced(err)) throw err;
			throw refusal(
				'PROOF_SERVER_UNREACHABLE',
				`The proof server did not take the asset's proof, which the peer needs before it opens a channel: ${sentence(plainMessage(err, 'it did not answer'))} Nothing was opened.`,
				502
			);
		}
	}
}

/** What a failed open says, in the dashboard's codes. */
function openFailure(err) {
	const mapped = mapError(err);
	if (isRefusal(mapped)) return mapped;
	return refusal('CHANNEL_OPEN_FAILED', `The channel could not be opened, and nothing was spent: ${sentence(plainMessage(err, 'the peer did not answer'))}`, 502);
}

/** Forget an open that came to nothing: its marker, its note, and the answer to its request key. */
function forgetOpen(host, id) {
	const { rows } = host;
	return host.lock.run(() =>
		rows.tx(() => {
			const note = rows.get(`chan/${id}`);
			rows.del(`committed/funding:${id}`);
			rows.del(`chan/${id}`);
			if (note && note.journal) rows.del(note.journal);
		})
	);
}

/**
 * An open failed. When nothing was signed it is undone, and the refusal to
 * give for it is returned. When the funding transaction was signed it may
 * be on the network: the open is kept and the loop carries it on, and this
 * returns null.
 */
async function undoOpen(host, id, err) {
	// No answer in time is not a no: the flow is the library's to carry on.
	if (codeOf(err) === 'ERR_BEIGNET_LN_TIMEOUT') return null;
	let gone = false;
	try {
		gone = await host.ln.cancelFlow(id);
	} catch (cancelError) {
		if (isFenced(cancelError)) throw cancelError;
		host.say('warn', `assets: a channel open could not be cancelled: ${plainMessage(cancelError)}`);
	}
	if (!gone) return null;
	const failure = openFailure(err);
	await forgetOpen(host, id);
	// Dropped because the user asked: that is not an error to report.
	if (!host.mem.dropping.has(id)) host.emitEvent('error', { code: failure.extensionCode, message: failure.message, channelId: id });
	await noteChannels(host);
	return failure;
}

/**
 * Tell the library to open the channel the note `chan/<id>` describes, with
 * the lock let go. Resolves to { ok } or { error }: `error` is the refusal
 * of an open that failed and was undone, or null for one that failed and is
 * kept. One open per id runs at a time.
 */
function startOpen(host, id, { reconnect = false } = {}) {
	const { mem } = host;
	if (mem.opens.has(id)) return mem.opens.get(id);
	const run = host.lock.outside(async () => {
		try {
			const note = host.rows.get(`chan/${id}`);
			if (!note) return { error: null };
			// After a restart the peer may not be connected yet.
			if (reconnect) await host.ln.connect({ pubkey: note.peerPubkey, host: note.host || undefined, port: note.port || undefined }).catch(() => undefined);
			const opened = await host.ln.openChannel({
				pendingChannelId: id,
				peerPubkey: note.peerPubkey,
				assets: note.assets.map((a) => ({ assetId: a.assetId, amount: BigInt(a.amount) })),
				groupKey: note.groupKey || null,
				decimalDisplay: note.decimalDisplay,
				fundingSats: note.fundingSats,
				pushSats: note.pushSats,
				feeRate: note.feeRate
			});
			await host.lock.run(() => {
				const current = host.rows.get(`chan/${id}`);
				if (current && !current.channelId) host.rows.put(`chan/${id}`, { ...current, channelId: opened.channelId });
			});
			await noteChannels(host);
			host.nudge();
			return { ok: true };
		} catch (err) {
			if (isFenced(err)) {
				host.shutdown();
				return { error: refusal('ASSETS_STOPPING', 'The wallet is restarting. Try again in a moment.', 503) };
			}
			try {
				return { error: await undoOpen(host, id, err) };
			} catch (undoError) {
				if (isFenced(undoError)) host.shutdown();
				return { error: null };
			}
		} finally {
			mem.opens.delete(id);
		}
	});
	mem.opens.set(id, run);
	return run;
}

/** `promise`, or null when it has not settled within `ms`. */
function within(promise, ms) {
	let timer = null;
	const late = new Promise((resolve) => {
		timer = setTimeout(() => resolve(null), Math.max(0, ms));
		if (typeof timer.unref === 'function') timer.unref();
	});
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function openChannel(host, body, key) {
	const route = 'channels/open';
	const first = await host.lock.run(() => {
		const done = ops.replay(host, route, key, body);
		if (done) return done;
		requireFull(host);
		host.requireReady();
		return null;
	});
	if (first) return first;
	if (!host.mem.channelWords) await noteChannels(host);
	const peer = readPeer(body.peer);
	const feeRate = await host.feeRate(body.feeRate);
	const plan = await planOpen(host, body, feeRate);
	if (!plan.sufficient) {
		throw refusal('INSUFFICIENT_BTC', 'This wallet does not have the bitcoin on-chain that opening this channel needs.', 409, {
			needed: plan.totalSats,
			spendable: plan.spendableSats,
			feeSats: plan.feeSats
		});
	}
	// The peer is asked before anything is written or spent.
	try {
		await host.ln.connect({ pubkey: peer.pubkey, host: peer.host || undefined, port: peer.port || undefined });
	} catch (err) {
		if (isFenced(err)) throw err;
		throw refusal('PEER_UNREACHABLE', 'The peer could not be reached, so nothing was opened and nothing was spent. Check its address, and that it is online.', 502);
	}
	if (!host.ln.peerSupports(peer.pubkey)) {
		throw refusal('PEER_NO_ASSET_CHANNELS', 'That peer does not open asset channels, so nothing was opened and nothing was spent.', 409);
	}
	await publishProvenance(host, plan);

	const id = crypto.randomBytes(32).toString('hex');
	const answer = { pendingChannelId: id, phase: 'funding' };
	const again = await host.lock.run(() => {
		const done = ops.replay(host, route, key, body);
		if (done) return done;
		requireFull(host);
		host.requireReady();
		host.rows.tx(() => {
			host.rows.put(`committed/funding:${id}`, { kind: 'funding', at: host.now() });
			ops.journal(host, route, key, body, { answer });
			host.rows.put(`chan/${id}`, {
				id,
				initiator: true,
				peerPubkey: peer.pubkey,
				peerAlias: peer.alias,
				host: peer.host,
				port: peer.port,
				key: plan.key,
				assetId: plan.reg.assetId,
				groupKey: plan.groupKey,
				amount: plan.amount.toString(),
				assets: plan.assets,
				decimalDisplay: Number.isInteger(plan.reg.decimalDisplay) ? plan.reg.decimalDisplay : 0,
				fundingSats: plan.channelSats,
				pushSats: plan.pushSats,
				feeRate,
				journal: key ? ops.journalKey(route, key) : null,
				createdAt: host.now(),
				channelId: null,
				closedAt: null
			});
		});
		return null;
	});
	if (again) return again;
	await noteChannels(host);
	// The open itself, with the lock let go. A peer that says no within a
	// few seconds is this request's answer; a slower open is the loop's.
	const early = await within(startOpen(host, id), host.cfg.openWaitMs);
	if (early && early.error) throw early.error;
	return answer;
}

async function closeChannel(host, body) {
	requireProvider(host);
	const wanted = hexKey(body.channelId);
	const force = !!body.force;
	const c = isId(wanted) ? channelList(host).find((x) => x.id === wanted || x.channelId === wanted) : null;
	if (!c || c.over) throw refusal('CHANNEL_NOT_FOUND', 'This wallet has no asset channel with that id.', 404);
	if (!host.mem.channelWords) await noteChannels(host);
	if (!c.channelId) {
		// Not a channel yet. An open nothing was signed for is dropped.
		let gone = false;
		host.mem.dropping.add(c.id);
		try {
			gone = await host.ln.cancelFlow(c.id);
			if (gone) await forgetOpen(host, c.id);
		} catch (err) {
			if (isFenced(err)) throw err;
			gone = false;
		} finally {
			// The open this cancels fails a moment later, and has to find the mark.
			const done = setTimeout(() => host.mem.dropping.delete(c.id), 5000);
			if (typeof done.unref === 'function') done.unref();
		}
		if (!gone) {
			throw refusal('CHANNEL_OPENING', 'This channel is still being opened, and its funding transaction is already signed. It can be closed once it is on the chain.', 409);
		}
		await noteChannels(host);
		return { channelId: c.id, closing: true, force };
	}
	try {
		await host.ln.closeChannel({ channelId: c.channelId, force });
	} catch (err) {
		if (isFenced(err)) throw err;
		const mapped = mapError(err);
		if (isRefusal(mapped)) throw mapped;
		throw refusal('CHANNEL_CLOSE_FAILED', `The channel could not be closed: ${sentence(plainMessage(err, 'the node refused'))}`, 502);
	}
	await noteChannels(host);
	host.nudge();
	return { channelId: c.channelId, closing: true, force };
}

/* ------------------------------------------------------------------ prices */

function knownAsset(host, wanted) {
	const key = hexKey(wanted);
	const reg = key ? host.known(key) : null;
	if (!reg) throw refusal('ASSET_NOT_FOUND', 'This wallet does not know that asset.', 404);
	return { reg, key: reg.groupKey || reg.assetId };
}

/** The figures of a price, as both quotes and an invoice carry them. */
function priceFields(reg, amountMsat, rate) {
	const priced = !views.isNominal(rate);
	return { amountSats: views.satsOf(amountMsat), rateText: priced ? views.rateText(reg, rate) : '', priced };
}

/** What a Lightning refusal of the library says, with what only the host knows. */
function lightningError(err, details) {
	if (isFenced(err)) return err;
	const mapped = mapError(err, details ? { details } : {});
	if (isRefusal(mapped)) {
		// Only the two that are about a channel's balance carry the figure.
		if (!['INSUFFICIENT_OUTBOUND', 'INSUFFICIENT_INBOUND'].includes(mapped.extensionCode)) delete mapped.details;
		return mapped;
	}
	return mapped;
}

/** Drop the prices that have run out. The caller holds the lock. */
function dropOldQuotes(host) {
	const now = host.now();
	for (const { key, value } of host.rows.list('l-quote/')) if (!value || (value.expiresAt || 0) <= now) host.rows.del(key);
}

/* ---------------------------------------------------------------- invoices */

async function invoiceQuote(host, body) {
	requireFull(host);
	const amount = ops.parseUnits(body.amount);
	const { reg, key } = knownAsset(host, body.key);
	const usable = channelList(host).filter((c) => c.key === key && c.usable);
	// A payment arrives through one channel: the most that can be received
	// is the most any one of them has on the peer's side.
	const best = usable.reduce((top, c) => (!top || c.receivable > top.receivable ? c : top), null);
	const maxReceivable = best ? best.receivable : 0n;
	const short = () => refusal('INSUFFICIENT_INBOUND', 'No asset channel of this wallet can receive that much.', 409, { maxReceivable: maxReceivable.toString() });
	if (amount > maxReceivable) throw short();
	let quoted;
	try {
		quoted = await host.ln.quoteInvoice({ assetId: best.assetId, groupKey: best.groupKey, amount, peerPubkey: best.peerPubkey });
	} catch (err) {
		throw lightningError(err, { maxReceivable: maxReceivable.toString() });
	}
	const price = priceFields(reg, quoted.amountMsat, quoted.unitsPerBtc);
	const quote = {
		kind: 'receive',
		quoteId: quoted.quoteId,
		key,
		amount: amount.toString(),
		peerPubkey: quoted.peerPubkey,
		peerAlias: best.peerAlias || null,
		...price,
		expiresAt: quoted.expiresAt
	};
	await host.lock.run(() => {
		dropOldQuotes(host);
		host.rows.put(`l-quote/${quote.quoteId}`, quote);
	});
	return {
		quoteId: quote.quoteId,
		peerPubkey: quote.peerPubkey,
		peerAlias: quote.peerAlias,
		assetAmount: quote.amount,
		amountSats: quote.amountSats,
		rateText: quote.rateText,
		priced: quote.priced,
		expiresAt: quote.expiresAt,
		maxReceivable: maxReceivable.toString()
	};
}

const quoteExpired = () => refusal('QUOTE_EXPIRED', 'That price has expired. Ask for a new one.', 410);

/** An invoice as the list and the answer that made it give it. */
function invoiceView(host, inv) {
	const deadline = Math.min(...[inv.expiresAt, inv.invoiceExpiresAt].filter((t) => Number.isFinite(t) && t > 0), Infinity);
	return {
		bolt11: inv.bolt11,
		paymentHash: inv.paymentHash,
		assetAmount: inv.assetAmount,
		amountSats: inv.amountSats,
		rateText: inv.rateText,
		priced: inv.priced,
		expiresAt: inv.expiresAt,
		invoiceExpiresAt: inv.invoiceExpiresAt,
		description: inv.description,
		asset: inv.asset,
		status: inv.status === 'PAID' ? 'PAID' : deadline <= host.now() ? 'EXPIRED' : 'OPEN',
		createdAt: inv.createdAt
	};
}

async function createInvoice(host, body) {
	requireFull(host);
	const quoteId = hexKey(body.quoteId);
	const description = body.description === undefined || body.description === null ? '' : String(body.description).trim();
	if (description.length > MAX_DESCRIPTION) throw refusal('INVALID_PARAMS', `A description can be up to ${MAX_DESCRIPTION} characters.`);
	const quote = isId(quoteId) ? host.rows.get(`l-quote/${quoteId}`) : null;
	// A price is for one asset and one amount. Asked to use it for another, it has run out.
	const same =
		!!quote &&
		quote.kind === 'receive' &&
		quote.expiresAt > host.now() &&
		(body.key === undefined || body.key === null || hexKey(body.key) === quote.key) &&
		(body.amount === undefined || body.amount === null || String(body.amount).trim() === quote.amount);
	if (!same) throw quoteExpired();
	const { reg } = knownAsset(host, quote.key);
	let made;
	try {
		made = await host.ln.createInvoice({ quoteId, description, expirySeconds: INVOICE_SECONDS });
	} catch (err) {
		throw lightningError(err);
	}
	const now = host.now();
	const invoice = {
		bolt11: made.bolt11,
		paymentHash: made.paymentHash,
		key: quote.key,
		assetAmount: quote.amount,
		amountSats: quote.amountSats,
		rateText: quote.rateText,
		priced: quote.priced,
		expiresAt: quote.expiresAt,
		invoiceExpiresAt: made.expiresAt,
		description,
		asset: views.brief(reg),
		status: 'OPEN',
		createdAt: now
	};
	const row = views.newRow({
		id: `ln-receive-${made.paymentHash}`,
		kind: 'ln-receive',
		ref: made.paymentHash,
		created: now,
		state: 'waiting',
		assets: [views.brief(reg, quote.amount)],
		paymentHash: made.paymentHash,
		// It can be paid until the price or the invoice runs out, whichever is first.
		expiresAt: Math.min(quote.expiresAt, made.expiresAt)
	});
	await host.lock.run(() =>
		host.rows.tx(() => {
			host.rows.put(`row/${row.id}`, row);
			host.rows.put(`inv/${made.paymentHash}`, invoice);
			host.rows.del(`l-quote/${quoteId}`);
		})
	);
	host.markDirty();
	host.emitRow(row);
	return { ...invoiceView(host, invoice), row: host.view(row) };
}

function listInvoices(host) {
	host.requireUp();
	if (modeOf(host) !== 'full') throw unavailable();
	const all = host.rows
		.list('inv/')
		.map((r) => r.value)
		.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
	return { invoices: all.slice(0, MAX_INVOICES_LISTED).map((inv) => invoiceView(host, inv)) };
}

/** An invoice was paid, or ran out unpaid. */
function recordInvoice(host, rowId, outcome, assetAmount) {
	const { rows } = host;
	return host.lock.run(() => {
		const row = host.getRow(rowId);
		if (!row || row.state !== 'waiting') return null;
		const next = clone(row);
		const now = host.now();
		const inv = rows.get(`inv/${row.paymentHash}`);
		if (outcome === 'paid') {
			next.state = 'complete';
			next.at.completed = now;
			if (assetAmount !== undefined && assetAmount !== null && next.assets[0]) next.assets[0].amount = assetAmount.toString();
		} else {
			next.state = 'failed';
			next.failure = { code: 'INVOICE_EXPIRED', message: 'Nobody paid this invoice before it ran out.' };
		}
		rows.tx(() => {
			rows.put(`row/${rowId}`, next);
			if (inv && outcome === 'paid') rows.put(`inv/${row.paymentHash}`, { ...inv, status: 'PAID', paidAt: now });
		});
		host.markDirty();
		host.emitRow(next);
		if (outcome === 'paid') for (const a of next.assets || []) host.emitEvent('balance', { key: a.key });
		return next;
	});
}

/* ------------------------------------------------------------------ paying */

const quoteChanged = (quote) =>
	refusal('QUOTE_CHANGED', 'The price moved before the payment was made, so nothing was paid.', 409, quote ? { quote } : undefined);

const payQuoteView = (q) => ({
	quoteId: q.quoteId,
	assetAmount: q.assetAmount,
	amountSats: q.amountSats,
	rateText: q.rateText,
	priced: q.priced,
	peerAlias: q.peerAlias,
	expiresAt: q.expiresAt,
	sendable: q.sendable
});

const cleanInvoice = (text) =>
	String(text || '')
		.trim()
		.replace(/^lightning:/i, '');

/** Ask the channel's peer what paying an invoice takes, and keep the answer until it is used or runs out. */
async function makePayQuote(host, body) {
	const bolt11 = cleanInvoice(body.bolt11);
	if (!bolt11) throw refusal('BAD_INVOICE', 'That is not a Lightning invoice this wallet can read.', 400);
	const { reg, key } = knownAsset(host, body.key);
	let amountMsat = null;
	let asked = null;
	if (body.amountSats !== undefined && body.amountSats !== null && body.amountSats !== '') {
		asked = Number(body.amountSats);
		if (!Number.isSafeInteger(asked) || asked <= 0) throw refusal('INVALID_PARAMS', 'The amount to pay must be a whole number of sats above zero.');
		amountMsat = BigInt(asked) * 1000n;
	}
	const usable = channelList(host).filter((c) => c.key === key && c.usable);
	// A payment leaves through one channel: the most that can be paid is
	// the most any one of them can send.
	const most = usable.reduce((top, c) => (c.sendable > top ? c.sendable : top), 0n);
	const short = () => refusal('INSUFFICIENT_OUTBOUND', 'No asset channel of this wallet can send that much.', 409, { sendable: most.toString() });
	if (most === 0n) throw short();
	let quoted;
	try {
		quoted = await host.ln.quotePayment({ bolt11, assetId: reg.assetId, groupKey: reg.groupKey || null, amountMsat });
	} catch (err) {
		throw lightningError(err, { sendable: most.toString() });
	}
	const through = usable.find((c) => c.channelId === quoted.channelId) || null;
	const sendable = through ? through.sendable : most;
	if (quoted.assetAmount > sendable) throw short();
	const quote = {
		kind: 'pay',
		quoteId: quoted.quoteId,
		key,
		invoice: sha256Hex(bolt11),
		paymentHash: quoted.paymentHash,
		assetAmount: quoted.assetAmount.toString(),
		...priceFields(reg, quoted.amountMsat, quoted.unitsPerBtc),
		asked,
		peerPubkey: quoted.peerPubkey,
		peerAlias: through ? through.peerAlias : null,
		channelId: quoted.channelId,
		expiresAt: quoted.expiresAt,
		sendable: sendable.toString()
	};
	await host.lock.run(() => {
		dropOldQuotes(host);
		host.rows.put(`l-quote/${quote.quoteId}`, quote);
	});
	return quote;
}

async function payQuote(host, body) {
	requireFull(host);
	return payQuoteView(await makePayQuote(host, body));
}

/** A payment as `POST /pay` answers it, from its row or the row's view. */
const payAnswer = (row) => ({
	status: row.state === 'complete' ? 'COMPLETED' : row.state === 'failed' ? 'FAILED' : 'PENDING',
	paymentHash: row.paymentHash,
	assetAmount: row.assets && row.assets[0] ? row.assets[0].amount : null,
	feeSats: row.feeSats === undefined ? null : row.feeSats,
	failureDescription: row.failure ? row.failure.message : null
});

/** Why a payment failed, as one plain sentence. */
function payFailure(result, error) {
	if (error) {
		const mapped = mapError(error);
		return { code: isRefusal(mapped) ? mapped.extensionCode : 'PAYMENT_FAILED', message: sentence(plainMessage(mapped, 'The payment could not be sent')) };
	}
	return { code: 'PAYMENT_FAILED', message: sentence(plainMessage({ message: result && result.failure }, 'The payment did not reach its recipient')) };
}

/**
 * Write down how a payment ended, or that it is on its way. `result` is the
 * library's word on it; `error` is what it threw instead.
 */
function recordPayment(host, rowId, result, error) {
	return host.lock.run(() => {
		const row = host.getRow(rowId);
		if (!row || row.state !== 'pending') return row;
		const next = clone(row);
		const now = host.now();
		if (error || (result && result.status === 'failed')) {
			next.state = 'failed';
			next.failure = error && error.failure ? error.failure : payFailure(result, error);
			next.at.completed = now;
		} else if (result && result.status === 'complete') {
			next.state = 'complete';
			next.at.completed = now;
			if (result.assetAmount !== null && result.assetAmount !== undefined && next.assets[0]) next.assets[0].amount = result.assetAmount.toString();
			next.feeSats = result.feeMsat === null || result.feeMsat === undefined ? 0 : views.satsOf(result.feeMsat);
		} else {
			// In the node's hands, and not over.
			next.sent = true;
		}
		if (JSON.stringify(next) === JSON.stringify(row)) return row;
		host.rows.put(`row/${rowId}`, next);
		host.markDirty();
		host.emitRow(next);
		if (next.state !== 'pending') for (const a of next.assets || []) host.emitEvent('balance', { key: a.key });
		return next;
	});
}

/** Look at a payment until it is over or `ms` have passed. */
async function awaitPayment(host, paymentHash, first, ms) {
	let seen = first;
	const deadline = Date.now() + Math.max(0, ms);
	while (seen && seen.status === 'pending' && !host.mem.stopped && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 200));
		seen = host.ln.payment(paymentHash) || seen;
	}
	return seen;
}

async function pay(host, body, key) {
	const route = 'pay';
	const quoteId = hexKey(body.quoteId);
	const bound = body.maxAssetAmount === undefined || body.maxAssetAmount === null || body.maxAssetAmount === '' ? null : ops.parseUnits(body.maxAssetAmount);
	const step = await host.lock.run(() => {
		const done = ops.replay(host, route, key, body);
		if (done) return { done: payAnswer(done.row) };
		requireFull(host);
		const quote = isId(quoteId) ? host.rows.get(`l-quote/${quoteId}`) : null;
		const live =
			!!quote &&
			quote.kind === 'pay' &&
			quote.expiresAt > host.now() &&
			(body.key === undefined || body.key === null || hexKey(body.key) === quote.key) &&
			(!cleanInvoice(body.bolt11) || sha256Hex(cleanInvoice(body.bolt11)) === quote.invoice);
		// The price ran out: a new one is asked for, with the lock let go.
		if (!live) return { stale: quote && quote.kind === 'pay' ? quote : null };
		// The price is past what the user agreed to. It still stands, and is shown.
		if (bound !== null && BigInt(quote.assetAmount) > bound) return { moved: quote };
		const rowId = `ln-send-${quote.paymentHash}`;
		const prev = host.getRow(rowId);
		if (prev && prev.state === 'complete') throw refusal('ALREADY_PAID', 'This wallet has already paid that invoice.', 409);
		if (prev && prev.state !== 'failed') throw refusal('PAYMENT_IN_FLIGHT', 'This wallet is already paying that invoice. Wait for it to finish.', 409);
		const { reg } = knownAsset(host, quote.key);
		const row = views.newRow({
			id: rowId,
			kind: 'ln-send',
			ref: quote.paymentHash,
			created: host.now(),
			assets: [views.brief(reg, quote.assetAmount)],
			paymentHash: quote.paymentHash,
			clientRef: key || null,
			amountSats: quote.amountSats,
			peerPubkey: quote.peerPubkey
		});
		host.rows.tx(() => {
			ops.journal(host, route, key, body, { rowId });
			host.rows.put(`row/${rowId}`, row);
			host.rows.del(`l-quote/${quoteId}`);
		});
		// From here the loop leaves this row to this request, which tells of
		// it once the library has taken the payment or refused it.
		host.mem.paying.add(rowId);
		host.markDirty();
		return { row, quote };
	});
	if (step.done) return step.done;
	if (step.moved) throw quoteChanged(payQuoteView(step.moved));
	if (step.stale !== undefined) {
		const fresh = await makePayQuote(host, {
			bolt11: body.bolt11,
			key: body.key || (step.stale && step.stale.key),
			amountSats: step.stale && step.stale.asked ? step.stale.asked : undefined
		});
		throw quoteChanged(payQuoteView(fresh));
	}
	const { row, quote } = step;
	let result = null;
	let error = null;
	try {
		try {
			result = await host.ln.payInvoice({ quoteId, maxAssetAmount: bound === null ? BigInt(quote.assetAmount) : bound });
			result = await awaitPayment(host, quote.paymentHash, result, host.cfg.payWaitMs);
		} catch (err) {
			if (isFenced(err)) throw err;
			error = err;
		}
		// The peer's price moved between the quote and the payment. Nothing
		// was sent, so nothing is on record, and the new price is shown.
		if (error && ['ERR_BEIGNET_LN_PRICE_BOUND', 'ERR_BEIGNET_LN_QUOTE_EXPIRED'].includes(codeOf(error))) {
			await host.lock.run(() =>
				host.rows.tx(() => {
					host.rows.del(`row/${row.id}`);
					if (key) host.rows.del(ops.journalKey(route, key));
				})
			);
			let fresh = null;
			try {
				fresh = payQuoteView(await makePayQuote(host, { bolt11: body.bolt11, key: quote.key, amountSats: quote.asked || undefined }));
			} catch (again) {
				if (isFenced(again)) throw again;
			}
			throw quoteChanged(fresh);
		}
		return payAnswer(await recordPayment(host, row.id, result, error));
	} finally {
		host.mem.paying.delete(row.id);
	}
}

/* -------------------------------------------------------------------- loop */

/**
 * Settle the payments and invoices whose end the node knows. A payment this
 * process is in the middle of is left to the request that began it.
 */
async function settleRows(host) {
	const ln = host.ln;
	const stored = host.listRows();
	for (const row of stored) {
		if (host.mem.stopped) return;
		if (row.kind !== 'ln-send' || row.state !== 'pending' || host.mem.paying.has(row.id)) continue;
		const seen = ln.payment(row.paymentHash);
		if (seen) {
			if (seen.status !== 'pending' || !row.sent) await recordPayment(host, row.id, seen, null);
			continue;
		}
		// The node has no record of it. One never handed over was stopped by
		// a restart before anything was sent. One that was handed over and is
		// gone cannot be answered for.
		await recordPayment(host, row.id, null, {
			failure: row.sent
				? { code: 'PAYMENT_UNKNOWN', message: 'This wallet no longer has a record of that payment, so it cannot say whether it went through.' }
				: { code: 'PAYMENT_NOT_SENT', message: 'The wallet restarted before this payment was sent. Nothing was paid.' }
		});
	}
	const waiting = stored.filter((r) => r.kind === 'ln-receive' && r.state === 'waiting');
	if (waiting.length === 0) return;
	const known = new Map(ln.invoices().map((i) => [i.paymentHash, i]));
	for (const row of waiting) {
		if (host.mem.stopped) return;
		const inv = known.get(row.paymentHash);
		if (inv && inv.status === 'paid') await recordInvoice(host, row.id, 'paid', inv.assetAmount);
		else if ((inv && inv.status === 'expired') || (row.expiresAt || 0) <= host.now()) await recordInvoice(host, row.id, 'expired');
	}
}

/**
 * Once per generation, before anything is opened: finish what a restart
 * interrupted. A funding flow the library holds that no user confirmed, and
 * that has signed nothing, is cancelled. An open the user did confirm, and
 * that never got as far as a signed funding transaction, is opened again
 * under the same id, or undone when asset channels are off by now.
 */
async function settleFlows(host) {
	const { ln, rows } = host;
	const marks = host.markers();
	const flows = new Map(ln.channels().map((c) => [c.pendingChannelId, c]));
	for (const c of flows.values()) {
		if (host.mem.stopped) return;
		if (!c.initiator || c.signed || c.state || marks.has(`funding:${c.pendingChannelId}`)) continue;
		try {
			await ln.cancelFlow(c.pendingChannelId);
		} catch (err) {
			if (isFenced(err)) throw err;
			host.say('warn', `assets: a channel open nobody confirmed could not be cancelled: ${plainMessage(err)}`);
		}
	}
	for (const name of marks.keys()) {
		if (host.mem.stopped) return;
		if (!name.startsWith('funding:')) continue;
		const id = name.slice('funding:'.length);
		const flow = flows.get(id);
		const note = rows.get(`chan/${id}`);
		if (!note) {
			await host.lock.run(() => rows.del(`committed/${name}`));
			continue;
		}
		// It got as far as a channel once. Whatever became of it since, it is
		// never opened a second time: the loop notes it as over.
		if (note.channelId) continue;
		// Signed, or a channel already: the library carries it on (resume).
		if (flow && (flow.signed || flow.state || flow.phase === 'active')) continue;
		if (flow && FAILED_PHASES.includes(flow.phase)) {
			await undoOpen(host, id, new Error('the peer turned the channel down'));
			continue;
		}
		if (modeOf(host) !== 'full') {
			await undoOpen(host, id, new Error('asset channels are off for this wallet'));
			continue;
		}
		// Not waited for: the loop goes on, and the open reports through its note.
		startOpen(host, id, { reconnect: true });
	}
	host.mem.lnSettled = true;
}

/**
 * The Lightning part of a pass of the loop. Nothing here runs under the
 * host's lock, and each step is one look: the library is told to carry on
 * what it has, and the rows are brought up to what the node says.
 */
async function pass(host) {
	const ln = host.ln;
	if (!ln || host.mem.stopped || host.mem.lnError || !ln.ready()) return;
	const quietly = async (what, run) => {
		try {
			await run();
		} catch (err) {
			if (isFenced(err)) throw err;
			host.say('warn', `assets: ${what}: ${plainMessage(err)}`);
		}
	};
	// What may sign or send a transaction waits for the same start sequence
	// everything else that spends waits for: until the chain is known to be
	// the wallet's, nothing is carried on and nothing is brought back.
	if (host.mem.orphansDone && host.mem.guarded) {
		if (!host.mem.lnSettled) await quietly('interrupted channel opens could not be settled', () => settleFlows(host));
		await quietly('asset channels could not be carried on', () => ln.resume());
		await quietly('the assets of a closed channel could not be brought back', () => ln.resumeRecovery());
	}
	await quietly('a Lightning payment could not be settled', () => settleRows(host));
	await quietly('the asset channels could not be read', () => noteChannels(host));
}

/** Rows that mean nothing any more. The caller holds the lock. */
function prune(host) {
	const now = host.now();
	dropOldQuotes(host);
	for (const { key, value } of host.rows.list('inv/')) {
		const deadline = Math.min(value.expiresAt || 0, value.invoiceExpiresAt || 0);
		if (value.status !== 'PAID' && deadline + INVOICE_KEEP_MS < now) host.rows.del(key);
	}
}

/* -------------------------------------------- what the library asks the host */

/** A proof file from the wallet's proof server, for an asset a peer puts into a channel. */
async function fetchProof(host, locator) {
	const universe = host.cfg.defaultUniverse;
	if (!universe) throw new Error('This wallet has no proof server to ask');
	return host.courierFor(universe.courier).receiveProof(locator);
}

/**
 * Whether to take a channel a peer offers. Only a wallet whose asset
 * channels are on takes one, only a few at a time, and only for an asset
 * its own proof server can show the issuance of: that is also how the
 * wallet comes to know the name of what it is being handed.
 */
async function acceptIncoming(host, proposal) {
	const { mem } = host;
	try {
		if (mem.stopped || modeOf(host) !== 'full' || !host.ln.ready() || !mem.lnSettled) return false;
		const now = host.now();
		for (const [id, at] of mem.accepted) if (now - at > ACCEPTED_KEPT_MS) mem.accepted.delete(id);
		const opening = new Set(
			channelList(host)
				.filter((c) => !c.initiator && c.word === 'OPENING')
				.map((c) => c.id)
		);
		for (const id of mem.accepted.keys()) opening.add(id);
		opening.delete(proposal.pendingChannelId);
		if (opening.size >= MAX_INBOUND_PENDING) return false;
		if (!Array.isArray(proposal.assets) || proposal.assets.length === 0) return false;
		// Counted from here, so offers that arrive together are not all taken.
		mem.accepted.set(proposal.pendingChannelId, now);
		for (const a of proposal.assets) {
			const reg = host.registry().get(a.assetId);
			const known = reg && reg.genesis ? reg : await ops.lookupAndLearn(host, a.assetId);
			if (views.typeName(known.type) === 'collectible') throw new Error('a collectible is not taken into a channel');
		}
		return true;
	} catch (err) {
		mem.accepted.delete(proposal && proposal.pendingChannelId);
		if (isFenced(err)) host.shutdown();
		else host.say('info', `assets: a channel a peer offered was turned down: ${plainMessage(err)}`);
		return false;
	}
}

/** Something happened in the library. The state is read from the node, so this is only a reason to look. */
function onEvent(host, event) {
	if (host.mem.stopped) return;
	if (event && (event.type === 'invoice' || event.type === 'payment')) {
		host.soon(async () => {
			try {
				if (host.ln && host.ln.ready()) await settleRows(host);
			} catch (err) {
				if (isFenced(err)) host.shutdown();
			}
		}, 50);
		return;
	}
	host.nudge();
}

/** What `host.ln.start` is given. Each callback begins outside the lock, whoever calls it. */
function startOptions(host) {
	const outside = (fn) => (...args) => host.lock.outside(() => fn(host, ...args));
	return {
		adapter: host.tap,
		lib: host.lib,
		quiet: host.cfg.lightning !== 'full',
		fetchProof: outside(fetchProof),
		acceptIncoming: outside(acceptIncoming),
		onEvent: outside(onEvent)
	};
}

module.exports = {
	modeOf,
	channelList,
	channelCount,
	statusOf,
	listChannels,
	channelQuote,
	openChannel,
	closeChannel,
	invoiceQuote,
	createInvoice,
	listInvoices,
	payQuote,
	pay,
	pass,
	prune,
	settleFlows,
	settleRows,
	noteChannels,
	startOptions,
	acceptIncoming,
	fetchProof,
	onEvent,
	MAX_INBOUND_PENDING,
	FORCE_CLOSED_SHOWN_MS
};
