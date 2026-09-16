import { api, w, btc, mine, waitFor, check, log, fund, healthy, sleep, listenPortOf, PRIMARY_LOCAL_HOST, waitTx } from './lib.mjs';
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
const policy = await w(L1, '/direct-funding/config');
const homeBefore = (await chansOf(L1, Pnode))[0];
const l1Before = await chansOf(L1, Pnode);
// W connects to P (the relay) so the frames have a lane.
await w(W.id, '/peer/connect', { method: 'POST', body: { pubkey: Pnode, host: PRIMARY_LOCAL_HOST, port: await listenPortOf(P) } }).catch((e) => log('W connect to P:', e.message));
let res;
try {
	res = await w(W.id, '/direct-funding/send', { method: 'POST', body: { request: req.request, amountSats: 150000, feeHeadroomSats: 1000 } });
	log('W send result', JSON.stringify(res));
} catch (e) {
	log('W send rejected:', e.code, e.message);
}
if (res) {
	check('anonymous sender: signed and attested', !!res.fundingTxid && res.status !== 'FAILED', `${res.status} attested=${res.attested}`);
	// A stranger's funding splices the home channel rather than opening a
	// second one (beignet #760, umbrel 6f7a9d8), and because the payer is
	// unpaired the splice is held until unpairedSpliceDepth confirmations.
	const depth = policy.unpairedSpliceDepth ?? 3;
	const splicing = await waitFor('home channel enters SPLICING for the stranger', async () => { const c = await chansOf(L1, Pnode); const h = c.find((x) => x.channelId === homeBefore.channelId); return h && h.state === 'SPLICING' ? h : null; }, { timeoutMs: 90000 });
	check('no second channel for an unpaired payer', (await chansOf(L1, Pnode)).length === l1Before.length, `${l1Before.length} channel(s), splicing ${splicing.fundingTxid?.slice(0, 12)}`);
	check('the splice is not adopted before its lock depth', splicing.fundingTxid !== res.fundingTxid, `still on ${splicing.fundingTxid?.slice(0, 12)}, funding ${res.fundingTxid.slice(0, 12)}`);
	await waitTx(res.fundingTxid, { confirmations: 0 });
	await mine(depth);
	const adopted = await waitFor(`home channel adopts the funding at depth ${depth}`, async () => { const c = await chansOf(L1, Pnode); const h = c.find((x) => x.fundingTxid === res.fundingTxid && x.state === 'NORMAL'); return h || null; }, { timeoutMs: 180000 });
	check('anonymous funding landed in the home channel', adopted.capacitySats >= homeBefore.capacitySats + 140000, `cap ${homeBefore.capacitySats} -> ${adopted.capacitySats} local ${adopted.localBalanceSats}`);
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
	await mine(1);
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
await mine(1);
await waitFor('W receives the splice-out payment', async () => (await w(W.id, '/transactions')).some((t) => t.address === wAddr || (t.type === 'received' && t.valueSats === 40000)), { timeoutMs: 90000 });
check('W got 40k at its address', true);
// Delete guard.
try { await api(`/wallets/${P}`, { method: 'DELETE' }); check('delete of P refused', false); } catch (e) { check('delete of P refused with dependents', e.code === 'PRIMARY_IN_USE' && e.details?.dependents?.some((d) => d.id === L1), `${e.code} ${JSON.stringify(e.details)}`); }
try { await api(`/wallets/${P}`, { method: 'PATCH', body: { onchainOnly: true } }); check('park P refused', false); } catch (e) { check('parking P refused', e.code === 'PRIMARY_IN_USE'); }
console.log(JSON.stringify({ ...ids, W: W.id }));
