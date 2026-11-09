'use strict';

/**
 * The manager's one way out to the internet: LNURL services and, later, the
 * Pubky network. Everything else the manager talks to is a daemon on
 * loopback or a server on the Umbrel's own network.
 *
 * A wallet's network mode (network-mode.js) decides the route, the same way
 * it decides how the wallet dials its peers:
 *
 *   mode       clearnet hosts   .onion hosts
 *   tor        over Tor         over Tor
 *   clearnet   direct           over Tor
 *   hybrid     direct           over Tor
 *
 * A Tor wallet on an Umbrel without Tor is refused rather than sent direct:
 * the owner chose Tor, and an IP address handed to a stranger's server
 * cannot be taken back.
 *
 * The rules a URL has to pass are LNURL's (LUD-01): https, except for an
 * onion, where Tor already encrypts and authenticates the hop. A regtest
 * wallet is let off both that and the private-address refusal, so a local
 * test server on plain http works.
 */
const dns = require('dns');
const net = require('net');
const tls = require('tls');
const { Agent, fetch } = require('undici');
const { SocksClient } = require('socks');
const netmode = require('./network-mode');

const MAX_BODY_BYTES = 128 * 1024;
const DIRECT_TIMEOUT_MS = 20_000;
const TOR_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;

function httpError(status, code, message) {
	const err = new Error(message);
	err.statusCode = status;
	err.code = code;
	// A 502 or 504 here is the remote service misbehaving or out of reach,
	// and a 503 is Tor being unavailable: neither is a fault in the manager,
	// so they are logged as one line, without a stack.
	if (status === 502 || status === 503 || status === 504) err.upstream = true;
	return err;
}

/** Addresses no request from here should reach: this box and its neighbors. */
const PRIVATE = new net.BlockList();
for (const [addr, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['224.0.0.0', 4],
	['240.0.0.0', 4]
]) {
	PRIVATE.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
	['::', 128],
	['::1', 128],
	['fc00::', 7],
	['fe80::', 10],
	['ff00::', 8]
]) {
	PRIVATE.addSubnet(addr, prefix, 'ipv6');
}

/** True for an address on this box or its local networks, IPv4-mapped included. */
function isPrivateAddress(address) {
	const family = net.isIP(address);
	if (family === 4) return PRIVATE.check(address, 'ipv4');
	if (family === 6) {
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
		if (mapped) return PRIVATE.check(mapped[1], 'ipv4');
		return PRIVATE.check(address, 'ipv6');
	}
	return false;
}

function isOnion(host) {
	return /\.onion\.?$/i.test(String(host || ''));
}

/** A URL's host without the brackets an IPv6 literal is written with. */
function bareHost(url) {
	return url.hostname.replace(/^\[(.*)\]$/, '$1');
}

/**
 * Which way a request for `host` leaves, for a wallet in `mode`: 'tor' or
 * 'direct'. Throws when the answer is Tor and there is no Tor to use.
 */
function routeFor({ mode, host, torProxy }) {
	if (isOnion(host) || mode === 'tor') {
		if (!torProxy) {
			throw httpError(
				503,
				'TOR_UNAVAILABLE',
				isOnion(host)
					? 'That service is an onion address, and Tor is not available on this Umbrel.'
					: "This wallet's network mode is Tor, and Tor is not available on this Umbrel right now, so nothing was sent."
			);
		}
		return 'tor';
	}
	return 'direct';
}

/**
 * Refuse a URL a wallet may not fetch. `relaxed` is the regtest allowance:
 * plain http and private addresses, for a test server on the same machine.
 */
function vetUrl(raw, { relaxed = false } = {}) {
	let url;
	try {
		url = raw instanceof URL ? raw : new URL(String(raw));
	} catch (_) {
		throw httpError(400, 'BAD_URL', 'That is not a web address this wallet can open.');
	}
	if (url.username || url.password) {
		throw httpError(400, 'BAD_URL', 'Web addresses with a user name or password in them are not opened.');
	}
	const host = bareHost(url);
	if (url.protocol === 'http:') {
		if (!isOnion(host) && !relaxed) {
			throw httpError(400, 'INSECURE_URL', 'The service is on plain http. Only https, or an onion address, is used for payments.');
		}
	} else if (url.protocol !== 'https:') {
		throw httpError(400, 'BAD_URL', 'Only https web addresses are opened.');
	}
	if (!relaxed) {
		if (host === 'localhost' || host.endsWith('.localhost') || isPrivateAddress(host)) {
			throw httpError(400, 'PRIVATE_URL', 'The service points at a private network address, which this wallet does not open.');
		}
	}
	return url;
}

/**
 * A DNS lookup that refuses names resolving to a private address. Run at
 * connect time, so a name cannot pass a check and then resolve somewhere
 * else for the connection itself.
 */
function vettedLookup(lookup = dns.lookup) {
	return (hostname, options, callback) => {
		if (typeof options === 'function') {
			callback = options;
			options = {};
		}
		lookup(hostname, { ...options, all: true }, (err, addresses) => {
			if (err) return callback(err);
			const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
			if (list.length === 0) return callback(httpError(502, 'DNS_EMPTY', `No address for ${hostname}`));
			if (list.some((a) => isPrivateAddress(a.address))) {
				return callback(
					httpError(400, 'PRIVATE_URL', 'The service points at a private network address, which this wallet does not open.')
				);
			}
			if (options.all) return callback(null, list);
			return callback(null, list[0].address, list[0].family);
		});
	};
}

/**
 * An undici connector that opens every connection through a SOCKS5 proxy,
 * handing it the host name so Tor resolves it (and reaches onions).
 */
