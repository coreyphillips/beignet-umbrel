'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const porch = require('./porch');
const { payloadFiles } = require('./backup');

const ON = { available: true, torAvailable: true };

test('relay URLs are held to the engine rules and reduced to their origin', () => {
	assert.equal(porch.parseRelayUrl(' wss://Relay.Example.com/ ').url, 'wss://relay.example.com');
	assert.equal(porch.parseRelayUrl('wss://relay.example.com:443').url, 'wss://relay.example.com');
	assert.equal(porch.parseRelayUrl('ws://10.0.0.5:2114').url, 'ws://10.0.0.5:2114');
	for (const bad of ['https://relay.example.com', 'wss://relay.example.com/v1/p/abc', 'wss://u:p@relay.example.com', 'wss://a.com,wss://b.com', 'relay.example.com', 'wss://relay.example.com:0', '']) {
		assert.throws(() => porch.parseRelayUrl(bad), { statusCode: 400 }, bad);
	}
});

test('each relay keeps its own token: kept when left out, replaced, or removed', () => {
	const first = porch.normalizePorch(
		{ enabled: true, relays: [{ url: 'wss://a.example', token: ' secret-a\n' }, { url: 'wss://b.example', token: 'secret-b' }] },
		ON
	);
	assert.deepEqual(first.porch, { enabled: true, relays: ['wss://a.example', 'wss://b.example'] });
	assert.deepEqual(first.tokens, { 'wss://a.example': ' secret-a\n', 'wss://b.example': 'secret-b' });

	const kept = porch.normalizePorch({ enabled: true, relays: [{ url: 'wss://a.example' }, { url: 'wss://b.example' }] }, {
		...ON,
		existing: first.porch,
		existingTokens: first.tokens
	});
	assert.deepEqual(kept.tokens, first.tokens);

	const changed = porch.normalizePorch(
		{ relays: [{ url: 'wss://a.example', token: 'new-a' }, { url: 'wss://b.example', token: null }] },
		{ ...ON, existing: first.porch, existingTokens: first.tokens }
	);
	assert.deepEqual(changed.tokens, { 'wss://a.example': 'new-a' });

	// A save about something else carries the relays and tokens through.
	const untouched = porch.normalizePorch({ via: 'direct' }, { ...ON, existing: first.porch, existingTokens: first.tokens });
	assert.deepEqual(untouched.tokens, first.tokens);
	assert.equal(untouched.porch.via, 'direct');
});

test('settings the engine would refuse are refused before anything is written', () => {
	assert.throws(() => porch.normalizePorch({ enabled: true, relays: [] }, ON), { code: 'BAD_PORCH' });
	assert.throws(() => porch.normalizePorch({ enabled: true, relays: ['wss://a.example', 'wss://A.example:443'] }, ON), /twice/);
	assert.throws(() => porch.normalizePorch({ enabled: true, relays: ['wss://a.example'] }, { available: false }), { code: 'PORCH_UNSUPPORTED' });
	assert.throws(() => porch.normalizePorch({ enabled: true, via: 'tor', relays: ['ws://192.168.1.4:2114'] }, ON), /private address/);
	assert.throws(() => porch.normalizePorch({ enabled: true, via: 'tor', relays: ['wss://a.example'] }, { available: true }), /Tor is not available/);
	assert.throws(() => porch.normalizePorch({ enabled: true, via: 'direct', relays: ['ws://abc.onion'] }, ON), /onion/);
	assert.throws(() => porch.normalizePorch({ enabled: true, via: 'direct', relays: ['wss://a.example'] }, { ...ON, porchProxy: '127.0.0.1:1080' }), /proxy/);
	assert.throws(() => porch.normalizePorch({ enabled: true, via: 'tor', relays: ['wss://a.example'] }, { ...ON, porchProxy: '127.0.0.1:1080' }), /proxy/);
	assert.throws(() => porch.normalizePorch({ enabled: true, relays: ['ws://192.168.1.4:2114'] }, { ...ON, porchProxy: '127.0.0.1:1080' }), /private address/);
	assert.throws(() => porch.normalizePorch({ enabled: true, relays: [{ url: 'wss://a.example', token: 'x'.repeat(257) }] }, ON), { code: 'BAD_PORCH_TOKEN' });
	assert.throws(() => porch.normalizePorch({ enabled: true, via: 'sideways', relays: ['wss://a.example'] }, ON), { code: 'BAD_PORCH' });
});

