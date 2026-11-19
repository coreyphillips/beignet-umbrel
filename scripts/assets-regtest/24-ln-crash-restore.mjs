// Power cuts and a restore, with an asset channel in play. A daemon is
// killed outright at the moments that matter: before an open has answered
// and as it answers, and with a payment in flight on either side. The daemon
// that comes back must neither lose units nor do anything twice. Then the
// limit a backup has: a wallet restored from one lists a channel that was
// open as not held here, keeps what it had on-chain, and says so.
import { api, x, post, idem, mine, height, sleep, crash, daemonPid, status, refusal, check, done, waitFor, healthy, assetsReady, txConfirmations, M } from './lib.mjs';
import { pair, peerOf, openAssetChannel, payAsset, channels, channelOf, channelOver, findChannel, split, total, conserved, handToTapd, liveChannels, bothSides, paymentEnded, OVER, NOT_LIVE } from './ln-lib.mjs';

const PASSPHRASE = 'regtest passphrase for asset channels';
// What a failed open says of itself, and the most blocks an acceptor may
// take to drop an open its peer never funded.
const FAILED_OPEN_CODES = new Set(['CHANNEL_OPEN_INTERRUPTED', 'CHANNEL_OPEN_FAILED']);
const ACCEPTOR_DROPS_WITHIN_BLOCKS = 6;
const words = (list) => list.map((c) => `${c.state}${c.failure ? `(${c.failure.code})` : ''}${c.peerConnected === false ? '[peer away]' : ''}`);
const live = (list) => list.filter((c) => !NOT_LIVE.has(c.state));
const nothingPending = async (id) => Object.values((await status(id)).pending).every((n) => n === 0);

// 1. An open cut by a crash, on either side of its answer.
//
// The wallet answers an open once its peer has signed the first commitment
// and that is on record, so the answer is the line. An open cut before it
// never got an answer. After the restart the opener either carries it on by
// itself, to one channel on both sides under the same request key, or shows
// it as a failed open whose key answers that failure, and the acceptor drops
// what it was offered by itself. An open cut at its answer is carried on.
// Neither may leave one side with a channel the other does not hold, an open
// the peer had heard of with no trace on the opener, or two channels for one
// request.

