'use strict';

/**
 * Per-wallet Porch relays (beignet docs/PORCH.md, umbrel #327): the relays a
 * wallet waits at so it can hand out a `wss://` peer link that names the
 * relay and not the Umbrel.
 *
 * The record holds the relay URLs and how they are dialed. Each relay's
 * registration token is a credential, so it lives in the wallet's secrets
 * directory beside its seed and goes into backups with it, never onto the
 * record the dashboard reads.
 *
 * Tokens reach the daemon through the wallet's own config.json, because
 * BEIGNET_PORCH_RELAYS is a bare list of URLs and BEIGNET_PORCH_TOKEN would
 * send one token to every relay listed. Once the app manages a wallet's
 * Porch it owns the porch keys in that file and leaves every other key as
 * it found it.
 */
const fs = require('fs');
const path = require('path');

const VIAS = ['default', 'tor', 'direct'];
const MAX_RELAYS = 8;
// The engine's PORCH_MAX_TOKEN_BYTES and MAX_AUTHORITY_BYTES.
const MAX_TOKEN_BYTES = 256;
const MAX_AUTHORITY_BYTES = 255;
// The keys of config.json the app writes. porchProxy and porchStandbys are
// left to whoever set them.
const MANAGED_KEYS = ['porchRelays', 'porchToken', 'porchVia'];

function httpError(status, code, message) {
	const err = new Error(message);
	err.statusCode = status;
	err.code = code;
	return err;
}

/** A relay URL as the engine takes it (parsePorchRelayUrl), reduced to its origin. */
function parseRelayUrl(input) {
	const raw = typeof input === 'string' ? input.trim() : '';
	const bad = (message) => httpError(400, 'BAD_PORCH_RELAY', message);
	if (!raw) throw bad('Enter a relay URL, such as wss://relay.example.com.');
	if (/[\s,]/.test(raw)) throw bad('A relay URL cannot contain spaces or commas. Add each relay as its own entry.');
	let url;
	try {
		url = new URL(raw);
	} catch (_) {
		throw bad(`"${raw}" is not a URL. Enter one like wss://relay.example.com.`);
	}
	if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
		throw bad('A Porch relay URL starts with wss:// (or ws:// for a relay without TLS).');
	}
	if (url.username || url.password) throw bad("Leave credentials out of the URL: the relay's token has its own field.");
	if ((url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
		throw bad("Enter the relay's base URL only, with no path: the node adds the paths it needs.");
	}
	if (!url.hostname) throw bad('The relay URL needs a host name.');
	if (Buffer.byteLength(url.host) > MAX_AUTHORITY_BYTES) throw bad('The relay name is too long.');
	return { url: `${url.protocol}//${url.host}`, authority: url.host, host: url.hostname.replace(/^\[|\]$/g, '') };
}

