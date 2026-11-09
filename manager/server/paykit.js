'use strict';

/**
 * Paykit: publishing this wallet's payment details under its Pubky identity,
 * and reading another identity's.
 *
 * What is published, all under the App ID "beignet":
 *
 * - btc-lightning-bolt12: a reusable offer, the same one for as long as the
 *   wallet still has it, so a payer who saved it keeps a working one.
 * - btc-bitcoin-p2wpkh (or -p2tr): a fresh address.
 * - btc-bitcoin-bip21: `bitcoin:<that address>?bgnq=<request>`, a direct
 *   funding request for a lightning-first wallet, when the engine can mint
 *   one that lasts a week. A request is single use, so it is minted again
 *   once it is paid or close to expiring.
 *
 * Each payload is `{"value": "..."}`. A list is public: anyone can read it,
 * and it is not signed beyond what the homeserver vouches for, so the payer
 * checks what it reads the way it checks a pasted request.
 *
 * The network calls go through paykit-worker.mjs, on the wallet's own route.
 */
const path = require('path');
const { Worker } = require('worker_threads');
const netmode = require('./network-mode');
const { routeFor } = require('./outbound');

const WORKER = path.join(__dirname, 'paykit-worker.mjs');
const APP_ID = 'beignet';
const MAX_WORKERS = 2;
const LOOKUP_CACHE_MS = 60_000;
const LOOKUP_CACHE_MAX = 200;
// A direct funding request published for a week, minted again a day before.
const DF_EXPIRY_SECS = 7 * 24 * 60 * 60;
const DF_REFRESH_BEFORE_MS = 24 * 60 * 60 * 1000;
const OFFER_DESCRIPTION = 'Paykit payment';
// A lookup reads a few small files; a publish may sign the identity up
// first. Tor gets more of both.
const TIMEOUTS = {
	get: { direct: 45_000, tor: 90_000 },
	set: { direct: 90_000, tor: 180_000 }
};

const ZBASE32_KEY = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;

function httpError(status, code, message) {
	const err = new Error(message);
	err.statusCode = status;
	err.code = code;
	// Paykit failing upstream is not a fault in the manager.
	if (status === 502 || status === 503 || status === 504) err.upstream = true;
	return err;
}

/**
 * The 52-character key out of any way a pubky is written: bare,
 * `pubky<key>`, `pubky://<key>` or `pk:<key>`, any case. Null otherwise.
 */
function readPubky(input) {
	const text = String(input ?? '').trim().toLowerCase();
	const key = text.replace(/^pubky:\/\//, '').replace(/^pk:/, '').replace(/^pubky(?=[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$)/, '');
	return ZBASE32_KEY.test(key) ? key : null;
}

/** What a paykit-discovery failure means to the person who pressed the button. */
function paykitError(code, message, { route } = {}) {
	const over = route === 'tor' ? ' over Tor' : '';
	switch (code) {
		case 'INVALID_PUBKY':
			return httpError(400, 'PAYKIT_INVALID_PUBKY', 'That is not a pubky.');
		case 'RATE_LIMITED':
			return httpError(
				429,
				'PAYKIT_RATE_LIMITED',
				"Pubky's signup service has reached its limit for this address, so this identity could not be signed up. Open this wallet's pubky in Pubky Ring once (Use in Pubky Ring, on the Tools tab), which signs it up, and then set the payment details again."
			);
		case 'AUTH':
			return httpError(502, 'PAYKIT_AUTH', `The Pubky homeserver refused to sign this identity in: ${message}`);
		case 'INVALID_DATA':
		case 'RESOURCE_LIMIT':
			return httpError(502, 'PAYKIT_BAD_DATA', `That pubky's payment details could not be read: ${message}`);
		case 'NOT_FOUND':
			return httpError(404, 'PAYKIT_NOT_FOUND', message);
		case 'TIMEOUT':
			return httpError(504, 'PAYKIT_TIMEOUT', `The Pubky network did not answer in time${over}.`);
		case 'INVALID_INPUT':
		case 'INVALID_SECRET':
			return httpError(500, 'PAYKIT_INVALID', message);
		default:
			return httpError(502, 'PAYKIT_UNREACHABLE', `Could not reach the Pubky network${over}: ${message}`);
	}
}

/** Run one call in a fresh worker; resolves with its result or rejects with its code. */
function runWorker(data, timeoutMs) {
	return new Promise((resolve, reject) => {
		const transfer = data.secret ? [data.secret.buffer] : [];
		const worker = new Worker(WORKER, { workerData: data, transferList: transfer });
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			worker.terminate().catch(() => {});
			fn(value);
		};
		const timer = setTimeout(() => finish(reject, Object.assign(new Error('timed out'), { code: 'TIMEOUT' })), timeoutMs);
		worker.once('message', (m) => {
			if (m && m.ok) finish(resolve, m.result);
			else finish(reject, Object.assign(new Error(m?.message || 'Paykit failed'), { code: m?.code || 'TRANSPORT' }));
		});
		worker.once('error', (e) => finish(reject, Object.assign(new Error(e.message), { code: 'TRANSPORT' })));
		worker.once('exit', (code) => finish(reject, Object.assign(new Error(`worker exited (${code})`), { code: 'TRANSPORT' })));
	});
}

