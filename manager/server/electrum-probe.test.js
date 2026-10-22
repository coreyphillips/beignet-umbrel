'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * The conversation the dashboard has with an Electrum server before anyone
 * trusts it with a wallet: what a reachable server reports, how a slow, silent
 * or absent one is described, how a certificate the wallet would refuse is
 * reported, and the short cache the three callers share.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const { WalletManager } = require('./wallet-manager');
const { KEY, CERT, PIN } = require('./fixtures/electrum-test-cert');
const {
	chainOfGenesis,
	probeElectrum,
	cachedProbe,
	clearProbeCache,
	discoverServers
} = require('./electrum-probe');

const MAINNET = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const TESTNET = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943';
const TESTNET4 = '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043';
const SIGNET = '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6';
const REGTEST = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const OTHER = 'ff'.repeat(32);

/**
 * A fake Electrum server on loopback. `mode` shapes how it answers:
 * normal (one reply per request, in order), batched (every reply in one
 * write, out of order), split (a reply cut across two writes), silent
 * (connects, never answers), no-features (server.features is an error).
 */
async function fakeElectrum(t, { tls: useTls = false, genesis = MAINNET, software = 'electrs/0.10.9', height = 840000, mode = 'normal' } = {}) {
	const state = { connections: 0, lines: [] };
	const answer = (msg) => {
		if (msg.method === 'server.version') return { id: msg.id, result: [software, '1.4'] };
		if (msg.method === 'server.features') {
			if (mode === 'no-features') return { id: msg.id, error: { code: -32601, message: 'unknown method' } };
			return { id: msg.id, result: { genesis_hash: genesis, protocol_min: '1.4', protocol_max: '1.4.2', server_version: software } };
		}
		if (msg.method === 'blockchain.headers.subscribe') return { id: msg.id, result: { height, hex: '' } };
		return { id: msg.id, error: { code: -32601, message: 'unknown method' } };
	};
	const onConnection = (socket) => {
		state.connections += 1;
		socket.on('error', () => {});
		let buf = '';
		socket.on('data', (chunk) => {
			buf += chunk.toString('utf8');
			let nl;
			const replies = [];
			while ((nl = buf.indexOf('\n')) !== -1) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				state.lines.push(line);
				replies.push(answer(JSON.parse(line)));
			}
			if (mode === 'silent') return;
			if (!replies.length) return;
			const text = replies.map((r) => `${JSON.stringify(r)}\n`);
			if (mode === 'batched') {
				socket.write(text.reverse().join(''));
				return;
			}
			if (mode === 'split') {
				// Everything owed so far, cut in the middle of a reply and sent
				// in two writes a moment apart.
				const whole = text.join('');
				const cut = Math.floor(whole.length / 2);
				socket.write(whole.slice(0, cut));
				setTimeout(() => socket.write(whole.slice(cut)), 5);
				return;
			}
			for (const line of text) socket.write(line);
		});
	};
	const server = useTls ? tls.createServer({ key: KEY, cert: CERT }, onConnection) : net.createServer(onConnection);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => server.close());
	return { ...state, state, port: server.address().port, host: '127.0.0.1' };
}

test.beforeEach(() => clearProbeCache());

test('a genesis hash names its chain, and anything else is unknown', () => {
	assert.equal(chainOfGenesis(MAINNET), 'mainnet');
	assert.equal(chainOfGenesis(TESTNET), 'testnet');
	assert.equal(chainOfGenesis(TESTNET4), 'testnet4', 'testnet4 is not what beignet calls testnet');
	assert.equal(chainOfGenesis(SIGNET), 'signet');
	assert.equal(chainOfGenesis(REGTEST), 'regtest');
	assert.equal(chainOfGenesis(MAINNET.toUpperCase()), 'mainnet');
	assert.equal(chainOfGenesis(OTHER), 'unknown');
	assert.equal(chainOfGenesis(null), 'unknown');
	assert.equal(chainOfGenesis(undefined), 'unknown');
});

test('a plain TCP server reports its software, chain and tip', async (t) => {
	const s = await fakeElectrum(t);
	const r = await probeElectrum({ host: s.host, port: s.port, tls: false });
	assert.equal(r.reachable, true);
	assert.equal(r.software, 'electrs/0.10.9');
	assert.equal(r.protocol, '1.4');
	assert.equal(r.chain, 'mainnet');
	assert.equal(r.genesisHash, MAINNET);
	assert.equal(r.height, 840000);
	assert.equal(r.certificate, null);
	assert.equal(r.error, null);
	assert.ok(typeof r.probedAt === 'number');
	assert.match(s.state.lines[0], /server\.version/, 'the client introduces itself before asking anything else');
});

test('replies are matched by id, however the server frames them', async (t) => {
	const batched = await fakeElectrum(t, { mode: 'batched', genesis: TESTNET, height: 2500000 });
	const split = await fakeElectrum(t, { mode: 'split', genesis: TESTNET, height: 2500000 });
	for (const s of [batched, split]) {
		const r = await probeElectrum({ host: s.host, port: s.port, tls: false });
		assert.equal(r.chain, 'testnet');
		assert.equal(r.height, 2500000);
		assert.equal(r.software, 'electrs/0.10.9');
		assert.equal(r.error, null);
	}
});

