'use strict';

/**
 * How the assets host reaches a proof server (a universe's REST gateway).
 *
 * Every request goes through the manager's outbound rules (../outbound.js):
 * the wallet's network mode picks the route, an onion always goes through
 * Tor, a Tor wallet without Tor is refused and never sent direct, and a
 * private address is refused everywhere except on regtest, where the proof
 * server is a machine on the local network with a certificate of its own.
 */
const fs = require('fs');
const { plainMessage } = require('./errors');

const MAX_BYTES = 24 * 1024 * 1024;
const DIRECT_TIMEOUT_MS = 20_000;
const TOR_TIMEOUT_MS = 60_000;

function netError(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

/**
 * `deps` are seams for tests: `fetchImpl`, `dispatcherFor(route)` and
 * `outbound`. Production loads undici and ../outbound on first use, so a
 * host that never talks to a proof server never loads them.
 */
function createNet({ cfg, logger, fetchImpl, dispatcherFor, outbound } = {}) {
	const agents = new Map();
	let loaded = null;
	const load = () => {
		if (!loaded) {
			const out = outbound || require('../outbound');
			let undici = null;
			if (!fetchImpl || !dispatcherFor) undici = require('undici');
			loaded = { outbound: out, fetch: fetchImpl || undici.fetch, Agent: undici ? undici.Agent : null };
		}
		return loaded;
	};

	function dispatcher(route) {
		if (dispatcherFor) return dispatcherFor(route);
		if (agents.has(route)) return agents.get(route);
		const { outbound: out, Agent } = load();
		let agent = null;
		if (route === 'tor') {
			agent = out.createDispatcher({ route: 'tor', torProxy: cfg.torProxy });
		} else if (cfg.caFile) {
			// Regtest only (config.js): trust exactly the certificate the local
			// proof server made for itself, under whatever name it is reached.
			try {
				const ca = fs.readFileSync(cfg.caFile);
				agent = new Agent({ connect: { ca, checkServerIdentity: () => undefined }, connections: 8 });
			} catch (err) {
				if (logger) logger.warn(`The proof server certificate at ${cfg.caFile} could not be read: ${err.message}`);
			}
		}
		if (!agent) agent = out.createDispatcher({ route: 'direct', allowPrivate: cfg.allowPrivate });
		agents.set(route, agent);
		return agent;
	}

	/** 'tor' or 'direct' for a web address, or throws when it may not be opened. */
	function routeOf(rawUrl) {
		const { outbound: out } = load();
		const url = out.vetUrl(rawUrl, { relaxed: cfg.allowPrivate });
		const host = url.hostname.replace(/^\[|\]$/g, '');
		return { url, route: out.routeFor({ mode: cfg.mode, host, torProxy: cfg.torProxy || '' }) };
	}

	async function request(rawUrl, { method = 'GET', headers = {}, body, timeoutMs } = {}) {
		const { outbound: out, fetch } = load();
		const { url, route } = routeOf(rawUrl);
		const via = route === 'tor' ? ' over Tor' : '';
		let response;
		try {
			response = await fetch(url.href, {
				method,
				headers,
				body,
				redirect: 'error',
				dispatcher: dispatcher(route),
				signal: AbortSignal.timeout(timeoutMs || (route === 'tor' ? TOR_TIMEOUT_MS : DIRECT_TIMEOUT_MS))
			});
		} catch (err) {
			const cause = (err && err.cause) || err;
			if (cause && cause.code === 'PRIVATE_URL') throw cause;
			const timedOut = [err && err.name, cause && cause.name].some((n) => n === 'TimeoutError' || n === 'AbortError');
			throw netError(
				timedOut ? 'PROOF_SERVER_TIMEOUT' : 'PROOF_SERVER_UNREACHABLE',
				timedOut ? `${url.host} did not answer in time${via}` : `Could not reach ${url.host}${via}`
			);
		}
		let bytes;
		try {
			bytes = await out.readCapped(response, MAX_BYTES);
		} catch (err) {
			throw netError('PROOF_SERVER_UNREACHABLE', `${url.host} sent back more than a proof should be, or stopped half way`);
		}
		const text = bytes.toString('utf8');
		return { ok: response.ok, status: response.status, text, json: async () => JSON.parse(text) };
	}

	/** The fetch the library's courier calls: (url, { method, headers, body }) => { ok, status, json() }. */
	const courierFetch = (url, init = {}) => request(url, init);

	/** Whether a proof server answers: { reachable, network, ms, error }. */
	async function test(rest, { timeoutMs = 15_000 } = {}) {
		const started = Date.now();
		try {
			const base = String(rest || '').trim().replace(/\/+$/, '');
			const res = await request(`${base}/v1/taproot-assets/universe/info`, { timeoutMs });
			if (!res.ok) return { reachable: false, network: null, ms: null, error: `The server answered HTTP ${res.status}` };
			const json = await res.json();
			if (!json || typeof json !== 'object') throw new Error('The server did not answer like a proof server');
			// A universe does not say which chain it serves; null is "not known".
			return { reachable: true, network: null, ms: Date.now() - started, error: null };
		} catch (err) {
			return { reachable: false, network: null, ms: null, error: plainMessage(err, 'The server did not answer like a proof server') };
		}
	}

	/** Whether requests to `rest` leave through Tor. A Tor wallet without Tor still counts. */
	function viaTor(rest) {
		try {
			return routeOf(rest).route === 'tor';
		} catch (err) {
			return cfg.mode === 'tor' || (err && err.code === 'TOR_UNAVAILABLE');
		}
	}

	return { request, courierFetch, test, viaTor };
}

module.exports = { createNet };