/**
 * The Paykit calls a wallet makes. `run(data, timeoutMs)` is the worker
 * runner, injectable for tests.
 */
function createPaykit({ torProxy, run = runWorker, now = Date.now } = {}) {
	let active = 0;
	const waiting = [];
	const cache = new Map();

	async function limited(fn) {
		if (active >= MAX_WORKERS) await new Promise((resolve) => waiting.push(resolve));
		active += 1;
		try {
			return await fn();
		} finally {
			active -= 1;
			const next = waiting.shift();
			if (next) next();
		}
	}

	function routeOf(rec, host) {
		return routeFor({ mode: netmode.networkMode(rec), host, torProxy });
	}

	async function call(op, rec, fields) {
		const route = routeOf(rec, 'pubky.app');
		try {
			return await limited(() => run({ op, route, torProxy, ...fields }, TIMEOUTS[op][route]));
		} catch (e) {
			throw paykitError(e.code, e.message, { route });
		}
	}

	/** Another identity's published payment details, cached for a minute per route. */
	async function lookup(rec, input) {
		const pubky = readPubky(input);
		if (!pubky) throw httpError(400, 'PAYKIT_INVALID_PUBKY', 'That is not a pubky.');
		const key = `${routeOf(rec, 'pubky.app')}:${pubky}`;
		const hit = cache.get(key);
		if (hit && now() - hit.at < LOOKUP_CACHE_MS) return { pubky, endpoints: hit.endpoints };
		const endpoints = await call('get', rec, { pubky });
		cache.delete(key);
		cache.set(key, { at: now(), endpoints });
		while (cache.size > LOOKUP_CACHE_MAX) cache.delete(cache.keys().next().value);
		return { pubky, endpoints };
	}

	/** Publish `endpoints` as the identity behind the 32-byte `secret`. The secret is zeroed. */
	async function publish(rec, secret, endpoints) {
		const copy = new Uint8Array(secret);
		secret.fill(0);
		try {
			const result = await call('set', rec, { secret: copy, endpoints });
			for (const key of cache.keys()) if (key.endsWith(`:${result.pubky}`)) cache.delete(key);
			return result;
		} finally {
			// Handed to a worker, the copy's buffer was moved there (and is
			// zeroed there): nothing is left here to clear, and filling a
			// detached buffer throws.
			if (copy.byteLength) copy.fill(0);
		}
	}

	return { lookup, publish, _cache: cache };
}

/* ----------------------------------------------------- what to publish */

/** Whether this wallet can take a direct funding payment published for a week. */
function directFundingReady(rec, dfAvailable) {
	return !!dfAvailable && !rec.onchainOnly && !!rec.lfbw?.enabled && rec.lfbw.setup === 'ready';
}

/** The Paykit identifier for an address the wallet handed out, or null. */
function addressIdentifier(address) {
	const a = String(address || '').toLowerCase();
	if (/^(bc|tb|bcrt)1q[02-9ac-hj-np-z]{38}$/.test(a)) return 'btc-bitcoin-p2wpkh';
	if (/^(bc|tb|bcrt)1p[02-9ac-hj-np-z]{58}$/.test(a)) return 'btc-bitcoin-p2tr';
	return null;
}

