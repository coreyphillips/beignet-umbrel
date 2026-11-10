'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * The manager's one way out to the internet: which route a request takes for
 * each network mode, what it refuses to open at all, and how it reads what
 * comes back. The fetch is a fake, so the routing decisions are checked
 * without a network or a Tor.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutbound, routeFor, vetUrl, isPrivateAddress, vettedLookup, MAX_BODY_BYTES } = require('./outbound');

function jsonResponse(body, { status = 200, headers = {} } = {}) {
	return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});
}

test('routeFor follows the network mode, and an onion always takes Tor', () => {
	const torProxy = 'tor:9050';
	assert.equal(routeFor({ mode: 'tor', host: 'example.com', torProxy }), 'tor');
	assert.equal(routeFor({ mode: 'hybrid', host: 'example.com', torProxy }), 'direct');
	assert.equal(routeFor({ mode: 'clearnet', host: 'example.com', torProxy }), 'direct');
	assert.equal(routeFor({ mode: 'clearnet', host: 'abc.onion', torProxy }), 'tor');
	assert.equal(routeFor({ mode: 'hybrid', host: 'abc.onion', torProxy }), 'tor');
});

test('a Tor wallet with no Tor is refused rather than sent direct', () => {
	assert.throws(() => routeFor({ mode: 'tor', host: 'example.com', torProxy: '' }), (e) => e.code === 'TOR_UNAVAILABLE');
	assert.throws(() => routeFor({ mode: 'hybrid', host: 'x.onion', torProxy: '' }), (e) => e.code === 'TOR_UNAVAILABLE');
});

test('vetUrl takes https and onions, and refuses http, credentials and private hosts', () => {
	assert.equal(vetUrl('https://example.com/a').href, 'https://example.com/a');
	assert.equal(vetUrl('http://abcdef.onion/a').hostname, 'abcdef.onion');
	for (const [url, code] of [
		['http://example.com/', 'INSECURE_URL'],
		['ftp://example.com/', 'BAD_URL'],
		['https://user:pw@example.com/', 'BAD_URL'],
		['https://localhost/', 'PRIVATE_URL'],
		['https://127.0.0.1/', 'PRIVATE_URL'],
		['https://10.21.0.5/', 'PRIVATE_URL'],
		['https://192.168.1.10/', 'PRIVATE_URL'],
		['https://[::1]/', 'PRIVATE_URL'],
		['https://[::ffff:10.0.0.1]/', 'PRIVATE_URL'],
		['not a url', 'BAD_URL']
	]) {
		assert.throws(() => vetUrl(url), (e) => e.code === code, url);
	}
	// Regtest is let off both, for a test server on this machine.
	assert.equal(vetUrl('http://127.0.0.1:8080/x', { relaxed: true }).port, '8080');
});

test('isPrivateAddress knows the local ranges and leaves public ones alone', () => {
	for (const a of ['10.0.0.1', '172.20.1.1', '192.168.0.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1']) {
		assert.equal(isPrivateAddress(a), true, a);
	}
	for (const a of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(a), false, a);
});

test('the connect-time lookup refuses a name that resolves to a private address', async () => {
	const lookup = vettedLookup((host, opts, cb) =>
		cb(null, host === 'evil.example' ? [{ address: '10.0.0.7', family: 4 }] : [{ address: '93.184.216.34', family: 4 }])
	);
	const resolve = (host) => new Promise((ok, no) => lookup(host, {}, (err, addr) => (err ? no(err) : ok(addr))));
	assert.equal(await resolve('good.example'), '93.184.216.34');
	await assert.rejects(resolve('evil.example'), (e) => e.code === 'PRIVATE_URL');
});

test('getJson picks the dispatcher for the route and parses the answer', async () => {
	const seen = [];
	const outbound = createOutbound({
		torProxy: 'tor:9050',
		dispatcherFor: (route, allowPrivate) => ({ route, allowPrivate }),
		fetchImpl: async (url, init) => {
			seen.push({ url, route: init.dispatcher.route, redirect: init.redirect });
			return jsonResponse({ tag: 'payRequest' });
		}
	});
	const { json } = await outbound.getJson('https://example.com/x', { rec: { networkMode: 'tor', network: 'mainnet' } });
	assert.deepEqual(json, { tag: 'payRequest' });
	await outbound.getJson('https://example.com/y', { rec: { networkMode: 'hybrid', network: 'mainnet' } });
	await outbound.getJson('http://abc.onion/z', { rec: { networkMode: 'clearnet', network: 'mainnet' } });
	assert.deepEqual(
		seen.map((s) => s.route),
		['tor', 'direct', 'tor']
	);
	assert.ok(seen.every((s) => s.redirect === 'manual'), 'redirects are followed by hand');
});

test('getJson follows a redirect, vetting each hop, and never from https to http', async () => {
	const answers = {
		'https://a.example/start': () => new Response(null, { status: 302, headers: { location: 'https://b.example/next' } }),
		'https://b.example/next': () => jsonResponse({ ok: 1 }),
		'https://a.example/down': () => new Response(null, { status: 302, headers: { location: 'http://b.example/plain' } }),
		'https://a.example/inside': () => new Response(null, { status: 302, headers: { location: 'https://10.0.0.1/admin' } }),
		'https://a.example/loop': () => new Response(null, { status: 302, headers: { location: 'https://a.example/loop' } })
	};
	const outbound = createOutbound({ dispatcherFor: () => ({}), fetchImpl: async (url) => answers[url]() });
	const rec = { networkMode: 'hybrid', network: 'mainnet' };
	const { json, url } = await outbound.getJson('https://a.example/start', { rec });
	assert.deepEqual(json, { ok: 1 });
	assert.equal(url.host, 'b.example');
	await assert.rejects(outbound.getJson('https://a.example/down', { rec }), (e) => e.code === 'INSECURE_REDIRECT');
	await assert.rejects(outbound.getJson('https://a.example/inside', { rec }), (e) => e.code === 'PRIVATE_URL');
	await assert.rejects(outbound.getJson('https://a.example/loop', { rec }), (e) => e.code === 'TOO_MANY_REDIRECTS');
});

