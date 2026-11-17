// An asset channel with a peer that runs the upstream implementation: lnd
// and tapd in one process (tapd-integrated), built by ts-tap's
// docker/native-interop from unmodified taproot-assets at its pinned
// commit, on this stack's chain, through the real manager and a wallet
// daemon of this app. The peer offers no fixed HTLC outputs, so the channel
// carries HTLCs signed the way tapd signs them, with one CSV delay for both
// sides.
//
// It covers the open, an invoice each way, both sides restarted, a payment
// priced by the peer to and from the stack's lnd (which holds no asset), a
// cooperative close, a force close by the peer, and a force close by the
// wallet with the peer stopped. At each stage the wallet and the peer hold
// between them everything that was minted, and what comes home to the
// wallet is handed to the stack's tapd, which verifies its proofs.
//
// Start the peer first: scripts/assets-regtest/stack.sh upstream.
//
// ASSETS_UPSTREAM_PEER=litd runs it against Lightning Terminal v0.17.11 as
// published instead (stack.sh litd): lnd v0.21.8-beta and tapd from
// taproot-assets v0.8.8 in one process. It checks macaroons, so each call is
// given lnd's or tapd's admin macaroon. It signals neither of the asset
// features that say how a channel's first commitment is derived, which the
// host answers for every peer.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT, api, x, post, idem, check, done, waitFor, mine, sendTo, sleep, newWallet, mintAndConfirm, balances } from './lib.mjs';
import { channelOf, split, total, handToTapd, noteBitcoin, restart, channelOver, liveChannels } from './ln-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The records an asset HTLC carries for its first hop come from the library
// this app vendors, as installed beside the engine the manager runs.
const PREFIX = process.env.ENGINE_PREFIX || path.resolve(HERE, '../../.engine-prefix');
const { lightning } = createRequire(path.join(PREFIX, 'node_modules', 'ts-tap', 'package.json'))('ts-tap');
const LITD = process.env.ASSETS_UPSTREAM_PEER === 'litd';
const SERVICE = LITD ? 'litd' : 'integrated';
const PEER_HOST = process.env.ASSETS_UPSTREAM_HOST || '127.0.0.1';
const PEER_PORT = Number((LITD ? process.env.ASSETS_LITD_P2P_PORT : process.env.ASSETS_UPSTREAM_P2P_PORT) || (LITD ? 19836 : 19835));
const LND_MACAROON = '/data/lnd/data/chain/bitcoin/regtest/admin.macaroon';
const TAPD_MACAROON = '/data/tapd/data/regtest/admin.macaroon';
/** The client's methods that lnd answers; tapd answers the others. */
const LND_METHODS = new Set(['track-payment', 'send-payment', 'send-route', 'sign-message', 'close-channel', 'lookup-invoice', 'channels', 'channel-info']);

