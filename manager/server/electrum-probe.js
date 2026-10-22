'use strict';

/**
 * Asking an Electrum server about itself.
 *
 * The dashboard offers one-click presets for the Electrum servers an Umbrel
 * may run and lets a user type any other, such as another Umbrel on the home
 * network. Whether a preset is installed, what software answers, which chain
 * it serves and how far it has synced are all one short conversation away, so
 * this module holds that conversation: one TCP or TLS connection, a few
 * JSON-RPC requests, the replies filed by id, and a hard deadline. Discovery,
 * the Test button and the wrong-chain guard in the manager all read the same
 * result shape from here, and the manager's own tip probe is one request
 * through the same socket code.
 */

const net = require('net');
const tls = require('tls');
const { certificateAccepted } = require('./electrum-tls');

// A server that does not answer at all in this long is reported as such. The
// same bound the manager uses before starting a wallet.
const PROBE_TIMEOUT_MS = 3000;
// How long a probe result stands in for a fresh one. Discover, then Test,
// then Save can each ask about the same server within seconds; one
// connection answers all three, and a wallet saved right after the dashboard
// probed its server does not wait for the probe again.
const CACHE_TTL_MS = 10000;

// Genesis block hashes, as `server.features.genesis_hash` reports them
// (display order), to the network name the manager uses. testnet4 is listed
// apart from testnet because beignet's `testnet` is testnet3: a testnet4
// server is a real mismatch, and the message should say which it is.
const GENESIS_CHAINS = {
	'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f': 'mainnet',
	'000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943': 'testnet',
	'00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043': 'testnet4',
	'00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6': 'signet',
	'0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206': 'regtest'
};

/** The network a genesis hash names, or 'unknown' for anything else. */
function chainOfGenesis(hash) {
	if (typeof hash !== 'string') return 'unknown';
	return GENESIS_CHAINS[hash.trim().toLowerCase()] || 'unknown';
}

function codedError(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

/**
 * Open one connection to an Electrum server, send every request, and resolve
 * once each has been answered: `{ replies: { [id]: message }, certificate }`.
 *
 * Rejects with code TLS_REJECTED when the wallet's verification rule
 * (electrum-tls.js) would refuse the certificate, carrying what was seen so
 * the user can pin it; with code TIMEOUT when the deadline passes, carrying
 * the replies that did arrive; and with the socket's own error otherwise.
 *
 * The deadline is a timer of its own and not only `socket.setTimeout`, which
 * measures idleness: a server that trickles one byte every second would
 * otherwise never time out.
 */
function electrumRequests(electrum, requests, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
	const { host, port, tls: useTls } = electrum;
	return new Promise((resolve, reject) => {
		let done = false;
		let buf = '';
		let socket;
		let timer = null;
		const replies = {};
		const pending = new Set(requests.map((r) => r.id));
		let certificate = null;
		const finish = (err, value) => {
			if (done) return;
			done = true;
			if (timer) clearTimeout(timer);
			try {
				socket.destroy();
			} catch (_) {
				/* already gone */
			}
			if (err) reject(err);
			else resolve(value);
		};
		try {
			socket = useTls
				? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false })
				: net.connect({ host, port });
		} catch (err) {
			return reject(err);
		}
		timer = setTimeout(() => {
			const err = codedError('TIMEOUT', `No answer from ${host}:${port} within ${timeoutMs} ms`);
			err.replies = replies;
			err.certificate = certificate;
			finish(err);
		}, timeoutMs);
		socket.setTimeout(timeoutMs);
		socket.once(useTls ? 'secureConnect' : 'connect', () => {
			if (useTls) {
				const cert = socket.getPeerCertificate();
				certificate = {
					authorized: !!socket.authorized,
					fingerprint: cert && cert.fingerprint256 ? cert.fingerprint256.replace(/:/g, '').toLowerCase() : null,
					accepted: certificateAccepted(socket, electrum)
				};
				// A wallet that verifies its server's certificate would not talk
				// to this one, so nothing is asked of it either.
				if (!certificate.accepted) {
					const err = codedError('TLS_REJECTED', `The certificate of ${host}:${port} is not trusted`);
					err.certificate = certificate;
					return finish(err);
				}
			}
			if (!pending.size) return finish(null, { replies, certificate });
			for (const r of requests) {
				socket.write(`${JSON.stringify({ id: r.id, method: r.method, params: r.params || [] })}\n`);
			}
		});
		socket.on('data', (chunk) => {
			buf += chunk.toString('utf8');
			// Replies are newline-delimited JSON, possibly several per chunk and
			// possibly one across two chunks, in any order.
			let nl;
			while ((nl = buf.indexOf('\n')) !== -1) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				let msg;
				try {
					msg = JSON.parse(line);
				} catch (_) {
					return finish(codedError('BAD_REPLY', `${host}:${port} answered something other than JSON`));
				}
				if (msg && pending.has(msg.id)) {
					replies[msg.id] = msg;
					pending.delete(msg.id);
				}
			}
			if (!pending.size) finish(null, { replies, certificate });
		});
		socket.once('timeout', () => {
			const err = codedError('TIMEOUT', `No answer from ${host}:${port} within ${timeoutMs} ms`);
			err.replies = replies;
			err.certificate = certificate;
			finish(err);
		});
		socket.once('error', (err) => finish(err));
		socket.once('close', () => {
			if (pending.size) finish(codedError('CLOSED', `${host}:${port} closed the connection`));
		});
	});
}