test('a server without server.features is reachable with an unknown chain', async (t) => {
	const s = await fakeElectrum(t, { mode: 'no-features' });
	const r = await probeElectrum({ host: s.host, port: s.port, tls: false });
	assert.equal(r.reachable, true);
	assert.equal(r.chain, 'unknown');
	assert.equal(r.genesisHash, null);
	assert.equal(r.height, 840000);
	assert.equal(r.error, null);
});

test('a closed port is unreachable, quickly', async () => {
	const srv = net.createServer();
	await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
	const { port } = srv.address();
	await new Promise((resolve) => srv.close(resolve));
	const started = Date.now();
	const r = await probeElectrum({ host: '127.0.0.1', port, tls: false });
	assert.equal(r.reachable, false);
	assert.equal(r.error, 'unreachable');
	assert.equal(r.chain, 'unknown');
	assert.ok(Date.now() - started < 1000);
});

test('a server that connects but never answers times out within the bound', async (t) => {
	const s = await fakeElectrum(t, { mode: 'silent' });
	const started = Date.now();
	const r = await probeElectrum({ host: s.host, port: s.port, tls: false }, { timeoutMs: 200 });
	assert.equal(r.reachable, true);
	assert.equal(r.error, 'timeout');
	assert.equal(r.chain, 'unknown');
	assert.ok(Date.now() - started < 1000);
});

test('a TLS server is described with its certificate, by the wallet rule', async (t) => {
	const s = await fakeElectrum(t, { tls: true });
	const base = { host: s.host, port: s.port, tls: true };
	const loose = await probeElectrum(base);
	assert.equal(loose.reachable, true);
	assert.equal(loose.chain, 'mainnet');
	assert.deepEqual(loose.certificate, { accepted: true, authorized: false, fingerprint: PIN });
	const linesBefore = s.state.lines.length;
	const refused = await probeElectrum({ ...base, tlsVerify: true });
	assert.equal(refused.reachable, true);
	assert.equal(refused.error, 'tls-rejected');
	assert.equal(refused.chain, 'unknown');
	assert.deepEqual(refused.certificate, { accepted: false, authorized: false, fingerprint: PIN }, 'the fingerprint is reported so it can be pinned');
	assert.equal(s.state.lines.length, linesBefore, 'nothing was asked of a server the wallet would refuse');
	const pinned = await probeElectrum({ ...base, tlsVerify: true, tlsFingerprints: [PIN] });
	assert.equal(pinned.error, null);
	assert.equal(pinned.chain, 'mainnet');
	assert.equal(pinned.certificate.accepted, true);
	const wrongPin = await probeElectrum({ ...base, tlsVerify: true, tlsFingerprints: [OTHER] });
	assert.equal(wrongPin.error, 'tls-rejected');
});

test('discovery probes every preset at once and keeps their order and fields', async (t) => {
	const up = await fakeElectrum(t);
	const quiet = await fakeElectrum(t, { mode: 'silent' });
	const presets = [
		{ id: 'quiet', label: 'Quiet', host: quiet.host, port: quiet.port, tls: false, note: 'n' },
		{ id: 'up', label: 'Up', host: up.host, port: up.port, tls: false, note: 'n' }
	];
	const started = Date.now();
	const { at, servers } = await discoverServers(presets, { timeoutMs: 300 });
	assert.ok(Date.now() - started < 600, 'one bound, not one per preset');
	assert.ok(typeof at === 'number');
	assert.deepEqual(servers.map((s) => s.id), ['quiet', 'up']);
	assert.equal(servers[0].label, 'Quiet');
	assert.equal(servers[0].error, 'timeout');
	assert.equal(servers[1].chain, 'mainnet');
	assert.equal(servers[1].note, 'n');
});

test('a result stands for a few seconds, and refresh asks again', async (t) => {
	const s = await fakeElectrum(t);
	const electrum = { host: s.host, port: s.port, tls: false };
	const a = await cachedProbe(electrum);
	const b = await cachedProbe(electrum);
	assert.equal(s.state.connections, 1, 'one conversation answers both');
	assert.equal(a, b);
	await cachedProbe(electrum, { refresh: true });
	assert.equal(s.state.connections, 2);
	await cachedProbe({ ...electrum, tls: false, tlsVerify: true });
	assert.equal(s.state.connections, 3, 'a different record is a different question');
	clearProbeCache();
	await cachedProbe(electrum);
	assert.equal(s.state.connections, 4);
});

test("the manager's tip probe still reads a height through the shared socket code", async (t) => {
	const s = await fakeElectrum(t, { height: 912345 });
	const m = Object.create(WalletManager.prototype);
	assert.equal(await m._electrumTip({ host: s.host, port: s.port, tls: false }), 912345);
	const silent = await fakeElectrum(t, { mode: 'silent' });
	const started = Date.now();
	assert.equal(await m._electrumTip({ host: silent.host, port: silent.port, tls: false }), null);
	assert.ok(Date.now() - started < 4000);
});
