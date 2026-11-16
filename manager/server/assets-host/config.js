'use strict';

/**
 * What the assets host is told by the process that started the daemon.
 *
 * The manager writes these (manager/server/assets.js, assetsEnv), and the
 * daemon hands its whole environment to the extension's factory. Nothing
 * here reads process.env itself, and nothing here does I/O: a setting that
 * cannot work is reported as `problem`, which the host turns into a failed
 * state the dashboard can show, with the bitcoin wallet running as before.
 */
const path = require('path');

// Per network of the engine: the chains it can be, the address prefix, and
// how deep a transaction must be before its proofs are built. A chain is
// named as the Taproot Assets library names it. The engine has one `testnet`,
// and whether a wallet's testnet is testnet3 or testnet4 is decided by the
// Electrum server it is pointed at, so that one is found out (chain.js).
const NETWORKS = Object.freeze({
	mainnet: { chains: ['mainnet'], hrp: 'tapbc', minConfirmations: 6 },
	testnet: { chains: ['testnet3', 'testnet4'], hrp: 'taptb', minConfirmations: 6 },
	regtest: { chains: ['regtest'], hrp: 'taprt', minConfirmations: 1 }
});

// Block 0 of each chain, as an explorer prints its hash.
const GENESIS = Object.freeze({
	'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f': 'mainnet',
	'000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943': 'testnet3',
	'00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043': 'testnet4',
	'0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206': 'regtest'
});

// The most one asset transaction may pay unless the operator says otherwise.
// A fee is paid for by the wallet's bitcoin, and nothing asks twice.
const DEFAULT_LIMITS = Object.freeze({ maxFeeRate: 500, maxFeeSats: 250000 });

const COURIER_RE = /^(universerpc|authmailbox\+universerpc|hashmail):\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?\/?$/i;
const DEFAULT_COURIER_PORT = 10029;
const MODES = ['tor', 'clearnet', 'hybrid'];

/** The parts of a proof courier address, or null when it is not one. */
function parseCourier(uri) {
	const m = COURIER_RE.exec(String(uri || '').trim());
	if (!m) return null;
	const port = m[3] === undefined ? DEFAULT_COURIER_PORT : Number(m[3]);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	const host = m[2].toLowerCase();
	return { scheme: m[1].toLowerCase(), host, port, hostPort: `${host}:${port}` };
}

/** `host:port` of a courier address: what two spellings of one server share. */
function courierHost(uri) {
	const parsed = parseCourier(uri);
	return parsed ? parsed.hostPort : null;
}

