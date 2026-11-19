// Shared by the Lightning scenarios (20 and up): two wallets with an asset
// channel between them, and the checks every one of them ends with.
import { api, w, x, post, idem, mine, height, sleep, waitFor, check, newWallet, mintAndConfirm, balances, rowReaches, tapcli, tapdBalance, healthy, assetsReady } from './lib.mjs';

export const LOCAL_HOST = process.env.PRIMARY_LOCAL_HOST || '127.0.0.1';

/** An asset channel is over once its assets are back on-chain. */
export const OVER = new Set(['CLOSED', 'FORCE_CLOSED']);
/**
 * The words of a channel being closed together and not over yet: the host's
 * own CLOSING (the close is asked for, or the assets are still on their way
 * home) and the engine's two for the negotiation in between.
 */
export const CLOSING_TOGETHER = new Set(['CLOSING', 'SHUTTING_DOWN', 'NEGOTIATING_CLOSING']);

export const channels = async (id) => (await x(id, '/channels')).channels || [];
// A channel is listed under the id its open was given until the funding
// transaction gives it its own, and keeps the first as pendingChannelId.
const isChannel = (c, channelId) => c.channelId === channelId || c.pendingChannelId === channelId;
export const channelOf = async (id, channelId) => (await channels(id)).find((c) => isChannel(c, channelId)) || null;
// Rows that are no channel: one that is over, and an open that failed, which
// is listed for a week with its reason.
export const NOT_LIVE = new Set([...OVER, 'FAILED']);
export const liveChannels = async (id) => (await channels(id)).filter((c) => !NOT_LIVE.has(c.state));

/** How another wallet reaches this one: its node key and the port it listens on, over loopback. */
export async function peerOf(id) {
	const rec = await api(`/wallets/${id}`);
	return { pubkey: rec.nodeId, host: LOCAL_HOST, port: rec.listenPort };
}

/** Everything a wallet holds of an asset: on-chain and on its side of channels. */
export async function total(id, key) {
	const a = ((await balances(id)).assets || []).find((h) => h.key === key || h.assetId === key);
	return a ? BigInt(a.balance.total) : 0n;
}
export async function split(id, key) {
	const a = ((await balances(id)).assets || []).find((h) => h.key === key || h.assetId === key);
	const b = a ? a.balance : { onchain: '0', channelLocal: '0', lightningSendable: '0', lightningReceivable: '0' };
	return { onchain: b.onchain, channel: b.channelLocal, sendable: b.lightningSendable, receivable: b.lightningReceivable };
}

/** Nothing was made and nothing was lost: the two wallets hold what was minted, between them. */
export async function conserved(what, ids, key, minted, less = 0n) {
	let sum = 0n;
	for (const id of ids) sum += await total(id, key);
	check(`${what}: the wallets hold everything that was minted, between them`, sum === BigInt(minted) - less, `${sum} of ${BigInt(minted) - less}`);
}

/** Two funded wallets, and one asset minted on the first. */
export async function pair(nameA, nameB, { amount = '100000', decimalDisplay = 2 } = {}) {
	const A = await newWallet(nameA);
	const B = await newWallet(nameB);
	const name = `ln-${Date.now().toString(36)}`;
	const mint = await mintAndConfirm(A.id, [{ name, type: 'normal', amount, decimalDisplay }]);
	const asset = mint.assets[0];
	const key = ((await balances(A.id)).assets || []).find((h) => h.assetId === asset.assetId).key;
	return { A, B, assetId: asset.assetId, key, name, minted: amount };
}

/** The channel a wallet lists for an open it asked for, or one its peer opened to it. */
export async function findChannel(id, { channelId, peerPubkey, key }) {
	const list = await channels(id);
	return list.find((c) => channelId && isChannel(c, channelId)) || list.find((c) => !NOT_LIVE.has(c.state) && c.peerPubkey === peerPubkey && c.asset && c.asset.key === key) || null;
}

/**
 * Open an asset channel from `from` to `to` and mine until both sides read
 * it as open. Returns { opened, quote, mine: the opener's view, theirs }.
 */
