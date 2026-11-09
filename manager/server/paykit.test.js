'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * Paykit publishing and lookup: what a wallet publishes, when it publishes
 * again, how a failure reads, and that the worker's network calls take the
 * wallet's route. The worker runner is injected, so nothing here reaches the
 * Pubky network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const http = require('http');
const { Worker } = require('worker_threads');
const {
	createPaykit,
	readPubky,
	gatherEndpoints,
	refreshReasons,
	addressIdentifier,
	describeEndpoints,
	DF_EXPIRY_SECS,
	DF_REFRESH_BEFORE_MS
} = require('./paykit');

const PUBKY = 'aihfhgdfshrj8nz9ofo7khayc1mgcqa4wrrdjahs5tmgo4pna3iy';
const ADDRESS = 'bcrt1q28tn3gq5ly02696y27c3py0aev066n0hdzp4n3';
const LFBW_READY = { network: 'regtest', lfbw: { enabled: true, setup: 'ready' }, reach: { host: 'abc.onion', port: 9735 } };

function stubDaemon({ offers = [], received = [], utxos = [] } = {}) {
	const calls = [];
	const call = async (method, path, body) => {
		calls.push([method, path, body]);
		if (path === '/offers') return offers;
		if (path === '/offer/create') return { offerId: 'new-offer', encoded: 'lno1newoffer' };
		if (path === '/address/new') return { address: ADDRESS };
		if (path === '/direct-funding/request') return { paymentHash: 'd'.repeat(64), expiresAt: 1_000_000 + DF_EXPIRY_SECS * 1000, request: 'ENVELOPE' };
		if (path === '/direct-funding/received') return received;
		if (path === '/utxos') return utxos;
		throw new Error(`unexpected ${method} ${path}`);
	};
	return { calls, call };
}

