import { api, w, cln, mine, waitFor, check, log, fund, healthy, sleep, listenPortOf, PRIMARY_LOCAL_HOST } from './lib.mjs';
const { P, Pnode } = JSON.parse(process.argv[2]);
// L3 names P as an EXTERNAL node by URI: no starting channel and no env
// change on P. The wallet still trusts its chosen primary, in both modes:
// without that the primary cannot provision inbound just in time, because
// its zero-conf open is refused as untrusted (lfbw.js normalizeLfbw). The
// external node's trust toward us is its own business, which is what the
// dependent check below is about.
const pEnvBefore = (await api(`/wallets/${P}`)).liquidityProvider;
const L3 = (await api('/wallets', { method: 'POST', body: { name: 'External phone', network: 'regtest', lfbw: { enabled: true, primaryUri: `${Pnode}@${PRIMARY_LOCAL_HOST}:${await listenPortOf(P)}` } } })).record;
const rec = await waitFor('L3 setup ready', async () => { const r = await api(`/wallets/${L3.id}`); if (r.lfbw.setup === 'failed') throw new Error(r.lfbw.setupError); return r.lfbw.setup === 'ready' ? r : null; }, { timeoutMs: 120000 });
check('external mode recorded', rec.lfbw.mode === 'external' && rec.lfbw.primaryPubkey === Pnode && rec.lfbw.trusted === true, `mode ${rec.lfbw.mode} trusted ${rec.lfbw.trusted}`);
const trust = await w(L3.id, '/trusted-peers');
check('the wallet trusts its chosen primary in external mode too', trust.some((t) => t.pubkey === Pnode && t.trusted), JSON.stringify(trust));
const df = await w(L3.id, '/direct-funding/config');
check('direct-funding policy names the external node, buys inbound alongside', df.lspPubkey === Pnode && df.targetInboundSat === 100000 && df.trusted === true, JSON.stringify(df));
check('P not listed as dependent of an external pairing', !(await api(`/wallets/${P}`)).lfbwDependents.some((d) => d.id === L3.id));
// JIT through the external node: an empty wallet's invoice, paid by CLN.
// 03 spends CLN's outbound toward P, and this script always runs after it,
// so top CLN up first or the pay fails for want of liquidity rather than
// for anything this script is testing.
const NEED_MSAT = 60_000_000;
const outboundToP = () => (JSON.parse(cln('listpeerchannels')).channels.find((c) => c.peer_id === Pnode && c.state === 'CHANNELD_NORMAL')?.spendable_msat ?? 0);
if (outboundToP() < NEED_MSAT) {
	const topup = JSON.parse(cln(`invoice ${NEED_MSAT * 2} topup-${Date.now()} "cln outbound for the external jit"`));
	const paid = await w(P, '/invoice/pay-safe', { method: 'POST', body: { bolt11: topup.bolt11 } });
	log('topped CLN up', paid.status, `spendable now ${outboundToP()} msat`);
}
check('CLN has outbound to pay through P', outboundToP() >= NEED_MSAT, `${outboundToP()} msat`);
const inv = await w(L3.id, '/jit/invoice', { method: 'POST', body: { lspPubkey: Pnode, amountSats: 40000, description: 'external jit', targetRemainingInboundSat: 10000 } });
let out = '';
try { out = cln(`pay ${inv.bolt11}`); } catch (e) { out = String(e.stdout || e.message); }
log('cln pay:', out.replace(/\s+/g, ' ').replace(/^#[^{]*/, '').slice(0, 120));
const chan = await waitFor('L3 got a channel from the external node with the payment', async () => { const c = await w(L3.id, '/channels'); const h = c.find((x) => x.peerPubkey === Pnode); return h && h.localBalanceSats >= 39000 ? h : null; }, { timeoutMs: 90000 }).catch(() => null);
check('JIT through an external primary', !!chan, chan ? JSON.stringify({ state: chan.state, usable: chan.htlcUsable, cap: chan.capacitySats, local: chan.localBalanceSats }) : JSON.stringify(await w(L3.id, '/channels')));
if (chan && !(chan.htlcUsable ?? chan.state === 'NORMAL')) {
	await mine(3);
	const usable = await waitFor('channel usable after confirmations (untrusted external)', async () => { const c = await w(L3.id, '/channels'); const h = c.find((x) => x.peerPubkey === Pnode); return h && (h.htlcUsable ?? h.state === 'NORMAL') ? h : null; }, { timeoutMs: 120000 }).catch(() => null);
	check('untrusted external channel confirms before use', !!usable);
}
// Channelize toward an external primary: a dual-funded open buying inbound, falling back to a plain open when it sells none.
await fund(L3.id, 300000);
await waitFor('L3 sees 300k', async () => (await w(L3.id, '/balance')).onchain >= 300000);
await sleep(12000);
const logs = await api(`/wallets/${L3.id}/logs`);
log(logs.filter((l) => /lightning-first/.test(l)).slice(-4).join('\n'));
const chans = await w(L3.id, '/channels');
check('confirmed deposit moved toward the external primary', chans.some((c) => c.peerPubkey === Pnode && c.capacitySats >= 250000) || logs.some((l) => /splicing|moving .* into a new channel|dual-funded open/.test(l)), JSON.stringify(chans.map((c) => [c.state, c.capacitySats, c.localBalanceSats])));
console.log(JSON.stringify({ L3: L3.id }));
