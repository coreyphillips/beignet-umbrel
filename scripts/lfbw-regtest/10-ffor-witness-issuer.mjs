// FFOR receipt witnesses and the BOLT 12 issuer: S settles, W keeps
// receipts and issues invoices (a public channel W -> S), R receives while
// down, X pays through W. Takes no argument.
import { api, w, chainTip, waitFor, check, log, fund, healthy, sleep } from './lib.mjs';
import { openSiblingChannel, channelWith, epochOn, VOUCHER_SATS } from './ffor-round.mjs';

const mk = (name, extra = {}) => api('/wallets', { method: 'POST', body: { name, network: 'regtest', ...extra } }).then((r) => r.record);
const S = await mk('Settler W', { ffor: { settle: { enabled: true } } });
const W = await mk('Witness', { ffor: { witness: { enabled: true }, issuer: { enabled: true } } });
const R = await mk('Receiver W');
const X = await mk('Payer W');
await Promise.all([healthy(S.id), healthy(W.id), healthy(R.id), healthy(X.id)]);
const Srec = await api(`/wallets/${S.id}`);
const Wrec = await api(`/wallets/${W.id}`);
check('W carries the witness and issuer roles', Wrec.ffor.witness.enabled === true && Wrec.ffor.issuer.enabled === true, JSON.stringify(Wrec.ffor));
const wStatus = await w(W.id, '/ffor/witness/status');
const iStatus = await w(W.id, '/ffor/issuer/status');
check('W\'s daemon runs both roles', wStatus.enabled === true && iStatus.enabled === true, JSON.stringify({ w: wStatus.enabled, i: iStatus.enabled }));
const cands = await api(`/wallets/${R.id}/ffor/candidates`);
check('R\'s candidates say who settles, witnesses and issues', cands.some((c) => c.id === S.id && c.settles && !c.witnesses) && cands.some((c) => c.id === W.id && c.witnesses && c.issues && !c.settles), JSON.stringify(cands.map((c) => [c.name, c.settles, c.witnesses, c.issues])));
try {
	await mk('Lonely issuer', { ffor: { issuer: { enabled: true } } });
	check('an issuer without the witness is refused', false);
} catch (e) {
	check('an issuer without the witness is refused', e.code === 'BAD_FFOR', e.code);
}
await fund(S.id, 3_000_000);
await fund(W.id, 3_000_000);
await fund(X.id, 3_000_000);
await waitFor('funded', async () => (await w(S.id, '/balance')).onchain >= 3_000_000 && (await w(W.id, '/balance')).onchain >= 3_000_000 && (await w(X.id, '/balance')).onchain >= 3_000_000);
await openSiblingChannel(S.id, R.id, 500000);
await openSiblingChannel(W.id, S.id, 1000000);
await openSiblingChannel(X.id, W.id, 500000);
// Payers find W -> S from gossip: the channel must be announced and in X's graph.
await waitFor('X\'s graph carries the W -> S channel', async () => { const h = await w(X.id, '/health'); return h.graphChannels >= 2 ? h : null; }, { timeoutMs: 180000, everyMs: 3000 }).catch(() => log('  (graph count not reached; the payment below tells)'));

const channel = await channelWith(R.id, Srec.nodeId);
const localBefore = channel.localBalanceSats;
const tip = await chainTip();
const book = { channelId: channel.channelId, voucherAmountsMsat: [String(VOUCHER_SATS * 1000), String(VOUCHER_SATS * 1000)], settlementDeadline: tip + 144, voucherExpiry: tip + 144 + 1152, feeBaseMsat: 1000, feeProportionalMillionths: 100 };
try {
	await api(`/wallets/${R.id}/ffor/epoch`, { method: 'POST', body: { ...book, witnessWalletIds: [S.id] } });
	check('the settlement peer cannot be its own witness', false);
} catch (e) {
	check('the settlement peer cannot be its own witness', e.code === 'BAD_FFOR_SETUP' && /settlement peer/.test(e.message), e.message.slice(0, 80));
}

