import { execSync } from 'node:child_process';

// Two chain drivers. Without REGTEST_API the scripts shell out to a Polar
// style bitcoind exactly as they always have. With it set, funding, mining
// and the waits go through bitcoin-regtest-dashboard's control API, which
// confirms in the same call it sends and hands back the outpoint.
export const CHAIN = process.env.REGTEST_API ? 'api' : 'docker';
export const API = (process.env.REGTEST_API || '').replace(/\/$/, '');
export const M = process.env.MANAGER_URL || 'http://127.0.0.1:3900';
export const BTC_CONTAINER = process.env.BTC_CONTAINER || 'bitcoin';
export const BTC_CLI_ARGS = process.env.BTC_CLI_ARGS || '-rpcport=43782 -rpcuser=polaruser -rpcpassword=polarpass -rpcwallet=default';
export const CLN_CONTAINER = process.env.CLN_CONTAINER ?? 'cln';
export const CLN_NETWORK = process.env.CLN_NETWORK || 'regtest';
// What a beignet daemon dials to reach CLN.
export const CLN_P2P_HOST = process.env.CLN_P2P_HOST || '127.0.0.1';
export const CLN_P2P_PORT = Number(process.env.CLN_P2P_PORT || 19846);
// What CLN dials to reach a manager daemon, and what a sibling daemon dials.
export const PRIMARY_DIAL_HOST = process.env.PRIMARY_DIAL_HOST || 'host.docker.internal';
export const PRIMARY_LOCAL_HOST = process.env.PRIMARY_LOCAL_HOST || '127.0.0.1';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function raw(url, { method = 'GET', body } = {}) {
	const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.ok === false) {
		// Not `path`: that is a parameter of api() and w(), not of this
		// function, so every error without a message used to die as
		// "ReferenceError: path is not defined" and lose the real status.
		const e = new Error(data.error?.message || `${method} ${url} -> ${res.status}`);
		e.code = data.error?.code;
		e.details = data.error?.details;
		e.status = res.status;
		e.url = url;
		throw e;
	}
	return data.result;
}
export const api = (path, opts) => raw(`${M}/api${path}`, opts);
export const w = (id, path, opts) => raw(`${M}/wallets/${id}/api${path}`, opts);

// The dashboard answers bare JSON, not the manager's {ok, result}, so it
// needs its own client. Errors are {error, rpcCode?, hint?}.
export async function chain(path, { method = 'GET', body } = {}) {
	if (CHAIN !== 'api') throw new Error('chain() needs REGTEST_API');
	const headers = {};
	if (body) headers['Content-Type'] = 'application/json';
	if (process.env.REGTEST_API_TOKEN) headers.Authorization = `Bearer ${process.env.REGTEST_API_TOKEN}`;
	const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const e = new Error(data.error || `${method} ${path} -> ${res.status}`);
		e.status = res.status;
		e.hint = data.hint;
		e.rpcCode = data.rpcCode;
		throw e;
	}
	return data;
}

// Async on both paths. The docker branch still runs execSync before it
// yields, so an unawaited call behaves as it always did; the api branch has
// to be awaited, which is why every call site now does.
export async function btc(args) {
	if (CHAIN === 'api') {
		const parts = String(args).trim().split(/\s+/);
		if (parts[0] === '-generate') return JSON.stringify(await mine(Number(parts[1] || 1)));
		const [method, ...params] = parts;
		const out = await rpc(method, params.map(coerce));
		return typeof out === 'string' ? out : JSON.stringify(out);
	}
	return execSync(`docker exec ${BTC_CONTAINER} bitcoin-cli ${BTC_CLI_ARGS} ${args}`).toString().trim();
}
const coerce = (v) => (/^-?\d+$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v);

export const rpc = (method, params = []) => chain('/rpc', { method: 'POST', body: { method, params } }).then((r) => r.result);

export async function mine(n = 1) {
	if (CHAIN === 'api') return chain('/mine', { method: 'POST', body: { blocks: n } });
	return execSync(`docker exec ${BTC_CONTAINER} bitcoin-cli ${BTC_CLI_ARGS} -generate ${n}`).toString().trim();
}

export const cln = (args) => {
	if (!CLN_CONTAINER) throw Object.assign(new Error('no CLN container configured (CLN_CONTAINER is empty)'), { skip: true });
	const out = execSync(`docker exec ${CLN_CONTAINER} lightning-cli --network=${CLN_NETWORK} ${args}`).toString();
	// `pay` prints route debug lines starting with # before its JSON, which
	// makes JSON.parse throw on output that is otherwise fine.
	return out.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
};

