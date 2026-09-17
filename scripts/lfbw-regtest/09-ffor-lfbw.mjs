// FFOR offline receive on a lightning-first wallet: its primary P settles,
// L receives on its home channel while down, X pays through P. Takes no
// argument.
import { api, w, waitFor, check, log, fund, healthy } from './lib.mjs';
import { openSiblingChannel, offlineReceiveRound, channelWith, VOUCHER_SATS } from './ffor-round.mjs';

const mk = (name, extra = {}) => api('/wallets', { method: 'POST', body: { name, network: 'regtest', ...extra } }).then((r) => r.record);
const P = await mk('Primary', { ffor: { settle: { enabled: true } } });
const X = await mk('Payer 2');
await Promise.all([healthy(P.id), healthy(X.id)]);
await fund(P.id, 5_000_000);
await fund(X.id, 3_000_000);
await waitFor('P and X funded', async () => (await w(P.id, '/balance')).onchain >= 5_000_000 && (await w(X.id, '/balance')).onchain >= 3_000_000);
const L = await mk('Spending', { lfbw: { enabled: true, primaryWalletId: P.id, initialChannelSats: 300000 } });
const ready = await waitFor('L setup ready', async () => { const r = await api(`/wallets/${L.id}`); if (r.lfbw.setup === 'failed') throw new Error(r.lfbw.setupError); return r.lfbw.setup === 'ready' ? r : null; }, { timeoutMs: 180000 });
const Prec = await api(`/wallets/${P.id}`);
check('P is the provider and settles', Prec.liquidityProvider === true && Prec.ffor.settle.enabled === true);
const home = await waitFor('home channel usable', async () => { const c = await channelWith(L.id, Prec.nodeId); return c && (c.htlcUsable ?? c.state === 'NORMAL') ? c : null; }, { timeoutMs: 120000 });
log('  home', home.state, 'local', home.localBalanceSats, 'remote', home.remoteBalanceSats);
// P's side of the home channel must hold the book: L pays P over it.
if (home.remoteBalanceSats < 3 * VOUCHER_SATS) {
	const inv = await w(P.id, '/invoice/create', { method: 'POST', body: { amountSats: 3 * VOUCHER_SATS, description: 'outbound for the book' } });
	const paid = await w(L.id, '/invoice/pay-safe', { method: 'POST', body: { bolt11: inv.bolt11 } });
	check('L moved the book\'s worth to P\'s side of the home channel', paid.status === 'COMPLETED', `${paid.status} ${paid.failureDescription || ''}`);
	await waitFor('P side holds the book', async () => { const c = await channelWith(L.id, Prec.nodeId); return c && c.remoteBalanceSats >= 2 * VOUCHER_SATS ? c : null; }, { timeoutMs: 60000 });
}
await openSiblingChannel(X.id, P.id, 500000);
const r = await offlineReceiveRound({ R: L.id, S: P.id, X: X.id, label: 'lfbw' });
const back = await api(`/wallets/${L.id}`);
check('lfbw: the link with the primary is ready again after the restart', back.lfbw.setup === 'ready' && back.healthy, JSON.stringify({ setup: back.lfbw.setup, healthy: back.healthy }));
check('lfbw: the home channel is still the one channel with P', (await w(L.id, '/channels')).filter((c) => c.peerPubkey === Prec.nodeId && !/CLOSED/.test(c.state)).length === 1);
console.log(JSON.stringify({ P: P.id, L: L.id, X: X.id, Pnode: Prec.nodeId, Lnode: ready.nodeId, epochId: r.epochId }));