const EMPTY = {
	reachable: false,
	software: null,
	protocol: null,
	chain: 'unknown',
	genesisHash: null,
	height: null,
	certificate: null,
	error: null
};

function readReplies(replies) {
	const out = {};
	const version = replies[1] && Array.isArray(replies[1].result) ? replies[1].result : null;
	if (version) {
		out.software = typeof version[0] === 'string' ? version[0] : null;
		out.protocol = typeof version[1] === 'string' ? version[1] : null;
	}
	const features = replies[2] && replies[2].result && typeof replies[2].result === 'object' ? replies[2].result : null;
	if (features) {
		out.genesisHash = typeof features.genesis_hash === 'string' ? features.genesis_hash.toLowerCase() : null;
		out.chain = chainOfGenesis(features.genesis_hash);
	}
	const tip = replies[3] && replies[3].result;
	if (tip && typeof tip.height === 'number') out.height = tip.height;
	return out;
}

/**
 * Everything the dashboard shows about a server, in one `ProbeResult`:
 *
 *   { reachable, software, protocol, chain, genesisHash, height,
 *     certificate: null | { accepted, authorized, fingerprint },
 *     error: null | 'unreachable' | 'timeout' | 'tls-rejected' | 'bad-reply',
 *     probedAt }
 *
 * `server.version` goes first because some servers refuse every other
 * method until the client has introduced itself. Never throws: a server
 * that cannot be reached is a result, not a failure.
 */
async function probeElectrum(electrum, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
	const requests = [
		{ id: 1, method: 'server.version', params: ['beignet-umbrel', '1.4'] },
		{ id: 2, method: 'server.features', params: [] },
		{ id: 3, method: 'blockchain.headers.subscribe', params: [] }
	];
	const probedAt = Date.now();
	try {
		const { replies, certificate } = await electrumRequests(electrum, requests, { timeoutMs });
		return { ...EMPTY, reachable: true, certificate, ...readReplies(replies), probedAt };
	} catch (err) {
		if (err.code === 'TLS_REJECTED') {
			return { ...EMPTY, reachable: true, certificate: err.certificate, error: 'tls-rejected', probedAt };
		}
		if (err.code === 'TIMEOUT') {
			// A slow server may have answered some of it; keep what arrived.
			const partial = err.replies ? readReplies(err.replies) : {};
			const reachable = !!err.certificate || Object.keys(partial).length > 0 || err.replies !== undefined;
			return { ...EMPTY, reachable: reachable && !!err.replies, certificate: err.certificate || null, ...partial, error: 'timeout', probedAt };
		}
		if (err.code === 'BAD_REPLY' || err.code === 'CLOSED') {
			return { ...EMPTY, reachable: true, error: 'bad-reply', probedAt };
		}
		return { ...EMPTY, error: 'unreachable', probedAt };
	}
}

const cache = new Map();

function cacheKey(electrum) {
	const pins = Array.isArray(electrum.tlsFingerprints) ? electrum.tlsFingerprints.join('+') : '';
	return `${electrum.host}:${electrum.port}:${electrum.tls ? 1 : 0}:${electrum.tlsVerify === true ? 1 : 0}:${pins}`;
}

/**
 * `probeElectrum` behind a short cache. A probe in flight is shared with
 * every caller that asks meanwhile; `refresh` throws the cached one away.
 */
function cachedProbe(electrum, { ttlMs = CACHE_TTL_MS, refresh = false, timeoutMs } = {}) {
	const key = cacheKey(electrum);
	const hit = cache.get(key);
	if (hit && !refresh && Date.now() - hit.at < ttlMs) return hit.promise;
	if (hit && refresh && hit.inflight) return hit.promise;
	const entry = { at: Date.now(), inflight: true, promise: null };
	entry.promise = probeElectrum(electrum, { timeoutMs }).then((result) => {
		entry.inflight = false;
		return result;
	});
	cache.set(key, entry);
	return entry.promise;
}

function clearProbeCache() {
	cache.clear();
}

/**
 * Every preset probed at once, each within its own bound, so the answer
 * lands in about one timeout no matter how many presets there are.
 */
async function discoverServers(presets, opts = {}) {
	const at = Date.now();
	const servers = await Promise.all(presets.map((p) => cachedProbe(p, opts).then((r) => ({ ...p, ...r }))));
	return { at, servers };
}

module.exports = {
	PROBE_TIMEOUT_MS,
	CACHE_TTL_MS,
	GENESIS_CHAINS,
	chainOfGenesis,
	electrumRequests,
	probeElectrum,
	cachedProbe,
	clearProbeCache,
	discoverServers
};
