// Power cuts and a restore, with an asset channel in play. A daemon is
// killed outright at the moments that matter: as an open is handed over,
// with a payment in flight on either side, as a close begins. The daemon
// that comes back must neither lose units nor do anything twice. Then the
// limit a backup has: a wallet restored from one lists a channel that was
// open as not held here, keeps what it had on-chain, and says so.
import { api, x, post, idem, mine, sleep, crash, daemonPid, status, refusal, check, done, waitFor, healthy, assetsReady, txConfirmations, M } from './lib.mjs';
import { pair, peerOf, openAssetChannel, payAsset, channels, channelOf, channelOver, findChannel, split, total, conserved, handToTapd, liveChannels, bothSides, paymentEnded, OVER } from './ln-lib.mjs';

const PASSPHRASE = 'regtest passphrase for asset channels';
let { A, B, assetId, key, minted } = await pair('LN crash A', 'LN crash B');

// 1. Killed as an open is handed over. One key, one channel or none, never two.
const peer = await peerOf(B.id);
const self = await peerOf(A.id);
const openKey = idem();
const openBody = { peer, key, amount: '40000', feeRate: 2 };
// The kill lands the moment the open answers. The answer comes once the
// funding is negotiated, a moment before the peer's signature on the first
// commitment is on record here, so this is an open cut before it is final.
const openerPid = await daemonPid(A.id);
const opened = await post(A.id, '/channels/open', openBody, openKey);
await crash(A.id, { pid: openerPid });
await assetsReady(A.id);
const openedAgain = await post(A.id, '/channels/open', openBody, openKey);
check('after a crash the same key still answers the same open', openedAgain.pendingChannelId === opened.pendingChannelId, JSON.stringify(openedAgain));
// The wait is short of the 2,016 blocks an acceptor keeps an unfunded open for
// (BOLT 2): an open one side has forgotten and the other still lists is
// reported as it stands, and the rest goes on with a pair of new wallets.
const look = async () => ({
	a: await findChannel(A.id, { channelId: opened.pendingChannelId, peerPubkey: peer.pubkey, key }),
	b: await findChannel(B.id, { peerPubkey: self.pubkey, key })
});
let settled;
try {
	settled = await waitFor(
		'the open that was cut is either a channel on both sides or gone on both',
		async () => {
			const { a, b } = await look();
			if (a && b && a.state === 'NORMAL' && b.state === 'NORMAL') return { a, b, open: true };
			const goneA = !a || OVER.has(a.state) || a.state === 'FAILED';
			if (goneA && !b && (await split(A.id, key)).onchain === minted) return { open: false };
			mine(1);
			return null;
		},
		{ timeoutMs: Number(process.env.CUT_OPEN_WAIT_MS || 45000), everyMs: 2500 }
	);
	check('the open that was cut is either a channel on both sides or gone on both', true, settled.open ? 'a channel on both' : 'gone on both');
} catch (_) {
	const { a, b } = await look();
	const brief = (c) => c && { state: c.state, capacity: c.capacity, local: c.localBalance, remote: c.remoteBalance, fundingTxid: c.fundingTxid, fundingOnChain: c.fundingTxid ? txConfirmations(c.fundingTxid) !== null : null };
	check('the open that was cut is either a channel on both sides or gone on both', false, JSON.stringify({ opener: brief(a), acceptor: brief(b), acceptorStatus: (await status(B.id)).lightning }));
	settled = { open: false, stranded: true };
}
check('never two channels for one request', (await liveChannels(A.id)).length <= 1 && (await liveChannels(B.id)).length <= 1, JSON.stringify((await channels(A.id)).map((c) => c.state)));
await conserved('after the cut open', [A.id, B.id], key, minted);

// From here on the scenario needs a channel: keep the one that survived, or open one.
let chanA;
let chanB;
if (settled.open) {
	chanA = settled.a;
	chanB = settled.b;
	check('the open that survived the crash is a usable channel', BigInt(chanA.sendable) > 0n && chanB.receivable !== '0', JSON.stringify([chanA.sendable, chanB.receivable]));
} else {
	check('the open that did not survive left every unit on-chain and nothing held back', (await split(A.id, key)).onchain === minted && Object.values((await status(A.id)).pending).every((n) => n === 0), JSON.stringify((await status(A.id)).pending));
	// One side still lists the open that was cut: what follows needs two wallets with nothing between them.
	if (settled.stranded) ({ A, B, assetId, key, minted } = await pair('LN crash A2', 'LN crash B2'));
	const again = await openAssetChannel(A.id, B.id, key, '40000');
	chanA = again.mine;
	chanB = again.theirs;
}

// 2. The payer is killed with a payment handed over.
const inv = await post(B.id, '/invoices', { key, amount: '5000', quoteId: (await post(B.id, '/invoices/quote', { key, amount: '5000' })).quoteId });
const payQuote = await post(A.id, '/pay/quote', { bolt11: inv.bolt11, key });
const payKey = idem();
const payBody = { bolt11: inv.bolt11, key, quoteId: payQuote.quoteId, maxAssetAmount: payQuote.assetAmount };
const paying = post(A.id, '/pay', payBody, payKey).catch((e) => ({ thrown: e }));
await sleep(400);
await crash(A.id);
await paying;
await assetsReady(A.id);
const paidAgain = await paymentEnded(A.id, payBody, payKey, inv.paymentHash, 'the payment that was cut has an end');
const firstPaid = paidAgain.paid;
const afterFirst = await bothSides(A.id, B.id, chanA, chanB);
check('it ended once: the channel moved by the invoice or not at all', !!afterFirst.a && afterFirst.a.localBalance === (firstPaid ? '35000' : '40000'), `${paidAgain.said} / ${afterFirst.a && afterFirst.a.localBalance}`);
check('and the payee agrees', !!afterFirst.b && afterFirst.b.localBalance === (firstPaid ? '5000' : '0'), String(afterFirst.b && afterFirst.b.localBalance));
await conserved('after the cut payment', [A.id, B.id], key, minted);