export async function openAssetChannel(from, to, key, amount, { feeRate = 2, key: requestKey = idem() } = {}) {
	const peer = await peerOf(to);
	const self = await peerOf(from);
	const body = { peer, key, amount: String(amount), feeRate };
	const quote = await post(from, '/channels/quote', { key, amount: String(amount), feeRate });
	const t0 = Date.now();
	const h0 = height();
	const opened = await post(from, '/channels/open', body, requestKey);
	console.log(`  timing: open answered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
	await sleep(1500);
	const both = await waitFor(
		'the asset channel is open on both sides',
		async () => {
			const a = await findChannel(from, { channelId: opened.pendingChannelId, peerPubkey: peer.pubkey, key });
			const b = await findChannel(to, { peerPubkey: self.pubkey, key });
			if (a && b && a.state === 'NORMAL' && b.state === 'NORMAL') return { a, b };
			mine(1);
			return null;
		},
		{ timeoutMs: 240000, everyMs: 2500 }
	);
	console.log(`  timing: open usable on both sides after ${((Date.now() - t0) / 1000).toFixed(1)}s and ${height() - h0} block(s)`);
	return { opened, quote, body, requestKey, mine: both.a, theirs: both.b };
}

/**
 * Both views of one channel, read once they agree. A payment answers as soon
 * as the payer holds the preimage; the settled HTLC leaves both commitments
 * a moment later, and until then its units are on neither side. After a
 * restart the two also have to find each other again. Falls back to a plain
 * read when they do not agree in time, for the caller's check to say so.
 */
export async function bothSides(a, b, chanA, chanB, { timeoutMs = 20000 } = {}) {
	const read = async () => ({ a: await channelOf(a, chanA.channelId), b: await channelOf(b, chanB.channelId) });
	const whole = (c) => !!c && BigInt(c.localBalance) + BigInt(c.remoteBalance) === BigInt(c.capacity);
	try {
		return await waitFor('both sides agree on the channel', async () => {
			const now = await read();
			return whole(now.a) && whole(now.b) && now.a.localBalance === now.b.remoteBalance && now.a.remoteBalance === now.b.localBalance ? now : null;
		}, { timeoutMs, everyMs: 250 });
	} catch (_) {
		return read();
	}
}

/**
 * How a payment that was cut ended, from the payer: the answer its replay
 * gets (same body, same key) and the payer's own row for the invoice.
 * `POST /pay` answers { status: COMPLETED | FAILED | PENDING, ... } or
 * refuses; PENDING and PAYMENT_IN_FLIGHT are not an end, so it waits. A
 * daemon that has not stopped since repeats the first answer it gave to a
 * key (the engine keeps the answers of an idempotent route in memory), so
 * a request that was answered PENDING is answered PENDING again after the
 * payment has ended: then the row is what says how it ended.
 */
export function paymentEnded(payer, body, requestKey, paymentHash, what, { timeoutMs = 180000 } = {}) {
	return waitFor(what, async () => {
		const answer = await post(payer, '/pay', body, requestKey).catch((e) => ({ refused: e }));
		const row = ((await x(payer, '/activity?kind=ln-send&limit=50')).rows || []).find((r) => r.paymentHash === paymentHash) || null;
		const code = answer.refused ? answer.refused.code : null;
		if (code === 'PAYMENT_IN_FLIGHT' || code === 'EXTENSION_STARTING' || code === 'EXTENSION_UNAVAILABLE') return null;
		const rowEnded = !!row && (row.state === 'complete' || row.state === 'failed' || !!row.failed);
		if (!answer.refused && answer.status === 'PENDING' && !rowEnded) return null;
		if (row && !rowEnded) return null;
		const paid = (!answer.refused && answer.status === 'COMPLETED') || (!!row && row.state === 'complete') || code === 'ALREADY_PAID';
		return { answer, row, paid, said: code || (answer.status === 'PENDING' ? `PENDING again, and the row ${row.state}` : answer.status) };
	}, { timeoutMs, everyMs: 2500 });
}

/** `payee` makes an invoice for `amount` of the asset and `payer` pays it. Returns what each side answered. */
export async function payAsset(payer, payee, key, amount, { description, requestKey = idem() } = {}) {
	const invoiceQuote = await post(payee, '/invoices/quote', { key, amount: String(amount) });
	const invoice = await post(payee, '/invoices', { key, amount: String(amount), description, quoteId: invoiceQuote.quoteId });
	const payQuote = await post(payer, '/pay/quote', { bolt11: invoice.bolt11, key });
	const body = { bolt11: invoice.bolt11, key, quoteId: payQuote.quoteId, maxAssetAmount: payQuote.assetAmount };
	const t0 = Date.now();
	const paid = await post(payer, '/pay', body, requestKey);
	console.log(`  timing: pay of ${amount} answered ${paid && paid.status} in ${((Date.now() - t0) / 1000).toFixed(2)}s`);
	return { invoiceQuote, invoice, payQuote, paid, body, requestKey };
}

/**
 * Wait for a channel to be over on a wallet, mining as it goes. A channel
 * closed together leaves the list once its assets are home, so "no longer
 * listed" is over too: { state: 'CLOSED', listed: false }.
 */
export async function channelOver(id, channelId, { blocksEach = 1, timeoutMs = 300000 } = {}) {
	const t0 = Date.now();
	const h0 = height();
	const over = await waitFor(
		`channel ${channelId.slice(0, 10)} is over on ${id.slice(0, 8)}`,
		async () => {
			const c = await channelOf(id, channelId);
			if (!c) return { state: 'CLOSED', listed: false };
			if (OVER.has(c.state)) return { ...c, listed: true };
			mine(blocksEach);
			return null;
		},
		{ timeoutMs, everyMs: 2500 }
	);
	console.log(`  timing: channel over on ${id.slice(0, 8)} after ${((Date.now() - t0) / 1000).toFixed(1)}s and ${height() - h0} block(s) from the first look`);
	return over;
}

/**
 * Hand a wallet's units of the asset to the stack's tapd, which checks every
 * proof in their history before it credits them. What comes out of a channel
 * is only as good as the proofs that came out with it, and this is tapd's
 * own word on those.
 */
export async function handToTapd(id, assetId, amount, what) {
	const before = BigInt(tapdBalance(assetId));
	const addr = tapcli('addrs', 'new', '--asset_id', assetId, '--amt', String(amount));
	const preview = await post(id, '/send/prepare', { address: addr.encoded, feeRate: 2 }, idem());
	const sent = await post(id, '/send/commit', { previewId: preview.previewId }, idem());
	mine(1);
	await rowReaches(id, sent.row.id, 'complete', { mineEach: true, timeoutMs: 240000 });
	await waitFor(`tapd credits ${amount}`, async () => (BigInt(tapdBalance(assetId)) === before + BigInt(amount) ? true : (mine(1), null)), { timeoutMs: 180000, everyMs: 2500 });
	check(`${what}: tapd verified the proofs and credited ${amount}`, BigInt(tapdBalance(assetId)) === before + BigInt(amount), tapdBalance(assetId));
}

/**
 * Where a wallet's bitcoin is, in sats: what it can spend on-chain, what
 * sits on the outputs its assets live in ("locked with assets"), and its
 * side of its asset channels, open and closing. The locked figure is one
 * pass of the host's loop behind a change, so it is read until two looks
 * a moment apart agree.
 */
export async function bitcoinOf(id) {
	const read = async () => {
		const b = await w(id, '/balance');
		const { btc } = await balances(id);
		return { spendable: btc.spendableSats, locked: btc.anchorSats, anchors: btc.anchorCount, inChannels: b.assetChannelSats || 0, closing: b.assetChannelClosingSats || 0 };
	};
	let last = await read();
	for (let i = 0; i < 10; i += 1) {
		await sleep(1200);
		const now = await read();
		if (JSON.stringify(now) === JSON.stringify(last)) break;
		last = now;
	}
	return { ...last, sum: last.spendable + last.locked + last.inChannels + last.closing };
}

/** Says where each wallet's bitcoin is, one line a wallet, and returns what it read: { name: bitcoinOf }. */
export async function noteBitcoin(what, wallets) {
	const out = {};
	for (const [name, id] of Object.entries(wallets)) {
		const b = (out[name] = await bitcoinOf(id));
		console.log(`  bitcoin ${what}: ${name} spendable ${b.spendable}, locked with assets ${b.locked} on ${b.anchors} output(s), in asset channels ${b.inChannels}, closing ${b.closing}, in all ${b.sum}`);
	}
	return out;
}

/** Stop a wallet and start it again. `assets: false` for one whose assets are off: it has no host to wait for. */
export async function restart(id, { assets = true } = {}) {
	await api(`/wallets/${id}/stop`, { method: 'POST', body: {} });
	await waitFor('wallet stopped', async () => (await api(`/wallets/${id}`)).status === 'stopped');
	await api(`/wallets/${id}/start`, { method: 'POST', body: {} });
	await healthy(id);
	if (assets) await assetsReady(id);
}

/** The engine's own list of a wallet's channels, bitcoin and asset alike. */
export const engineChannels = (id) => w(id, '/channels');
