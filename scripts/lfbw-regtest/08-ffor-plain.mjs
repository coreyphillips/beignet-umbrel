// FFOR offline receive between plain wallets: S settles, R receives while
// down, X pays. Takes no argument; prints the ids for 09.
import { api, w, waitFor, check, log, fund, healthy, chainTip, sleep } from './lib.mjs';
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
check('R lists S among its settlement candidates', cands.some((c) => c.id === S.id && c.nodeId === Srec.nodeId && c.settles), JSON.stringify(cands.map((c) => [c.name, c.settles])));
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

// Enforcement: a second book, S gone, the return says unreachable, and
// Enforce force-closes the channel. The epoch stays ACTIVE on the record
// by design; the channel's state is what the app reads.
{
	const Rrec = await api(`/wallets/${R.id}`);
	const ch = await channelWith(R.id, Srec.nodeId);
	const tip2 = await chainTip();
	await w(R.id, '/ffor/epoch/start', { method: 'POST', body: { channelId: ch.channelId, voucherAmountsMsat: ['20000000'], settlementDeadline: tip2 + 144, voucherExpiry: tip2 + 144 + 1152, feeBaseMsat: 1000, feeProportionalMillionths: 100, witnessPeers: [] } });
	await waitFor('second epoch ACTIVE', async () => { const e = await epochOn(R.id, ch.channelId); return e && e.state === 'ACTIVE' ? e : null; });
	await w(R.id, '/ffor/invoice', { method: 'POST', body: { channelId: ch.channelId, k: 1 } });
	await api(`/wallets/${S.id}/stop`, { method: 'POST' });
	await waitFor('R sees S away', async () => { const c = await channelWith(R.id, Srec.nodeId); return c && c.state !== 'NORMAL' ? c : null; }, { timeoutMs: 60000 });
	const away = await api(`/wallets/${R.id}/ffor/return`, { method: 'POST', body: { channelId: ch.channelId } });
	check('enforce: a return with S away reads unreachable, not closed', away.outcome === 'unreachable' && away.action === 'nothing', JSON.stringify({ outcome: away.outcome, action: away.action, channelState: away.channelState }));
	let refusedCode = null;
	try { await api(`/wallets/${R.id}/ffor/enforce`, { method: 'POST', body: { channelId: 'ff'.repeat(32) } }); } catch (e) { refusedCode = e.code; }
	check('enforce: an unknown channel is refused, not reported as broadcast', /NOT_FOUND|FFOR_ENFORCE_REFUSED/.test(String(refusedCode)), String(refusedCode));
	const enforced = await api(`/wallets/${R.id}/ffor/enforce`, { method: 'POST', body: { channelId: ch.channelId } });
	check('enforce: the force close was broadcast', !!enforced.commitmentTxid, JSON.stringify(enforced));
	const after = await waitFor('the channel reads force-closed', async () => { const c = (await w(R.id, '/channels')).find((x) => x.channelId === ch.channelId); return c && /FORCE_CLOSED|CLOSED/.test(c.state) ? c : null; }, { timeoutMs: 60000 });
	const rec = await api(`/wallets/${R.id}`);
	check('enforce: the record carries the broadcast and no enforce warning', rec.fforEnforced && rec.fforEnforced.channelId === ch.channelId && !rec.fforEnforce, JSON.stringify({ enforced: !!rec.fforEnforced, warning: rec.fforEnforce }));
	const e2 = await epochOn(R.id, ch.channelId);
	check('enforce: the epoch stays ACTIVE on the record (by design)', e2 && e2.state === 'ACTIVE', e2 && e2.state);
	const again = await api(`/wallets/${R.id}/ffor/return`, { method: 'POST', body: { channelId: ch.channelId } });
	check('enforce: a return on the closed channel reads enforced, not unreachable', again.outcome === 'enforced', JSON.stringify({ outcome: again.outcome, channelState: again.channelState }));
	// A restart must not try to reconcile the enforced epoch.
	const beforeAt = (await api(`/wallets/${R.id}`)).fforReturn.at;
	await api(`/wallets/${R.id}/stop`, { method: 'POST' });
	await api(`/wallets/${R.id}/start`, { method: 'POST' });
	await waitFor('R back', async () => (await api(`/wallets/${R.id}`)).healthy, { timeoutMs: 120000 });
	await sleep(5000);
	const restarted = await api(`/wallets/${R.id}`);
	check('enforce: a restart leaves the enforced epoch alone', !restarted.fforReturn || restarted.fforReturn.at === beforeAt, JSON.stringify(restarted.fforReturn && { outcome: restarted.fforReturn.outcome, at: restarted.fforReturn.at, before: beforeAt }));
	await api(`/wallets/${S.id}/start`, { method: 'POST' });
	log('  enforce: channel', after.state, 'closeStatus', JSON.stringify(after.closeStatus || null).slice(0, 80));
}
console.log(JSON.stringify({ S: S.id, R: R.id, X: X.id, Snode: Srec.nodeId }));
