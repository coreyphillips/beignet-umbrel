'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * Sibling wallets that share a channel are kept connected over loopback:
 * after both are healthy, after either restarts, and after a drop. Stopped,
 * parked and foreign-network wallets are left alone, and a refused dial is
 * logged once.
 */
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');
const { siblingsOf, redialDelay, channelSiblings } = require('./sibling-peers');

const PK_A = '02' + 'aa'.repeat(32);
const PK_B = '03' + 'bb'.repeat(32);
const PK_C = '02' + 'cc'.repeat(32);
const PK_EXT = '03' + 'ee'.repeat(32);

const wallet = (id, port, nodeId, extra = {}) => ({
	id,
	name: id.toUpperCase(),
	network: 'regtest',
	port,
	nodeId,
	onchainOnly: false,
	running: true,
	...extra
});
const channel = (peerPubkey, state = 'NORMAL') => ({ channelId: `ch-${peerPubkey.slice(2, 6)}`, peerPubkey, state });

function managerWith(records, channels) {
	const m = Object.create(WalletManager.prototype);
	const store = Object.fromEntries(records.map((r) => [r.id, r]));
	m.registry = {
		get: (id) => store[id],
		list: () => Object.values(store),
		upsert: (r) => {
			store[r.id] = r;
		}
	};
	m.runtime = new Map();
	m.logs = [];
	m._log = (id, line) => m.logs.push(`${id}: ${line}`);
	m._captureNodeId = async () => {};
	m._restoreLfbwLinks = async () => {};
	m.siblingRedialMs = 20;
	m.calls = [];
	m.refuse = new Set();
	m.connected = {};
	m._daemonCall = async (rec, method, apiPath, body) => {
		if (apiPath === '/channels') return channels[rec.id] || [];
		if (apiPath === '/peers') return (m.connected[rec.id] || []).map((pubkey) => ({ pubkey, state: 'ready' }));
		if (apiPath === '/peer/connect') {
			m.calls.push({ from: rec.id, ...body });
			if (m.refuse.has(body.port)) throw new Error(`connect ECONNREFUSED 127.0.0.1:${body.port}`);
			return { pubkey: body.pubkey, host: body.host, port: body.port, state: 'connected' };
		}
		throw new Error(`unexpected ${method} ${apiPath}`);
	};
	for (const r of records) up(m, r.id);
	return { m, store };
}

// A daemon that is running and answering /health.
function up(m, id) {
	const rt = m.runtimeState(id);
	rt.proc = { pid: id };
	rt.status = 'running';
	rt.healthy = true;
	rt.stopping = false;
	return rt;
}

