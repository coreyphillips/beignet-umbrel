// Shared by the assets regtest scenarios: the manager, a wallet's assets
// routes, the stack's bitcoind and its tapd. See README.md.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const M = process.env.MANAGER_URL || 'http://127.0.0.1:3900';
export const PROJECT = process.env.ASSETS_REGTEST_PROJECT || 'umbrel-assets-regtest';
export const TS_TAP_DIR = process.env.TS_TAP_DIR || '';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(...a);

let failures = 0;
export const check = (name, ok, extra = '') => {
	if (!ok) failures += 1;
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
	return ok;
};
/** Call last: the exit code says whether every check passed. */
export const done = (result) => {
	if (result !== undefined) console.log(JSON.stringify(result));
	console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
	process.exit(failures ? 1 : 0);
};

/** One request to the manager or, through it, to a wallet's daemon. */
export async function raw(url, { method = 'GET', body, key } = {}) {
	const headers = {};
	if (body !== undefined) headers['Content-Type'] = 'application/json';
	if (key) headers['X-Idempotency-Key'] = key;
	const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.ok === false) {
		const error = data.error || {};
		// An assets refusal arrives as EXTENSION_ERROR with the host's own
		// code beside it, which is the one a caller acts on.
		const e = new Error(error.message || `${method} ${url} -> ${res.status}`);
		e.code = (error.extension && error.extension.code) || error.code;
		e.details = (error.extension && error.extension.details) || error.details;
		e.status = res.status;
		throw e;
	}
	return data.result;
}
export const api = (path, opts) => raw(`${M}/api${path}`, opts);
export const w = (id, path, opts) => raw(`${M}/wallets/${id}/api${path}`, opts);
/** A wallet's assets routes. */
export const x = (id, path, opts) => w(id, `/x/assets${path}`, opts);
export const post = (id, path, body = {}, key) => x(id, path, { method: 'POST', body, key });
/** A key for one money-moving request, kept across its retries. */
export const idem = () => randomBytes(16).toString('hex');