// ---- Round A: a witness on the path, a hand-minted invoice ----
const setupA = await api(`/wallets/${R.id}/ffor/epoch`, { method: 'POST', body: { ...book, witnessWalletIds: [W.id] } });
check('A: the setup ran to done with the witness acknowledged', setupA.step === 'done' && setupA.witnesses[0].step === 'acknowledged', JSON.stringify({ step: setupA.step, w: setupA.witnesses[0] }));
let e = await epochOn(R.id, channel.channelId);
check('A: the book names W and W acknowledged it', e.state === 'ACTIVE' && e.witnessPeers[0] === Wrec.nodeId && e.witnesses[0].acknowledged === true && e.witnesses[0].witnessNodeId === Wrec.nodeId, JSON.stringify({ peers: e.witnessPeers, witnesses: e.witnesses }));
const mb = await w(W.id, '/ffor/witness/status');
check('A: W holds one provisioned mailbox for the book', mb.mailboxes.length === 1 && mb.mailboxes[0].state === 'PROVISIONED' && mb.mailboxes[0].slots === 2, JSON.stringify(mb.mailboxes));
const inv = await w(R.id, '/ffor/invoice', { method: 'POST', body: { channelId: channel.channelId, k: 1 } });
check('A: the invoice minted after the acknowledgement', !!inv.bolt11);
await api(`/wallets/${R.id}/stop`, { method: 'POST' });
const paid = await w(X.id, '/invoice/pay-safe', { method: 'POST', body: { bolt11: inv.bolt11 } });
check('A: X paid through W while R was down', paid.status === 'COMPLETED', `${paid.status} ${paid.failureDescription || ''}`);
const recorded = await waitFor('W kept a receipt', async () => { const s = await w(W.id, '/ffor/witness/status'); return s.mailboxes[0] && s.mailboxes[0].records >= 1 ? s : null; }, { timeoutMs: 30000 });
check('A: W recorded the receipt before passing the fulfil on', recorded.mailboxes[0].records === 1, JSON.stringify(recorded.mailboxes[0]));
const wlogs = await api(`/wallets/${W.id}/logs`);
check('A: W\'s log carries the witness events', wlogs.some((l) => /ffor:witness-provisioned/.test(l)) && wlogs.some((l) => /ffor:witness-recorded/.test(l)), wlogs.filter((l) => /ffor:witness/.test(l)).slice(-2).join(' | '));
// S goes away too: the return credits through the witness, not the peer.
await api(`/wallets/${S.id}/stop`, { method: 'POST' });
await api(`/wallets/${R.id}/start`, { method: 'POST' });
const back = await waitFor('R back and returned', async () => { const r = await api(`/wallets/${R.id}`); return r.healthy && r.fforReturn && r.fforReturn.channelId === channel.channelId ? r : null; }, { timeoutMs: 180000, everyMs: 2000 });
const ret = back.fforReturn;
check('A: with S away the witness answered and credited the paid voucher', ret.outcome === 'unreachable' && ret.witnesses.length === 1 && ret.witnesses[0].ok === true && ret.witnesses[0].credited === 1 && JSON.stringify(ret.preimagesKnown) === '[1]', JSON.stringify({ outcome: ret.outcome, witnesses: ret.witnesses, preimagesKnown: ret.preimagesKnown }));
e = await epochOn(R.id, channel.channelId);
check('A: slot 1 reads settled on R from the receipt alone', e.slots[0].state === 'settled' && e.state === 'ACTIVE', JSON.stringify(e.slots.map((s) => s.state)));
// S returns: a manual return closes the book cooperatively.
await api(`/wallets/${S.id}/start`, { method: 'POST' });
await waitFor('S back', async () => (await api(`/wallets/${S.id}`)).healthy, { timeoutMs: 120000 });
await waitFor('channel NORMAL again', async () => { const c = await channelWith(R.id, Srec.nodeId); return c && c.state === 'NORMAL' ? c : null; }, { timeoutMs: 120000 });
const closedRet = await api(`/wallets/${R.id}/ffor/return`, { method: 'POST', body: { channelId: channel.channelId } });
check('A: once S is back the book closes and the voucher is credited', closedRet.outcome === 'closed' && closedRet.epoch.state === 'CLOSED' && closedRet.epoch.slots[0].state === 'settled', JSON.stringify({ outcome: closedRet.outcome, slots: closedRet.epoch.slots.map((s) => s.state) }));
const afterA = await waitFor('R credited', async () => { const c = await channelWith(R.id, Srec.nodeId); return c && c.localBalanceSats >= localBefore + VOUCHER_SATS ? c : null; }, { timeoutMs: 60000 });
check('A: the channel balance grew by the voucher', afterA.localBalanceSats >= localBefore + VOUCHER_SATS, `${localBefore} -> ${afterA.localBalanceSats}`);