function down(m, id) {
	const rt = m.runtimeState(id);
	rt.proc = null;
	rt.status = 'stopped';
	rt.healthy = false;
	return rt;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('siblings are the other Lightning wallets on the network, and only those with a live channel count', () => {
	const a = wallet('a', 3901, PK_A);
	const records = [
		a,
		wallet('b', 3902, PK_B),
		wallet('c', 3903, PK_C, { onchainOnly: true }),
		wallet('d', 3904, PK_EXT, { network: 'bitcoin' }),
		wallet('e', 3905, null)
	];
	assert.deepEqual(siblingsOf(a, records).map((s) => s.id), ['b']);
	assert.deepEqual(siblingsOf({ ...a, onchainOnly: true }, records), []);
	const sibs = siblingsOf(a, records);
	assert.deepEqual(channelSiblings(sibs, [channel(PK_B)]).map((s) => s.id), ['b']);
	assert.deepEqual(channelSiblings(sibs, [channel(PK_B, 'AWAITING_REESTABLISH')]).map((s) => s.id), ['b']);
	assert.deepEqual(channelSiblings(sibs, [channel(PK_B, 'CLOSED'), channel(PK_B, 'FORCE_CLOSED')]), []);
	assert.deepEqual(channelSiblings(sibs, [channel(PK_EXT)]), []);
});

test('two running siblings with a channel get a loopback connect once both are healthy, and again after a restart', async () => {
	const { m } = managerWith([wallet('a', 3901, PK_A), wallet('b', 3902, PK_B)], {
		a: [channel(PK_B)],
		b: [channel(PK_A)]
	});
	// A comes up while B is still starting: nothing to connect to yet.
	down(m, 'b');
	m.runtimeState('b').proc = { pid: 'b' };
	m.runtimeState('b').status = 'starting';
	await m._onHealthy('a');
	assert.deepEqual(m.calls, []);

	// B comes up second and makes the connection, to A's listen port.
	up(m, 'b');
	await m._onHealthy('b');
	assert.deepEqual(m.calls, [{ from: 'b', pubkey: PK_A, host: '127.0.0.1', port: 3901 + 6000 }]);
	assert.ok(m.logs.includes('b: connected to sibling "A" over loopback'));

	// A restarts: its own pass dials B again.
	m.calls = [];
	m._maybeRestart = () => {};
	m._onChildExit('a', m.runtimeState('a'), m.runtimeState('a').proc, 0, null);
	up(m, 'a');
	await m._onHealthy('a');
	assert.deepEqual(m.calls, [{ from: 'a', pubkey: PK_B, host: '127.0.0.1', port: 3902 + 6000 }]);
});

test('a stopped, parked, foreign-network or channel-less sibling gets no connect', async () => {
	const { m } = managerWith(
		[
			wallet('a', 3901, PK_A),
			wallet('b', 3902, PK_B, { running: false }),
			wallet('c', 3903, PK_C, { onchainOnly: true }),
			wallet('d', 3904, PK_EXT, { network: 'bitcoin' }),
			wallet('e', 3905, '02' + 'dd'.repeat(32))
		],
		{ a: [channel(PK_B), channel(PK_C), channel(PK_EXT)] }
	);
	down(m, 'b');
	await m._onHealthy('a');
	assert.deepEqual(m.calls, []);

	// An on-chain only wallet does not dial its siblings either.
	const parked = managerWith([wallet('a', 3901, PK_A, { onchainOnly: true }), wallet('b', 3902, PK_B)], {
		a: [channel(PK_B)]
	}).m;
	await parked._onHealthy('a');
	assert.deepEqual(parked.calls, []);
});

test('a sibling dropping triggers one reconnect after the backoff; other peers dropping trigger none', async (t) => {
	const { m, store } = managerWith([wallet('a', 3901, PK_A), wallet('b', 3902, PK_B)], {
		a: [channel(PK_B), channel(PK_EXT)]
	});
	// The daemon's event stream, as the manager subscribes to it.
	const sse = http.createServer((req, res) => {
		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		const send = (pubkey) => res.write(`event: peer:disconnect\ndata: ${JSON.stringify({ pubkey })}\n\n`);
		send(PK_B);
		send(PK_B);
		send(PK_EXT);
	});
	await new Promise((resolve) => sse.listen(0, '127.0.0.1', resolve));
	t.after(() => sse.close());
	store.a.port = sse.address().port;
	m.token = () => 'token';
	m.channelLog = () => ({ record: () => null });
	m.siblingRedialMs = 150;
	const rt = m.runtimeState('a');
	m._startEvents('a', store.a, rt);
	t.after(() => m._stopEvents(rt));

	await sleep(60);
	assert.deepEqual(m.calls, [], 'nothing before the backoff');
	assert.equal(rt.siblingRedials.size, 1, 'both drops of B share one redial');
	await sleep(200);
	assert.deepEqual(m.calls, [{ from: 'a', pubkey: PK_B, host: '127.0.0.1', port: 3902 + 6000 }]);
});

test('the lower node id redials first, and a later redial leaves an already connected sibling alone', async () => {
	assert.equal(redialDelay(PK_A, PK_B, 100), 100);
	assert.equal(redialDelay(PK_B, PK_A, 100), 300);
	const { m } = managerWith([wallet('a', 3901, PK_A), wallet('b', 3902, PK_B)], {
		a: [channel(PK_B)],
		b: [channel(PK_A)]
	});
	m.connected.b = [PK_A];
	await m._linkSiblings('b', { pubkey: PK_A });
	assert.deepEqual(m.calls, [], 'A already dialed B back');
	// A restart pass dials regardless: it moves the reconnect address to loopback.
	await m._linkSiblings('b');
	assert.equal(m.calls.length, 1);
});

test('a redial pending when the wallet stops is dropped, even if it is back up before the backoff', async () => {
	const { m } = managerWith([wallet('a', 3901, PK_A), wallet('b', 3902, PK_B)], { a: [channel(PK_B)] });
	m._killProc = async () => {};
	m._scheduleSiblingRedial('a', PK_B);
	await m.stopWallet('a');
	up(m, 'a');
	await sleep(60);
	assert.deepEqual(m.calls, []);
});

test('a refused connect is logged once, and the recovery is logged when it comes', async () => {
	const { m } = managerWith([wallet('a', 3901, PK_A), wallet('b', 3902, PK_B)], { a: [channel(PK_B)] });
	m.refuse.add(3902 + 6000);
	await m._linkSiblings('a');
	await m._linkSiblings('a', { pubkey: PK_B });
	await m._linkSiblings('a');
	assert.equal(m.calls.length, 3);
	const refusals = m.logs.filter((l) => l.includes('could not connect to sibling "B"'));
	assert.equal(refusals.length, 1);
	assert.match(refusals[0], /ECONNREFUSED 127\.0\.0\.1:9902/);

	m.refuse.clear();
	await m._linkSiblings('a');
	await m._linkSiblings('a');
	assert.equal(m.logs.filter((l) => l.includes('connected to sibling "B" over loopback')).length, 1);
});
