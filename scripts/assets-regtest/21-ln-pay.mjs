// Paying over an asset channel, both ways: an invoice for the asset, the
// payment that settles it once however often it is asked for, the limits on
// what each side can send and receive, a price that is no longer there, and
// the same channel still working after both daemons restart.
import { post, idem, status, refusal, check, done, activity, x, waitFor } from './lib.mjs';
import { pair, openAssetChannel, payAsset, channelOf, split, conserved, restart } from './ln-lib.mjs';

const { A, B, assetId, key, minted } = await pair('LN payer', 'LN payee');
const { mine: chanA, theirs: chanB } = await openAssetChannel(A.id, B.id, key, '40000');
const read = async () => ({ a: await channelOf(A.id, chanA.channelId), b: await channelOf(B.id, chanB.channelId) });
// A payment answers as soon as the payer holds the preimage. The settled
// HTLC leaves both commitments a moment later, and until then its units are
// on neither side: wait until the two views add up again before reading.
const whole = (c) => !!c && BigInt(c.localBalance) + BigInt(c.remoteBalance) === BigInt(c.capacity);
const sides = async () => {
	try {
		return await waitFor('both sides have settled', async () => {
			const now = await read();
			return whole(now.a) && whole(now.b) && now.a.localBalance === now.b.remoteBalance && now.a.remoteBalance === now.b.localBalance ? now : null;
		}, { timeoutMs: 15000, everyMs: 200 });
	} catch (_) {
		return read();
	}
};

// Before anything has moved, the opener cannot receive and the acceptor cannot send.
const noInbound = await refusal(() => post(A.id, '/invoices/quote', { key, amount: '1' }));
check('a wallet whose peer holds nothing in the channel cannot be paid through it yet', !!noInbound && noInbound.code === 'INSUFFICIENT_INBOUND' && noInbound.details && noInbound.details.maxReceivable === '0', noInbound ? JSON.stringify([noInbound.code, noInbound.details]) : 'accepted');

// B asks for 5,000 and A pays it.
const first = await payAsset(A.id, B.id, key, '5000', { description: 'first' });
check('the invoice quote names the peer, the amount and what can be received', first.invoiceQuote.assetAmount === '5000' && first.invoiceQuote.maxReceivable === '40000' && first.invoiceQuote.peerPubkey === chanB.peerPubkey && first.invoiceQuote.expiresAt > Date.now(), JSON.stringify(first.invoiceQuote));
check('between two wallets of this app the quote carries no bitcoin price', first.invoiceQuote.priced === false && first.payQuote.priced === false && !first.invoiceQuote.rateText, JSON.stringify([first.invoiceQuote.priced, first.payQuote.priced, first.invoiceQuote.rateText]));
check('the invoice is a regtest Lightning invoice with a waiting row', /^lnbcrt/.test(first.invoice.bolt11) && /^[0-9a-f]{64}$/.test(first.invoice.paymentHash) && first.invoice.row.kind === 'ln-receive' && first.invoice.row.paymentHash === first.invoice.paymentHash, JSON.stringify(first.invoice.row));
check('the payer is quoted exactly the amount asked for', first.payQuote.assetAmount === '5000' && BigInt(first.payQuote.sendable) >= 5000n, JSON.stringify(first.payQuote));
check('the payment completes for that amount', first.paid.status === 'COMPLETED' && first.paid.paymentHash === first.invoice.paymentHash && first.paid.assetAmount === '5000', JSON.stringify(first.paid));
const replay = await post(A.id, '/pay', first.body, first.requestKey);
check('the same payment asked again answers the same', replay.status === 'COMPLETED' && replay.paymentHash === first.paid.paymentHash, JSON.stringify(replay));
let s = await sides();
check('and moved the asset once: 35,000 and 5,000', s.a.localBalance === '35000' && s.a.remoteBalance === '5000' && s.b.localBalance === '5000' && s.b.remoteBalance === '35000', JSON.stringify([s.a.localBalance, s.a.remoteBalance, s.b.localBalance, s.b.remoteBalance]));
check('and the channel is the size it was funded at, on both sides', s.a.capacity === '40000' && s.b.capacity === '40000', JSON.stringify([s.a.capacity, s.b.capacity]));
const sendRow = (await activity(A.id, { kind: 'ln-send', limit: 20 })).rows.find((r) => r.paymentHash === first.paid.paymentHash);
check('the payer has a Lightning send in its history, tied to the request', !!sendRow && sendRow.state === 'complete' && sendRow.clientRef === first.requestKey && sendRow.assets[0].amount === '5000', JSON.stringify(sendRow));
const recvRow = await waitFor('the payee marks the invoice paid', async () => (await activity(B.id, { kind: 'ln-receive', limit: 20 })).rows.find((r) => r.paymentHash === first.paid.paymentHash && r.state === 'complete'));
check('the payee has a Lightning receive, complete', !!recvRow && recvRow.assets[0].amount === '5000');
const listed = (await x(B.id, '/invoices')).invoices.find((i) => i.paymentHash === first.paid.paymentHash);
check('and its invoice no longer reads open', !!listed && listed.status !== 'OPEN', listed ? listed.status : 'missing');
check('nothing on-chain moved', (await split(A.id, key)).onchain === '60000' && (await split(B.id, key)).onchain === '0');
await conserved('after the first payment', [A.id, B.id], key, minted);