test('readPubky takes every way a pubky is written, and nothing else', () => {
	for (const form of [PUBKY, `pubky${PUBKY}`, `pubky://${PUBKY}`, `pk:${PUBKY}`, PUBKY.toUpperCase(), `  ${PUBKY}\n`]) {
		assert.equal(readPubky(form), PUBKY, form);
	}
	for (const bad of ['', 'pubky', PUBKY.slice(1), `${PUBKY}x`, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', `pubky://${PUBKY}/pub/x`, PUBKY.replace('a', 'l')]) {
		assert.equal(readPubky(bad), null, bad);
	}
});

test('a plain wallet publishes a new offer and a fresh address', async () => {
	const d = stubDaemon();
	const { endpoints, state } = await gatherEndpoints({ rec: { network: 'regtest' }, call: d.call, dfAvailable: true });
	assert.deepEqual(describeEndpoints(endpoints), [
		{ appId: 'beignet', identifier: 'btc-lightning-bolt12', value: 'lno1newoffer' },
		{ appId: 'beignet', identifier: 'btc-bitcoin-p2wpkh', value: ADDRESS }
	]);
	assert.deepEqual(state, { offerId: 'new-offer', address: ADDRESS, df: null });
	assert.ok(!d.calls.some(([, p]) => p === '/direct-funding/request'), 'no direct funding without a lightning-first wallet');
});

test('the offer published last time is kept while the wallet still has it', async () => {
	const d = stubDaemon({ offers: [{ offerId: 'kept', encoded: 'lno1kept' }] });
	const { endpoints } = await gatherEndpoints({ rec: { network: 'regtest' }, call: d.call, state: { offerId: 'kept' } });
	assert.equal(describeEndpoints(endpoints)[0].value, 'lno1kept');
	assert.ok(!d.calls.some(([, p]) => p === '/offer/create'));
});

test('a ready lightning-first wallet adds a week-long direct funding request', async () => {
	const d = stubDaemon();
	const { endpoints, state } = await gatherEndpoints({ rec: LFBW_READY, call: d.call, dfAvailable: true });
	const minted = d.calls.find(([, p]) => p === '/direct-funding/request');
	assert.deepEqual(minted[2], { expirySecs: 604800, host: 'abc.onion', port: 9735 });
	assert.deepEqual(describeEndpoints(endpoints).at(-1), {
		appId: 'beignet',
		identifier: 'btc-bitcoin-bip21',
		value: `bitcoin:${ADDRESS}?bgnq=ENVELOPE`
	});
	assert.deepEqual(JSON.parse(endpoints.at(-1).payload), { value: `bitcoin:${ADDRESS}?bgnq=ENVELOPE` });
	assert.equal(state.df.paymentHash, 'd'.repeat(64));
});

test('direct funding waits for an engine that can make a request last a week', async () => {
	const d = stubDaemon();
	const { state } = await gatherEndpoints({ rec: LFBW_READY, call: d.call, dfAvailable: false });
	assert.equal(state.df, null);
	assert.ok(!d.calls.some(([, p]) => p === '/direct-funding/request'));
});

test('an on-chain only wallet publishes its address alone', async () => {
	const d = stubDaemon();
	const { endpoints } = await gatherEndpoints({ rec: { network: 'regtest', onchainOnly: true }, call: d.call, dfAvailable: true });
	assert.deepEqual(endpoints.map((e) => e.identifier), ['btc-bitcoin-p2wpkh']);
});

test('addressIdentifier names segwit v0 and taproot addresses', () => {
	assert.equal(addressIdentifier(ADDRESS), 'btc-bitcoin-p2wpkh');
	assert.equal(addressIdentifier('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'), 'btc-bitcoin-p2tr');
	assert.equal(addressIdentifier('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), null);
});

test('refreshReasons: nothing while everything published still stands', async () => {
	const d = stubDaemon({ offers: [{ offerId: 'o1' }] });
	const state = { publishedAt: 1, offerId: 'o1', address: ADDRESS, df: { paymentHash: 'h', expiresAt: 10 * DF_REFRESH_BEFORE_MS } };
	assert.deepEqual(await refreshReasons({ rec: LFBW_READY, call: d.call, state, dfAvailable: true, now: 0 }), []);
});

test('refreshReasons: a paid, expiring or vanished request, a used address, a lost offer', async () => {
	const base = { publishedAt: 1, offerId: 'o1', address: ADDRESS, df: { paymentHash: 'h', expiresAt: 10 * DF_REFRESH_BEFORE_MS } };
	const reasons = (opts, state = base, rec = LFBW_READY, dfAvailable = true, now = 0) =>
		refreshReasons({ rec, call: stubDaemon({ offers: [{ offerId: 'o1' }], ...opts }).call, state, dfAvailable, now });

	assert.deepEqual(await reasons({ received: [{ receiptHash: 'h', status: 'PAID' }] }), ['the direct funding request was paid']);
	assert.deepEqual(await reasons({}, base, LFBW_READY, true, 9.5 * DF_REFRESH_BEFORE_MS), ['the direct funding request is about to expire']);
	assert.deepEqual(await reasons({}, base, { network: 'regtest' }), ['direct funding is no longer available']);
	assert.deepEqual(await reasons({ utxos: [{ address: ADDRESS, value: 1000 }] }), ['the address was paid']);
	assert.deepEqual(await reasons({ offers: [] }), ['the offer is gone']);
	assert.deepEqual(await reasons({}, { ...base, df: null }), ['direct funding became available']);
	assert.deepEqual(await reasons({}, { publishedAt: 0 }), [], 'never published, nothing to refresh');
});

test('a lookup is cached for a minute, per pubky and route', async () => {
	let runs = 0;
	let clock = 0;
	const paykit = createPaykit({
		torProxy: '127.0.0.1:9050',
		now: () => clock,
		run: async (data) => {
			runs += 1;
			assert.equal(data.op, 'get');
			assert.equal(data.pubky, PUBKY);
			return [{ appId: 'beignet', identifier: 'btc-lightning-bolt12', payload: '{"value":"lno1x"}' }];
		}
	});
	const rec = { networkMode: 'clearnet' };
	await paykit.lookup(rec, `pubky://${PUBKY}`);
	await paykit.lookup(rec, PUBKY.toUpperCase());
	assert.equal(runs, 1);
	await paykit.lookup({ networkMode: 'tor' }, PUBKY);
	assert.equal(runs, 2, 'a Tor wallet does not reuse a direct lookup');
	clock = 61_000;
	await paykit.lookup(rec, PUBKY);
	assert.equal(runs, 3);
});

test('the worker gets the route the network mode asks for, and the secret is zeroed', async () => {
	const seen = [];
	const paykit = createPaykit({
		torProxy: '127.0.0.1:9050',
		run: async (data, timeoutMs) => {
			seen.push({ route: data.route, timeoutMs, secret: Buffer.from(data.secret).toString('hex') });
			return { pubky: PUBKY, encrypted: false };
		}
	});
	const secret = Buffer.alloc(32, 7);
	await paykit.publish({ networkMode: 'tor' }, secret, []);
	assert.deepEqual(seen[0], { route: 'tor', timeoutMs: 180_000, secret: '07'.repeat(32) });
	assert.ok(secret.every((b) => b === 0), "the caller's copy is zeroed");
	await paykit.publish({ networkMode: 'hybrid' }, Buffer.alloc(32, 1), []);
	assert.equal(seen[1].route, 'direct');
});

test('a Tor wallet with no Tor is refused before any worker runs', async () => {
	let runs = 0;
	const paykit = createPaykit({ torProxy: '', run: async () => (runs += 1) });
	await assert.rejects(paykit.lookup({ networkMode: 'tor' }, PUBKY), (e) => e.code === 'TOR_UNAVAILABLE');
	assert.equal(runs, 0);
});

test('failures read as what they mean, and none is a stack in the log', async () => {
	const failing = (code, message = 'boom') =>
		createPaykit({ run: async () => Promise.reject(Object.assign(new Error(message), { code })) });
	const rec = { networkMode: 'clearnet' };
	await assert.rejects(failing('RATE_LIMITED').publish(rec, Buffer.alloc(32), []), (e) => e.code === 'PAYKIT_RATE_LIMITED' && e.statusCode === 429 && /Pubky Ring/.test(e.message));
	await assert.rejects(failing('TRANSPORT', 'fetch failed').lookup(rec, PUBKY), (e) => e.code === 'PAYKIT_UNREACHABLE' && e.upstream === true && /fetch failed/.test(e.message));
	await assert.rejects(failing('TIMEOUT').lookup(rec, PUBKY), (e) => e.code === 'PAYKIT_TIMEOUT' && e.statusCode === 504);
	await assert.rejects(failing('INVALID_DATA').lookup(rec, PUBKY), (e) => e.code === 'PAYKIT_BAD_DATA');
	await assert.rejects(createPaykit({ run: async () => [] }).lookup(rec, 'not a pubky'), (e) => e.code === 'PAYKIT_INVALID_PUBKY' && e.statusCode === 400);
});

test('no more than two Paykit calls run at once', async () => {
	let running = 0;
	let peak = 0;
	const paykit = createPaykit({
		run: async () => {
			running += 1;
			peak = Math.max(peak, running);
			await new Promise((r) => setTimeout(r, 20));
			running -= 1;
			return [];
		}
	});
	const keys = ['y', 'b', 'n', 'd', 'r'].map((c) => c.repeat(52));
	await Promise.all(keys.map((k) => paykit.lookup({ networkMode: 'clearnet' }, k)));
	assert.equal(peak, 2);
});

/* What the worker relies on: the dispatcher npm undici installs globally is
 * the one Node's built-in fetch (the one the Pubky SDK wraps) goes through.
 * Run in a thread of its own, as the worker is. */
function fakeSocks() {
	const targets = [];
	const server = net.createServer((client) => {
		client.once('data', () => {
			client.write(Buffer.from([5, 0]));
			client.once('data', (req) => {
				const len = req[4];
				const host = req.subarray(5, 5 + len).toString('utf8');
				const port = req.readUInt16BE(5 + len);
				targets.push(`${host}:${port}`);
				const upstream = net.connect(port, '127.0.0.1', () => {
					client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
					client.pipe(upstream).pipe(client);
				});
				upstream.on('error', () => client.destroy());
			});
		});
		client.on('error', () => {});
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, targets, port: server.address().port })));
}

test("in a worker, the global dispatcher routes Node's own fetch through the proxy", async () => {
	const service = http.createServer((req, res) => res.end('{"ok":true}'));
	await new Promise((r) => service.listen(0, '127.0.0.1', r));
	const socks = await fakeSocks();
	const code = `
		const { parentPort, workerData } = require('worker_threads');
		const { setGlobalDispatcher } = require('undici');
		const { createDispatcher } = require(workerData.outbound);
		setGlobalDispatcher(createDispatcher({ route: 'tor', torProxy: workerData.torProxy }));
		globalThis.fetch(workerData.url).then((r) => r.json()).then(
			(j) => parentPort.postMessage({ ok: j.ok }),
			(e) => parentPort.postMessage({ error: e.message })
		);
	`;
	try {
		const answer = await new Promise((resolve, reject) => {
			const w = new Worker(code, {
				eval: true,
				workerData: {
					outbound: require.resolve('./outbound'),
					torProxy: `127.0.0.1:${socks.port}`,
					url: `http://localhost:${service.address().port}/pub/paykit`
				}
			});
			w.once('message', (m) => {
				w.terminate();
				resolve(m);
			});
			w.once('error', reject);
		});
		assert.deepEqual(answer, { ok: true });
		assert.deepEqual(socks.targets, [`localhost:${service.address().port}`]);
	} finally {
		service.close();
		socks.server.close();
	}
});

test('the real runner moves the secret into the worker, and the publish survives it', async () => {
	// The real runWorker transfers the secret's buffer, detaching it here; a
	// cleanup that then fills it must not throw over a publish that worked.
	const { runWorker } = require('./paykit');
	const paykit = createPaykit({
		run: (data, ms) => {
			const moved = runWorker({ op: 'nope', route: 'direct', secret: data.secret }, ms);
			assert.equal(data.secret.byteLength, 0, 'the buffer left this thread');
			return moved.catch(() => ({ pubky: PUBKY, encrypted: false }));
		}
	});
	const result = await paykit.publish({ networkMode: 'clearnet' }, Buffer.alloc(32, 9), []);
	assert.equal(result.pubky, PUBKY);
});