test('turning Porch off is never refused, and on-chain only turns it off', () => {
	const off = porch.normalizePorch({ enabled: false, via: 'tor', relays: ['ws://192.168.1.4:2114'] }, { available: false });
	assert.equal(off.porch.enabled, false);
	const parked = porch.normalizePorch(undefined, {
		existing: { enabled: true, relays: ['wss://a.example'] },
		existingTokens: { 'wss://a.example': 't' },
		onchainOnly: true
	});
	assert.equal(parked.porch.enabled, false);
	assert.deepEqual(parked.tokens, { 'wss://a.example': 't' });
});

test('a hand-written config.json is read in the record shape, with its tokens', () => {
	assert.equal(porch.nativePorch({ porchRelays: [] }), null);
	assert.deepEqual(porch.nativePorch({ porchRelays: ['wss://a.example'], porchToken: 'solo', porchVia: 'tor' }), {
		porch: { enabled: true, relays: ['wss://a.example'], via: 'tor' },
		tokens: { 'wss://a.example': 'solo' }
	});
	assert.deepEqual(porch.nativePorch({ porchRelays: [{ url: 'wss://a.example', token: 'ta' }, 'wss://b.example', 'nonsense'] }).tokens, {
		'wss://a.example': 'ta'
	});
});

function tempHome(native) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'porch-'));
	if (native) {
		fs.mkdirSync(path.join(home, '.beignet'));
		fs.writeFileSync(path.join(home, '.beignet', 'config.json'), JSON.stringify(native));
	}
	return home;
}
const readNative = (home) => JSON.parse(fs.readFileSync(path.join(home, '.beignet', 'config.json'), 'utf8'));

test('the config file gets a token per relay entry and keeps every other key', () => {
	const home = tempHome({ network: 'mainnet', porchToken: 'old', porchRelays: ['wss://old.example'], porchStandbys: 3 });
	const rec = { porch: { enabled: true, relays: ['wss://a.example', 'wss://b.example'], via: 'tor' } };
	assert.equal(porch.syncNativeConfig(home, rec, { 'wss://a.example': 'ta' }, true), true);
	assert.deepEqual(readNative(home), {
		network: 'mainnet',
		porchStandbys: 3,
		porchRelays: [{ url: 'wss://a.example', token: 'ta' }, 'wss://b.example'],
		porchVia: 'tor'
	});
	assert.equal(fs.statSync(path.join(home, '.beignet', 'config.json')).mode & 0o777, 0o600);
	assert.equal(porch.syncNativeConfig(home, rec, { 'wss://a.example': 'ta' }, true), false, 'unchanged file is not rewritten');
});

test('turning Porch off removes hand-written relays, and on-chain only overrides the file', () => {
	const home = tempHome({ network: 'mainnet', porchRelays: [{ url: 'wss://a.example', token: 'ta' }], porchToken: 'x' });
	const rec = { porch: { enabled: false, relays: ['wss://a.example'] } };
	porch.syncNativeConfig(home, rec, {}, true);
	assert.deepEqual(readNative(home), { network: 'mainnet' });
	assert.deepEqual(porch.porchEnv(rec, true), { BEIGNET_PORCH_RELAYS: '' });

	// Never managed by the app: the file is left alone, except that an
	// on-chain only wallet gets Porch turned off over it.
	const manual = tempHome({ porchRelays: ['wss://a.example'] });
	assert.equal(porch.syncNativeConfig(manual, {}, {}, true), false);
	assert.deepEqual(porch.porchEnv({}, true), {});
	assert.deepEqual(porch.porchEnv({ onchainOnly: true }, true), { BEIGNET_PORCH_RELAYS: '' });
	const managedParked = { onchainOnly: true, porch: { enabled: true, relays: ['wss://a.example'] } };
	assert.deepEqual(porch.porchEnv(managedParked, true), { BEIGNET_PORCH_RELAYS: '' });
	porch.syncNativeConfig(manual, managedParked, {}, true);
	assert.deepEqual(readNative(manual), {});
	assert.deepEqual(porch.porchEnv({ porch: { enabled: true, relays: ['wss://a.example'] } }, true), {});
	assert.deepEqual(porch.porchEnv({ onchainOnly: true }, false), {}, 'an engine without Porch gets the env it always got');
});