/** The engine's isPrivateOrLoopbackHost: a host Tor cannot reach. */
function isPrivateHost(host) {
	const h = String(host || '').trim().toLowerCase();
	if (h === 'localhost') return true;
	const v6 = h.split('%')[0];
	if (v6 === '::1' || v6 === '::') return true;
	if (/^fe[89ab][0-9a-f]:/.test(v6) || /^f[cd][0-9a-f]{2}:/.test(v6)) return true;
	const mapped = v6.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
	const m = (mapped ? mapped[1] : h).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return false;
	const [a, b] = m.slice(1).map(Number);
	if (m.slice(1).some((n) => Number(n) > 255)) return false;
	return a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function checkToken(token) {
	const bad = (message) => httpError(400, 'BAD_PORCH_TOKEN', message);
	if (typeof token !== 'string') throw bad('A registration token must be text.');
	const clean = token.trim();
	if (!clean) throw bad('A registration token cannot be blank. Remove it instead.');
	if (Buffer.byteLength(clean) > MAX_TOKEN_BYTES) throw bad(`A registration token is at most ${MAX_TOKEN_BYTES} bytes.`);
	return clean;
}

/**
 * The Porch settings a save leaves the wallet with, and the tokens that go
 * with them. Per relay, a `token` string sets or replaces it, null removes
 * it, and leaving it out keeps the one already saved, so a save that is not
 * about tokens never loses one. Turning Porch off is never refused: every
 * rule about reaching a relay applies only while it is on.
 */
function normalizePorch(
	input,
	{ existing, existingTokens = {}, available = false, onchainOnly = false, torAvailable = false, porchProxy } = {}
) {
	if (input === undefined) {
		if (!existing) return { porch: existing, tokens: existingTokens };
		return { porch: { ...existing, enabled: existing.enabled === true && !onchainOnly }, tokens: existingTokens };
	}
	const bad = (message) => httpError(400, 'BAD_PORCH', message);
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Porch settings must be an object.');
	if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw bad('Porch enabled must be true or false.');
	const via = input.via === undefined || input.via === null ? existing?.via || 'default' : input.via;
	if (!VIAS.includes(via)) throw bad('Relay connection must be default, tor or direct.');
	const enabled = !onchainOnly && (input.enabled ?? existing?.enabled ?? false);

	let relays;
	const tokens = {};
	if (input.relays === undefined) {
		relays = (existing?.relays || []).slice();
		for (const url of relays) if (existingTokens[url]) tokens[url] = existingTokens[url];
	} else {
		if (!Array.isArray(input.relays)) throw bad('Relays must be a list.');
		if (input.relays.length > MAX_RELAYS) throw bad(`Add at most ${MAX_RELAYS} relays.`);
		relays = [];
		const seen = new Set();
		for (const entry of input.relays) {
			const item = typeof entry === 'string' ? { url: entry } : entry;
			if (!item || typeof item !== 'object' || Array.isArray(item)) throw bad('Each relay is a URL with an optional token.');
			const relay = parseRelayUrl(item.url);
			if (seen.has(relay.authority)) throw httpError(400, 'BAD_PORCH_RELAY', `${relay.authority} is listed twice.`);
			seen.add(relay.authority);
			relays.push(relay.url);
			if (item.token === undefined) {
				if (existingTokens[relay.url]) tokens[relay.url] = existingTokens[relay.url];
			} else if (item.token !== null && item.token !== '') {
				tokens[relay.url] = checkToken(item.token);
			}
		}
	}

	if (enabled) {
		if (!available) throw httpError(400, 'PORCH_UNSUPPORTED', 'The bundled engine does not support Porch.');
		if (!relays.length) throw bad('Add a relay URL to turn Porch on.');
		if (via === 'tor' && !torAvailable) {
			throw bad('Tor is not available to this app, so the relays cannot be reached through it.');
		}
		if (via === 'direct' && porchProxy) {
			throw bad("This wallet's config file names a Porch proxy, which cannot be combined with direct relay connections.");
		}
		for (const url of relays) {
			const { host } = parseRelayUrl(url);
			const onion = host.toLowerCase().endsWith('.onion');
			if (via === 'direct' && onion) throw bad(`${host} is an onion service: it can only be reached over Tor.`);
			if (via === 'tor' && !onion && isPrivateHost(host)) {
				throw bad(`${host} is a private address that Tor cannot reach. Use the default or direct connection for it.`);
			}
		}
	}
	return { porch: { enabled, relays, ...(via !== 'default' ? { via } : {}) }, tokens };
}

function nativeConfigPath(home) {
	return path.join(home, '.beignet', 'config.json');
}

/** A wallet's own config.json: {} when there is none, null when it cannot be read. */
function readNativeConfig(home) {
	try {
		const parsed = JSON.parse(fs.readFileSync(nativeConfigPath(home), 'utf8'));
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
	} catch (err) {
		return err.code === 'ENOENT' ? {} : null;
	}
}

/**
 * Porch as a wallet's config.json sets it by hand, in the record's shape,
 * so the dashboard can show it and a first save from the dashboard keeps
 * its tokens. Entries the engine would refuse are left out.
 */
function nativePorch(native) {
	if (!native || !Array.isArray(native.porchRelays) || !native.porchRelays.length) return null;
	const relays = [];
	const tokens = {};
	for (const entry of native.porchRelays) {
		const item = typeof entry === 'string' ? { url: entry } : entry || {};
		let relay;
		try {
			relay = parseRelayUrl(item.url);
		} catch (_) {
			continue;
		}
		if (relays.includes(relay.url)) continue;
		relays.push(relay.url);
		if (typeof item.token === 'string' && item.token) tokens[relay.url] = item.token;
	}
	if (relays.length === 1 && !tokens[relays[0]] && typeof native.porchToken === 'string' && native.porchToken) {
		tokens[relays[0]] = native.porchToken;
	}
	if (!relays.length) return null;
	const via = VIAS.includes(native.porchVia) ? native.porchVia : 'default';
	return { porch: { enabled: true, relays, ...(via !== 'default' ? { via } : {}) }, tokens };
}

/** Whether Porch is actually on for a record. */
function porchOn(rec, available) {
	return !!available && !rec.onchainOnly && rec.porch?.enabled === true && (rec.porch.relays || []).length > 0;
}

/**
 * Bring a wallet's config.json in line with its record before the daemon
 * starts. The porch keys are replaced, everything else is kept, and a token
 * goes only in its own relay's entry. A wallet whose Porch the app has never
 * managed is left alone. Throws on a file that cannot be read, so the start
 * fails with the reason instead of writing over it.
 */
function syncNativeConfig(home, rec, tokens, available) {
	if (!rec.porch) return false;
	const native = readNativeConfig(home);
	if (native === null) {
		throw new Error(`${nativeConfigPath(home)} could not be read, so its Porch settings were not updated`);
	}
	const next = { ...native };
	for (const key of MANAGED_KEYS) delete next[key];
	if (porchOn(rec, available)) {
		next.porchRelays = rec.porch.relays.map((url) => (tokens[url] ? { url, token: tokens[url] } : url));
		if (rec.porch.via && rec.porch.via !== 'default') next.porchVia = rec.porch.via;
	}
	if (JSON.stringify(next) === JSON.stringify(native)) return false;
	const file = nativeConfigPath(home);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, file);
	return true;
}

