import { api, w, btc, mine, waitFor, check, log, fund, healthy, sleep } from './lib.mjs';
// 1. Primary P, funded.
const P = (await api('/wallets', { method: 'POST', body: { name: 'Primary', network: 'regtest' } })).record;
log('P', P.id, 'port', P.port);
await healthy(P.id);
await fund(P.id, 5_000_000);
await waitFor('P funded', async () => (await w(P.id, '/balance')).onchain >= 5_000_000);
// 2. L1, lightning-first on P, 200k starting channel.
const L1 = (await api('/wallets', { method: 'POST', body: { name: 'Spending', network: 'regtest', lfbw: { enabled: true, primaryWalletId: P.id, initialChannelSats: 200000 } } })).record;
log('L1', L1.id, 'lfbw', JSON.stringify(L1.lfbw));
const ready = await waitFor('L1 setup ready', async () => { const r = await api(`/wallets/${L1.id}`); if (r.lfbw.setup === 'failed') throw new Error('setup failed: ' + r.lfbw.setupError); return r.lfbw.setup === 'ready' ? r : null; }, { timeoutMs: 180000 });
const Prec = await api(`/wallets/${P.id}`);
check('P is now a liquidity provider', Prec.liquidityProvider === true);
check('P lists L1 as dependent', Prec.lfbwDependents.some((d) => d.id === L1.id));
const plogs = await api(`/wallets/${P.id}/logs`);
check('P restarted for the provider role', plogs.some((l) => /restarting as a liquidity provider/.test(l)));
const l1trust = await w(L1.id, '/trusted-peers');
const ptrust = await w(P.id, '/trusted-peers');
check('L1 trusts P', l1trust.some((t) => t.pubkey === Prec.nodeId), JSON.stringify(l1trust));
check('P trusts L1', ptrust.some((t) => t.pubkey === ready.nodeId), JSON.stringify(ptrust));
const df = await w(L1.id, '/direct-funding/config');
check('L1 direct-funding policy names P with allowSplice', df.lspPubkey === Prec.nodeId && df.allowSplice === true && df.trusted === true, JSON.stringify(df));
const chans = await waitFor('starting channel usable without mining', async () => { const c = await w(L1.id, '/channels'); const home = c.find((x) => x.peerPubkey === Prec.nodeId && (x.htlcUsable ?? x.state === 'NORMAL')); return home ? c : null; }, { timeoutMs: 60000 });
const home = chans.find((x) => x.peerPubkey === Prec.nodeId);
check('home channel 200k from P, zero-conf', home.capacitySats === 200000 && home.remoteBalanceSats >= 190000, JSON.stringify({ state: home.state, cap: home.capacitySats, local: home.localBalanceSats, remote: home.remoteBalanceSats }));
log('blockcount', btc('getblockcount'));
console.log(JSON.stringify({ P: P.id, L1: L1.id, Pnode: Prec.nodeId, L1node: ready.nodeId }));
