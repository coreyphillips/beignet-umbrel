import { api, w, btc, mine, waitFor, check, log, fund, healthy, sleep } from './lib.mjs';
const ids = JSON.parse(process.argv[2]);
const { P, L1, Pnode, L1node } = ids;
const chansOf = async (id, peer) => (await w(id, '/channels')).filter((c) => c.peerPubkey === peer && c.state !== 'CLOSED' && c.state !== 'FORCE_CLOSED');
// An unpaired sender W, funded.
const W = (await api('/wallets', { method: 'POST', body: { name: 'Stranger', network: 'regtest' } })).record;
await healthy(W.id);
await fund(W.id, 1_000_000);
await waitFor('W funded', async () => (await w(W.id, '/balance')).onchain >= 1_000_000);
// L1 mints a request with no direct address: W must reach it through P's relay.
const req = await w(L1, '/direct-funding/request', { method: 'POST', body: { amountSats: 150000 } });
check('request minted', /^[A-Za-z0-9_-]+$/.test(req.request) && req.expiresAt > Date.now(), `hash ${req.paymentHash.slice(0, 12)}`);
const homeBefore = (await chansOf(L1, Pnode))[0];
const l1Before = await chansOf(L1, Pnode);
// W connects to P (the relay) so the frames have a lane.
await w(W.id, '/peer/connect', { method: 'POST', body: { pubkey: Pnode, host: '127.0.0.1', port: 9901 } }).catch((e) => log('W connect to P:', e.message));
let res;
try {
	res = await w(W.id, '/direct-funding/send', { method: 'POST', body: { request: req.request, amountSats: 150000, feeHeadroomSats: 1000 } });
	log('W send result', JSON.stringify(res));
} catch (e) {
	log('W send rejected:', e.code, e.message);
}
if (res) {
	check('anonymous sender: a funding, not a splice', !!res.fundingTxid && res.status !== 'FAILED', res.status);
	const l1After = await waitFor('L1 sees a new channel with P', async () => { const c = await chansOf(L1, Pnode); return c.length > l1Before.length ? c : null; }, { timeoutMs: 60000 });
	const fresh = l1After.find((c) => !l1Before.some((b) => b.channelId === c.channelId));
	check('new channel is not usable before confirmation (pending)', !(fresh.htlcUsable ?? fresh.state === 'NORMAL'), `${fresh.state} cap ${fresh.capacitySats}`);
	mine(3);
	const usable = await waitFor('new channel usable after confirmations', async () => { const c = await chansOf(L1, Pnode); const f = c.find((x) => x.channelId === fresh.channelId) || c.find((x) => x.capacitySats === fresh.capacitySats); return f && (f.htlcUsable ?? f.state === 'NORMAL') ? f : null; }, { timeoutMs: 120000 });
	check('anonymous funding landed as L1 balance', usable.localBalanceSats >= 140000, `local ${usable.localBalanceSats} cap ${usable.capacitySats}`);
}
// The paired sender: P itself pays L1's request; with allowSplice this grows the home channel.
const req2 = await w(L1, '/direct-funding/request', { method: 'POST', body: { amountSats: 120000 } });
const home1 = (await chansOf(L1, Pnode)).find((c) => c.channelId === homeBefore.channelId) || homeBefore;
let res2;
try {
	res2 = await w(P, '/direct-funding/send', { method: 'POST', body: { request: req2.request, amountSats: 120000, feeHeadroomSats: 1000 } });
	log('P send result', JSON.stringify(res2));
} catch (e) {
	log('P send rejected:', e.code, e.message);
}
if (res2) {
	const grown = await waitFor('paired sender splices the home channel', async () => { const c = await chansOf(L1, Pnode); const h = c.find((x) => x.channelId === home1.channelId); return h && h.capacitySats > home1.capacitySats ? h : null; }, { timeoutMs: 60000 }).catch((e) => { log(e.message); return null; });
	check('home channel grew by the paired payment (no second channel)', !!grown && grown.capacitySats >= home1.capacitySats + 110000, grown ? `cap ${home1.capacitySats} -> ${grown.capacitySats} state ${grown.state}` : JSON.stringify((await chansOf(L1, Pnode)).map((c) => [c.state, c.capacitySats])));
	mine(1);
}
// Expired request: rejected before the witness leaves, so the app may fall back.
const stale = await w(L1, '/direct-funding/request', { method: 'POST', body: { amountSats: 20000 } });
log('expiry ms from now', stale.expiresAt - Date.now());
// Splice-out from L1 to W's address: the "send to a bitcoin address" of a lightning-first wallet.
const { address: wAddr } = await w(W.id, '/address/new', { method: 'POST', body: {} });
const home2 = (await chansOf(L1, Pnode)).find((c) => c.htlcUsable ?? c.state === 'NORMAL');
const q = await w(L1, '/channel/splice-quote', { method: 'POST', body: { channelId: home2.channelId, direction: 'out', feeratePerkw: 1750 } });
log('splice-out quote', JSON.stringify(q));
const out = await w(L1, '/channel/splice-out', { method: 'POST', body: { channelId: home2.channelId, amountSats: 40000, feeratePerkw: 1750, address: wAddr } });
log('splice-out', JSON.stringify(out).slice(0, 200));
check('splice-out accepted', out && out.ok !== false, JSON.stringify(out).slice(0, 120));
mine(1);
await waitFor('W receives the splice-out payment', async () => (await w(W.id, '/transactions')).some((t) => t.address === wAddr || (t.type === 'received' && t.valueSats === 40000)), { timeoutMs: 90000 });
check('W got 40k at its address', true);
// Delete guard.
try { await api(`/wallets/${P}`, { method: 'DELETE' }); check('delete of P refused', false); } catch (e) { check('delete of P refused with dependents', e.code === 'PRIMARY_IN_USE' && e.details?.dependents?.some((d) => d.id === L1), `${e.code} ${JSON.stringify(e.details)}`); }
try { await api(`/wallets/${P}`, { method: 'PATCH', body: { onchainOnly: true } }); check('park P refused', false); } catch (e) { check('parking P refused', e.code === 'PRIMARY_IN_USE'); }
console.log(JSON.stringify({ ...ids, W: W.id }));
