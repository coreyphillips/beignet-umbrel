import { api, w, btc, mine, waitFor, check, log, fund, healthy } from './lib.mjs';
// Sibling wallets that share a channel stay connected over loopback (umbrel
// #146). Needs the manager started with PUBLIC_HOST=10.255.255.1: that puts
// an address nothing answers into L1's requests as the primary's, standing in
// for the primary's onion. A payer connected to P never dials it; one that is
// not spends its connect timeout there, as a dial through Tor would.
const ids = JSON.parse(process.argv[2]);
const { P, L1, Pnode } = ids;
const DEAD_HOST = '10.255.255.1';
const live = (c) => c.state !== 'CLOSED' && c.state !== 'FORCE_CLOSED';
const usableWith = async (id, peer) => (await w(id, '/channels')).find((c) => c.peerPubkey === peer && live(c) && (c.htlcUsable ?? c.state === 'NORMAL'));
const peerOf = async (id, peer) => (await w(id, '/peers')).find((p) => p.pubkey === peer);
// /peers reports the address a peer is stored under, not the socket's, so an
// end that was dialed still lists what it last dialed itself. The dead
// address cannot carry a connection: ready on both ends with either end
// listing loopback is a loopback link.
const loopback = async (a, aNode, b, bNode) => {
	const [ab, ba] = [await peerOf(a, bNode), await peerOf(b, aNode)];
	return ab?.state === 'ready' && ba?.state === 'ready' && [ab.host, ba.host].includes('127.0.0.1') ? { ab, ba } : null;
};

await healthy(P);
await healthy(L1);
const df = await w(L1, '/direct-funding/config');
if (df.lspHost !== DEAD_HOST) {
	check(`L1 requests name P at ${DEAD_HOST} (restart the manager with PUBLIC_HOST=${DEAD_HOST})`, false, `lspHost ${df.lspHost}`);
	process.exit(1);
}
const Prec = await api(`/wallets/${P}`);

// W: a sibling payer with its own channel to P.
let W = ids.W;
if (!W) {
	W = (await api('/wallets', { method: 'POST', body: { name: 'Sibling payer', network: 'regtest' } })).record.id;
	await healthy(W);
}
if (!(await w(W, '/channels')).some((c) => c.peerPubkey === Pnode && live(c))) {
	await fund(W, 1_000_000);
	await waitFor('W funded', async () => (await w(W, '/balance')).onchain >= 1_000_000);
	const { channelId } = await w(W, '/channel/connect-and-open', { method: 'POST', body: { pubkey: Pnode, host: '127.0.0.1', port: Prec.listenPort, amountSats: 400000 } });
	// The open answers before the funding is broadcast; mining first would leave it unconfirmed.
	await waitFor('W funding in the mempool', async () => { const c = (await w(W, '/channels')).find((x) => x.channelId === channelId && x.fundingTxid); return c && btc('getrawmempool').includes(c.fundingTxid); });
	mine(3);
	await waitFor('W channel with P usable', () => usableWith(W, Pnode), { timeoutMs: 120000 });
}
const Wrec = await api(`/wallets/${W}`);
const Wnode = Wrec.nodeId;
await waitFor('W connected to P over loopback', () => loopback(W, Wnode, P, Pnode), { timeoutMs: 30000 });

// W holds only the dead address for P, as a payer that last reached P through
// its onion would. A dial to a connected peer just records the address (one
// that joins W's own reconnect to the dead address times out with it, having
// recorded it all the same). The manager points it back at loopback the next
// time it links the pair.
await w(W, '/peer/connect', { method: 'POST', body: { pubkey: Pnode, host: DEAD_HOST, port: Prec.listenPort } }).catch(() => null);

// Pay an L1 request from W at once, and read W's lane log for the send.
async function payFromW(label) {
	await waitFor('L1 home channel usable', () => usableWith(L1, Pnode), { timeoutMs: 60000, everyMs: 250 });
	const t0 = Date.now();
	const req = await w(L1, '/direct-funding/request', { method: 'POST', body: { amountSats: 60000 } });
	let res = null;
	try {
		res = await w(W, '/direct-funding/send', { method: 'POST', body: { request: req.request, amountSats: 60000, feeHeadroomSats: 1000 } });
	} catch (e) {
		log('W send rejected:', e.code, e.message);
	}
	const sendMs = Date.now() - t0;
	check(`${label}: W send committed`, !!(res && res.fundingTxid), res ? `${res.status} in ${(sendMs / 1000).toFixed(1)}s` : `failed after ${(sendMs / 1000).toFixed(1)}s`);
	// The skip reaches the action log or the daemon's own output depending on
	// the engine build, so both are read.
	const entries = await w(W, `/logs?category=channel&since=${t0}`);
	const ring = (await api(`/wallets/${W}/logs`)).filter((l) => Date.parse(l.slice(1, 25)) >= t0);
	const skipped = [...entries.map((e) => JSON.stringify(e)), ...ring].filter((l) => l.includes('lane_not_established'));
	check(`${label}: no lane_not_established on W`, skipped.length === 0, skipped.join(' | ').slice(0, 300));
	check(`${label}: commit well under one dial timeout (15 s)`, !!res && sendMs < 15000, `${(sendMs / 1000).toFixed(1)}s`);
	// Confirm the funding past the receiver's depth, so the next send is not
	// declined behind it, and give the wallets a moment to see the blocks.
	if (res) {
		mine(3);
		await new Promise((r) => setTimeout(r, 10000));
	}
}

// 1. Restart P: once it is back the pair is linked again at once.
await api(`/wallets/${P}/stop`, { method: 'POST' });
await waitFor('W sees P gone', async () => !(await peerOf(W, Pnode)), { timeoutMs: 60000 });
await api(`/wallets/${P}/start`, { method: 'POST' });
await healthy(P);
let tHealthy = Date.now();
let linked = await waitFor('W connected to P over loopback after P restarts', () => loopback(W, Wnode, P, Pnode), { timeoutMs: 20000, everyMs: 250 }).catch(() => null);
check('P restart: W is back on P over 127.0.0.1 within 20 s', !!linked, linked ? `${((Date.now() - tHealthy) / 1000).toFixed(1)}s` : JSON.stringify([await peerOf(W, Pnode), await peerOf(P, Wnode)]));
await payFromW('P restart');

// 2. Stop W long enough for P's own reconnect backoff to pass a minute, then
// pay as soon as W is healthy.
await api(`/wallets/${W}/stop`, { method: 'POST' });
log('  W stopped; waiting 70 s for P to back off');
await new Promise((r) => setTimeout(r, 70000));
await api(`/wallets/${W}/start`, { method: 'POST' });
await healthy(W);
tHealthy = Date.now();
linked = await waitFor('W connected to P over loopback after W restarts', () => loopback(W, Wnode, P, Pnode), { timeoutMs: 5000, everyMs: 250 }).catch(() => null);
check('W restart: W is on P over 127.0.0.1 within 5 s of healthy', !!linked, linked ? `${((Date.now() - tHealthy) / 1000).toFixed(1)}s` : JSON.stringify([await peerOf(W, Pnode), await peerOf(P, Wnode)]));
await payFromW('W restart');

const logs = [...(await api(`/wallets/${P}/logs`)), ...(await api(`/wallets/${W}/logs`))];
check('the manager logged the loopback link', logs.some((l) => /connected to sibling ".*" over loopback/.test(l)));
console.log(JSON.stringify({ ...ids, W, Wnode }));