function positiveInt(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseUniverses(raw) {
	if (raw === undefined || raw === null || raw === '') return { list: [] };
	let parsed;
	try {
		parsed = JSON.parse(String(raw));
	} catch (_) {
		return { list: [], problem: 'The list of proof servers this wallet was started with could not be read.' };
	}
	if (!Array.isArray(parsed)) return { list: [], problem: 'The list of proof servers this wallet was started with is not a list.' };
	const list = [];
	const seen = new Set();
	for (const entry of parsed) {
		const courier = parseCourier(entry && entry.courier);
		let rest;
		try {
			rest = new URL(String((entry && entry.rest) || ''));
		} catch (_) {
			rest = null;
		}
		if (!courier || !rest || !/^https?:$/.test(rest.protocol)) continue;
		// The mailbox spelling of a server reaches the same machine, so one
		// entry answers for both.
		if (seen.has(courier.hostPort)) continue;
		seen.add(courier.hostPort);
		list.push({
			courier: `universerpc://${courier.hostPort}`,
			host: courier.hostPort,
			rest: `${rest.origin}${rest.pathname.replace(/\/+$/, '')}`,
			isDefault: entry.isDefault === true,
			// The one chain this server is for, when it is for only one of
			// the chains a network can be (a testnet3 universe, a testnet4 one).
			chain: typeof entry.chain === 'string' && entry.chain ? entry.chain : null
		});
	}
	return { list };
}

/**
 * The host's settings for `network` from `env`.
 *
 * Always returns an object. `problem` is a sentence when the host cannot run
 * at all (a chain this app does not carry assets on, or packages it was not
 * told where to find).
 */
function parseConfig(network, env = {}) {
	const chain = NETWORKS[network];
	const universes = parseUniverses(env.BEIGNET_ASSETS_UNIVERSES);
	const mode = MODES.includes(String(env.BEIGNET_ASSETS_NETWORK_MODE || '').toLowerCase())
		? String(env.BEIGNET_ASSETS_NETWORK_MODE).toLowerCase()
		: 'clearnet';
	const regtest = network === 'regtest';
	const cfg = {
		network,
		// The chain, by the library's name for it. Null for a testnet wallet
		// until the host has found out which testnet it is on (onChain).
		tapNetwork: chain && chain.chains.length === 1 ? chain.chains[0] : null,
		chains: chain ? chain.chains.slice() : [],
		hrp: chain ? chain.hrp : null,
		minConfirmations: chain ? chain.minConfirmations : 6,
		modulesDir: String(env.BEIGNET_ASSETS_MODULES || '').trim() || null,
		universes: universes.list,
		defaultUniverse: universes.list[0] || null,
		mode,
		torProxy: String(env.BEIGNET_ASSETS_TOR_PROXY || '').trim() || null,
		// Only a regtest wallet may reach a private address or trust a named
		// certificate, whatever the environment says.
		allowPrivate: regtest && String(env.BEIGNET_ASSETS_ALLOW_PRIVATE || '').toLowerCase() === 'true',
		caFile: regtest ? String(env.BEIGNET_ASSETS_CA_FILE || '').trim() || null : null,
		relaxed: regtest,
		backupFile: String(env.BEIGNET_ASSETS_BACKUP_FILE || '').trim() || null,
		importFile: String(env.BEIGNET_ASSETS_IMPORT_FILE || '').trim() || null,
		// Asset channels arrive with a later engine. Until then, off.
		lightning: 'off',
		limits: {
			maxFeeRate: positiveInt(env.BEIGNET_ASSETS_MAX_FEE_RATE, DEFAULT_LIMITS.maxFeeRate),
			maxFeeSats: positiveInt(env.BEIGNET_ASSETS_MAX_FEE_SATS, DEFAULT_LIMITS.maxFeeSats)
		},
		previewTtlMs: 3 * 60 * 1000,
		// A broadcast transaction with no confirmation after this long is
		// called stuck: an hour, or three blocks where blocks are mined by hand.
		stuckAfterMs: 60 * 60 * 1000,
		stuckAfterBlocks: regtest ? 3 : null,
		// For a moment after the wallet sends a transaction of its own it
		// counts no coins at all. A request that needs bitcoin within the
		// window of one waits up to this long for the count to come back.
		settleWindowMs: 30 * 1000,
		settleWaitMs: 8 * 1000,
		receiveWindowMs: 7 * 24 * 60 * 60 * 1000,
		receiveSetMax: 50,
		problem: null
	};
	if (!chain) {
		cfg.problem =
			network === 'signet'
				? 'Assets are not available on signet in this app.'
				: `Assets are not available on the ${network} network in this app.`;
	} else if (!cfg.modulesDir || !path.isAbsolute(cfg.modulesDir)) {
		cfg.problem = 'The assets packages are not installed beside the wallet engine, so assets cannot start.';
	} else if (universes.problem) {
		cfg.problem = universes.problem;
	}
	for (const name of ['backupFile', 'importFile']) {
		if (cfg[name] && !path.isAbsolute(cfg[name])) cfg[name] = null;
	}
	return cfg;
}

/**
 * `cfg` for a wallet known to be on `chain`: the library is told that chain,
 * and the proof servers of the network's other chain are dropped, so the
 * default is the first one this chain can use.
 */
function onChain(cfg, chain) {
	const universes = cfg.universes.filter((u) => !u.chain || u.chain === chain);
	return { ...cfg, tapNetwork: chain, universes, defaultUniverse: universes[0] || null };
}

/** The REST address of the server a courier address names, or null when it is not one this wallet knows. */
function restFor(cfg, uriOrHost) {
	const host = courierHost(uriOrHost) || String(uriOrHost || '').toLowerCase();
	const found = cfg.universes.find((u) => u.host === host);
	return found ? found.rest : null;
}

module.exports = { NETWORKS, GENESIS, DEFAULT_LIMITS, DEFAULT_COURIER_PORT, parseCourier, courierHost, parseConfig, onChain, restFor };