export async function waitFor(desc, fn, { timeoutMs = 90000, everyMs = 1000 } = {}) {
	const t0 = Date.now();
	for (;;) {
		let v;
		try { v = await fn(); } catch (e) { v = null; }
		if (v) { console.log(`  ok: ${desc} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); return v; }
		if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${desc}`);
		await sleep(everyMs);
	}
}

export const log = (...a) => console.log(...a);
export const check = (name, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
export const skip = (name, why) => console.log(`SKIP ${name} :: ${why}`);

// The three clocks a chain assertion depends on. bitcoind sees a block
// first, electrs indexes it, and only then does a daemon's Electrum client
// report it. Printing all three turns "the balance is wrong" into a
// diagnosis: chain > electrs is electrs lag, electrs > wallet is the
// daemon's client, all three equal is the engine.
export async function chainTip() {
	if (CHAIN === 'api') return (await chain('/status')).chain.blocks;
	return Number(execSync(`docker exec ${BTC_CONTAINER} bitcoin-cli ${BTC_CLI_ARGS} getblockcount`).toString().trim());
}
export async function electrsTip() {
	if (CHAIN !== 'api') return null;
	// The route answers a bare number, not an object.
	const t = await chain('/electrs/blocks/tip/height');
	return typeof t === 'number' ? t : (t?.height ?? null);
}
export const walletTip = (id) => w(id, '/health').then((h) => h.blockHeight ?? null).catch(() => null);
export async function tips(id) {
	const [c, e, v] = await Promise.all([chainTip().catch(() => null), electrsTip().catch(() => null), id ? walletTip(id) : null]);
	return `chain=${c} electrs=${e} wallet=${v}`;
}

// Always reads satisfied/timedOut: the dashboard's wait endpoints answer
// HTTP 200 on timeout too, so branching on res.ok turns a timeout into a
// silent pass.
export async function waitTx(txid, { confirmations = 1, timeoutMs = 60000 } = {}) {
	if (CHAIN === 'api') {
		const r = await chain(`/wait/tx/${txid}?confirmations=${confirmations}&timeout=${Math.ceil(timeoutMs / 1000)}`);
		if (!r.satisfied) throw new Error(`waitTx ${txid.slice(0, 12)} timed out at ${r.confirmations} of ${confirmations} conf (inMempool=${r.inMempool})`);
		return r;
	}
	return waitFor(`tx ${txid.slice(0, 12)} at ${confirmations} conf`, async () => {
		try { const t = JSON.parse(await btc(`getrawtransaction ${txid} 1`)); return (t.confirmations || 0) >= confirmations ? t : null; } catch { return null; }
	}, { timeoutMs });
}
export async function waitMempool(txid, { timeoutMs = 60000 } = {}) {
	if (CHAIN !== 'api') return null;
	return chain(`/wait/mempool/${txid}?timeout=${Math.ceil(timeoutMs / 1000)}`);
}
// The gate the balance assertions were missing: the wallet's own view, not
// the chain's.
export const waitWalletSeesTx = (id, txid, { confirmed = true, timeoutMs = 90000 } = {}) =>
	waitFor(`wallet ${id.slice(0, 8)} sees ${txid.slice(0, 12)}${confirmed ? ' confirmed' : ''}`, async () => {
		const txs = await w(id, '/transactions');
		const t = txs.find((x) => x.txid === txid);
		return t && (!confirmed || t.confirmed) ? t : null;
	}, { timeoutMs });

export async function fund(id, sats, { confirm = true, settle = confirm, key, bootstrap = true } = {}) {
	const { address } = await w(id, '/address/new', { method: 'POST', body: {} });
	if (CHAIN === 'api') {
		const r = await chain('/faucet', {
			method: 'POST',
			body: { address, amount: Number((sats / 1e8).toFixed(8)), confirmations: confirm ? 1 : 0, feeRate: 1, bootstrap, idempotencyKey: key }
		});
		if (settle) { await waitTx(r.txid, { confirmations: confirm ? 1 : 0 }); await waitWalletSeesTx(id, r.txid, { confirmed: confirm }); }
		return { address, txid: r.txid, vout: r.vout, amountSats: r.amountSats, blockHash: r.blockHash, blockHeight: r.blockHeight, minedBlocks: r.minedBlocks, bootstrap: r.bootstrap };
	}
	const txid = btc(`sendtoaddress ${address} ${(sats / 1e8).toFixed(8)}`);
	if (confirm) await mine(1);
	if (settle) await waitWalletSeesTx(id, txid, { confirmed: confirm });
	return { address, txid, vout: null, amountSats: sats, blockHash: null, blockHeight: null, minedBlocks: null, bootstrap: null };
}

export const reorg = (body) => chain('/chain/reorg', { method: 'POST', body });

export const healthy = (id) => waitFor(`wallet ${id.slice(0, 8)} healthy`, async () => (await api(`/wallets/${id}`)).healthy);
// The manager publishes the daemon's Lightning listen port, so nothing needs
// to assume 9901.
export const listenPortOf = (id) => api(`/wallets/${id}`).then((r) => r.listenPort);