const entry = (identifier, value) => ({ appId: APP_ID, identifier, payload: JSON.stringify({ value }) });

/**
 * The endpoints to publish now, and what to remember about them. `call` is
 * the daemon (method, path, body); `state` is what was published last.
 */
async function gatherEndpoints({ rec, call, state = {}, dfAvailable = false }) {
	const endpoints = [];
	let offerId = null;
	if (!rec.onchainOnly) {
		const offers = await call('GET', '/offers').catch(() => []);
		let offer = state.offerId ? (offers || []).find((o) => o.offerId === state.offerId) : null;
		if (!offer) offer = await call('POST', '/offer/create', { description: OFFER_DESCRIPTION });
		if (offer?.encoded) {
			offerId = offer.offerId;
			endpoints.push(entry('btc-lightning-bolt12', offer.encoded));
		}
	}
	const { address } = await call('POST', '/address/new', {});
	const identifier = addressIdentifier(address);
	if (identifier) endpoints.push(entry(identifier, address));
	let df = null;
	if (directFundingReady(rec, dfAvailable)) {
		const body = { expirySecs: DF_EXPIRY_SECS };
		if (rec.reach) {
			body.host = rec.reach.host;
			body.port = rec.reach.port;
		}
		const minted = await call('POST', '/direct-funding/request', body);
		if (minted?.request) {
			df = { paymentHash: minted.paymentHash, expiresAt: minted.expiresAt };
			endpoints.push(entry('btc-bitcoin-bip21', `bitcoin:${address}?bgnq=${minted.request}`));
		}
	}
	if (endpoints.length === 0) throw httpError(409, 'PAYKIT_NOTHING', 'This wallet has nothing it can publish yet.');
	return { endpoints, state: { offerId, address, df } };
}

/**
 * Why what is published should be published again, if it should: an empty
 * list means it still stands. Read from the daemon, so a wallet that is not
 * running answers nothing (its caller skips it).
 */
async function refreshReasons({ rec, call, state, dfAvailable = false, now = Date.now() }) {
	const reasons = [];
	if (!state || !state.publishedAt) return reasons;
	const ready = directFundingReady(rec, dfAvailable);
	if (state.df) {
		if (!ready) reasons.push('direct funding is no longer available');
		else if (state.df.expiresAt - now < DF_REFRESH_BEFORE_MS) reasons.push('the direct funding request is about to expire');
		else {
			const received = await call('GET', '/direct-funding/received').catch(() => null);
			if (Array.isArray(received) && received.some((r) => r.receiptHash === state.df.paymentHash)) {
				reasons.push('the direct funding request was paid');
			}
		}
	} else if (ready) reasons.push('direct funding became available');
	if (rec.onchainOnly && state.offerId) reasons.push('the wallet is on-chain only now');
	if (!rec.onchainOnly) {
		const offers = await call('GET', '/offers').catch(() => null);
		if (Array.isArray(offers) && !(state.offerId && offers.some((o) => o.offerId === state.offerId))) {
			reasons.push('the offer is gone');
		}
	}
	if (state.address) {
		const utxos = await call('GET', '/utxos').catch(() => null);
		if (Array.isArray(utxos) && utxos.some((u) => u.address === state.address)) reasons.push('the address was paid');
	}
	return reasons;
}

/** The published list as the dashboard shows it: identifier and value. */
function describeEndpoints(endpoints) {
	return (endpoints || []).map((e) => {
		let value = e.payload;
		try {
			const parsed = JSON.parse(e.payload);
			if (parsed && typeof parsed.value === 'string') value = parsed.value;
		} catch (_) {
			/* a raw payload stays as it is */
		}
		return { appId: e.appId, identifier: e.identifier, value };
	});
}

module.exports = {
	createPaykit,
	runWorker,
	readPubky,
	paykitError,
	gatherEndpoints,
	refreshReasons,
	directFundingReady,
	addressIdentifier,
	describeEndpoints,
	APP_ID,
	DF_EXPIRY_SECS,
	DF_REFRESH_BEFORE_MS
};
