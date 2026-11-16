'use strict';

/**
 * The assets host of one wallet: its state, its start sequence and the loop
 * that moves confirmed work forward.
 *
 * What protects funds, in one place:
 *
 *   Nothing is advanced past its fee preview unless the host holds a
 *   `committed/<id>` row for it, written before the advance. The loop steps
 *   exactly those batches and parcels, one by id, and never asks the library
 *   to resume everything it has.
 *
 *   At start, every batch and parcel without that row and short of its
 *   broadcast is cancelled, every live asset output is protected from the
 *   bitcoin wallet's coin selection again, and the library reconciles its
 *   records with the chain. Until that has happened, no route that spends
 *   is served.
 *
 *   One lock (store.createHostLock) serialises every route that changes
 *   something and every step of the loop. A step is one batch, one parcel or
 *   one address, and a chain wait inside it is a single look, so a route
 *   never waits for a block.
 *
 *   Asset channels (lightning.js) follow the first rule with a marker of
 *   their own, and turn the last one around: the library's Lightning
 *   service is called back by the node, so nothing of it is ever called
 *   while the lock is held.
 *
 * Storage is the node's database through the extension's view. When the node
 * is rebuilt that view is closed and every call throws: the loop takes it as
 * the signal to stop, quietly, and the next generation starts from the rows.
 */
const fs = require('fs');
const { hostRows, createHostLock, sha256Hex } = require('./store');
const { STATES, ANCHOR_SATS, TAP_KEY_FAMILY, hex, unhex } = require('./adapter');
const { restFor, parseCourier } = require('./config');
const { refusal, isFenced, isNotYet, isCourierTrouble, isProofMissing, isProofInvalid, plainMessage, codeOf } = require('./errors');
const views = require('./views');
const backup = require('./backup');

// lightning.js needs ops.js, which needs this file: it is asked for when it
// is used, by which time all three have loaded.
const lightning = () => require('./lightning');

const QUOTE_ID = 'host-quote';
const JOURNAL_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_MS = 24 * 60 * 60 * 1000;
const EXPORT_GAP_MS = 60_000;
const EXPORT_DEBOUNCE_MS = 2_000;
const BACKSTOP_MS = 60_000;
const REACH_TTL_MS = 60_000;
const PUBLISH_WAIT_MS = 30_000;
const PUBLISH_WAIT_MAX_MS = 60 * 60 * 1000;
// A step that keeps failing on a proof server is tried again less and less
// often, however often the chain moves: after 15 seconds, then twice as long
// each time, up to a limit that depends on what is wrong. A receive waiting
// for its proof is asked about most often, a server that answered "no" least.
// Anything else that fails (the chain, a broadcast) is tried on every pass.
const STEP_WAIT_MS = 15_000;
const STEP_WAIT_MAX_MS = { receive: 2 * 60 * 1000, refused: 60 * 60 * 1000, other: 5 * 60 * 1000 };
const SERVER_TROUBLE = new Set(['PROOF_REFUSED', 'COURIER_UNREACHABLE', 'PROOF_UNAVAILABLE', 'UNKNOWN_COURIER']);

const EVENT_OF = { mint: 'mint', send: 'transfer', burn: 'transfer', receive: 'receive', 'ln-send': 'payment', 'ln-receive': 'invoice' };
const receiveRowId = (encoded) => `recv-${sha256Hex(encoded).slice(0, 32)}`;
const handedKey = (l) => `handed/${sha256Hex(JSON.stringify([l.assetId, l.scriptKey, l.anchorOutPoint])).slice(0, 40)}`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const transport = (err) => ['PROOF_SERVER_UNREACHABLE', 'PROOF_SERVER_TIMEOUT', 'TOR_UNAVAILABLE'].includes(codeOf(err));

/**
 * A proof server that answered, and whose answer was no. A gateway in front
 * of it saying it is down or slow (502, 503, 504) is not the server's answer.
 */
function answeredNo(err) {
	const status = Number(err && err.status);
	return codeOf(err) === 'ERR_COURIER_HTTP' && status >= 400 && ![502, 503, 504].includes(status);
}

/** The server's own reason for a refusal, without the keys it wraps it in. */
function serverReason(err) {
	const text = plainMessage(err, '')
		.replace(/^Courier returned HTTP \d+:?\s*/i, '')
		.replace(/\s+/g, ' ')
		.trim();
	const last = text.split(/\):\s+/).pop().trim() || text;
	const reason = last.length > 160 ? `${last.slice(0, 157)}...` : last;
	return reason ? `${reason} (HTTP ${err.status})` : `HTTP ${err.status}`;
}

/** What a row says while a step keeps failing and is tried again. */
function stepFailure(err, kind) {
	const code = codeOf(err);
	if (code === 'ERR_COURIER_ENDPOINT' || code === 'ERR_COURIER_UNSUPPORTED') {
		return { code: 'UNKNOWN_COURIER', message: 'The proof server this names is not one this wallet knows how to reach', retrying: true };
	}
	if (kind === 'receive' && isProofMissing(err)) {
		return { code: 'PROOF_UNAVAILABLE', message: 'The proof server does not have the proof yet', retrying: true };
	}
	if (kind !== 'receive' && answeredNo(err)) {
		// Not the same as a server that is down: waiting will not change its mind.
		return { code: 'PROOF_REFUSED', message: `The proof server did not take the proof: ${serverReason(err)}`, retrying: true };
	}
	if (isCourierTrouble(err)) {
		return {
			code: kind === 'receive' ? 'PROOF_UNAVAILABLE' : 'COURIER_UNREACHABLE',
			message: plainMessage(err, 'The proof server is not answering'),
			retrying: true
		};
	}
	return { code: 'RETRYING', message: plainMessage(err), retrying: true };
}

/**
 * Build the host. `tap` (the adapter) is set by the caller once it exists:
 * it needs `host.courierFor`, `host.proofPublisher` and `host.lock.flowLock`.
 * `ln` is the wallet's asset channels (adapter.js createLightning), or null
 * for a wallet that cannot have any; the caller starts it with
 * `host.startLightning()` once `tap` is set.
 * `timers: false` is for tests, which drive `startup()` and `pass()` by hand.
 */
