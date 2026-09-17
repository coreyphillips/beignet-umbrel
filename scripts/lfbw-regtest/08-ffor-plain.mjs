// FFOR offline receive between plain wallets: S settles, R receives while
// down, X pays. Takes no argument; prints the ids for 09.
import { api, w, waitFor, check, log, fund, healthy, chainTip } from './lib.mjs';
import { openSiblingChannel, offlineReceiveRound, channelWith, epochOn } from './ffor-round.mjs';

const mk = (name, extra = {}) => api('/wallets', { method: 'POST', body: { name, network: 'regtest', ...extra } }).then((r) => r.record);
const S = await mk('Settler', { ffor: { settle: { enabled: true } } });
const R = await mk('Receiver');
const X = await mk('Payer');
log('S', S.id, 'R', R.id, 'X', X.id);
await Promise.all([healthy(S.id), healthy(R.id), healthy(X.id)]);
const Srec = await api(`/wallets/${S.id}`);
check('S carries the settlement role on its record', Srec.ffor.settle.enabled === true, JSON.stringify(Srec.ffor));
const cands = await api(`/wallets/${R.id}/ffor/candidates`);
check('R lists S as its one settlement candidate', cands.length === 1 && cands[0].id === S.id && cands[0].nodeId === Srec.nodeId, JSON.stringify(cands));
try {
	await api('/wallets', { method: 'POST', body: { name: 'Parked', network: 'regtest', onchainOnly: true, ffor: { settle: { enabled: true } } } });
	check('an on-chain only wallet cannot settle', false);
} catch (e) {
	check('an on-chain only wallet cannot settle', e.code === 'FFOR_NEEDS_LIGHTNING', e.code);
}
await fund(S.id, 3_000_000);
await fund(X.id, 3_000_000);
await waitFor('S and X funded', async () => (await w(S.id, '/balance')).onchain >= 3_000_000 && (await w(X.id, '/balance')).onchain >= 3_000_000);
await openSiblingChannel(S.id, R.id, 500000);
await openSiblingChannel(X.id, S.id, 500000);
// A wallet that does not settle refuses the book: S asks X (whose side of
// their channel holds the funds) and X has no role. The peer answers after
// the start call returned, so the refusal arrives as an ABORTED epoch with
// the engine's reason 2 rather than as a 400.
const sToX = await channelWith(S.id, (await api(`/wallets/${X.id}`)).nodeId);
const tip = await chainTip();
const refused = await w(S.id, '/ffor/epoch/start', { method: 'POST', body: { channelId: sToX.channelId, voucherAmountsMsat: ['1000000'], settlementDeadline: tip + 144, voucherExpiry: tip + 144 + 1152, feeBaseMsat: 0, feeProportionalMillionths: 0, witnessPeers: [] } });
const aborted = await waitFor('the book with a peer without the role aborts', async () => { const e = await epochOn(S.id, sToX.channelId); return e && e.state === 'ABORTED' ? e : null; }, { timeoutMs: 30000 });
check('a peer without the role refuses the book (ABORTED, reason 2)', refused.state === 'NEGOTIATING' && aborted.abortReason === 2, JSON.stringify({ started: refused.state, abortReason: aborted.abortReason }));
check('the refused setup left no live epoch on S', !(await w(S.id, '/ffor/epochs')).some((e) => !/CLOSED|ABORTED/.test(e.state)));
await offlineReceiveRound({ R: R.id, S: S.id, X: X.id, label: 'plain' });
console.log(JSON.stringify({ S: S.id, R: R.id, X: X.id, Snode: Srec.nodeId }));