// 1a. Cut before the answer, at a set delay short of the half second an open
//     takes to answer here: the opener has it on record by then, its peer has
//     heard of it, and nobody has signed anything. The acceptor is read once
//     the kill has landed, to say whether it had heard: it lists what it was
//     offered for some seconds after its peer has gone.
let cutKind = 'none';
{
	const { A: C, B: D, key: cutKey, minted: cutMinted } = await pair('LN cut A', 'LN cut B');
	const body = { peer: await peerOf(D.id), key: cutKey, amount: '40000', feeRate: 2 };
	const requestKey = idem();
	const pid = await daemonPid(C.id);
	const t0 = Date.now();
	let first = null;
	const asking = post(C.id, '/channels/open', body, requestKey).then((answer) => (first = { answer }), (thrown) => (first = { thrown }));
	await sleep(Number(process.env.CUT_OPEN_AFTER_MS || 300));
	const coming = crash(C.id, { pid });
	const killedAt = Date.now() - t0;
	await sleep(150);
	const heard = (await channels(D.id)).length > 0;
	await asking;
	await coming;
	const answered = !!first.answer;
	console.log(`  the opener was killed ${killedAt}ms into the open, ${answered ? 'after its answer' : 'before any answer'}; the acceptor ${heard ? 'had listed the open' : 'had not heard of it'}`);

	// What the two make of it by themselves: the key is not asked again yet.
	// Six looks with no block, then one block a look.
	const back = Date.now();
	const h0 = height();
	const seen = [];
	let acceptorDropped = null;
	let ended = null;
	let same = 0;
	for (let i = 0; i < 50 && !ended; i += 1) {
		const c = await channels(C.id);
		const d = await channels(D.id);
		const word = words(d).join('+') || 'nothing';
		if (seen[seen.length - 1] !== word) seen.push(word);
		if (!d.length && !acceptorDropped) acceptorDropped = { seconds: (Date.now() - back) / 1000, blocks: height() - h0 };
		if (d.length) acceptorDropped = null;
		const [lc, ld] = [live(c), live(d)];
		if (lc.length === 1 && ld.length === 1 && lc[0].state === 'NORMAL' && ld[0].state === 'NORMAL') ended = { kind: 'carried on', a: lc[0], b: ld[0] };
		else if (!lc.length && !d.length && (same += 1) >= 2) ended = { kind: c.some((r) => r.state === 'FAILED') ? 'failed open' : 'nothing', row: c.find((r) => r.state === 'FAILED') || null };
		else {
			if (lc.length || d.length) same = 0;
			if (i >= 6) mine(1);
			await sleep(1000);
		}
	}
	const took = `${((Date.now() - back) / 1000).toFixed(1)}s and ${height() - h0} block(s) after the opener was back`;
	cutKind = ended ? ended.kind : 'unsettled';
	check('an open cut before its answer has one end on both sides', !!ended, ended ? `${ended.kind}, ${took}` : JSON.stringify({ opener: words(await channels(C.id)), acceptor: words(await channels(D.id)), took }));
	console.log(`  the acceptor showed: ${seen.join(', then ')}`);
	if (answered) check('an open that had answered is carried on', cutKind === 'carried on', cutKind);
	else check('it is carried on or shown as a failed open, and never just gone once the peer had heard of it', cutKind === 'carried on' || cutKind === 'failed open' || (cutKind === 'nothing' && !heard), `${cutKind}${heard ? '' : ' (the peer had not heard of it)'}`);

	if (cutKind === 'failed open' || cutKind === 'nothing') {
		// The acceptor is not left with a channel it does not hold.
		check('the acceptor dropped what it was offered by itself, and lists nothing', (await channels(D.id)).length === 0 && (await status(D.id)).assetChannels === 0, JSON.stringify(words(await channels(D.id))));
		check(`within ${ACCEPTOR_DROPS_WITHIN_BLOCKS} blocks`, !!acceptorDropped && acceptorDropped.blocks <= ACCEPTOR_DROPS_WITHIN_BLOCKS, acceptorDropped ? `${acceptorDropped.seconds.toFixed(1)}s and ${acceptorDropped.blocks} block(s)` : 'never');
		if (acceptorDropped) console.log(`  timing: the acceptor dropped the cut open ${acceptorDropped.seconds.toFixed(1)}s and ${acceptorDropped.blocks} block(s) after the opener was back`);
		check('every unit is on-chain again on the opener, with nothing pending', (await split(C.id, cutKey)).onchain === cutMinted && (await nothingPending(C.id)), JSON.stringify([await split(C.id, cutKey), (await status(C.id)).pending]));
	}
	if (cutKind === 'failed open') {
		const row = ended.row;
		check('the failed open says why, by code and in a sentence', !!row.failure && FAILED_OPEN_CODES.has(row.failure.code) && /nothing was spent/.test(row.failure.message), JSON.stringify(row.failure));
		check('it is no channel: nothing to send, nothing to receive, not counted', row.sendable === '0' && row.receivable === '0' && (await status(C.id)).assetChannels === 0 && (await status(C.id)).lightning.usableChannels === 0, JSON.stringify({ sendable: row.sendable, receivable: row.receivable, assetChannels: (await status(C.id)).assetChannels }));
		const replay = await refusal(() => post(C.id, '/channels/open', body, requestKey));
		check('the key that asked answers that failure with 409, never an open', !!replay && replay.status === 409 && replay.code === row.failure.code, replay ? `${replay.status} ${replay.code}` : 'accepted');
		await sleep(3000);
		mine(1);
		check('and the replay opened nothing', (await liveChannels(C.id)).length === 0 && (await channels(D.id)).length === 0, JSON.stringify([words(await channels(C.id)), words(await channels(D.id))]));
		await conserved('after the open that failed', [C.id, D.id], cutKey, cutMinted);
		// "It can be tried again": a new key opens a channel between the same two.
		const retried = await openAssetChannel(C.id, D.id, cutKey, '40000');
		check('a new request opens a channel between the same two', retried.mine.state === 'NORMAL' && retried.theirs.state === 'NORMAL' && (await liveChannels(C.id)).length === 1 && (await liveChannels(D.id)).length === 1, JSON.stringify([words(await channels(C.id)), words(await channels(D.id))]));
	} else if (cutKind === 'carried on') {
		const replay = await post(C.id, '/channels/open', body, requestKey).catch((e) => ({ refused: `${e.status} ${e.code}` }));
		check('the key that asked answers the channel that was carried on', replay.pendingChannelId === ended.a.pendingChannelId, JSON.stringify(replay));
		check('which is usable', BigInt(ended.a.sendable) > 0n && ended.b.receivable !== '0', JSON.stringify([ended.a.sendable, ended.b.receivable]));
	} else if (cutKind === 'nothing') {
		// Never recorded, or (the check above) lost: either way the key may open one channel now.
		const replay = await post(C.id, '/channels/open', body, requestKey).catch((e) => ({ refused: `${e.status} ${e.code}` }));
		console.log(`  the key that asked now answers: ${JSON.stringify(replay)}`);
	}
	await sleep(2000);
	check('never two channels for one request', (await liveChannels(C.id)).length <= 1 && (await liveChannels(D.id)).length <= 1, JSON.stringify([words(await channels(C.id)), words(await channels(D.id))]));
	await conserved('after the open cut before its answer', [C.id, D.id], cutKey, cutMinted);
}

