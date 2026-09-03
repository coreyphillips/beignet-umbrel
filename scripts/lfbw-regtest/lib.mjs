import { execSync } from 'node:child_process';
export const M = 'http://127.0.0.1:3900';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function raw(url, { method = 'GET', body } = {}) {
	const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.ok === false) { const e = new Error(data.error?.message || `${path} ${res.status}`); e.code = data.error?.code; e.details = data.error?.details; throw e; }
	return data.result;
}
export const api = (path, opts) => raw(`${M}/api${path}`, opts);
export const w = (id, path, opts) => raw(`${M}/wallets/${id}/api${path}`, opts);
export const btc = (args) => execSync(`docker exec bitcoin bitcoin-cli -rpcport=43782 -rpcuser=polaruser -rpcpassword=polarpass -rpcwallet=default ${args}`).toString().trim();
export const mine = (n = 1) => btc(`-generate ${n}`);
export const cln = (args) => execSync(`docker exec cln lightning-cli --network=regtest ${args}`).toString().trim();
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
export async function fund(id, sats, { confirm = true } = {}) {
	const { address } = await w(id, '/address/new', { method: 'POST', body: {} });
	const txid = btc(`sendtoaddress ${address} ${(sats / 1e8).toFixed(8)}`);
	if (confirm) mine(1);
	return { address, txid };
}
export const healthy = (id) => waitFor(`wallet ${id.slice(0, 8)} healthy`, async () => (await api(`/wallets/${id}`)).healthy);