// And back: the acceptor holds bitcoin in the channel from the open, so it can pay at once.
const back = await payAsset(B.id, A.id, key, '2000');
check('the payee can pay back straight away', back.paid.status === 'COMPLETED' && back.paid.assetAmount === '2000', JSON.stringify(back.paid));
s = await sides();
check('37,000 and 3,000', s.a.localBalance === '37000' && s.b.localBalance === '3000', JSON.stringify([s.a.localBalance, s.b.localBalance]));
await conserved('after paying back', [A.id, B.id], key, minted);

// Limits.
const inbound = await refusal(() => post(A.id, '/invoices/quote', { key, amount: '3001' }));
check('an invoice for more than the peer holds is refused, with the most that can be received', !!inbound && inbound.code === 'INSUFFICIENT_INBOUND' && inbound.details.maxReceivable === '3000', inbound ? JSON.stringify([inbound.code, inbound.details]) : 'accepted');
const q1 = await post(B.id, '/invoices/quote', { key, amount: '30000' });
const inv1 = await post(B.id, '/invoices', { key, amount: '30000', quoteId: q1.quoteId });
const q2 = await post(B.id, '/invoices/quote', { key, amount: '20000' });
const inv2 = await post(B.id, '/invoices', { key, amount: '20000', quoteId: q2.quoteId });
const pq1 = await post(A.id, '/pay/quote', { bolt11: inv1.bolt11, key });
const paid1 = await post(A.id, '/pay', { bolt11: inv1.bolt11, key, quoteId: pq1.quoteId, maxAssetAmount: pq1.assetAmount }, idem());
check('a larger payment goes through', paid1.status === 'COMPLETED');
const outbound = await refusal(() => post(A.id, '/pay/quote', { bolt11: inv2.bolt11, key }));
check('an invoice for more than this side holds is refused, with what can be sent', !!outbound && outbound.code === 'INSUFFICIENT_OUTBOUND' && outbound.details.sendable === (await channelOf(A.id, chanA.channelId)).sendable, outbound ? JSON.stringify([outbound.code, outbound.details]) : 'accepted');
const notInvoice = await refusal(() => post(A.id, '/pay/quote', { bolt11: 'lnbcrt1notaninvoice', key }));
check('what is not an invoice is refused as one', !!notInvoice && notInvoice.code === 'BAD_INVOICE', notInvoice ? notInvoice.code : 'accepted');
// The 30,000 just paid are on neither side until the settled HTLC has left
// both commitments, which the two refusals above do not wait for.
await sides();
await conserved('after the limits', [A.id, B.id], key, minted);

// A price that is gone, and a bound that is too low: nothing is paid either time.
const q3 = await post(A.id, '/invoices/quote', { key, amount: '1000' });
const inv3 = await post(A.id, '/invoices', { key, amount: '1000', quoteId: q3.quoteId });
const beforeLocal = (await channelOf(B.id, chanB.channelId)).localBalance;
const gone = await refusal(() => post(B.id, '/pay', { bolt11: inv3.bolt11, key, quoteId: 'no-such-quote', maxAssetAmount: '1000' }, idem()));
check('a payment at a price the wallet no longer has is refused with a new one', !!gone && gone.code === 'QUOTE_CHANGED' && gone.details && gone.details.quote && !!gone.details.quote.quoteId && gone.details.quote.assetAmount === '1000', gone ? JSON.stringify([gone.code, gone.details]) : 'accepted');
const pq3 = await post(B.id, '/pay/quote', { bolt11: inv3.bolt11, key });
const low = await refusal(() => post(B.id, '/pay', { bolt11: inv3.bolt11, key, quoteId: pq3.quoteId, maxAssetAmount: '999' }, idem()));
check('a payment that would cost more than the amount agreed to is refused', !!low && low.code === 'QUOTE_CHANGED', low ? low.code : 'accepted');
check('and neither refusal paid anything', (await channelOf(B.id, chanB.channelId)).localBalance === beforeLocal);
const fresh = await post(B.id, '/pay/quote', { bolt11: inv3.bolt11, key });
const paid3 = await post(B.id, '/pay', { bolt11: inv3.bolt11, key, quoteId: fresh.quoteId, maxAssetAmount: fresh.assetAmount }, idem());
check('with a new price the same invoice is paid', paid3.status === 'COMPLETED' && paid3.assetAmount === '1000');

// Both daemons restart, and the channel carries a payment again.
await restart(A.id);
await restart(B.id);
await waitFor('the channel is usable again on both sides', async () => {
	const now = await sides();
	return now.a && now.b && now.a.state === 'NORMAL' && now.b.state === 'NORMAL' && BigInt(now.a.sendable) > 0n;
}, { timeoutMs: 120000, everyMs: 2000 });
const afterRestart = await sides();
check('balances are as they were before the restart', afterRestart.a.localBalance === '8000' && afterRestart.b.localBalance === '32000', JSON.stringify([afterRestart.a.localBalance, afterRestart.b.localBalance]));
const again = await payAsset(A.id, B.id, key, '500');
check('a payment after the restart completes', again.paid.status === 'COMPLETED');
check('the replay of the first payment still answers the same, after the restart', (await post(A.id, '/pay', first.body, first.requestKey)).paymentHash === first.paid.paymentHash);
await sides();
await conserved('at the end', [A.id, B.id], key, minted);
check('nothing is left in progress', Object.values((await status(A.id)).pending).every((n) => n === 0) && Object.values((await status(B.id)).pending).every((n) => n === 0), JSON.stringify([(await status(A.id)).pending, (await status(B.id)).pending]));

done({ A: A.id, B: B.id, assetId, key, channelId: chanA.channelId });
