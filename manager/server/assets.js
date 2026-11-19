'use strict';

/**
 * Taproot Assets (docs/ASSETS.md): the pure rules the manager applies around
 * the assets host. The host itself runs inside each wallet's daemon, as an
 * engine extension (assets-host/), because it needs the wallet's keys and
 * coins in the same process. The manager never loads it. What the manager
 * decides is whether a daemon is told to load it, with which settings, and
 * what a wallet's record says about it.
 *
 * Nothing here does I/O except hostProblem, which reads two file modes.
 * wallet-manager.js is the I/O around the rest.
 */
const fs = require('fs');
const path = require('path');
const { publicUniverseServers } = require('./config');

/** The module the daemon loads. Named by BEIGNET_EXTENSIONS, nothing else. */
const HOST_MODULE = path.join(__dirname, 'assets-host', 'index.js');

// A new wallet has assets on: the tab is there, and nothing is created or
// sent until its owner does it. The universe is null while the wallet uses
// the default for its network.
const ASSETS_DEFAULTS = Object.freeze({ enabled: true, universe: null });

// A proof courier as an asset address names it. universerpc is the one this
// app can deliver to and fetch from; authmailbox+universerpc is accepted on
// an address so it can be shown and explained, and reaches the same server.
const COURIER_RE = /^(universerpc|authmailbox\+universerpc):\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i;

// Every event the host relays, as the daemon names them on its stream.
const ASSET_EVENTS = Object.freeze([
	'assets:status',
	'assets:mint',
	'assets:transfer',
	'assets:receive',
	'assets:proof-delivery',
	'assets:balance',
	'assets:backup',
	'assets:error',
	'assets:channel',
	'assets:invoice',
	'assets:payment'
]);

// The ones worth a line in the wallet's log: money moving, and trouble.
const LOGGED_EVENTS = Object.freeze(['assets:mint', 'assets:transfer', 'assets:receive', 'assets:proof-delivery', 'assets:error']);

function httpError(status, code, message) {
	const err = new Error(message);
	err.statusCode = status;
	err.code = code;
	return err;
}

function isOnion(host) {
	return /\.onion\.?$/i.test(String(host || ''));
}

/** The host and port of a courier address, or null when it is not one. */
function parseCourier(uri) {
	const m = COURIER_RE.exec(String(uri || '').trim());
	if (!m) return null;
	const port = m[3] === undefined ? 10029 : Number(m[3]);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	return { scheme: m[1].toLowerCase(), host: m[2].toLowerCase(), port };
}

/** A courier address in the one spelling it is stored and compared in. */
function canonicalCourier(uri) {
	const parsed = parseCourier(uri);
	return parsed ? `${parsed.scheme}://${parsed.host}:${parsed.port}` : null;
}

/**
 * A wallet's own universe server: the courier address its new asset
 * addresses name, and the REST gateway of the same server. Null, '' or
 * undefined clears it back to the network's default. https, except for an
 * onion (Tor encrypts the hop) and on regtest (a local server).
 */
function normalizeUniverse(input, { network } = {}) {
	if (input === null || input === undefined || input === '') return null;
	if (typeof input !== 'object') {
		throw httpError(400, 'BAD_UNIVERSE', 'A universe server is a courier address and a web address.');
	}
	const courier = canonicalCourier(input.courier);
	if (!courier || !courier.startsWith('universerpc://')) {
		throw httpError(
			400,
			'BAD_UNIVERSE',
			'The proof courier address looks like universerpc://universe.example.com:10029.'
		);
	}
	let url;
	try {
		url = new URL(String(input.rest || '').trim());
	} catch (_) {
		throw httpError(400, 'BAD_UNIVERSE', 'The web address of the universe server is not one this wallet can open.');
	}
	if (url.username || url.password || url.search || url.hash) {
		throw httpError(400, 'BAD_UNIVERSE', 'The web address of the universe server has parts this wallet does not use.');
	}
	const relaxed = network === 'regtest';
	if (url.protocol === 'http:') {
		if (!relaxed && !isOnion(url.hostname)) {
			throw httpError(400, 'BAD_UNIVERSE', 'The universe server is on plain http. Only https, or an onion address, is used.');
		}
	} else if (url.protocol !== 'https:') {
		throw httpError(400, 'BAD_UNIVERSE', 'Only https web addresses are opened.');
	}
	// No trailing slash, so the host can append its own paths.
	const rest = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
	return { courier, rest };
}