function createHost({ cfg, storage, wallet, lib, net, emit, logger, tap = null, ln = null, chainCheck = null, now = () => Date.now(), timers = true }) {
	const rows = hostRows(storage);
	const lock = createHostLock();
	const mem = {
		firstPass: false,
		// When this host last saw a transaction of its own go out, by the
		// machine's clock. See settledSpendable.
		sentAt: 0,
		// The receive rows the loop looked at on its last pass; null before one.
		watched: null,
		guarded: false,
		guardError: null,
		startError: null,
		orphansDone: false,
		stopped: false,
		startup: { done: 0, total: 4 },
		proofServer: { reachable: null, lastError: null, viaTor: false },
		summary: {},
		backupState: {},
		failures: new Map(),
		// When each failing step may be tried again: rowId -> { tries, at, wait, said }.
		retries: new Map(),
		couriers: new Map(),
		reach: new Map(),
		unlearnable: new Set(),
		statusKey: null,
		lastTip: 0,
		passing: false,
		again: false,
		wantBlock: false,
		fingerprint: null,
		importError: null,
		lastExportAt: 0,
		lockedKey: null,
		lockedSats: 0,
		ticks: 0,
		// Asset channels (lightning.js). Why the service did not start, when it
		// did not; whether the opens a restart interrupted have been settled;
		// the opens and payments this process is in the middle of; the inbound
		// channels it said yes to; and each channel's state as last told.
		lnError: null,
		lnSettled: false,
		opens: new Map(),
		paying: new Set(),
		accepted: new Map(),
		dropping: new Set(),
		// The closed channels whose assets could not be brought back at the
		// last look, with since when.
		recovery: new Map(),
		// What the library said where nobody was waiting, and when: text -> time.
		lnSaid: new Map(),
		// The ended opens the library was asked to take off its list.
		forgetAsked: new Set(),
		// Whether what channel fundings left set aside has been settled:
		// null before it was asked, then 'kept' or 'done'.
		lnReservations: null,
		channelWords: null
	};
	const handles = { pass: null, tip: null, backstop: null, preview: null, export: null };
	// chainCheck is set when the wallet's Electrum server has not yet said it
	// is on cfg's chain (chain.js). Until it passes, nothing is checked
	// against the chain and nothing spends.
	const host = { cfg, storage, wallet, lib, net, rows, lock, mem, tap, ln, chainCheck, now };

	/**
	 * A timer that owes nothing to the section it was started in. Started
	 * the plain way from inside one, its callback would count as holding the
	 * lock for as long as that section ran, and would not wait.
	 */
	const later = (fn, delay) => {
		const handle = lock.outside(() => setTimeout(fn, delay));
		handle.unref();
		return handle;
	};

	/**
	 * Run `fn` shortly, owing nothing to whoever asked. A host that is driven
	 * by hand (tests) schedules nothing: its next pass does the same work.
	 */
	host.soon = (fn, delay) => {
		if (!timers || mem.stopped) return;
		later(fn, delay);
	};

	const say = (level, message) => {
		try {
			if (logger && typeof logger[level] === 'function') logger[level](message);
		} catch (_) {
			/* a logger that throws is not a reason to stop */
		}
	};
	host.say = say;

	host.emitEvent = (name, data) => {
		if (mem.stopped) return;
		try {
			emit(name, data);
		} catch (_) {
			/* the stream is the daemon's; a failed publish loses one event */
		}
	};

	/** The chain tip the wallet itself last saw. Costs nothing; 0 when not known yet. */
	host.tip = () => {
		try {
			const h = Number(wallet && wallet.data && wallet.data.header && wallet.data.header.height);
			return Number.isFinite(h) && h > 0 ? h : 0;
		} catch (_) {
			return 0;
		}
	};

	host.spendable = () => {
		try {
			const b = wallet.getBalanceBreakdown();
			return Math.max(0, Number(b && b.spendable) || 0);
		} catch (_) {
			return 0;
		}
	};

	/**
	 * The wallet's spendable bitcoin, once it has caught up with a transaction
	 * of its own. For a moment after the wallet sends one it counts no coins
	 * at all: the ones it spent are gone and its change is not in yet. A mint
	 * or a send asked for in that moment would be told the wallet is empty,
	 * so this waits, briefly, for the count to come back. A wallet that
	 * really is empty answers at once unless it has just sent something.
	 */
	host.settledSpendable = async () => {
		let sats = host.spendable();
		const deadline = Date.now() + cfg.settleWaitMs;
		while (sats === 0 && !mem.stopped && mem.sentAt && Date.now() - mem.sentAt < cfg.settleWindowMs && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 200));
			sats = host.spendable();
		}
		return sats;
	};

	/** The fee rate of a request, or the wallet's own estimate when it gives none. */
	host.feeRate = async (value) => {
		if (value !== undefined && value !== null && value !== '') {
			const n = Number(value);
			if (!Number.isFinite(n) || n <= 0) throw refusal('INVALID_PARAMS', 'The fee rate must be a number of sats per vbyte above zero.');
			if (n > cfg.limits.maxFeeRate) {
				throw refusal('FEE_TOO_HIGH', `That fee rate is above the ${cfg.limits.maxFeeRate} sat/vB this wallet allows for an asset transaction.`, 400, {
					maxFeeRate: cfg.limits.maxFeeRate
				});
			}
			return n;
		}
		try {
			const est = await wallet.getFeeEstimates();
			const v = est && est.value ? est.value : est;
			const n = Number(v && v.normal);
			if (Number.isFinite(n) && n > 0) return Math.min(n, cfg.limits.maxFeeRate);
		} catch (_) {
			/* fall through to the refusal */
		}
		throw refusal('INVALID_PARAMS', 'A fee rate is needed, and the wallet could not estimate one.');
	};

	host.requireUp = () => {
		if (mem.stopped) throw refusal('ASSETS_STOPPING', 'The wallet is restarting. Try again in a moment.', 503);
	};
	/** Refuse anything that spends until the start sequence has protected what the wallet holds. */
	host.requireReady = () => {
		host.requireUp();
		if (!mem.orphansDone || !mem.guarded) {
			const why = mem.startError || mem.guardError;
			throw refusal('ASSETS_STARTING', why ? `Assets are still starting (${why}). Try again in a moment.` : 'Assets are still starting. Try again in a moment.', 503);
		}
	};

	/* ---------------------------------------------------------------- rows */

	host.getRow = (id) => rows.get(`row/${id}`);
	host.listRows = () => rows.list('row/').map((r) => r.value);
	host.view = (row) => views.rowView(row, { tip: host.tip(), cfg, now: now(), watched: mem.watched });
	host.receiveRowId = receiveRowId;
	host.markers = () => new Map(rows.list('committed/').map((r) => [r.key.slice('committed/'.length), r.value]));
	host.findRow = (id) => {
		const text = String(id || '');
		const row = /^[a-z]+(-[a-z]+)?-[0-9a-f]{8,128}$/.test(text) ? host.getRow(text) : null;
		if (!row) throw refusal('NOT_FOUND', 'Nothing with that id is known to this wallet.', 404);
		return row;
	};

	host.emitRow = (row) => host.emitEvent(EVENT_OF[row.kind] || 'transfer', { row: host.view(row) });

	/** Store a row if it changed, and tell whoever is listening. */
	function commitRow(prev, row) {
		if (prev && same(prev, row)) return false;
		rows.put(`row/${row.id}`, row);
		const moved = !prev || prev.state !== row.state;
		if (moved || prev.txid !== row.txid) host.markDirty();
		host.emitRow(row);
		if (prev && row.kind !== 'burn' && (prev.at.proof !== row.at.proof || !same(prev.failure, row.failure))) {
			host.emitEvent('proof-delivery', { row: host.view(row) });
		}
		if (moved && ['proofs', 'complete', 'failed'].includes(row.state)) {
			for (const a of row.assets || []) host.emitEvent('balance', { key: a.key });
		}
		return true;
	}

	const confOf = (row) => {
		const tip = host.tip();
		return row.blockHeight && tip >= row.blockHeight ? tip - row.blockHeight + 1 : 0;
	};

	/** Fill in what follows from a row's state: its times, its depth, its failure. */
	function settle(row, failure) {
		const t = now();
		const conf = confOf(row);
		row.conf = Math.min(conf, cfg.minConfirmations);
		if (row.kind !== 'receive' && !['pending', 'failed'].includes(row.state) && !row.at.broadcast) {
			row.at.broadcast = t;
			mem.sentAt = Date.now();
		}
		if (row.at.broadcast && row.seenHeight == null) row.seenHeight = host.tip();
		if ((conf >= 1 || ['confirming', 'proofs', 'complete'].includes(row.state)) && !row.at.confirmed) row.at.confirmed = t;
		if (row.state === 'complete') {
			row.at.proof = row.at.proof || t;
			row.at.completed = row.at.completed || t;
		}
		row.failure = failure || null;
	}

	const feeFields = (fee) => (fee ? { feeSats: fee.sats, vbytes: fee.vbytes } : {});

	/* ------------------------------------------------------------ registry */

	/** What the host has learnt of each asset, by asset ID. */
	host.registry = () => new Map(rows.list('asset/').map((r) => [r.value.assetId, r.value]));

	host.learn = (info) => {
		const prev = rows.get(`asset/${info.assetId}`) || {};
		const next = { ...prev };
		for (const [k, v] of Object.entries(info)) if (v !== undefined) next[k] = v;
		next.mintedHere = !!(prev.mintedHere || info.mintedHere);
		next.supplyKnown = !!(prev.supplyKnown || info.supplyKnown);
		if (prev.point || info.point) next.point = { outpoint: null, height: null, timestamp: null, ...(prev.point || {}), ...(info.point || {}) };
		if (!same(prev, next)) rows.put(`asset/${info.assetId}`, next);
		return next;
	};

	/** Record an asset from its verified issuance (the library's lookupAsset answer). */
	host.learnIssuance = (iss, extra = {}) => {
		const facts = iss.proofFile ? lib.fileFacts(iss.proofFile) : { timestamp: null };
		return host.learn({
			assetId: hex(iss.assetId),
			groupKey: iss.groupKey ? hex(iss.groupKey) : null,
			name: iss.name,
			type: views.typeName(iss.type),
			decimalDisplay: Number.isInteger(iss.decimalDisplay) ? iss.decimalDisplay : 0,
			genesis: lib.encodeGenesis(iss.genesis),
			issued: String(iss.issued),
			point: { outpoint: iss.anchorOutPoint || null, height: iss.blockHeight || null, timestamp: facts.timestamp },
			meta: lib.metaView(iss.meta),
			...extra
		});
	};

	/** The registry entry for an asset ID or a group key. Of a group, the issuance held most. */
	host.known = (wanted, held) => {
		const all = [...host.registry().values()];
		const direct = all.find((r) => r.assetId === wanted);
		if (direct) return direct;
		const family = all.filter((r) => r.groupKey && r.groupKey === wanted);
		if (!family.length) return null;
		const of = (r) => (held && held.get(r.assetId) ? held.get(r.assetId).total : 0n);
		family.sort((a, b) => (of(a) === of(b) ? 0 : of(a) > of(b) ? -1 : 1));
		return family[0];
	};

	/** Every asset held, as the dashboard reads them. */
	host.assets = async () => {
		const records = await host.tap.stores.assets.listAssets();
		let groups = new Map();
		try {
			groups = new Map((await host.tap.minter.listGroups()).map((g) => [g.groupKey, !!g.canIssue]));
		} catch (err) {
			if (isFenced(err)) throw err;
		}
		return views.assetViews({
			records,
			registry: host.registry(),
			groups,
			rows: host.listRows(),
			channels: lightning().channelList(host),
			limits: lightning().paymentLimits(host)
		});
	};

	/* ------------------------------------------------------- proof servers */

	/*
	 * A proof file the sender handed to the person receiving (ops.importProof)
	 * is kept in a row until its receive is complete. The library asks its
	 * courier for the proof of a payment it has found on the chain; the
	 * courier it is given answers from these rows before it asks a server.
	 * So a file is checked by the same code, against the same chain and the
	 * same address, as a proof a server hands over, and nothing that came
	 * from a file is believed before that.
	 */
	host.handed = (locator) => (locator && locator.anchorOutPoint ? rows.get(handedKey(locator)) : null);
	host.keepHanded = (locator, fileHex, address) => rows.put(handedKey(locator), { locator: { ...locator }, file: fileHex, address, at: now() });
	host.dropHanded = (locator) => {
		if (!host.handed(locator)) return false;
		rows.del(handedKey(locator));
		return true;
	};

	const handedFirst = (courier) =>
		new Proxy(courier, {
			get(target, prop) {
				if (prop === 'receiveProof') {
					return async (locator) => {
						const handed = host.handed(locator);
						return handed ? Buffer.from(handed.file, 'hex') : target.receiveProof(locator);
					};
				}
				const value = target[prop];
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});

	host.courierFor = (uri) => {
		const key = String(uri);
		if (!mem.couriers.has(key)) {
			mem.couriers.set(
				key,
				handedFirst(
					lib.makeCourier(key, {
						fetch: net.courierFetch,
						resolveEndpoint: (u, hostPort) => restFor(cfg, String(u || key)) || restFor(cfg, String(hostPort || '')) || undefined
					})
				)
			);
		}
		return mem.couriers.get(key);
	};

	// The minter hands each issuance proof here when a mint is final. Sending
	// it is the loop's job, so a proof server that is down never holds a mint.
	host.proofPublisher = {
		async deliverProof(locator) {
			const id = sha256Hex(JSON.stringify([locator.assetId, locator.scriptKey, locator.anchorOutPoint])).slice(0, 40);
			rows.put(`publish/${id}`, { locator: { ...locator }, at: now(), tries: 0, lastError: null });
		}
	};

	async function publishPending({ force = false } = {}) {
		for (const { key, value } of rows.list('publish/')) {
			if (mem.stopped) return;
			// A server that refuses is asked again less and less often.
			const wait = Math.min(PUBLISH_WAIT_MAX_MS, PUBLISH_WAIT_MS * 2 ** Math.min(value.tries || 0, 8));
			if (!force && value.triedAt && now() - value.triedAt < wait) continue;
			const l = value.locator;
			let file = null;
			let error = null;
			try {
				file = await host.tap.minter.exportProof(unhex(l.assetId), unhex(l.scriptKey), l.anchorOutPoint);
			} catch (err) {
				if (isFenced(err)) throw err;
				// A proof this wallet no longer has cannot be published by it.
				await lock.run(() => rows.del(key));
				continue;
			}
			try {
				if (!cfg.defaultUniverse) throw new Error('This wallet has no proof server to publish to');
				await host.courierFor(cfg.defaultUniverse.courier).deliverProof(l, file);
			} catch (err) {
				if (isFenced(err)) throw err;
				error = err;
			}
			await lock.run(() => {
				if (!error) {
					rows.del(key);
					mem.proofServer = { ...mem.proofServer, reachable: true, lastError: null };
					return;
				}
				const message = plainMessage(error, 'The proof server did not take the proof');
				rows.put(key, {
					...value,
					tries: (value.tries || 0) + 1,
					triedAt: now(),
					lastError: message,
					code: transport(error) ? 'COURIER_UNREACHABLE' : 'PROOF_REFUSED'
				});
				mem.proofServer = { ...mem.proofServer, lastError: message, ...(transport(error) ? { reachable: false } : {}) };
			});
		}
	}
	host.publishPending = publishPending;

	/** Whether the proof server a courier address names answers. Remembered for a minute. */
	host.reachable = async (uri) => {
		const rest = restFor(cfg, uri);
		if (!rest) return null;
		const hit = mem.reach.get(rest);
		if (hit && now() - hit.at < REACH_TTL_MS) return hit.ok;
		const r = await net.test(rest, { timeoutMs: 6000 });
		mem.reach.set(rest, { at: now(), ok: r.reachable });
		if (cfg.defaultUniverse && rest === cfg.defaultUniverse.rest) {
			mem.proofServer = { ...mem.proofServer, reachable: r.reachable, lastError: r.reachable ? mem.proofServer.lastError : r.error };
			host.emitStatus();
		}
		return r.reachable;
	};

	async function checkProofServer() {
		if (!cfg.defaultUniverse || mem.stopped) return;
		try {
			const rest = cfg.defaultUniverse.rest;
			const r = await net.test(rest);
			if (mem.stopped) return;
			mem.reach.set(rest, { at: now(), ok: r.reachable });
			if (r.reachable && mem.proofServer.reachable === false) {
				// Back again: what waited on it is tried now, not when its wait ends.
				for (const [rowId, failure] of mem.failures) if (failure.code === 'COURIER_UNREACHABLE') mem.retries.delete(rowId);
			}
			const waiting = rows.list('publish/').find((p) => p.value.lastError);
			mem.proofServer = {
				reachable: r.reachable,
				lastError: r.reachable ? (waiting ? waiting.value.lastError : null) : r.error,
				viaTor: net.viaTor(rest)
			};
			host.emitStatus();
		} catch (err) {
			if (isFenced(err)) shutdown();
		}
	}
	host.checkProofServer = checkProofServer;

	/* ----------------------------------------------------------- the chain */

	/** The height a transaction confirmed at, or null. One look at the chain. */
	host.chainHeight = async (txid) => {
		try {
			return await host.tap.chain.txBlockHeight(Buffer.from(txid, 'hex').reverse());
		} catch (err) {
			if (isFenced(err)) throw err;
			return null;
		}
	};

	/* --------------------------------------------------------------- steps */

	/**
	 * Run one step of a row. A step a proof server failed is left alone until
	 * its wait is over (see STEP_WAIT_MS), unless `force` says someone asked
	 * for it now.
	 */
	async function step(rowId, kind, run, { force = false } = {}) {
		const held = mem.retries.get(rowId);
		if (!force && held && now() - held.at < held.wait) return;
		try {
			await run();
			mem.failures.delete(rowId);
			mem.retries.delete(rowId);
		} catch (err) {
			if (isFenced(err)) throw err;
			if (isNotYet(err)) {
				mem.failures.delete(rowId);
				mem.retries.delete(rowId);
				return;
			}
			const failure = stepFailure(err, kind);
			const tries = (held ? held.tries : 0) + 1;
			const limit = STEP_WAIT_MAX_MS[failure.code === 'PROOF_REFUSED' ? 'refused' : kind === 'receive' ? 'receive' : 'other'];
			const wait = SERVER_TROUBLE.has(failure.code) ? Math.min(limit, STEP_WAIT_MS * 2 ** Math.min(tries - 1, 12)) : 0;
			mem.failures.set(rowId, failure);
			mem.retries.set(rowId, { tries, at: now(), wait, said: failure.message });
			// Said when it starts and when the reason changes, not on every try.
			if (!held || held.said !== failure.message) say('warn', `assets: ${rowId} did not move on: ${plainMessage(err)}`);
		}
	}

	/** Move one confirmed mint on as far as the chain lets it. */
	host.stepBatch = (id, opts) => step(`mint-${id}`, 'mint', () => host.tap.minter.advance(id), opts);
	/** Move one confirmed send or burn on. */
	host.stepParcel = (id, kind, opts) => step(`${kind}-${id}`, kind, () => host.tap.freighter.advance(id), opts);

	/** Look for one address's payment, and fetch its proof once it is deep enough. */
	host.stepReceive = async (encoded, { force = false } = {}) => {
		const R = STATES.Receive;
		const record = await host.tap.stores.receives.getReceive(encoded);
		if (!record) return;
		if (record.state >= R.Complete) {
			host.dropHanded(record.locator);
			return;
		}
		const rowId = receiveRowId(encoded);
		if (!force && record.state === R.Located && record.locator && record.locator.anchorOutPoint) {
			// The proof is asked for once the transaction is deep enough, not on
			// every pass before that.
			const height = await host.chainHeight(record.locator.anchorOutPoint.split(':')[0]);
			const tip = host.tip();
			if (!height || !tip || tip - height + 1 < cfg.minConfirmations) return;
		}
		await step(
			rowId,
			'receive',
			async () => {
				try {
					await host.tap.freighter.receive(lib.decodeAddress(encoded).raw);
				} catch (err) {
					// A file that does not verify is not kept, or the proof server
					// would never be asked again for the real one.
					if (isProofInvalid(err) && host.dropHanded(record.locator)) {
						say('warn', `assets: the proof file imported for ${rowId} did not verify and was dropped: ${plainMessage(err)}`);
					}
					throw err;
				}
			},
			{ force }
		);
		const after = await host.tap.stores.receives.getReceive(encoded);
		if (after && after.state >= R.Complete) host.dropHanded(after.locator);
		// Trouble before anything was seen on-chain is not the sender's news,
		// and no reason to look for the payment less often.
		if (record.state === R.Registered && after && after.state === R.Registered) {
			mem.failures.delete(rowId);
			mem.retries.delete(rowId);
		}
	};

	/* ----------------------------------------------------------- refreshers */

	function batchBriefs(batch) {
		return lib.batchAssets(batch).map((a) => {
			const seedling = (batch.seedlings || []).find((s) => s.name === a.name) || {};
			return views.brief({ ...a, type: views.typeName(a.type), decimalDisplay: seedling.decimalDisplay }, a.amount);
		});
	}

	function parcelBriefs(parcel) {
		const reg = host.registry();
		if (parcel.burn) {
			const known = reg.get(parcel.burn.assetId) || { assetId: parcel.burn.assetId, groupKey: null, type: 'normal' };
			return [views.brief(known, parcel.burn.amount)];
		}
		return (parcel.addresses || []).map((encoded, i) => {
			const addr = lib.decodeAddress(encoded);
			const known = reg.get(addr.assetId) || { assetId: addr.assetId, groupKey: addr.groupKey, type: 'normal' };
			return views.brief(known, parcel.amounts && parcel.amounts[i] !== undefined ? parcel.amounts[i] : addr.amount);
		});
	}

	host.refreshMint = async (id) => {
		const B = STATES.Batch;
		const rowId = `mint-${id}`;
		const prev = host.getRow(rowId);
		// A finished mint is looked at again only while its proofs are not
		// on the proof server, to say so and to stop saying so.
		if (prev && views.isTerminal(prev.state) && !prev.failure) return prev;
		const batch = await host.tap.minter.getBatch(id);
		const row = prev
			? clone(prev)
			: views.newRow({
					id: rowId,
					kind: 'mint',
					ref: id,
					created: batch.createdAt || now(),
					assets: batchBriefs(batch),
					satsPerVbyte: batch.feeRate === undefined ? null : batch.feeRate,
					anchorSats: ANCHOR_SATS,
					...feeFields(lib.batchFee(batch))
				});
		const signed = batch.genesis && batch.genesis.signedTx;
		if (signed && !row.txid) row.txid = lib.txid(signed);
		if (batch.block && batch.block.height) row.blockHeight = batch.block.height;
		else if (row.txid && batch.state === B.Broadcast) row.blockHeight = (await host.chainHeight(row.txid)) || null;
		const ids = new Set(row.assets.map((a) => a.assetId));
		const waiting = rows
			.list('publish/')
			.map((r) => r.value)
			.filter((p) => ids.has(p.locator.assetId));
		row.state = views.deriveMint(batch.state, confOf(row));
		let failure = row.state === 'complete' ? null : mem.failures.get(rowId) || null;
		const refused = waiting.find((p) => p.lastError);
		if (row.state === 'failed') failure = { code: 'CANCELLED', message: 'This mint was cancelled before it was sent', retrying: false };
		else if (!failure && refused) {
			failure = { code: refused.code || 'COURIER_UNREACHABLE', message: `The proof server did not take the proof: ${refused.lastError}`, retrying: true };
		}
		settle(row, failure);
		commitRow(prev, row);
		return row;
	};

	host.refreshTransfer = async (id, kind) => {
		const S = STATES.Send;
		const rowId = `${kind}-${id}`;
		const prev = host.getRow(rowId);
		if (prev && views.isTerminal(prev.state)) return prev;
		const parcel = await host.tap.freighter.getParcel(id);
		let row = prev ? clone(prev) : null;
		if (!row) {
			const first = parcel.addresses && parcel.addresses[0];
			const parsed = first ? parseCourier(lib.decodeAddress(first).courier) : null;
			row = views.newRow({
				id: rowId,
				kind,
				ref: id,
				created: parcel.createdAt || now(),
				assets: parcelBriefs(parcel),
				satsPerVbyte: parcel.feeRate === undefined ? null : parcel.feeRate,
				anchorSats: kind === 'send' ? ANCHOR_SATS : 0,
				address: first || null,
				courier: parsed ? parsed.hostPort : null,
				...feeFields(lib.parcelFee(parcel))
			});
		}
		const sent = parcel.state >= S.Broadcast && parcel.state !== S.Cancelled;
		if (sent && parcel.signedTx && !row.txid) row.txid = lib.txid(parcel.signedTx);
		if (parcel.block && parcel.block.height) row.blockHeight = parcel.block.height;
		else if (row.txid && sent && parcel.state < S.TransferProofs) row.blockHeight = (await host.chainHeight(row.txid)) || null;
		row.state = views.deriveTransfer(parcel.state, confOf(row));
		let failure = row.state === 'complete' ? null : mem.failures.get(rowId) || null;
		if (row.state === 'failed') {
			failure = { code: 'CANCELLED', message: parcel.error ? plainMessage({ message: parcel.error }) : 'This was cancelled before it was sent', retrying: false };
		}
		settle(row, failure);
		commitRow(prev, row);
		return row;
	};

	host.refreshReceive = async (encoded) => {
		const R = STATES.Receive;
		const rowId = receiveRowId(encoded);
		const prev = host.getRow(rowId);
		if (prev && views.isTerminal(prev.state)) return prev;
		const record = await host.tap.stores.receives.getReceive(encoded);
		if (!record) return prev;
		let row = prev ? clone(prev) : null;
		if (!row) {
			const addr = lib.decodeAddress(encoded);
			const known = host.registry().get(addr.assetId) || { assetId: addr.assetId, groupKey: addr.groupKey, type: 'normal' };
			const parsed = parseCourier(addr.courier);
			row = views.newRow({
				id: rowId,
				kind: 'receive',
				ref: encoded,
				created: record.createdAt || now(),
				state: 'waiting',
				assets: [views.brief(known, addr.amount)],
				address: encoded,
				courier: parsed ? parsed.hostPort : null
			});
		}
		if (record.locator && record.locator.anchorOutPoint) {
			row.txid = record.locator.anchorOutPoint.split(':')[0];
			if (!row.blockHeight) row.blockHeight = (await host.chainHeight(row.txid)) || null;
		}
		row.state = views.deriveReceive(record.state, confOf(row), cfg.minConfirmations);
		if (record.state >= R.Verified && !row.at.proof) row.at.proof = now();
		settle(row, record.state >= R.Located && record.state < R.Complete ? mem.failures.get(rowId) || null : null);
		commitRow(prev, row);
		return row;
	};

	/** Refresh one stored row from the record it follows. */
	host.refreshRow = (row) => {
		// A Lightning row follows no record of the library's on-chain side:
		// lightning.js settles it from the node.
		if (row.kind === 'ln-send' || row.kind === 'ln-receive') return row;
		if (row.kind === 'mint') return host.refreshMint(row.ref);
		if (row.kind === 'receive') return host.refreshReceive(row.ref);
		return host.refreshTransfer(row.ref, row.kind);
	};

	async function refreshAll() {
		const quiet = async (run) => {
			try {
				await lock.run(run);
			} catch (err) {
				if (isFenced(err)) throw err;
				say('warn', `assets: a row could not be refreshed: ${plainMessage(err)}`);
			}
		};
		for (const [id, mark] of host.markers()) {
			if (mem.stopped) return;
			// A channel open has a marker and no activity row.
			if (mark.kind === 'funding') continue;
			const prev = host.getRow(`${mark.kind}-${id}`);
			if (prev && views.isTerminal(prev.state) && !(mark.kind === 'mint' && prev.failure)) continue;
			await quiet(() => (mark.kind === 'mint' ? host.refreshMint(id) : host.refreshTransfer(id, mark.kind)));
		}
		for (const r of await host.tap.stores.receives.listReceives()) {
			if (mem.stopped) return;
			const prev = host.getRow(receiveRowId(r.id));
			if (prev && (views.isTerminal(prev.state) || (prev.state === 'waiting' && r.state === STATES.Receive.Registered))) continue;
			await quiet(() => host.refreshReceive(r.id));
		}
	}

	async function updateSummary() {
		const records = await host.tap.stores.assets.listAssets();
		const live = records.filter(views.isLive);
		const anchors = [...new Set(live.map((r) => r.anchorOutPoint))].sort();
		const lockedKey = anchors.join(',');
		if (lockedKey !== mem.lockedKey) {
			let locked = anchors.length * ANCHOR_SATS;
			try {
				locked = Number(await host.tap.tapLockedSats());
			} catch (err) {
				if (isFenced(err)) throw err;
			}
			mem.lockedKey = lockedKey;
			mem.lockedSats = locked;
		}
		// An asset that arrived without the host hearing its name (a receive,
		// a restore) is read from the wallet's own proof of it, once.
		const registry = host.registry();
		for (const id of new Set(live.map((r) => r.assetId))) {
			const known = registry.get(id);
			if (known && known.genesis && known.point && known.point.height != null) continue;
			if (!lib.canLookup || mem.unlearnable.has(id)) continue;
			try {
				const iss = await host.tap.freighter.lookupAsset({ assetId: unhex(id) });
				await lock.run(() => host.learnIssuance(iss));
			} catch (err) {
				if (isFenced(err)) throw err;
				mem.unlearnable.add(id);
			}
		}
		const stored = host.listRows();
		// A send whose proof the sender handed over as a file is not something
		// still happening, though the proof server has not taken its proof.
		const settled = (r) => r.kind === 'send' && r.state === 'proofs' && !!r.handedOver;
		const active = (kind) => stored.filter((r) => r.kind === kind && !views.isTerminal(r.state) && r.state !== 'waiting' && !settled(r)).length;
		// A channel that is not over holds assets too, though no record on
		// the chain says so.
		const channels = lightning().channelCount(host);
		mem.summary = {
			holdsAssets: live.length > 0 || channels > 0,
			channels,
			anchorCount: anchors.length,
			lockedSats: mem.lockedSats,
			pending: { mints: active('mint'), sends: active('send'), receives: active('receive'), burns: active('burn') },
			retrying: stored.some((r) => r.state !== 'failed' && r.failure && r.failure.retrying)
		};
	}
	host.updateSummary = updateSummary;

	/* -------------------------------------------------------------- status */

	host.phase = () => {
		if (!mem.firstPass) return 'starting';
		return mem.proofServer.reachable === false || mem.summary.retrying || mem.importError ? 'degraded' : 'ready';
	};

	host.status = () => {
		try {
			mem.backupState = rows.get('backup') || {};
		} catch (_) {
			/* closed storage: the last state read stands */
		}
		return views.statusView({
			cfg,
			phase: host.phase(),
			error: mem.importError ? `The assets backup could not be restored: ${mem.importError}` : null,
			tip: host.tip(),
			summary: mem.summary,
			startup: mem.firstPass ? null : { ...mem.startup, ...(mem.startError || mem.guardError ? { waiting: mem.startError || mem.guardError } : {}) },
			proofServer: mem.proofServer,
			backup: { exportedAt: mem.backupState.exportedAt, dirty: mem.backupState.dirty, importError: mem.importError },
			lightning: lightning().statusOf(host)
		});
	};

	/** Publish the status when the part the manager keeps has changed. */
	host.emitStatus = () => {
		const s = host.status();
		const key = JSON.stringify([s.phase, s.ready, s.error, s.holdsAssets, s.backup, s.lightning]);
		if (key === mem.statusKey) return;
		mem.statusKey = key;
		host.emitEvent('status', s);
	};

	/* -------------------------------------------------------------- backup */

	host.fingerprint = async () => {
		if (!mem.fingerprint) {
			const node = await host.tap.keys.derive({ family: TAP_KEY_FAMILY, index: 0 });
			mem.fingerprint = sha256Hex(hex(node.publicKey));
		}
		return mem.fingerprint;
	};

	/** Write the backup file now. Cheap when nothing changed. */
	host.exportNow = async () => {
		const fingerprint = await host.fingerprint();
		const res = backup.exportBackup({ storage, rows, cfg, fingerprint, now: now(), lightning: host.ln });
		mem.lastExportAt = now();
		host.emitEvent('backup', { exportedAt: res.exportedAt, dirty: false, changed: res.changed });
		host.emitStatus();
		return res;
	};

	function scheduleExport() {
		if (!timers || mem.stopped || !cfg.backupFile || handles.export) return;
		const wait = Math.max(EXPORT_DEBOUNCE_MS, EXPORT_GAP_MS - (now() - mem.lastExportAt));
		handles.export = later(() => {
			handles.export = null;
			host.exportNow().catch((err) => {
				if (isFenced(err)) shutdown();
				else say('warn', `assets: the backup could not be written: ${plainMessage(err)}`);
			});
		}, wait);
	}

	/** Asset state changed: the backup file is behind until the next export. */
	host.markDirty = () => {
		const state = rows.get('backup') || {};
		if (!state.dirty) rows.put('backup', { ...state, dirty: true });
		scheduleExport();
	};

	/** Restore a backup into the store. The caller holds the lock. */
	host.importNow = async (source) => {
		const fingerprint = await host.fingerprint();
		const res = backup.importBackup({ storage, cfg, fingerprint, backup: source, lightning: host.ln });
		// What the wallet holds may have changed: protect and reconcile again
		// before anything spends.
		mem.guarded = false;
		mem.lockedKey = null;
		mem.unlearnable.clear();
		// A backup carries no funding flows: what one had set aside in the
		// on-chain records is settled again from the chain (lightning.js).
		mem.lnReservations = null;
		if (!res.same) host.markDirty();
		return res;
	};

	/**
	 * Hand the library's Lightning service the adapter, and what it asks the
	 * host: a proof from the proof server, whether to take a channel a peer
	 * offers, and where to say that something happened. A service that will
	 * not start leaves the wallet with its assets and without Lightning.
	 */
	host.startLightning = async () => {
		if (!host.ln) return;
		// The service itself starts once the engine has bound its node, which
		// may be now or later: either way a failure lands here, never on the
		// engine that did the binding.
		const failed = (err) => {
			mem.lnError = plainMessage(err, 'The Lightning service could not be started');
			say('warn', `assets: asset channels could not start: ${mem.lnError}`);
			host.emitStatus();
		};
		mem.lnError = null;
		try {
			host.ln.start({ ...lightning().startOptions(host), onStartError: failed });
		} catch (err) {
			if (isFenced(err)) throw err;
			failed(err);
		}
	};

	/** Before the node serves: restore a backup the manager left for this wallet. */
	host.attach = async () => {
		if (!cfg.importFile) return;
		try {
			if (!fs.statSync(cfg.importFile).isFile()) return;
		} catch (_) {
			return;
		}
		try {
			// There is no node yet to say whether a channel is open, and a
			// backup is never restored over one. A wallet with Lightning rows
			// restores from the dashboard, once its node can be asked.
			lightning().refuseImportUnasked(host);
			const res = await host.importNow(backup.readBackupFile(cfg.importFile));
			fs.renameSync(cfg.importFile, `${cfg.importFile}.imported`);
			say('info', `assets: restored the assets backup (${res.imported} rows written)`);
		} catch (err) {
			if (isFenced(err)) throw err;
			mem.importError = plainMessage(err, 'The backup could not be read');
			say('warn', `assets: the assets backup was not restored: ${mem.importError}`);
		}
	};

	/* ------------------------------------------------------------- preview */

	/** Cancel the open preview, if there is one. The caller holds the lock. */
	host.dropPreview = async () => {
		const p = rows.get('preview');
		if (!p) return false;
		// A preview the user confirmed is no longer a preview, whatever this row says.
		if (!rows.get(`committed/${p.parcelId}`)) {
			try {
				await host.tap.freighter.cancel(p.parcelId);
			} catch (err) {
				if (isFenced(err)) throw err;
				say('warn', `assets: a preview could not be cancelled: ${plainMessage(err)}`);
			}
		}
		rows.del('preview');
		host.disarmPreview();
		return true;
	};

	host.expirePreview = async () => {
		const p = rows.get('preview');
		if (p && p.expiresAt <= now()) await host.dropPreview();
	};

	host.disarmPreview = () => {
		if (handles.preview) clearTimeout(handles.preview);
		handles.preview = null;
	};

	host.armPreview = (expiresAt) => {
		host.disarmPreview();
		if (!timers || mem.stopped) return;
		handles.preview = later(() => {
			handles.preview = null;
			lock.run(() => host.expirePreview()).catch((err) => {
				if (isFenced(err)) shutdown();
			});
		}, Math.max(0, expiresAt - now()) + 50);
	};

	/* --------------------------------------------------------------- start */

	/** Protect every live asset output and reconcile with the chain. Sets `guarded`. */
	async function guard() {
		try {
			if (host.chainCheck) {
				await host.chainCheck();
				host.chainCheck = null;
			}
			await lock.run(async () => {
				const live = (await host.tap.stores.assets.listAssets()).filter(views.isLive);
				for (const op of new Set(live.map((r) => r.anchorOutPoint))) await host.tap.anchor.protectAnchor(op);
				await host.tap.freighter.reconcile();
			});
			mem.guarded = true;
			mem.guardError = null;
		} catch (err) {
			if (isFenced(err)) throw err;
			mem.guarded = false;
			mem.guardError = plainMessage(err, 'The chain could not be reached');
			say('warn', `assets: could not check the wallet's assets against the chain yet: ${mem.guardError}`);
		}
		return mem.guarded;
	}
	host.guard = guard;

	/** Cancel what was prepared and never confirmed. The caller holds the lock. */
	async function cancelOrphans() {
		const S = STATES.Send;
		const B = STATES.Batch;
		const cutoff = now() - RECENT_MS;
		rows.del('preview');
		const marks = host.markers();
		for (const p of await host.tap.stores.parcels.listParcels()) {
			if (marks.has(p.id)) continue;
			// A cancel that was interrupted is finished by asking again.
			const again = p.state === S.Cancelled && (p.updatedAt || 0) >= cutoff;
			if (p.state >= S.Broadcast && !again) continue;
			try {
				await host.tap.freighter.cancel(p.id);
			} catch (err) {
				if (isFenced(err)) throw err;
				say('warn', `assets: an unconfirmed send could not be cancelled: ${plainMessage(err)}`);
			}
		}
		for (const b of await host.tap.stores.batches.listBatches()) {
			if (marks.has(b.id)) continue;
			const cancelled = b.state === B.SeedlingCancelled || b.state === B.SproutCancelled;
			const again = cancelled && (b.updatedAt || 0) >= cutoff;
			if (b.state >= B.Broadcast && !again) continue;
			try {
				await host.tap.minter.cancel(b.id);
			} catch (err) {
				if (isFenced(err)) throw err;
				say('warn', `assets: an unconfirmed mint could not be cancelled: ${plainMessage(err)}`);
			}
		}
	}

	/**
	 * Cancel what was never committed, once per generation. Until this has
	 * run, nothing that spends is served and the loop moves nothing on.
	 */
	async function settleOrphans() {
		try {
			await lock.run(cancelOrphans);
		} catch (err) {
			if (!isFenced(err)) mem.startError = plainMessage(err, 'The wallet could not be read');
			throw err;
		}
		mem.orphansDone = true;
		mem.startError = null;
		mem.startup.done = Math.max(mem.startup.done, 2);
	}

	function pruneJournal() {
		const cutoff = now() - JOURNAL_KEEP_MS;
		for (const { key, value } of rows.list('idem/')) if (!value || (value.at || 0) < cutoff) rows.del(key);
	}

	/* ---------------------------------------------------------------- loop */

	async function onePass(block) {
		if (!mem.orphansDone) {
			// The start sequence did not get this far. It is finished here, so
			// a wallet is not left refusing to spend until its next restart.
			try {
				await settleOrphans();
			} catch (err) {
				if (isFenced(err)) throw err;
				say('warn', `assets: the start sequence is not finished: ${plainMessage(err)}`);
				host.emitStatus();
				return;
			}
		}
		const B = STATES.Batch;
		const S = STATES.Send;
		await lock.run(() => host.expirePreview());
		if (!mem.guarded) await guard();
		if (mem.guarded) {
			const marks = host.markers();
			for (const b of await host.tap.stores.batches.listBatches()) {
				if (mem.stopped) return;
				if (marks.has(b.id) && b.state >= B.Frozen && b.state < B.Finalized) await lock.run(() => host.stepBatch(b.id));
			}
			await publishPending();
			for (const p of await host.tap.stores.parcels.listParcels()) {
				if (mem.stopped) return;
				const mark = marks.get(p.id);
				if (mark && p.state < S.Complete) await lock.run(() => host.stepParcel(p.id, mark.kind));
			}
			const receives = await host.tap.stores.receives.listReceives();
			const active = views.activeReceives(receives, { now: now(), windowMs: cfg.receiveWindowMs, max: cfg.receiveSetMax });
			mem.watched = new Set(active.map((r) => receiveRowId(r.id)));
			for (const r of active) {
				if (mem.stopped) return;
				await lock.run(() => host.stepReceive(r.id));
			}
			// A file kept for an address this wallet no longer waits on.
			for (const { key, value } of rows.list('handed/')) {
				if (!receives.some((r) => r.id === value.address)) await lock.run(() => rows.del(key));
			}
			if (block) {
				for (const repair of [() => host.tap.minter.repairProofs(), () => host.tap.freighter.repairProofs(), () => host.tap.freighter.reconcile()]) {
					if (mem.stopped) return;
					try {
						await lock.run(repair);
					} catch (err) {
						if (isFenced(err)) throw err;
						if (!isNotYet(err)) say('debug', `assets: a chain check did not finish: ${plainMessage(err)}`);
					}
				}
			}
		}
		await refreshAll();
		// Asset channels: opens and closes carried on, payments and invoices
		// settled. None of it under the lock (lightning.js).
		await lightning().pass(host, { block });
		await updateSummary();
		if (mem.guarded && !mem.firstPass) {
			mem.firstPass = true;
			mem.startup.done = mem.startup.total;
		}
		host.emitStatus();
	}

	/** One pass of the loop. A pass asked for while one runs follows it. */
	async function pass({ block = false } = {}) {
		if (mem.stopped) return;
		if (mem.passing) {
			mem.again = true;
			mem.wantBlock = mem.wantBlock || block;
			return;
		}
		mem.passing = true;
		try {
			let withBlock = block;
			do {
				mem.again = false;
				await onePass(withBlock);
				withBlock = mem.wantBlock;
				mem.wantBlock = false;
			} while (mem.again && !mem.stopped);
		} catch (err) {
			if (isFenced(err)) shutdown();
			else say('warn', `assets: a pass of the service loop failed: ${plainMessage(err)}`);
		} finally {
			mem.passing = false;
		}
	}
	host.pass = pass;

	function schedule(delay, block) {
		if (!timers || mem.stopped) return;
		mem.wantBlock = mem.wantBlock || block;
		if (handles.pass) return;
		handles.pass = later(() => {
			handles.pass = null;
			const withBlock = mem.wantBlock;
			mem.wantBlock = false;
			pass({ block: withBlock });
		}, delay);
	}

	/** Something was written: look again soon. */
	host.nudge = () => schedule(250, false);

	function arm() {
		if (!timers || mem.stopped) return;
		mem.lastTip = host.tip();
		handles.tip = setInterval(() => {
			const t = host.tip();
			if (t && t !== mem.lastTip) {
				mem.lastTip = t;
				schedule(500, true);
			}
		}, cfg.relaxed ? 2000 : 5000);
		handles.tip.unref();
		handles.backstop = setInterval(() => {
			mem.ticks += 1;
			schedule(0, false);
			if (mem.ticks % 5 === 0) checkProofServer();
		}, BACKSTOP_MS);
		handles.backstop.unref();
	}

	function shutdown() {
		mem.stopped = true;
		// The Lightning service is closed and not waited for: the engine gives
		// a stop five seconds, and a payment in flight is the node's to finish.
		try {
			if (host.ln) host.ln.stop();
		} catch (_) {
			/* it is being left behind either way */
		}
		for (const name of Object.keys(handles)) {
			if (handles[name]) {
				clearTimeout(handles[name]);
				clearInterval(handles[name]);
			}
			handles[name] = null;
		}
	}
	host.shutdown = shutdown;

	/** The start sequence. Resolves after the first pass; `start` does not wait for it. */
	host.startup = async () => {
		try {
			await lock.run(async () => {
				pruneJournal();
				lightning().prune(host);
				try {
					await host.tap.anchor.releaseFunding(QUOTE_ID);
				} catch (err) {
					if (isFenced(err)) throw err;
				}
			});
			mem.startup.done = 1;
			await settleOrphans();
			await guard();
			if (mem.guarded) mem.startup.done = 3;
			host.emitStatus();
			checkProofServer();
			await pass({ block: true });
		} catch (err) {
			if (isFenced(err)) {
				shutdown();
				return;
			}
			// The loop finishes what this did not: see onePass.
			if (!mem.orphansDone) mem.startError = plainMessage(err, 'The wallet could not be read');
			say('error', `assets: the start sequence failed: ${plainMessage(err)}`);
		}
		arm();
	};

	host.start = async () => {
		host.startup().catch(() => undefined);
	};

	host.stop = async (reason) => {
		const dirty = (() => {
			try {
				return !!(rows.get('backup') || {}).dirty;
			} catch (_) {
				return false;
			}
		})();
		if (reason === 'shutdown' && dirty && cfg.backupFile) {
			try {
				await host.exportNow();
			} catch (_) {
				/* the next start writes it */
			}
		}
		shutdown();
	};

	return host;
}

module.exports = { createHost, stepFailure, receiveRowId, QUOTE_ID, STEP_WAIT_MS, STEP_WAIT_MAX_MS };