// ---- Round B: the issuer answers a payer who holds no invoice ----
const tip2 = await chainTip();
const bookB = { ...book, settlementDeadline: tip2 + 144, voucherExpiry: tip2 + 144 + 1152 };
const setupB = await api(`/wallets/${R.id}/ffor/epoch`, { method: 'POST', body: { ...bookB, witnessWalletIds: [W.id], issuer: { walletId: W.id, description: 'ffor issuer test' } } });
check('B: the setup provisioned the witness and the issuer', setupB.step === 'done' && setupB.issuer && setupB.issuer.step === 'provisioned' && !!setupB.issuer.offerId, JSON.stringify({ step: setupB.step, issuer: setupB.issuer }));
const rRec = await api(`/wallets/${R.id}`);
const iss = rRec.fforIssuance[channel.channelId];
check('B: the record carries the offer for this book', !!iss && iss.epochId === setupB.epochId && /^lno1/.test(iss.encoded) && iss.issuerName === 'Witness', JSON.stringify(iss && { epochId: iss.epochId, issuer: iss.issuerName, offer: iss.encoded.slice(0, 12) }));
const man = await w(W.id, '/ffor/issuer/status');
check('B: W holds the issuer manifest, issuing', man.manifests.some((m) => m.state === 'ISSUING' && m.slots === 2), JSON.stringify(man.manifests));
await api(`/wallets/${R.id}/stop`, { method: 'POST' });
// X asks W for an invoice through the offer and pays it, with R down.
const payB = await w(X.id, '/offer/pay', { method: 'POST', body: { offer: iss.encoded } });
check('B: X paid the offer through the issuer while R was down', payB.status === 'COMPLETED' || payB.ok === true, JSON.stringify(payB).slice(0, 160));
const issued = await waitFor('W issued a slot', async () => { const s = await w(W.id, '/ffor/issuer/status'); const m = s.manifests.find((x) => x.state === 'ISSUING' || x.issued.length > 0); return m && m.issued.length >= 1 ? m : null; }, { timeoutMs: 30000 });
check('B: the issuer issued slot 1', JSON.stringify(issued.issued) === '[1]', JSON.stringify(issued.issued));
const wlogs2 = await api(`/wallets/${W.id}/logs`);
check('B: W\'s log carries the issuer events', wlogs2.some((l) => /ffor:issuer-provisioned/.test(l)) && wlogs2.some((l) => /ffor:issuer-issued/.test(l)), wlogs2.filter((l) => /ffor:issuer/.test(l)).slice(-2).join(' | '));
await api(`/wallets/${R.id}/start`, { method: 'POST' });
const backB = await waitFor('R back and returned (B)', async () => { const r = await api(`/wallets/${R.id}`); return r.healthy && r.fforReturn && r.fforReturn.at > ret.at && r.fforReturn.epoch && r.fforReturn.epoch.epochId === setupB.epochId ? r : null; }, { timeoutMs: 180000, everyMs: 2000 });
check('B: the return closed the book with the issued voucher credited', backB.fforReturn.outcome === 'closed' && backB.fforReturn.epoch.slots[0].state === 'settled' && backB.fforReturn.witnesses[0].ok === true, JSON.stringify({ outcome: backB.fforReturn.outcome, slots: backB.fforReturn.epoch.slots.map((s) => s.state), witnesses: backB.fforReturn.witnesses }));
check('B: the offer retired with the book', !(await api(`/wallets/${R.id}`)).fforIssuance[channel.channelId]);
const afterB = await channelWith(R.id, Srec.nodeId);
check('B: the channel balance grew by the second voucher', afterB.localBalanceSats >= localBefore + 2 * VOUCHER_SATS, `${afterA.localBalanceSats} -> ${afterB.localBalanceSats}`);
console.log(JSON.stringify({ S: S.id, W: W.id, R: R.id, X: X.id }));