/**
 * The record's assets block from a request, over what the record holds.
 * A field left out keeps its value.
 */
function normalizeAssets(input, existing, { network } = {}) {
	const base = { ...ASSETS_DEFAULTS, ...(existing && typeof existing === 'object' ? existing : {}) };
	const current = {
		enabled: base.enabled !== false,
		universe: base.universe && base.universe.courier && base.universe.rest ? { courier: base.universe.courier, rest: base.universe.rest } : null
	};
	if (input === undefined || input === null) return current;
	if (typeof input !== 'object') throw httpError(400, 'BAD_ASSETS', 'assets must be an object.');
	const next = { ...current };
	if (input.enabled !== undefined) {
		if (typeof input.enabled !== 'boolean') throw httpError(400, 'BAD_ASSETS', 'assets.enabled must be true or false.');
		next.enabled = input.enabled;
	}
	if (input.universe !== undefined) next.universe = normalizeUniverse(input.universe, { network });
	return next;
}

/**
 * Every universe server a wallet's host knows: the wallet's own first when
 * it has one, then the public ones for its network. The first is the one
 * new addresses name; the rest are there so a send to an address naming
 * one of them can still deliver its proof.
 */
function universesFor(rec, env = process.env) {
	const assets = normalizeAssets(undefined, rec && rec.assets, { network: rec && rec.network });
	const list = [];
	const seen = new Set();
	const known = publicUniverseServers(rec && rec.network, env);
	const add = (entry, isDefault) => {
		const courier = canonicalCourier(entry.courier);
		if (!courier || seen.has(courier)) return;
		seen.add(courier);
		// A server for one chain of a network that can be two says so, and
		// the host keeps the ones for the chain the wallet turns out to be
		// on. A wallet's own entry for a server the app knows is for that
		// server's chain too, whatever gateway it names.
		const same = known.find((s) => canonicalCourier(s.courier) === courier);
		const chain = entry.chain || (same && same.chain) || null;
		list.push({ courier, rest: entry.rest, isDefault, ...(chain ? { chain } : {}) });
	};
	if (assets.universe) add(assets.universe, false);
	for (const server of known) add(server, true);
	return list;
}

/**
 * Why the daemon would refuse to load the host module, or null. The engine
 * refuses a module another local user could have written (its own file and
 * directory checks), and a refused module refuses the whole start, so the
 * manager looks first and leaves assets off instead of losing the wallet.
 */
function hostProblem(file = HOST_MODULE, { uid = typeof process.getuid === 'function' ? process.getuid() : null, platform = process.platform } = {}) {
	let real;
	try {
		real = fs.realpathSync(file);
	} catch (_) {
		return 'the assets host is not installed';
	}
	if (platform === 'win32' || uid === null) return null;
	for (const target of [real, path.dirname(real)]) {
		let stat;
		try {
			stat = fs.statSync(target);
		} catch (err) {
			return `${target} could not be read (${err.message})`;
		}
		if (stat.uid !== uid && stat.uid !== 0) return `${target} belongs to another user`;
		if ((stat.mode & 0o022) !== 0) return `${target} is writable by its group or by everyone`;
	}
	return null;
}

/** Where a wallet's assets files live: the backup the host writes, and an import waiting for it. */
function assetsPaths(walletDir) {
	const dir = path.join(walletDir, 'assets');
	return { dir, backup: path.join(dir, 'backup.json'), pendingImport: path.join(dir, 'pending-import.json') };
}