export async function waitFor(desc, fn, { timeoutMs = 120000, everyMs = 1000 } = {}) {
	const t0 = Date.now();
	let last;
	for (;;) {
		let v;
		try {
			v = await fn();
		} catch (e) {
			last = e;
			v = null;
		}
		if (v) {
			console.log(`  ok: ${desc} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
			return v;
		}
		if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${desc}${last ? `: ${last.message}` : ''}`);
		await sleep(everyMs);
	}
}

/** The refusal a call makes, or null when it succeeds. */
export async function refusal(fn) {
	try {
		await fn();
		return null;
	} catch (e) {
		return e;
	}
}

/* ------------------------------------------------------------- the chain */

const compose = (args, opts = {}) =>
	execFileSync('docker', ['compose', '-p', PROJECT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

export const btc = (...args) =>
	compose(['exec', '-T', 'bitcoind', 'bitcoin-cli', '-regtest', '-rpcport=18443', '-rpcuser=taptest', '-rpcpassword=taptest', ...args.map(String)]);
const miner = (...args) => btc('-rpcwallet=mining', ...args);

export const height = () => Number(btc('getblockcount'));
export function mine(n = 1) {
	miner('generatetoaddress', n, miner('getnewaddress'));
	return height();
}
export const sendTo = (address, sats) => miner('sendtoaddress', address, (sats / 1e8).toFixed(8));
export const mempool = () => JSON.parse(btc('getrawmempool'));
export const inMempool = (txid) => mempool().includes(txid);
export const txConfirmations = (txid) => {
	try {
		return JSON.parse(btc('getrawtransaction', txid, 'true')).confirmations || 0;
	} catch (_) {
		return null;
	}
};

/* ------------------------------------------------------------------ tapd */

export function tapcli(...args) {
	const out = compose(['exec', '-T', 'tapd', 'tapcli', '--network=regtest', ...args.map(String)]);
	try {
		return JSON.parse(out);
	} catch (_) {
		return out;
	}
}

/** Mint one asset in tapd and return it as tapd lists it, confirmed. */
export async function tapdMint({ name, amount, type = 'normal', decimals = 0, grouped = false }) {
	const args = ['assets', 'mint', '--type', type, '--name', name, '--supply', amount];
	if (decimals) args.push('--decimal_display', decimals, '--meta_type', 'json', '--meta_bytes', '{}');
	if (grouped) args.push('--new_grouped_asset');
	tapcli(...args);
	tapcli('assets', 'mint', 'finalize');
	await sleep(1500);
	// tapd lists a mint at its first confirmation and puts it in its universe,
	// where this app looks an unknown asset up, only once it is six deep.
	mine(6);
	const minted = await waitFor(`tapd minted ${name}`, () => {
		const all = tapcli('assets', 'list').assets || [];
		return all.find((a) => a.asset_genesis && a.asset_genesis.name === name && a.chain_anchor && Number(a.chain_anchor.block_height) > 0);
	});
	await waitFor(`tapd's universe holds ${name}`, () => tapdKnows(minted.asset_genesis.asset_id));
	return minted;
}

/**
 * tapd's own verdict on a proof file, read from its command line: it checks
 * every proof in the file's history against its chain. { valid, ... }.
 */
export function tapdVerifies(fileBytes) {
	let out;
	try {
		out = compose(['exec', '-T', 'tapd', 'tapcli', '--network=regtest', 'proofs', 'verify', '--proof_file', '-'], {
			input: Buffer.from(fileBytes),
			stdio: ['pipe', 'pipe', 'pipe']
		});
	} catch (err) {
		// A file it will not have ends the command with an error, not an answer.
		return { valid: false, said: String(err.stderr || err.message).trim().slice(0, 300) };
	}
	try {
		return JSON.parse(out);
	} catch (_) {
		return { valid: false, said: out };
	}
}

/** Whether tapd's universe holds the issuance of an asset: it stores one only after verifying it. */
export const tapdKnows = (assetId) => Object.values(tapcli('universe', 'roots').universe_roots || {}).some((r) => r.id && r.id.asset_id === assetId);

export const tapdBalance = (assetId) => {
	const balances = tapcli('assets', 'balance').asset_balances || {};
	return (balances[assetId] && balances[assetId].balance) || '0';
};

/* --------------------------------------------------------------- wallets */

export const healthy = (id) => waitFor(`wallet ${id.slice(0, 8)} healthy`, async () => (await api(`/wallets/${id}`)).healthy);

/** A new regtest wallet with spendable coins and its assets host ready. */
export async function newWallet(name, { sats = 2_000_000, onchainOnly = false } = {}) {
	const { record } = await api('/wallets', { method: 'POST', body: { name, network: 'regtest', onchainOnly } });
	await healthy(record.id);
	if (sats > 0) await fund(record.id, sats);
	await assetsReady(record.id);
	return record;
}

export async function fund(id, sats) {
	const { address } = await w(id, '/address/new', { method: 'POST', body: {} });
	const txid = sendTo(address, sats);
	mine(1);
	await waitFor(`wallet ${id.slice(0, 8)} sees ${sats} sats`, async () => {
		const b = await w(id, '/balance');
		return (b.onchain ?? b.confirmed ?? 0) >= sats;
	});
	return { address, txid };
}

export const assetsReady = (id) =>
	waitFor(`assets ready on ${id.slice(0, 8)}`, async () => {
		const s = await x(id, '/status');
		if (s.phase === 'failed') throw new Error(`assets host failed: ${s.error}`);
		return s.ready ? s : null;
	});

/** The process of a wallet's daemon, found by the port it listens on. */
export async function daemonPid(id) {
	const { port } = await api(`/wallets/${id}`);
	try {
		const out = execFileSync('lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		return Number(out.trim().split('\n')[0]) || null;
	} catch (_) {
		return null;
	}
}

/**
 * Kill a wallet's daemon outright, as a power cut would, and wait for the
 * manager to bring it back with its assets host ready. Nothing is flushed
 * and no stop handler runs.
 */
export async function crash(id) {
	const pid = await daemonPid(id);
	if (!pid) throw new Error(`no daemon found for ${id}`);
	process.kill(pid, 'SIGKILL');
	await waitFor(`daemon of ${id.slice(0, 8)} is back`, async () => {
		const now = await daemonPid(id);
		return now && now !== pid;
	});
	await healthy(id);
	return assetsReady(id);
}

export const status = (id) => x(id, '/status');
export const balances = (id) => x(id, '/balances');
export const holding = async (id, key) => ((await balances(id)).assets || []).find((a) => a.key === key || a.assetId === key) || null;
export const onchain = async (id, key) => ((await holding(id, key)) || { balance: { onchain: '0' } }).balance.onchain;
export const activity = (id, params = {}) => {
	const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();
	return x(id, `/activity${q ? `?${q}` : ''}`);
};
export const rowOf = async (id, rowId) => ((await activity(id, { limit: 200 })).rows || []).find((r) => r.id === rowId) || null;

/** Wait for a row to reach one of `states`, mining a block between looks when asked. */
export function rowReaches(id, rowId, states, { mineEach = false, timeoutMs = 120000 } = {}) {
	const wanted = Array.isArray(states) ? states : [states];
	return waitFor(
		`row ${rowId.slice(0, 12)} ${wanted.join(' or ')}`,
		async () => {
			const row = await rowOf(id, rowId);
			if (row && row.failed && !wanted.includes('failed') && !(row.failure && row.failure.retrying)) {
				throw new Error(`row failed: ${JSON.stringify(row.failure)}`);
			}
			if (row && wanted.includes(row.state)) return row;
			if (mineEach) mine(1);
			return null;
		},
		{ timeoutMs, everyMs: mineEach ? 2000 : 1000 }
	);
}

/** Mint through the app and wait until the assets are spendable. */
export async function mintAndConfirm(id, seedlings, { feeRate = 2 } = {}) {
	const { row } = await post(id, '/mint', { seedlings, feeRate }, idem());
	mine(1);
	const final = await rowReaches(id, row.id, 'complete', { mineEach: true });
	return final;
}