test('an unreadable config file is never written over', () => {
	const home = tempHome();
	fs.mkdirSync(path.join(home, '.beignet'));
	fs.writeFileSync(path.join(home, '.beignet', 'config.json'), '{ not json');
	// Off needs nothing from the file: the env turns Porch off over it.
	assert.equal(porch.syncNativeConfig(home, { porch: { enabled: false, relays: [] } }, {}, true), false);
	assert.throws(() => porch.syncNativeConfig(home, { porch: { enabled: true, relays: ['wss://a.example'] } }, {}, true), /could not be read/);
	assert.equal(fs.readFileSync(path.join(home, '.beignet', 'config.json'), 'utf8'), '{ not json');
});

test('tokens stay out of what the dashboard reads and out of daemon errors', () => {
	const pub = porch.publicPorch({ enabled: true, relays: ['wss://a.example', 'wss://b.example'] }, { 'wss://a.example': 'sekrit' }, false, 'app');
	assert.deepEqual(pub, {
		enabled: true,
		relays: [{ url: 'wss://a.example', hasToken: true }, { url: 'wss://b.example', hasToken: false }],
		via: 'default',
		source: 'app'
	});
	assert.ok(!JSON.stringify(pub).includes('sekrit'));
	const status = porch.redact({ relays: [{ relay: 'wss://a.example', lastError: 'refused token sekrit' }] }, { 'wss://a.example': 'sekrit' });
	assert.equal(status.relays[0].lastError, 'refused token [redacted]');
});

test('a short token is taken out of relay errors and nowhere else', async () => {
	const { WalletManager } = require('./wallet-manager');
	const tokenFile = path.join(tempHome(), 'porch_tokens');
	porch.writeTokens(tokenFile, { 'wss://a.example': 'e' });
	const uri = '02' + 'ab'.repeat(32) + '@wss://a.example/v1/p/route';
	const m = Object.assign(Object.create(WalletManager.prototype), {
		porchSupported: true,
		registry: { get: () => ({ id: 'w1', porch: { enabled: true, relays: ['wss://a.example'] } }) },
		paths: () => ({ home: tempHome(), porchTokensFile: tokenFile }),
		runtimeState: () => ({ proc: {}, healthy: true }),
		_daemonCall: async () => ({
			enabled: true,
			listening: true,
			links: [{ default: true, uris: [uri] }],
			relays: [{ relay: 'wss://a.example', state: 'refused', lastError: 'token e refused' }]
		})
	});
	const status = await m.porchStatus('w1');
	assert.equal(status.relays[0].state, 'refused');
	assert.equal(status.relays[0].relay, 'wss://a.example');
	assert.equal(status.links[0].uris[0], uri);
	assert.equal(status.relays[0].lastError, 'tok[redacted]n [redacted] r[redacted]fus[redacted]d');
});

test('the token file is written readable by the owner only, and removed when empty', () => {
	const file = path.join(tempHome(), 'secrets', 'porch_tokens');
	porch.writeTokens(file, { 'wss://a.example': 't' });
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(porch.readTokens(file), { 'wss://a.example': 't' });
	porch.writeTokens(file, {});
	assert.equal(fs.existsSync(file), false);
});

test('a backup archive may carry a wallet\'s Porch tokens', () => {
	const files = payloadFiles({ files: [{ path: 'wallets/abc-1/secrets/porch_tokens', mode: 0o600, data: Buffer.from('{}').toString('base64') }] });
	assert.ok(files.has('wallets/abc-1/secrets/porch_tokens'));
});