/**
 * The environment that makes a wallet's daemon load the assets host. Empty
 * when assets are unavailable on this install, switched off for the box
 * (BEIGNET_ASSETS=off) or off for the wallet: a daemon that is not told
 * about the host runs exactly as it did before the feature existed.
 */
function assetsEnv(rec, { available, modulesDir, hostModule = HOST_MODULE, mode, torProxy, walletDir, lightning = 'off', env = process.env } = {}) {
	if (!available || !modulesDir || !walletDir) return {};
	if (String(env.BEIGNET_ASSETS || '').toLowerCase() === 'off') return {};
	const assets = normalizeAssets(undefined, rec.assets, { network: rec.network });
	if (!assets.enabled) return {};
	const paths = assetsPaths(walletDir);
	const out = {
		BEIGNET_EXTENSIONS: hostModule,
		// Where ts-tap and its adapter are installed, beside the engine.
		BEIGNET_ASSETS_MODULES: modulesDir,
		BEIGNET_ASSETS_UNIVERSES: JSON.stringify(universesFor(rec, env)),
		// The wallet's network mode decides how the host reaches a universe
		// server, as it decides how the manager reaches an LNURL service.
		BEIGNET_ASSETS_NETWORK_MODE: mode || 'clearnet',
		BEIGNET_ASSETS_BACKUP_FILE: paths.backup,
		BEIGNET_ASSETS_IMPORT_FILE: paths.pendingImport,
		BEIGNET_ASSETS_LIGHTNING: rec.onchainOnly ? 'off' : lightning
	};
	if (torProxy) out.BEIGNET_ASSETS_TOR_PROXY = torProxy;
	if (rec.network === 'regtest') {
		// A regtest universe is a machine on the local network, which the
		// host's outbound guard refuses everywhere else, and it serves a
		// certificate it signed itself.
		out.BEIGNET_ASSETS_ALLOW_PRIVATE = 'true';
		const local = publicUniverseServers('regtest', env).find((s) => s.ca);
		if (local) out.BEIGNET_ASSETS_CA_FILE = local.ca;
	}
	// Operator-level fee ceilings pass through; the host has its own defaults.
	for (const name of ['BEIGNET_ASSETS_MAX_FEE_RATE', 'BEIGNET_ASSETS_MAX_FEE_SATS']) {
		if (env[name]) out[name] = env[name];
	}
	return out;
}

/** The assets block of a wallet's public record. */
function publicAssets(rec, rt) {
	const assets = normalizeAssets(undefined, rec.assets, { network: rec.network });
	const status = (rt && rt.assets) || null;
	return {
		enabled: assets.enabled,
		universe: assets.universe,
		// What the host last reported; null until it has. A wallet that
		// holds assets needs the app backup, which the dashboard says.
		holdsAssets: status ? !!status.holdsAssets : rec.assetsHeld === true,
		phase: status ? status.phase : null,
		error: status ? status.error || null : null
	};
}

/** One log line for an event worth keeping, or null. */
function describeAssetEvent(name, data) {
	if (!LOGGED_EVENTS.includes(name)) return null;
	const row = data && data.row;
	if (name === 'assets:error') {
		return `assets error [${(data && data.code) || 'UNKNOWN'}] ${(data && data.message) || ''}`.trim();
	}
	if (!row) return null;
	const what = (row.assets || []).map((a) => `${a.amount} ${a.name || a.assetId}`).join(', ');
	const txid = row.txid ? ` ${row.txid}` : '';
	return `${name} ${row.kind || ''} ${row.state || ''}${what ? ` (${what})` : ''}${txid}`.replace(/\s+/g, ' ').trim();
}

module.exports = {
	HOST_MODULE,
	ASSETS_DEFAULTS,
	ASSET_EVENTS,
	LOGGED_EVENTS,
	parseCourier,
	canonicalCourier,
	normalizeUniverse,
	normalizeAssets,
	universesFor,
	hostProblem,
	assetsPaths,
	assetsEnv,
	publicAssets,
	describeAssetEvent
};