/**
 * The daemon env for Porch. An empty BEIGNET_PORCH_RELAYS wins over the
 * config file, which is what turns Porch off for an on-chain only wallet
 * whose file still lists relays: the missing TCP listener alone does not.
 */
function porchEnv(rec, available) {
	if (!available || porchOn(rec, available)) return {};
	return rec.porch || rec.onchainOnly ? { BEIGNET_PORCH_RELAYS: '' } : {};
}

function readTokens(file) {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch (_) {
		return {};
	}
}

function writeTokens(file, tokens) {
	if (!Object.keys(tokens).length) {
		fs.rmSync(file, { force: true });
		return;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, JSON.stringify(tokens), { mode: 0o600 });
	fs.chmodSync(file, 0o600);
}

/** Every string in `value` with each token in it replaced. */
function redact(value, tokens) {
	const secrets = Object.values(tokens || {}).filter((t) => typeof t === 'string' && t.length);
	if (!secrets.length) return value;
	const walk = (v) => {
		if (typeof v === 'string') return secrets.reduce((s, t) => s.split(t).join('[redacted]'), v);
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
		return v;
	};
	return walk(value);
}

/** Porch as the dashboard sees it: which relays have a token, never the token. */
function publicPorch(porch, tokens, onchainOnly, source) {
	if (!porch) return { enabled: false, relays: [], via: 'default', source: null };
	return {
		enabled: porch.enabled === true && !onchainOnly,
		relays: (porch.relays || []).map((url) => ({ url, hasToken: !!tokens[url] })),
		via: porch.via || 'default',
		source
	};
}

module.exports = {
	VIAS,
	MAX_RELAYS,
	parseRelayUrl,
	isPrivateHost,
	normalizePorch,
	nativeConfigPath,
	readNativeConfig,
	nativePorch,
	porchOn,
	syncNativeConfig,
	porchEnv,
	readTokens,
	writeTokens,
	redact,
	publicPorch
};