function editableWallet(rec, native) {
	const { WalletManager } = require('./wallet-manager');
	const home = tempHome(native);
	const secrets = path.join(home, 'secrets');
	const records = { w1: { id: 'w1', name: 'w', network: 'regtest', electrum: {}, port: 3001, recovery: { mode: 'off', guardians: [] }, ...rec } };
	const m = Object.assign(Object.create(WalletManager.prototype), {
		porchSupported: true,
		guardianHostingSupported: true,
		settings: { get: () => ({ defaultNetwork: 'regtest', recoveryGuardians: [] }) },
		registry: { get: (id) => records[id], list: () => Object.values(records), upsert: (r) => (records[r.id] = r) },
		runtime: new Map(),
		paths: () => ({ home, secrets, porchTokensFile: path.join(secrets, 'porch_tokens') }),
		publicRecord: (id) => records[id],
		_log: () => {}
	});
	return { m, records, home, tokensFile: path.join(secrets, 'porch_tokens'), config: () => porch.readNativeConfig(home) };
}

test('a refused edit leaves Porch on disk as it was', async () => {
	const native = { porchRelays: [{ url: 'wss://a.example', token: 't' }] };
	const w = editableWallet({}, native);
	await assert.rejects(w.m.updateWallet('w1', { onchainOnly: true, guardianServe: true, porch: { enabled: false } }), { code: 'GUARDIAN_SERVE_NEEDS_LIGHTNING' });
	assert.deepEqual(w.config(), native);
	assert.equal(w.records.w1.porch, undefined);

	// The token file cannot be written: config.json is not touched.
	const locked = editableWallet({});
	fs.mkdirSync(path.dirname(locked.tokensFile), { mode: 0o500 });
	await assert.rejects(locked.m.updateWallet('w1', { porch: { enabled: true, relays: [{ url: 'wss://a.example', token: 't' }] } }), { code: 'PORCH_CONFIG_UNWRITABLE' });
	assert.deepEqual(locked.config(), {});

	// config.json cannot be read: the token file written first is taken back.
	const broken = editableWallet({}, {});
	fs.writeFileSync(porch.nativeConfigPath(broken.home), '{');
	await assert.rejects(broken.m.updateWallet('w1', { porch: { enabled: true, relays: [{ url: 'wss://a.example', token: 't' }] } }), { code: 'PORCH_CONFIG_UNWRITABLE' });
	assert.equal(fs.existsSync(broken.tokensFile), false);
	assert.equal(broken.records.w1.porch, undefined);
});

test('Lightning coming back leaves Porch off unless the save turns it on', async () => {
	const w = editableWallet({ onchainOnly: true }, { porchRelays: [{ url: 'wss://a.example', token: 't' }], keep: 1 });
	await w.m.updateWallet('w1', { onchainOnly: false });
	assert.deepEqual(w.records.w1.porch, { enabled: false, relays: ['wss://a.example'] });
	assert.deepEqual(porch.readTokens(w.tokensFile), { 'wss://a.example': 't' });
	assert.deepEqual(w.config(), { keep: 1 });
	assert.deepEqual(porch.porchEnv(w.records.w1, true), { BEIGNET_PORCH_RELAYS: '' });

	await w.m.updateWallet('w1', { porch: { enabled: true } });
	assert.deepEqual(w.config().porchRelays, [{ url: 'wss://a.example', token: 't' }]);
});

test('an edit that waited on its Electrum check does not undo Porch saved meanwhile', async () => {
	const w = editableWallet({ onchainOnly: true });
	w.m._normalizeElectrum = (e) => e;
	w.m._electrumChanged = () => true;
	w.m._refuseWrongChain = async () => {
		Object.assign(w.records.w1, { onchainOnly: false, porch: { enabled: true, relays: ['wss://a.example'] } });
	};
	await w.m.updateWallet('w1', { electrum: { host: 'e.example', port: 50001 } });
	assert.equal(w.records.w1.porch.enabled, true);
	assert.equal(w.records.w1.onchainOnly, false);
});