test('getJson refuses an oversized body, non-JSON, and a bare HTTP error, but passes an LNURL error through', async () => {
	const answers = {
		'https://x.example/big': () => jsonResponse(JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES) })),
		'https://x.example/html': () => new Response('<html></html>', { status: 200 }),
		'https://x.example/500': () => new Response('oops', { status: 500 }),
		'https://x.example/lnerr': () => jsonResponse({ status: 'ERROR', reason: 'nope' }, { status: 400 })
	};
	const outbound = createOutbound({ dispatcherFor: () => ({}), fetchImpl: async (url) => answers[url]() });
	const rec = { networkMode: 'hybrid', network: 'mainnet' };
	await assert.rejects(outbound.getJson('https://x.example/big', { rec }), (e) => e.code === 'RESPONSE_TOO_LARGE');
	await assert.rejects(outbound.getJson('https://x.example/html', { rec }), (e) => e.code === 'SERVICE_BAD_ANSWER');
	await assert.rejects(outbound.getJson('https://x.example/500', { rec }), (e) => /HTTP 500/.test(e.message));
	const { json } = await outbound.getJson('https://x.example/lnerr', { rec });
	assert.deepEqual(json, { status: 'ERROR', reason: 'nope' });
});

test('getJson turns a transport failure into a plain reason naming the host', async () => {
	const outbound = createOutbound({
		torProxy: 'tor:9050',
		dispatcherFor: () => ({}),
		fetchImpl: async () => {
			throw new TypeError('fetch failed');
		}
	});
	await assert.rejects(
		outbound.getJson('https://x.example/', { rec: { networkMode: 'tor', network: 'mainnet' } }),
		(e) => e.code === 'SERVICE_UNREACHABLE' && /x\.example over Tor/.test(e.message)
	);
});

/**
 * A SOCKS5 server just big enough for one CONNECT with no authentication,
 * as Tor's SocksPort answers it. It records where each request asked to go
 * and pipes the bytes there.
 */
function fakeSocks() {
	const net = require('net');
	const targets = [];
	const server = net.createServer((client) => {
		client.once('data', (greeting) => {
			if (greeting[0] !== 5) return client.destroy();
			client.write(Buffer.from([5, 0]));
			client.once('data', (req) => {
				// VER CMD RSV ATYP ...
				let host;
				let at;
				if (req[3] === 1) {
					host = Array.from(req.subarray(4, 8)).join('.');
					at = 8;
				} else if (req[3] === 3) {
					const len = req[4];
					host = req.subarray(5, 5 + len).toString('utf8');
					at = 5 + len;
				} else return client.destroy();
				const port = req.readUInt16BE(at);
				targets.push(`${host}:${port}`);
				const upstream = net.connect(port, host === 'localhost' ? '127.0.0.1' : host, () => {
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

test('a Tor wallet goes out through the SOCKS proxy, and a Clearnet wallet does not', async () => {
	const http = require('http');
	const service = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ tag: 'payRequest', via: req.headers.host }));
	});
	await new Promise((r) => service.listen(0, '127.0.0.1', r));
	const servicePort = service.address().port;
	const socks = await fakeSocks();
	const outbound = createOutbound({ torProxy: `127.0.0.1:${socks.port}` });
	try {
		const url = `http://localhost:${servicePort}/lnurlp/alice`;
		const viaTor = await outbound.getJson(url, { rec: { network: 'regtest', networkMode: 'tor' } });
		assert.equal(viaTor.json.tag, 'payRequest');
		assert.deepEqual(socks.targets, [`localhost:${servicePort}`], 'the name went to the proxy unresolved, as Tor needs it');

		const direct = await outbound.getJson(url, { rec: { network: 'regtest', networkMode: 'clearnet' } });
		assert.equal(direct.json.tag, 'payRequest');
		assert.equal(socks.targets.length, 1, 'the Clearnet request did not touch the proxy');
	} finally {
		service.close();
		socks.server.close();
	}
});

test('a Tor wallet whose proxy is down fails rather than going direct', async () => {
	const http = require('http');
	let reached = 0;
	const service = http.createServer((req, res) => {
		reached += 1;
		res.end('{}');
	});
	await new Promise((r) => service.listen(0, '127.0.0.1', r));
	// A port nothing listens on: bind one, note it, close it.
	const net = require('net');
	const dead = await new Promise((resolve) => {
		const s = net.createServer().listen(0, '127.0.0.1', () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
	const outbound = createOutbound({ torProxy: `127.0.0.1:${dead}` });
	try {
		await assert.rejects(
			outbound.getJson(`http://localhost:${service.address().port}/x`, { rec: { network: 'regtest', networkMode: 'tor' } }),
			(e) => e.code === 'SERVICE_UNREACHABLE' && /over Tor/.test(e.message) && e.upstream === true
		);
		assert.equal(reached, 0, 'the service was never reached around the proxy');
	} finally {
		service.close();
	}
});