const compose = (args, opts = {}) =>
	execFileSync('docker', ['compose', '-p', PROJECT, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
const lastJson = (out) => JSON.parse(out.split('\n').filter(Boolean).pop());
/** One RPC of the peer through the client its image carries (protojson in, protojson out): its last answer. */
const peerRpc = (method, request = {}) =>
	lastJson(compose(['exec', '-T', ...(LITD ? ['-e', `NATIVE_INTEROP_MACAROON=${LND_METHODS.has(method) ? LND_MACAROON : TAPD_MACAROON}`] : []), SERVICE, 'native-interop-client', method], { input: JSON.stringify(request) }));
const peerLncli = (...args) => JSON.parse(compose(['exec', '-T', SERVICE, 'lncli', '--lnddir=/data/lnd', '--network=regtest', LITD ? `--macaroonpath=${LND_MACAROON}` : '--no-macaroons', ...args.map(String)]));
const peerTapcli = (...args) => {
	const out = compose(['exec', '-T', SERVICE, 'tapcli', '--network=regtest', '--rpcserver=127.0.0.1:10009', '--tlscertpath=/data/lnd/tls.cert', LITD ? `--macaroonpath=${TAPD_MACAROON}` : '--no-macaroons', ...args.map(String)]);
	try {
		return JSON.parse(out);
	} catch (_) {
		return out;
	}
};
/** The stack's own lnd: a third node with bitcoin and no asset. */
const thirdLncli = (...args) => JSON.parse(compose(['exec', '-T', 'lnd', 'lncli', '--network=regtest', ...args.map(String)]));
const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64');

/* ---------------------------------------------------------------- the peer */

const services = compose(['ps', '--status', 'running', '--services']).split('\n');
if (!services.includes(SERVICE)) {
	check(`the upstream peer runs beside the stack (scripts/assets-regtest/stack.sh ${LITD ? 'litd' : 'upstream'})`, false, services.join(', '));
	done();
}
const peerInfo = peerLncli('getinfo');
const peerPubkey = peerInfo.identity_pubkey;
const peerBits = Object.keys(peerInfo.features || {}).map(Number);
console.log(`  the peer${LITD ? ' (litd)' : ''}: ${peerPubkey} ${peerInfo.version}, features ${peerBits.join(',')}`);
check('the peer offers asset channels and no fixed HTLC outputs', (peerBits.includes(2025) || peerBits.includes(2026)) && !peerBits.includes(450) && !peerBits.includes(451), peerBits.join(','));
// Its universe takes proofs from outside, as the stack's tapd's does.
for (const proofType of ['issuance', 'transfer']) peerTapcli('universe', 'federation', 'config', 'global', `--proof_type=${proofType}`, '--allow_insert=true', '--allow_export=true');
if (BigInt(peerLncli('walletbalance').confirmed_balance) < 300_000_000n) {
	sendTo(peerLncli('newaddress', 'p2wkh').address, 500_000_000);
	mine(6);
	await waitFor('the peer sees its bitcoin', () => BigInt(peerLncli('walletbalance').confirmed_balance) >= 300_000_000n);
}

/** What the peer holds of the asset on-chain and in its channels, from its own lists. */
const peerUnits = (assetId) => {
	const onchain = BigInt((peerRpc('balance', { asset_id: true, asset_filter: b64(assetId) }).asset_balances || {})[assetId]?.balance || '0');
	return onchain;
};
const peerChannel = (walletNodeId) => (peerRpc('channels', { peer: b64(walletNodeId) }).channels || [])[0] || null;
const peerChannelUnits = (ch) => {
	if (!ch || !ch.custom_channel_data) return { local: 0n, remote: 0n };
	const data = typeof ch.custom_channel_data === 'string' ? JSON.parse(Buffer.from(ch.custom_channel_data, 'base64').toString('utf8')) : ch.custom_channel_data;
	const sum = (list) => (list || []).reduce((s, a) => s + BigInt(a.amount || 0), 0n);
	return { local: sum(data.local_assets), remote: sum(data.remote_assets), data };
};

/* -------------------------------------------------------------- the wallet */

const A = await newWallet('LN upstream wallet', { sats: 3_000_000 });
const walletNodeId = (await api(`/wallets/${A.id}`)).nodeId;
const name = `up-${Date.now().toString(36)}`;
const mint = await mintAndConfirm(A.id, [{ name, type: 'normal', amount: '100000', decimalDisplay: 0 }]);
const assetId = mint.assets[0].assetId;
const key = ((await balances(A.id)).assets || []).find((h) => h.assetId === assetId).key;
const MINTED = 100_000n;
let handed = 0n;
async function conserved(what) {
	const wallet = await total(A.id, key);
	const ch = peerChannel(walletNodeId);
	const peer = peerUnits(assetId) + peerChannelUnits(ch).local;
	check(`${what}: the wallet and the peer hold all that was minted between them`, wallet + peer + handed === MINTED, `wallet ${wallet} + peer ${peer} + handed to tapd ${handed}`);
}

// The peer checks what a channel is funded with against its universe: it
// is given the issuance the wallet published to the stack's tapd.
const synced = peerTapcli('universe', 'sync', '--universe_host', 'tapd:10029', '--asset_id', assetId);
console.log(`  the peer synced from the stack's universe: ${JSON.stringify(synced).slice(0, 300)}`);
await waitFor('the peer knows the asset', () => Object.values(peerTapcli('universe', 'roots').universe_roots || {}).some((r) => r.id && r.id.asset_id === assetId));

/** Open a channel of `amount` from the wallet to the peer and wait for both to read it open. */
async function openToPeer(amount) {
	const peer = { pubkey: peerPubkey, host: PEER_HOST, port: PEER_PORT };
	const quote = await post(A.id, '/channels/quote', { key, amount: String(amount), feeRate: 2 });
	const t0 = Date.now();
	const opened = await post(A.id, '/channels/open', { peer, key, amount: String(amount), feeRate: 2 }, idem());
	console.log(`  timing: open answered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
	const both = await waitFor(
		'the asset channel is open on the wallet and active on the peer',
		async () => {
			const list = (await x(A.id, '/channels')).channels || [];
			const mine_ = list.find((c) => c.pendingChannelId === opened.pendingChannelId || c.channelId === opened.pendingChannelId);
			const theirs = peerChannel(walletNodeId);
			if (mine_ && mine_.state === 'NORMAL' && theirs && theirs.active) return { mine: mine_, theirs };
			mine(1);
			return null;
		},
		{ timeoutMs: 300000, everyMs: 2500 }
	);
	console.log(`  timing: open usable after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
	return { quote, opened, ...both };
}

/**
 * The peer prices an invoice over a channel only once the channel is in its
 * graph with this wallet's policy on it: until then lnd answers "edge not
 * found", after the peer has already asked this wallet for a quote that it
 * keeps, and tapd at the pinned commit ends AddInvoice in a nil pointer
 * dereference on a missing policy. So the graph is waited for, and not the
 * invoice retried. The wallet's channel_update that lnd can place carries the
 * channel's short ID, which the engine sends once the funding is six blocks
 * deep: the one it sends at channel_ready names lnd's alias, and lnd keeps
 * the edge of a channel of this type under its short ID. Blocks are mined
 * while it waits.
 */
async function peerGraphHas() {
	const ch = peerChannel(walletNodeId);
	if (!ch) throw new Error('the peer lists no channel with the wallet');
	await waitFor('the channel is in the peer\'s graph with the wallet\'s policy', () => {
		try {
			// lnd's RPC names the short channel ID `chan_id`.
			const edge = peerLncli('getchaninfo', '--chan_id', ch.chan_id);
			if (edge && edge.node1_policy && edge.node2_policy) return edge;
			mine(1);
			return null;
		} catch (_) {
			mine(1);
			return null;
		}
	}, { timeoutMs: 60000, everyMs: 1000 });
}

/** The live asset channel with the peer, as the wallet lists it. */
const liveWithPeer = async () => ((await x(A.id, '/channels')).channels || []).find((c) => c.state === 'NORMAL' && c.peerPubkey === peerPubkey) || null;

/**
 * Waits until a payment of `units` has left both commitments: the payer's
 * side is debited when it offers the HTLC, the payee's side credited only
 * once the settled HTLC has left both, so a quote asked in between reads the
 * old balances.
 */
async function settledBy(before, units) {
	const want = BigInt(before.localBalance) + BigInt(units);
	await waitFor('the payment has left both commitments', async () => {
		const c = await channelOf(A.id, before.channelId);
		return c && BigInt(c.localBalance) === want && BigInt(c.localBalance) + BigInt(c.remoteBalance) === BigInt(c.capacity) ? c : null;
	}, { timeoutMs: 60000, everyMs: 500 });
}

/** The peer invoices `units` of the asset and the wallet pays it. */
async function walletPaysPeer(units, memo) {
	await peerGraphHas();
	const before = await liveWithPeer();
	const inv = peerRpc('invoice', { asset_id: b64(assetId), asset_amount: String(units), peer_pubkey: b64(walletNodeId), invoice_request: { memo, expiry: '600', private: true } });
	const bolt11 = inv.invoice_result.payment_request;
	const quoted = await post(A.id, '/pay/quote', { bolt11, key });
	const paid = await post(A.id, '/pay', { bolt11, key, quoteId: quoted.quoteId, maxAssetAmount: quoted.assetAmount }, idem());
	if (paid.status === 'COMPLETED') await settledBy(before, -units);
	return { inv, quoted, paid };
}

/** The wallet invoices `units` with a price from the peer, and the peer pays it with the asset. */
async function peerPaysWallet(units) {
	const before = await liveWithPeer();
	const quoted = await post(A.id, '/invoices/quote', { key, amount: String(units) });
	const invoice = await post(A.id, '/invoices', { key, amount: String(units), quoteId: quoted.quoteId });
	// tapd's SendPayment with the records of the first hop takes the price
	// as the wallet agreed it with the peer and asks nobody again.
	const records = Object.fromEntries(
		Array.from(lightning.htlcToCustomRecords({ balances: [{ assetId: Buffer.from(assetId, 'hex'), amount: BigInt(units) }], rfqId: Buffer.from(quoted.quoteId, 'hex') }), ([type, value]) => [type.toString(), value.toString('base64')])
	);
	const reverse = peerRpc('pay', {
		asset_id: b64(assetId),
		payment_request: { payment_request: invoice.bolt11, timeout_seconds: 60, fee_limit_msat: '0', max_parts: 1, no_inflight_updates: true, first_hop_custom_records: records }
	});
	const row = await waitFor('the wallet reads its invoice paid', async () => (((await x(A.id, '/invoices')).invoices || []).find((i) => i.paymentHash === invoice.paymentHash && i.status === 'PAID') || null), { timeoutMs: 60000 });
	await settledBy(before, units);
	return { quoted, invoice, reverse, row };
}

/* ------------------------------------------------------------ 1. the open */

const first = await openToPeer(40_000);
check('the wallet opens an asset channel with the upstream peer', first.mine.state === 'NORMAL' && first.mine.localBalance === '40000', JSON.stringify({ state: first.mine.state, local: first.mine.localBalance }));
const csv = { local: first.theirs.local_constraints && first.theirs.local_constraints.csv_delay, remote: first.theirs.remote_constraints && first.theirs.remote_constraints.csv_delay };
check('the channel has one CSV delay for both sides, as tapd signs it', !!csv.local && csv.local === csv.remote, JSON.stringify(csv));
const engineList = await (await import('./lib.mjs')).w(A.id, '/channels');
check('the engine lists it as a channel that carries an asset', Array.isArray(engineList) && engineList.some((c) => c.auxiliary === true), JSON.stringify(engineList.map((c) => ({ state: c.state, auxiliary: c.auxiliary }))));
await conserved('after the open');
const btcOpen = await noteBitcoin('after the open', { wallet: A.id });

/* -------------------------------------------------- 2. an invoice each way */

const p1 = await walletPaysPeer(7_500, 'scenario 25: the wallet pays');
check('the wallet pays an asset invoice of the upstream peer', p1.paid.status === 'COMPLETED' && p1.quoted.assetAmount === '7500', JSON.stringify({ status: p1.paid.status, quoted: p1.quoted.assetAmount, priced: p1.quoted.priced }));
// tapd at the pinned commit lets an HTLC that carries units out only while
// its spendable bitcoin in the channel covers the payment's whole value in
// sats, though only the carrier goes on the wire. The peer of an open from
// this wallet holds the push, 1,708 sats, less a 1,000 sat reserve: it pays
// this wallet, or forwards to it, a little under 1,100 sats' worth at most.
const p2 = await peerPaysWallet(700);
check('the upstream peer pays an asset invoice of the wallet', p2.reverse.payment_result && p2.reverse.payment_result.status === 'SUCCEEDED' && !!p2.row, JSON.stringify({ status: p2.reverse.payment_result && p2.reverse.payment_result.status, failure: p2.reverse.payment_result && p2.reverse.payment_result.failure_reason, received: p2.row && p2.row.receivedAmount }));
check('both payments are on both sides: 40,000 less 7,500 plus 700', (await channelOf(A.id, first.mine.channelId))?.localBalance === '33200', (await channelOf(A.id, first.mine.channelId))?.localBalance);
await conserved('after a payment each way');
const btcPaid = await noteBitcoin('after a payment each way', { wallet: A.id });
console.log(`  the carrier: the wallet's channel bitcoin moved ${btcOpen.wallet.inChannels - btcPaid.wallet.inChannels} sat over the two payments`);

/* ------------------------------------------------------ 3. both restarted */

await restart(A.id);
compose(['restart', SERVICE]);
await waitFor('the channel is back after both restarts', async () => {
	const c = await channelOf(A.id, first.mine.channelId);
	const theirs = peerChannel(walletNodeId);
	return c && c.state === 'NORMAL' && c.peerOnline !== false && theirs && theirs.active ? c : null;
}, { timeoutMs: 240000, everyMs: 3000 });
const p3 = await walletPaysPeer(1_000, 'scenario 25: after the restarts');
check('after both restarted the wallet pays the peer again', p3.paid.status === 'COMPLETED', p3.paid.status);
await conserved('after both restarted');

/* ------------------------------------ 4. a price from the peer, and a hop */

const thirdPubkey = thirdLncli('getinfo').identity_pubkey;
try {
	peerLncli('connect', `${thirdPubkey}@lnd:9735`);
} catch (err) {
	if (!/already connected/i.test(String(err.stderr || err.message))) throw err;
}
// A bitcoin channel from an earlier run of this scenario is used as it is.
const btcChannel = (peerLncli('listchannels').channels || []).find((c) => c.remote_pubkey === thirdPubkey && c.active)
	? { funding_txid: '(an earlier run\'s channel)' }
	: peerLncli('openchannel', '--node_key', thirdPubkey, '--local_amt', 2_000_000, '--push_amt', 1_000_000);
mine(6);
// Active on both sides: the stack lnd routes over its own link only once that
// link has started, a moment after the peer reads the channel active.
await waitFor('the peer and the stack lnd have an active bitcoin channel', () => (peerLncli('listchannels').channels || []).some((c) => c.remote_pubkey === thirdPubkey && c.active) && (thirdLncli('listchannels').channels || []).some((c) => c.remote_pubkey === peerPubkey && c.active), { timeoutMs: 120000, everyMs: 2000 });
await sleep(3000);
console.log(`  bitcoin channel peer to the stack's lnd: ${btcChannel.funding_txid}`);
// The stack's lnd pays an invoice of the wallet in bitcoin: the peer prices it, takes the sats and pays units on.
const pricedIn = await post(A.id, '/invoices/quote', { key, amount: '600' });
check('an invoice priced by the upstream peer says so, in sats and at its rate', pricedIn.priced === true && Number(pricedIn.amountSats) > 0, JSON.stringify({ priced: pricedIn.priced, amountSats: pricedIn.amountSats, rate: pricedIn.rateText }));
const invIn = await post(A.id, '/invoices', { key, amount: '600', quoteId: pricedIn.quoteId });
let payOut = null;
try {
	payOut = compose(['exec', '-T', 'lnd', 'lncli', '--network=regtest', 'payinvoice', '--force', '--json', invIn.bolt11]);
} catch (err) {
	payOut = String(err.stdout || '') + String(err.stderr || err.message);
}
console.log(`  the stack lnd paid: ${String(payOut).split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400)}`);
const inRow = await waitFor('the wallet reads its bitcoin-paid invoice paid', async () => (((await x(A.id, '/invoices')).invoices || []).find((i) => i.paymentHash === invIn.paymentHash && i.status === 'PAID') || null), { timeoutMs: 90000 }).catch(() => null);
check('a node with no asset pays the wallet in bitcoin, and the wallet receives units through the peer', !!inRow, JSON.stringify(inRow && { received: inRow.receivedAmount, sats: inRow.amountSats }));
// The wallet pays a bitcoin invoice of the stack's lnd with units: the peer prices them and pays the sats on.
const outInvoice = thirdLncli('addinvoice', '--amt', 1500, '--memo', 'scenario 25: paid in units');
const askOut = () => post(A.id, '/pay/quote', { bolt11: outInvoice.payment_request, key }).catch((e) => ({ refused: { code: e.code, message: e.message } }));
let pricedOut = await askOut();
// A bitcoin channel opened by this run reaches the wallet's graph only once
// it is announced, 6 blocks deep, and lnd's gossip has passed it on, which
// lnd batches. Until then the wallet has no route to the stack's lnd and
// refuses before it asks the peer for a price, so asking again costs the
// peer nothing.
if (pricedOut.refused && pricedOut.refused.code === 'PAYMENT_NOT_SENT' && btcChannel.funding_txid !== "(an earlier run's channel)") {
	console.log('  the wallet has no route over the new bitcoin channel yet: asking again');
	pricedOut = await waitFor('the wallet routes to the stack lnd over the new bitcoin channel', async () => {
		const answer = await askOut();
		return answer.refused && answer.refused.code === 'PAYMENT_NOT_SENT' ? null : answer;
	}, { timeoutMs: 300000, everyMs: 20000 }).catch(() => pricedOut);
}
check('a bitcoin invoice of another node is priced in units by the peer', !pricedOut.refused && pricedOut.priced === true, JSON.stringify(pricedOut));
if (!pricedOut.refused) {
	const sent = await post(A.id, '/pay', { bolt11: outInvoice.payment_request, key, quoteId: pricedOut.quoteId, maxAssetAmount: pricedOut.assetAmount }, idem()).catch((e) => ({ refused: { code: e.code, message: e.message } }));
	const settled = await waitFor('the stack lnd reads its invoice settled', () => {
		// lncli prints the payment hash as hex.
		const inv = thirdLncli('lookupinvoice', outInvoice.r_hash);
		return inv.state === 'SETTLED' ? inv : null;
	}, { timeoutMs: 90000 }).catch(() => null);
	check('the wallet pays a bitcoin invoice of a node with no asset, in units through the peer', !!settled && sent.status === 'COMPLETED', JSON.stringify({ answer: sent.status || sent.refused, settled: settled && settled.state, units: pricedOut.assetAmount }));
}
await conserved('after the payments through the peer');

/* ----------------------------------------------- 5. a cooperative close */

const beforeClose = await split(A.id, key);
await post(A.id, '/channels/close', { channelId: first.mine.channelId, force: false });
const over1 = await channelOver(A.id, first.mine.channelId, { blocksEach: 1, timeoutMs: 300000 });
check('the cooperative close with the upstream peer ends', over1.state === 'CLOSED', over1.state);
await waitFor('the peer has its share on-chain', () => (peerChannel(walletNodeId) ? null : peerUnits(assetId) > 0n ? true : (mine(1), null)), { timeoutMs: 180000, everyMs: 2500 });
const afterClose = await split(A.id, key);
check("the wallet's share comes home on-chain", BigInt(afterClose.onchain) === BigInt(beforeClose.onchain) + BigInt(beforeClose.channel) && afterClose.channel === '0', JSON.stringify({ beforeClose, afterClose }));
await conserved('after the cooperative close');
const share1 = BigInt(beforeClose.channel);
await handToTapd(A.id, assetId, String(share1), "the wallet's share of the cooperative close");
handed += share1;
await conserved('after handing that share to tapd');

/* ----------------------------------- 6. a force close by the upstream peer */

const second = await openToPeer(20_000);
const p4 = await walletPaysPeer(3_000, 'scenario 25: before the peer force closes');
check('a payment on the second channel', p4.paid.status === 'COMPLETED', p4.paid.status);
const point = second.theirs.channel_point.split(':');
const closing = peerRpc('close-channel', { channel_point: { funding_txid_str: point[0], output_index: Number(point[1]) }, force: true });
console.log(`  the peer force closed: ${JSON.stringify(closing).slice(0, 200)}`);
const over2 = await channelOver(A.id, second.mine.channelId, { blocksEach: 2, timeoutMs: 600000 });
check("the wallet takes its share of the peer's force close", over2.state === 'FORCE_CLOSED' || over2.state === 'CLOSED', over2.state);
const peerBefore2 = peerUnits(assetId);
await waitFor('the peer sweeps its share after the delay', () => (peerUnits(assetId) >= peerBefore2 + 3000n ? true : (mine(12), null)), { timeoutMs: 900000, everyMs: 3000 });
await conserved("after the peer's force close");
await handToTapd(A.id, assetId, '17000', "the wallet's share of the peer's force close");
handed += 17_000n;

/* ------------------------- 7. a force close by the wallet, the peer stopped */

const third = await openToPeer(10_000);
const p5 = await walletPaysPeer(2_000, 'scenario 25: before the wallet force closes');
check('a payment on the third channel', p5.paid.status === 'COMPLETED', p5.paid.status);
compose(['stop', SERVICE]);
const forced = await post(A.id, '/channels/close', { channelId: third.mine.channelId, force: true });
check('the wallet force closes with the peer stopped', forced.closing === true && forced.force === true, JSON.stringify(forced));
const over3 = await channelOver(A.id, third.mine.channelId, { blocksEach: 12, timeoutMs: 900000 });
check('after the delay the wallet has swept its share', over3.state === 'FORCE_CLOSED' || over3.state === 'CLOSED', over3.state);
compose(['start', SERVICE]);
await waitFor('the peer is back', () => compose(['ps', '--status', 'running', '--services']).split('\n').includes(SERVICE) && peerLncli('getinfo').synced_to_chain, { timeoutMs: 180000, everyMs: 3000 }).catch(() => null);
await sleep(5000);
const peerBefore3 = peerUnits(assetId);
await waitFor("the peer takes its share of the wallet's force close", () => (peerUnits(assetId) >= peerBefore3 + 2000n ? true : (mine(1), null)), { timeoutMs: 300000, everyMs: 3000 }).catch(() => null);
await conserved("after the wallet's force close");
await handToTapd(A.id, assetId, '8000', "the wallet's share of its force close");
handed += 8_000n;
await conserved('at the end');
check('no live channel is left on the wallet', (await liveChannels(A.id)).length === 0);
await noteBitcoin('at the end', { wallet: A.id });

done({ A: A.id, assetId, key, peer: peerPubkey });
