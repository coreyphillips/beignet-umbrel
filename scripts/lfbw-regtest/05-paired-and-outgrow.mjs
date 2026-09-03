import { api, w, cln, mine, waitFor, check, log, sleep } from './lib.mjs';
const { P, L1, Pnode, L2 } = JSON.parse(process.argv[2]);
// Restart the three daemons onto the rebuilt engine.
for (const id of [P, L1, L2]) { await api(`/wallets/${id}/stop`, { method: 'POST' }); }
for (const id of [P, L1, L2]) { await api(`/wallets/${id}/start`, { method: 'POST' }); }
for (const id of [L1, L2]) await waitFor(`${id.slice(0, 8)} ready`, async () => { const r = await api(`/wallets/${id}`); return r.healthy && r.lfbw.setup === 'ready' ? r : null; }, { timeoutMs: 180000 });
await sleep(4000);
const chansOf = async (id) => (await w(id, '/channels')).filter((c) => c.peerPubkey === Pnode && c.state !== 'CLOSED' && c.state !== 'FORCE_CLOSED');
// A. The primary pays L1's request minted with NO direct address.
const homeL1 = (await chansOf(L1)).find((c) => c.htlcUsable ?? c.state === 'NORMAL');
const req = await w(L1, '/direct-funding/request', { method: 'POST', body: { amountSats: 90000 } });
const t0 = Date.now();
let res;
try { res = await w(P, '/direct-funding/send', { method: 'POST', body: { request: req.request, amountSats: 90000, feeHeadroomSats: 1000 } }); log('P send', res.status, 'in', ((Date.now() - t0) / 1000).toFixed(1), 's'); } catch (e) { log('P send rejected:', e.code, e.message, 'after', ((Date.now() - t0) / 1000).toFixed(1), 's'); }
if (res) {
	const grown = await waitFor('home channel grows over the existing connection', async () => { const h = (await chansOf(L1)).find((x) => x.channelId === homeL1.channelId); return h && h.capacitySats > homeL1.capacitySats ? h : null; }, { timeoutMs: 60000 }).catch(() => null);
	check('primary paid its dependent with no address in the request (existing connection, splice)', !!grown, grown ? `cap ${homeL1.capacitySats} -> ${grown.capacitySats}` : JSON.stringify((await chansOf(L1)).map((c) => [c.state, c.capacitySats])));
	mine(1);
}
// B. A JIT receive that outgrows L2's existing channels: a splice, not a third channel.
const before = await chansOf(L2);
const inbound = before.reduce((s, c) => s + c.remoteBalanceSats, 0);
const want = inbound + 150000;
const inv = await w(L2, '/jit/invoice', { method: 'POST', body: { lspPubkey: Pnode, amountSats: want, description: 'outgrow', targetRemainingInboundSat: 10000 } });
let payOut = '';
try { payOut = cln(`pay ${inv.bolt11}`); } catch (e) { payOut = String(e.stdout || e.message); }
log('cln pay:', payOut.replace(/\s+/g, ' ').replace(/^#[^{]*/, '').slice(0, 160));
const after = await waitFor('L2 received the oversized payment', async () => { const c = await chansOf(L2); const local = c.reduce((s, x) => s + x.localBalanceSats, 0); const bl = before.reduce((s, x) => s + x.localBalanceSats, 0); return local >= bl + want - 1000 ? c : null; }, { timeoutMs: 120000 }).catch((e) => { log(e.message); return null; });
check('the payment grew an existing channel rather than opening a third', !!after && after.length === before.length && after.some((c) => before.find((b) => b.channelId === c.channelId && c.capacitySats > b.capacitySats)), JSON.stringify((after || await chansOf(L2)).map((c) => [c.channelId.slice(0, 8), c.state, c.capacitySats, c.localBalanceSats])));
const invs = await w(L2, '/invoices');
log('invoice status', invs.find((i) => i.paymentHash === inv.paymentHash)?.status);
