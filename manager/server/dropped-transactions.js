'use strict';

/**
 * Pending on-chain transactions that can no longer confirm (issue #285).
 *
 * The daemon's GET /transactions reports every transaction it holds at height
 * 0 as `confirmed: false`. That includes one the network has dropped: a
 * receive whose coins a conflicting transaction spent (a double spend, a
 * replacement, the other signed version of a cooperative close) or one every
 * mempool evicted. The engine's wallet notices and marks such a record
 * `exists: false`, but up to Beignet 0.37.0 the listing left that flag out, so
 * the dashboard showed a dead transaction as "pending, waiting for a block"
 * for good. From Beignet 0.38.0 the listing marks it `dropped: true` itself
 * (coreyphillips/beignet#1967).
 *
 * Each pending row is checked here against the wallet's own Electrum server,
 * the one its daemon uses. A live transaction is in its address's history,
 * whether in the mempool or in a block, on any server, with or without a
 * transaction index. One that is not there, and was first seen more than
 * GRACE_MS ago, is marked `dropped: true`. A row the engine itself reports
 * dropped, with `dropped: true` or `exists: false`, is dropped without
 * asking. Anything that cannot be
 * checked, a row with no address or a server that does not answer, is left
 * exactly as the daemon reported it.
 */

const crypto = require('crypto');
const { address: bitcoinAddress, networks } = require('bitcoinjs-lib');
const { electrumRequests } = require('./electrum-probe');

// A transaction first seen this recently may not have reached the server's
// index yet, so its absence says nothing.
const GRACE_MS = 2 * 60 * 1000;
// How long one look at a wallet's pending transactions stands.
const CHECK_TTL_MS = 30 * 1000;
const TIMEOUT_MS = 5000;
// No more than this many addresses are looked up in one pass.
const MAX_LOOKUPS = 50;

const NETWORKS = { mainnet: networks.bitcoin, testnet: networks.testnet, signet: networks.testnet, regtest: networks.regtest };

/** The Electrum script hash of `address` on `network`, or null when it does not decode there. */
function scriptHash(address, network) {
	const chain = NETWORKS[network];
	if (!chain || typeof address !== 'string' || !address) return null;
	try {
		const script = bitcoinAddress.toOutputScript(address, chain);
		return crypto.createHash('sha256').update(script).digest().reverse().toString('hex');
	} catch (_) {
		return null;
	}
}

/** Whether the engine itself reports `row` gone: `dropped` from Beignet 0.38.0, or a raw `exists: false`. */
function engineSaysDropped(row) {
	return row.dropped === true || row.exists === false;
}

/** First-seen time in ms, from a timestamp the engine may give in seconds or milliseconds. */
function firstSeenMs(row) {
	const value = Number(row.timestamp);
	if (!Number.isFinite(value) || value <= 0) return null;
	return value < 1e12 ? value * 1000 : value;
}

/**
 * Marks the rows of `rows` that can no longer confirm. `lookup(hashes)`
 * resolves each script hash's history, a Map of hash to an array of
 * `{ tx_hash, height }`, or rejects when the server cannot be asked.
 */
async function markDropped(rows, { network, lookup, now = Date.now() }) {
	if (!Array.isArray(rows)) return rows;
	const pending = rows.filter((row) => row && row.confirmed === false && typeof row.txid === 'string');
	if (!pending.length) return rows;
	const hashes = new Map();
	for (const row of pending) {
		if (engineSaysDropped(row)) continue;
		const seen = firstSeenMs(row);
		if (seen === null || now - seen < GRACE_MS) continue;
		const hash = scriptHash(row.address, network);
		if (hash && (hashes.has(hash) || hashes.size < MAX_LOOKUPS)) hashes.set(hash, row.address);
	}
	let histories = new Map();
	if (hashes.size) {
		try {
			histories = await lookup([...hashes.keys()]);
		} catch (_) {
			histories = new Map();
		}
	}
	const dropped = new Set();
	for (const row of pending) {
		if (engineSaysDropped(row)) {
			dropped.add(row.txid);
			continue;
		}
		const hash = scriptHash(row.address, network);
		const history = hash ? histories.get(hash) : undefined;
		// Only an answer that was read and lists the address's transactions,
		// without this one, says it is gone.
		if (!Array.isArray(history)) continue;
		const seen = firstSeenMs(row);
		if (seen === null || now - seen < GRACE_MS) continue;
		if (!history.some((entry) => entry && entry.tx_hash === row.txid)) dropped.add(row.txid);
	}
	if (!dropped.size) return rows;
	return rows.map((row) => (row && dropped.has(row.txid) && row.confirmed === false ? { ...row, dropped: true } : row));
}

/** Script hash histories from one Electrum server, all on one connection. */
function electrumLookup(electrum, { requests = electrumRequests, timeoutMs = TIMEOUT_MS } = {}) {
	return async (hashes) => {
		const asked = hashes.map((hash, index) => ({ id: index + 1, method: 'blockchain.scripthash.get_history', params: [hash] }));
		const { replies } = await requests(electrum, asked, { timeoutMs });
		const histories = new Map();
		hashes.forEach((hash, index) => {
			const reply = replies[index + 1];
			if (reply && !reply.error && Array.isArray(reply.result)) histories.set(hash, reply.result);
		});
		return histories;
	};
}

/**
 * The manager's GET /wallets/:id/api/transactions: the daemon's list, with a
 * transaction that can no longer confirm marked `dropped`. One look per
 * wallet stands for CHECK_TTL_MS, so a dashboard that refreshes often asks
 * the server at most that often.
 */
function createTransactionsRoute(manager, { lookupFor = (electrum) => electrumLookup(electrum), now = Date.now } = {}) {
	const checks = new Map();
	return async function transactions(id, query = '') {
		const rec = manager.registry.get(id);
		const rows = await manager._daemonCall(rec, 'GET', `/transactions${query}`);
		if (!Array.isArray(rows) || !rec?.electrum) return rows;
		const pendingIds = rows.filter((row) => row && row.confirmed === false).map((row) => row.txid).sort().join(',');
		if (!pendingIds) return rows;
		const held = checks.get(id);
		let dropped;
		if (held && held.pendingIds === pendingIds && now() - held.at < CHECK_TTL_MS) {
			dropped = held.dropped;
		} else {
			const marked = await markDropped(rows, { network: rec.network, lookup: lookupFor(rec.electrum), now: now() });
			dropped = new Set(marked.filter((row) => row && row.dropped).map((row) => row.txid));
			checks.set(id, { pendingIds, at: now(), dropped });
		}
		return rows.map((row) => (row && dropped.has(row.txid) && row.confirmed === false ? { ...row, dropped: true } : row));
	};
}

module.exports = { markDropped, electrumLookup, createTransactionsRoute, scriptHash, GRACE_MS, CHECK_TTL_MS };
