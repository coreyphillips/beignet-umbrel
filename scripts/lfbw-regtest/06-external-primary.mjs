import { api, w, cln, mine, waitFor, check, log, fund, healthy, sleep } from './lib.mjs';
const { P, Pnode } = JSON.parse(process.argv[2]);
// L3 names P as an EXTERNAL node by URI: no return trust, no starting channel, no env change on P.
const pEnvBefore = (await api(`/wallets/${P}`)).liquidityProvider;
const L3 = (await api('/wallets', { method: 'POST', body: { name: 'External phone', network: 'regtest', lfbw: { enabled: true, primaryUri: `${Pnode}@127.0.0.1:9901` } } })).record;
const rec = await waitFor('L3 setup ready', async () => { const r = await api(`/wallets/${L3.id}`); if (r.lfbw.setup === 'failed') throw new Error(r.lfbw.setupError); return r.lfbw.setup === 'ready' ? r : null; }, { timeoutMs: 120000 });
check('external mode recorded', rec.lfbw.mode === 'external' && rec.lfbw.primaryPubkey === Pnode && rec.lfbw.trusted === false);
const trust = await w(L3.id, '/trusted-peers');
check('no trust toward an external primary unless asked', trust.length === 0, JSON.stringify(trust));
const df = await w(L3.id, '/direct-funding/config');
check('direct-funding policy names the external node, buys inbound alongside', df.lspPubkey === Pnode && df.targetInboundSat === 100000 && df.trusted === false, JSON.stringify(df));
check('P not listed as dependent of an external pairing', !(await api(`/wallets/${P}`)).lfbwDependents.some((d) => d.id === L3.id));
// JIT through the external node: an empty wallet's invoice, paid by CLN.
const inv = await w(L3.id, '/jit/invoice', { method: 'POST', body: { lspPubkey: Pnode, amountSats: 40000, description: 'external jit', targetRemainingInboundSat: 10000 } });
let out = '';
try { out = cln(`pay ${inv.bolt11}`); } catch (e) { out = String(e.stdout || e.message); }
log('cln pay:', out.replace(/\s+/g, ' ').replace(/^#[^{]*/, '').slice(0, 120));
const chan = await waitFor('L3 got a channel from the external node with the payment', async () => { const c = await w(L3.id, '/channels'); const h = c.find((x) => x.peerPubkey === Pnode); return h && h.localBalanceSats >= 39000 ? h : null; }, { timeoutMs: 90000 }).catch(() => null);
check('JIT through an external primary', !!chan, chan ? JSON.stringify({ state: chan.state, usable: chan.htlcUsable, cap: chan.capacitySats, local: chan.localBalanceSats }) : JSON.stringify(await w(L3.id, '/channels')));
if (chan && !(chan.htlcUsable ?? chan.state === 'NORMAL')) {
	mine(3);
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
