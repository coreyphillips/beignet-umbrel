import { api, w, btc, mine, cln, waitFor, check, log, fund, healthy, sleep } from './lib.mjs';
const ids = JSON.parse(process.argv[2]);
const { P, Pnode } = ids;
// CLN opens a channel to P so it can pay P's dependents.
const clnId = JSON.parse(cln('getinfo')).id;
try { log(cln(`connect ${Pnode}@host.docker.internal:9901`).slice(0, 120)); } catch (e) { log('connect', e.message.slice(0, 200)); }
const existing = JSON.parse(cln('listpeerchannels')).channels.filter((c) => c.peer_id === Pnode && c.state === 'CHANNELD_NORMAL');
if (existing.length === 0) {
	// P opens to CLN (a CLN-initiated v2 open trips a one-sat fee rounding refusal in the engine, filed separately).
	const open = await w(P, '/channel/connect-and-open', { method: 'POST', body: { pubkey: clnId, host: '127.0.0.1', port: 19846, amountSats: 1000000 } });
	log('P open to CLN', open.state || JSON.stringify(open).slice(0, 80));
	await new Promise((r) => setTimeout(r, 6000));
	mine(6);
	await waitFor('cln channel with P normal', () => JSON.parse(cln('listpeerchannels')).channels.some((c) => c.peer_id === Pnode && c.state === 'CHANNELD_NORMAL'), { timeoutMs: 180000, everyMs: 3000 });
	// Give CLN outbound toward P: P pays a CLN invoice over the new channel.
	await waitFor('P sees the CLN channel usable', async () => (await w(P, '/channels')).some((c) => c.peerPubkey === clnId && (c.htlcUsable ?? c.state === 'NORMAL')), { timeoutMs: 120000 });
	const clnInv = JSON.parse(cln(`invoice 500000000 lfbw-${Date.now()} "outbound for cln"`));
	const paid = await w(P, '/invoice/pay-safe', { method: 'POST', body: { bolt11: clnInv.bolt11 } });
	log('P paid CLN', paid.status, paid.failureDescription || '');
}
await waitFor('P sees the CLN channel usable', async () => (await w(P, '/channels')).some((c) => c.peerPubkey === clnId && (c.htlcUsable ?? c.state === 'NORMAL')), { timeoutMs: 120000 });
const pBefore = (await w(P, '/balance')).onchain;
// L2: lightning-first on P, no starting channel, no funds.
const L2 = (await api('/wallets', { method: 'POST', body: { name: 'Empty phone', network: 'regtest', lfbw: { enabled: true, primaryWalletId: P } } })).record;
const L2rec = await waitFor('L2 setup ready', async () => { const r = await api(`/wallets/${L2.id}`); if (r.lfbw.setup === 'failed') throw new Error(r.lfbw.setupError); return r.lfbw.setup === 'ready' ? r : null; }, { timeoutMs: 120000 });
check('L2 has no channel yet', (await w(L2.id, '/channels')).length === 0);
// A JIT invoice for 30k: the primary provisions the channel when it is paid.
const inv = await w(L2.id, '/jit/invoice', { method: 'POST', body: { lspPubkey: Pnode, amountSats: 30000, description: 'jit test', targetRemainingInboundSat: 10000 } });
check('JIT invoice minted with the quoted fee', !!inv.bolt11 && inv.flatFeeSat === 0 && inv.feePpm === 0, JSON.stringify({ flat: inv.flatFeeSat, ppm: inv.feePpm }));
// Over the wallet's ceiling: refused before any invoice exists.
try { await w(L2.id, '/jit/invoice', { method: 'POST', body: { lspPubkey: Pnode, amountSats: 5_000_000, description: 'too big' } }); check('over-cap JIT refused', false); } catch (e) { check('over-cap JIT refused before an invoice exists', true, `${e.code}: ${e.message.slice(0, 100)}`); }
// CLN pays it.
let pay;
try { pay = JSON.parse(cln(`pay ${inv.bolt11}`)); log('cln pay', pay.status, 'parts', pay.parts); } catch (e) { log('cln pay failed:', e.message.slice(0, 400)); }
const chan = await waitFor('L2 has a channel from P with the payment', async () => { const c = await w(L2.id, '/channels'); const h = c.find((x) => x.peerPubkey === Pnode); return h && h.localBalanceSats >= 29000 ? h : null; }, { timeoutMs: 90000 });
check('zero-conf JIT channel usable with 30k local', (chan.htlcUsable ?? chan.state === 'NORMAL') && chan.localBalanceSats >= 29000, JSON.stringify({ state: chan.state, cap: chan.capacitySats, local: chan.localBalanceSats, remote: chan.remoteBalanceSats }));
const invs = await w(L2.id, '/invoices');
check('invoice reads paid', invs.some((i) => i.paymentHash === inv.paymentHash && /PAID|COMPLETED/.test(i.status)), JSON.stringify(invs.map((i) => i.status)));
const pAfter = (await w(P, '/balance')).onchain;
check('P fronted the channel from its on-chain balance', pAfter < pBefore, `P onchain ${pBefore} -> ${pAfter}`);
// A second payment while the channel is short: 250k over a 30k-local channel needs a splice hold.
const inv2 = await w(L2.id, '/jit/invoice', { method: 'POST', body: { lspPubkey: Pnode, amountSats: 250000, description: 'jit splice', targetRemainingInboundSat: 10000 } });
try { const p2 = JSON.parse(cln(`pay ${inv2.bolt11}`)); log('cln pay 2', p2.status); } catch (e) { log('cln pay 2 failed:', e.message.slice(0, 300)); }
const grown = await waitFor('L2 balance grew by the second payment', async () => { const c = await w(L2.id, '/channels'); const h = c.filter((x) => x.peerPubkey === Pnode); const local = h.reduce((s, x) => s + x.localBalanceSats, 0); return local >= 270000 ? h : null; }, { timeoutMs: 120000 }).catch((e) => { log(e.message); return null; });
check('second JIT payment landed (splice or new channel)', !!grown, grown ? JSON.stringify(grown.map((c) => [c.state, c.capacitySats, c.localBalanceSats])) : '');
console.log(JSON.stringify({ ...ids, L2: L2.id }));