// 1b. Cut the moment the open answers: the peer has signed, so it is carried on.
let { A, B, assetId, key, minted } = await pair('LN crash A', 'LN crash B');
let chanA;
let chanB;
let carriedOn = false;
{
	const peer = await peerOf(B.id);
	const self = await peerOf(A.id);
	const openKey = idem();
	const openBody = { peer, key, amount: '40000', feeRate: 2 };
	const openerPid = await daemonPid(A.id);
	const opened = await post(A.id, '/channels/open', openBody, openKey);
	await crash(A.id, { pid: openerPid });
	await assetsReady(A.id);
	const back = Date.now();
	const h0 = height();
	const atRestart = [await channels(A.id), await channels(B.id)];
	check('an open cut at its answer is listed on both sides after the restart', live(atRestart[0]).length === 1 && live(atRestart[1]).length === 1 && atRestart[0].every((c) => c.state !== 'FAILED'), JSON.stringify(atRestart.map(words)));
	const openedAgain = await post(A.id, '/channels/open', openBody, openKey).catch((e) => ({ refused: `${e.status} ${e.code}` }));
	check('the same key still answers the same open', openedAgain.pendingChannelId === opened.pendingChannelId, JSON.stringify(openedAgain));
	const look = async () => ({
		a: await findChannel(A.id, { channelId: opened.pendingChannelId, peerPubkey: peer.pubkey, key }),
		b: await findChannel(B.id, { peerPubkey: self.pubkey, key })
	});
	let both = null;
	try {
		both = await waitFor(
			'the open cut at its answer is a channel on both sides',
			async () => {
				const { a, b } = await look();
				if (a && b && a.state === 'NORMAL' && b.state === 'NORMAL') return { a, b };
				mine(1);
				return null;
			},
			{ timeoutMs: Number(process.env.CUT_OPEN_WAIT_MS || 60000), everyMs: 2500 }
		);
	} catch (_) {
		both = null;
	}
	carriedOn = !!both;
	const { a, b } = both || (await look());
	const brief = (c) => c && { state: c.state, failure: c.failure, capacity: c.capacity, local: c.localBalance, fundingTxid: c.fundingTxid, fundingOnChain: c.fundingTxid ? txConfirmations(c.fundingTxid) !== null : null };
	check('and is carried on to a channel on both sides', carriedOn, carriedOn ? `${((Date.now() - back) / 1000).toFixed(1)}s and ${height() - h0} block(s) after the opener was back` : JSON.stringify({ opener: brief(a), acceptor: brief(b) }));
	check('never two channels for one request', (await liveChannels(A.id)).length <= 1 && (await liveChannels(B.id)).length <= 1, JSON.stringify([words(await channels(A.id)), words(await channels(B.id))]));
	await conserved('after the open cut at its answer', [A.id, B.id], key, minted);
	if (carriedOn) {
		chanA = a;
		chanB = b;
		check('the open that survived the crash is a usable channel', BigInt(chanA.sendable) > 0n && chanB.receivable !== '0', JSON.stringify([chanA.sendable, chanB.receivable]));
	} else {
		// What follows needs a channel: two new wallets with nothing between them.
		({ A, B, assetId, key, minted } = await pair('LN crash A2', 'LN crash B2'));
		const again = await openAssetChannel(A.id, B.id, key, '40000');
		chanA = again.mine;
		chanB = again.theirs;
	}
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

done({ A: A.id, B: B.id, assetId, key, firstPaid, secondPaid, cutBeforeAnswer: cutKind, cutAtAnswerCarriedOn: carriedOn });