// 3. The payee is killed with a payment on its way in.
const inv2 = await post(B.id, '/invoices', { key, amount: '3000', quoteId: (await post(B.id, '/invoices/quote', { key, amount: '3000' })).quoteId });
const q2 = await post(A.id, '/pay/quote', { bolt11: inv2.bolt11, key });
const key2 = idem();
const body2 = { bolt11: inv2.bolt11, key, quoteId: q2.quoteId, maxAssetAmount: q2.assetAmount };
const paying2 = post(A.id, '/pay', body2, key2).catch((e) => ({ thrown: e }));
await sleep(300);
await crash(B.id);
await paying2;
await assetsReady(B.id);
const second = await paymentEnded(A.id, body2, key2, inv2.paymentHash, 'the payment the payee was killed under has an end', { timeoutMs: 240000 });
const secondPaid = second.paid;
const moved = (firstPaid ? 5000n : 0n) + (secondPaid ? 3000n : 0n);
const { a: midA, b: midB } = await bothSides(A.id, B.id, chanA, chanB);
check('both sides agree on what moved, whoever was killed', !!midA && !!midB && BigInt(midA.localBalance) === 40000n - moved && BigInt(midB.localBalance) === moved, `${second.said} / ${midA && midA.localBalance} / ${midB && midB.localBalance}`);
const invoices = (await x(B.id, '/invoices')).invoices || [];
check('an invoice is paid at most once', invoices.filter((i) => i.status === 'PAID').length === (firstPaid ? 1 : 0) + (secondPaid ? 1 : 0), JSON.stringify(invoices.map((i) => i.status)));
await conserved('after both cut payments', [A.id, B.id], key, minted);

// The channel still works after all that.
await payAsset(A.id, B.id, key, '2000');
await payAsset(B.id, A.id, key, '500');
const net = moved + 1500n;
const each = await bothSides(A.id, B.id, chanA, chanB);
check('and still carries a payment each way', !!each.a && BigInt(each.a.localBalance) === 40000n - net, String(each.a && each.a.localBalance));

// 4. The limit of a backup. Archive the box with the channel open, lose the
//    opener entirely, restore it.
const res = await fetch(`${M}/api/backup/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: PASSPHRASE }) });
check('the box archives with an asset channel open', res.ok, String(res.status));
const archive = Buffer.from(await res.arrayBuffer()).toString('base64');
const before = await split(A.id, key);
await api(`/wallets/${A.id}?purge=true`, { method: 'DELETE' });
await api('/backup/restore', { method: 'POST', body: { passphrase: PASSPHRASE, archive } });
await api(`/wallets/${A.id}/start`, { method: 'POST', body: {} });
await healthy(A.id);
await assetsReady(A.id);
const restored = await status(A.id);
const lost = (await channels(A.id)).find((c) => c.channelId === chanA.channelId) || null;
check('the restored wallet lists the channel as one its node does not hold', !!lost && lost.state === 'MISSING', JSON.stringify(lost && { state: lost.state, local: lost.localBalance }));
check('with the balance it last knew, and nothing to send or receive through it', !!lost && BigInt(lost.localBalance) === 40000n - net && lost.sendable === '0' && lost.receivable === '0', JSON.stringify(lost));
check('it says so, by code and in a sentence', (restored.lightning.warnings || []).some((wn) => wn.code === 'CHANNEL_MISSING' && /cannot bring the assets in it back by itself/.test(wn.text)), JSON.stringify(restored.lightning.warnings));
check('and counts no usable channel', restored.lightning.usableChannels === 0);
check('what it held on-chain is all there', (await split(A.id, key)).onchain === before.onchain, JSON.stringify([before, await split(A.id, key)]));
const noClose = await refusal(() => post(A.id, '/channels/close', { channelId: chanA.channelId, force: true }));
check('it cannot close what its node does not hold', !!noClose && noClose.code === 'CHANNEL_MISSING', noClose ? noClose.code : 'accepted');
const noPay = await refusal(() => post(A.id, '/invoices/quote', { key, amount: '10' }));
check('and takes no invoice through it', !!noPay && noPay.code === 'INSUFFICIENT_INBOUND', noPay ? noPay.code : 'accepted');

// The peer still holds the channel and can take its own share home alone.
const closing = await post(B.id, '/channels/close', { channelId: chanB.channelId, force: true });
check('the peer that still holds the channel can force close it', closing.closing === true && closing.force === true, JSON.stringify(closing));
const overB = await channelOver(B.id, chanB.channelId, { blocksEach: 12, timeoutMs: 600000 });
check('and sweeps its share', OVER.has(overB.state), overB.state);
check('the peer has what it was paid, on-chain', BigInt((await split(B.id, key)).onchain) === net && (await split(B.id, key)).channel === '0', JSON.stringify(await split(B.id, key)));
await handToTapd(B.id, assetId, String(net), "the peer's share of a channel its opener lost");
check('the restored wallet did not make units up', BigInt((await split(A.id, key)).onchain) === BigInt(before.onchain) && (await total(A.id, key)) <= BigInt(minted) - net, `${(await split(A.id, key)).onchain} on-chain, ${await total(A.id, key)} in all`);

done({ A: A.id, B: B.id, assetId, key, firstPaid, secondPaid, openSurvived: settled.open });
