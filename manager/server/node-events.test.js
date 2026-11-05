'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * The daemon event stream's connection state (beignet-umbrel #282). The
 * stream is opened before the daemon listens, so its first attempts fail and
 * the retry backs off; kick() connects at once instead, and whenConnected()
 * says when events can no longer be missed. Held against a local SSE server
 * on loopback.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { subscribeToEvents } = require('./node-events');

const freePort = () =>
	new Promise((resolve) => {
		const s = http.createServer();
		s.listen(0, '127.0.0.1', () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});

// A minimal /events endpoint: answers 200, keeps the response open and
// counts the requests it served.
function sseServer(port) {
	const open = new Set();
	let requests = 0;
	const server = http.createServer((req, res) => {
		requests += 1;
		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		res.write(':ok\n\n');
		open.add(res);
		res.on('close', () => open.delete(res));
	});
	return new Promise((resolve) =>
		server.listen(port, '127.0.0.1', () =>
			resolve({
				get requests() {
					return requests;
				},
				send: (name, data) => {
					for (const res of open) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
				},
				endAll: () => {
					for (const res of open) res.end();
				},
				close: () =>
					new Promise((r) => {
						for (const res of open) res.destroy();
						server.close(() => r());
					})
			})
		)
	);
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('a stream opened before the daemon listens waits out its backoff unless kicked', async () => {
	const port = await freePort();
	const sub = subscribeToEvents({ port, token: 't', onEvent: () => {}, log: () => {} });
	try {
		await settle(50); // the first attempt is refused; a retry is due in 1 s
		const server = await sseServer(port);
		try {
			assert.equal(sub.connected, false);
			// Without a kick the stream is still in its backoff 300 ms later.
			assert.equal(await sub.whenConnected(300), false);
			const t0 = Date.now();
			sub.kick();
			assert.equal(await sub.whenConnected(2000), true);
			assert.ok(Date.now() - t0 < 800, `kick connected in ${Date.now() - t0} ms, before the 1 s retry`);
			assert.equal(sub.connected, true);
		} finally {
			sub.stop();
			await server.close();
		}
	} finally {
		sub.stop();
	}
});

test('a connected stream answers at once, delivers events and ignores a kick', async () => {
	const port = await freePort();
	const server = await sseServer(port);
	const seen = [];
	const sub = subscribeToEvents({ port, token: 't', onEvent: (name, data) => seen.push([name, data]), log: () => {} });
	try {
		assert.equal(await sub.whenConnected(2000), true);
		assert.equal(await sub.whenConnected(0), true);
		sub.kick();
		await settle(50);
		assert.equal(server.requests, 1, 'a kick while connected opens no second stream');
		server.send('ffor:state', { channelId: 'ab', state: 'CLOSED' });
		await settle(50);
		assert.deepEqual(seen, [['ffor:state', { channelId: 'ab', state: 'CLOSED' }]]);
	} finally {
		sub.stop();
		await server.close();
	}
});

test('a dropped stream reads not connected until it is back', async () => {
	const port = await freePort();
	const server = await sseServer(port);
	const sub = subscribeToEvents({ port, token: 't', onEvent: () => {}, log: () => {} });
	try {
		assert.equal(await sub.whenConnected(2000), true);
		server.endAll();
		await settle(50);
		assert.equal(sub.connected, false);
		// The retry after a drop is due in 1 s; a kick brings it back now.
		sub.kick();
		assert.equal(await sub.whenConnected(500), true);
		assert.equal(server.requests, 2);
	} finally {
		sub.stop();
		await server.close();
	}
});

test('stop() answers a pending wait with false and later waits at once', async () => {
	const port = await freePort();
	const sub = subscribeToEvents({ port, token: 't', onEvent: () => {}, log: () => {} });
	const pending = sub.whenConnected(10000);
	await settle(20);
	sub.stop();
	assert.equal(await pending, false);
	assert.equal(await sub.whenConnected(10000), false);
	assert.equal(sub.connected, false);
	sub.kick(); // a stopped stream stays stopped
	await settle(20);
	assert.equal(sub.connected, false);
});