function socksConnector(torProxy, timeoutMs = TOR_TIMEOUT_MS, createConnection = SocksClient.createConnection) {
	const [proxyHost, proxyPortRaw] = String(torProxy).split(':');
	const proxyPort = Number(proxyPortRaw);
	return (opts, callback) => {
		let done = false;
		const finish = (err, socket) => {
			if (done) return;
			done = true;
			callback(err, socket);
		};
		const https = opts.protocol === 'https:';
		const port = Number(opts.port) || (https ? 443 : 80);
		const hostname = String(opts.hostname).replace(/^\[(.*)\]$/, '$1');
		createConnection({
			proxy: { host: proxyHost, port: proxyPort, type: 5 },
			command: 'connect',
			destination: { host: hostname, port },
			timeout: timeoutMs
		}).then(
			({ socket }) => {
				if (!https) return finish(null, socket);
				const secure = tls.connect({
					socket,
					servername: opts.servername || (net.isIP(hostname) ? undefined : hostname),
					ALPNProtocols: ['http/1.1']
				});
				secure.once('secureConnect', () => finish(null, secure));
				secure.once('error', (e) => {
					socket.destroy();
					finish(e);
				});
			},
			(e) => finish(e)
		);
	};
}

/**
 * The undici dispatcher for a route. `allowPrivate` drops the connect-time
 * DNS check, for regtest. Exported for the Pubky worker, which installs one
 * as its global dispatcher.
 */
function createDispatcher({ route, torProxy, allowPrivate = false, lookup } = {}) {
	if (route === 'tor') {
		return new Agent({ connect: socksConnector(torProxy), connections: 4 });
	}
	return new Agent({
		connect: allowPrivate ? {} : { lookup: vettedLookup(lookup) },
		connections: 8
	});
}

/** Read at most `limit` bytes of a response body, refusing more. */
async function readCapped(response, limit = MAX_BODY_BYTES) {
	const reader = response.body?.getReader();
	if (!reader) return Buffer.alloc(0);
	const chunks = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > limit) {
				await reader.cancel().catch(() => {});
				throw httpError(502, 'RESPONSE_TOO_LARGE', 'The service sent back far more than a payment request needs.');
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, length);
}

/**
 * The outbound client. `fetchImpl` and `dispatcherFor` are seams for tests;
 * production uses undici's own fetch with one cached agent per route.
 */
function createOutbound({ torProxy = '', fetchImpl = fetch, dispatcherFor } = {}) {
	const agents = new Map();
	const agentFor =
		dispatcherFor ||
		((route, allowPrivate) => {
			const key = `${route}:${allowPrivate}`;
			if (!agents.has(key)) agents.set(key, createDispatcher({ route, torProxy, allowPrivate }));
			return agents.get(key);
		});

	/**
	 * GET `url` for the wallet `rec` and parse the answer as JSON. Redirects
	 * are followed by hand, each hop vetted again and never from https down
	 * to http. Errors carry a code and a message the dashboard can show.
	 */
	async function getJson(rawUrl, { rec } = {}) {
		const mode = netmode.networkMode(rec);
		const relaxed = rec?.network === 'regtest';
		let url = vetUrl(rawUrl, { relaxed });
		for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
			const route = routeFor({ mode, host: bareHost(url), torProxy });
			let response;
			try {
				response = await fetchImpl(url.href, {
					method: 'GET',
					redirect: 'manual',
					headers: { accept: 'application/json' },
					dispatcher: agentFor(route, relaxed && route === 'direct'),
					signal: AbortSignal.timeout(route === 'tor' ? TOR_TIMEOUT_MS : DIRECT_TIMEOUT_MS)
				});
			} catch (e) {
				const cause = e?.cause || e;
				if (cause?.code === 'PRIVATE_URL') throw cause;
				const timedOut = e?.name === 'TimeoutError' || cause?.name === 'TimeoutError';
				throw httpError(
					502,
					timedOut ? 'SERVICE_TIMEOUT' : 'SERVICE_UNREACHABLE',
					timedOut
						? `${url.host} did not answer in time${route === 'tor' ? ' over Tor' : ''}.`
						: `Could not reach ${url.host}${route === 'tor' ? ' over Tor' : ''}.`
				);
			}
			if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
				await response.body?.cancel().catch(() => {});
				const next = new URL(response.headers.get('location'), url);
				if (url.protocol === 'https:' && next.protocol !== 'https:') {
					throw httpError(502, 'INSECURE_REDIRECT', `${url.host} redirected from https to plain http.`);
				}
				url = vetUrl(next, { relaxed });
				continue;
			}
			const body = await readCapped(response);
			let json;
			try {
				json = JSON.parse(body.toString('utf8'));
			} catch (_) {
				throw httpError(
					502,
					'SERVICE_BAD_ANSWER',
					response.ok
						? `${url.host} did not answer with a payment request.`
						: `${url.host} answered HTTP ${response.status}.`
				);
			}
			// LNURL services report their own errors in a 200 or a 4xx alike,
			// as JSON with a reason, which is worth more than the status.
			if (!response.ok && !(json && typeof json === 'object' && json.status === 'ERROR')) {
				throw httpError(502, 'SERVICE_HTTP_ERROR', `${url.host} answered HTTP ${response.status}.`);
			}
			return { json, url };
		}
		throw httpError(502, 'TOO_MANY_REDIRECTS', 'The service redirected too many times.');
	}

	return { getJson };
}

module.exports = {
	createOutbound,
	createDispatcher,
	routeFor,
	vetUrl,
	isPrivateAddress,
	isOnion,
	vettedLookup,
	socksConnector,
	readCapped,
	MAX_BODY_BYTES
};
