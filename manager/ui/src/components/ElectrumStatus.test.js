/**
 * Run with: npm test (from manager/ui).
 *
 * What the dashboard says about a probed Electrum server: the one-line badge
 * under a preset, the Test button's sentences, and the refusal of a server on
 * another chain with its way through.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { click, render } from '../../test/render.mjs';
import { ChainMismatchNote, chainKey, colonFingerprint, describeProbe, describeTest } from './ElectrumStatus.jsx';

const up = (extra = {}) => ({
	reachable: true,
	software: 'electrs/0.10.9',
	protocol: '1.4',
	chain: 'mainnet',
	genesisHash: null,
	height: 908214,
	certificate: null,
	error: null,
	...extra
});

test('a preset badge reads the probe in a few words', () => {
	assert.deepEqual(describeProbe(null, null, { loading: true }), { state: 'checking', tone: 'muted', text: 'checking' });
	assert.equal(describeProbe(null).text, '', 'nothing known, nothing said');
	assert.deepEqual(describeProbe(up()), { state: 'reachable', tone: 'green', text: 'mainnet · 908,214' });
	assert.deepEqual(describeProbe(up(), 'mainnet'), { state: 'reachable', tone: 'green', text: 'mainnet · 908,214' });
	assert.deepEqual(describeProbe(up(), 'testnet'), { state: 'wrong-chain', tone: 'yellow', text: 'mainnet, not testnet' });
	assert.deepEqual(describeProbe(up({ chain: 'testnet4' }), 'testnet'), { state: 'wrong-chain', tone: 'yellow', text: 'testnet4, not testnet' });
	assert.deepEqual(describeProbe(up({ chain: 'unknown', height: null }), 'mainnet'), { state: 'reachable', tone: 'green', text: 'chain unknown' }, 'an unknown chain is not a mismatch');
	assert.deepEqual(describeProbe(up({ reachable: false, error: 'unreachable', software: null, chain: 'unknown', height: null })), { state: 'unreachable', tone: 'muted', text: 'not found' });
	assert.deepEqual(describeProbe(up({ error: 'tls-rejected', software: null, chain: 'unknown', height: null, certificate: { accepted: false, authorized: false, fingerprint: 'ab' } })), { state: 'tls-rejected', tone: 'red', text: 'certificate refused' });
	assert.deepEqual(describeProbe(up({ error: 'timeout', software: null, chain: 'unknown', height: null })), { state: 'unreachable', tone: 'muted', text: 'no answer' });
	assert.equal(describeProbe(up({ error: 'timeout', height: null })).text, 'mainnet', 'a slow server that said enough is reported on what it said');
	assert.deepEqual(describeProbe(up({ error: 'bad-reply', software: null, chain: 'unknown', height: null })), { state: 'unreachable', tone: 'muted', text: 'not an Electrum server' });
	const mismatch = { error: 'tls-mismatch', software: null, chain: 'unknown', height: null };
	assert.deepEqual(describeProbe(up({ ...mismatch, tls: true })), { state: 'tls-mismatch', tone: 'yellow', text: 'not a TLS server' }, 'a preset asked over TLS');
	assert.deepEqual(describeProbe(up({ ...mismatch, tls: false })), { state: 'tls-mismatch', tone: 'yellow', text: 'TLS only' }, 'a preset asked in plaintext');
});

test('the Test button speaks in sentences, with the certificate and the chain', () => {
	const e = { host: '192.168.1.20', port: 50001 };
	assert.deepEqual(describeTest({ electrum: e, ...up(), network: 'mainnet', chainMatches: true }), {
		state: 'reachable',
		text: 'electrs/0.10.9 answered on mainnet at height 908,214.'
	});
	assert.equal(describeTest({ electrum: e, ...up(), network: 'testnet', chainMatches: false }).state, 'wrong-chain');
	assert.match(describeTest({ electrum: e, ...up(), network: 'testnet', chainMatches: false }).text, /That is mainnet, not testnet\.$/);
	assert.deepEqual(describeTest({ electrum: e, ...up({ reachable: false, error: 'unreachable' }), chainMatches: null }), {
		state: 'unreachable',
		text: 'Nothing answered at 192.168.1.20:50001. Check the address and that the server is running.'
	});
	const fp = 'ac46dda716db709848ac80a84eba47a746736b4996d53d3bcff07c6e8d45c47f';
	assert.equal(colonFingerprint(fp), 'AC:46:DD:A7:16:DB:70:98:48:AC:80:A8:4E:BA:47:A7:46:73:6B:49:96:D5:3D:3B:CF:F0:7C:6E:8D:45:C4:7F');
	const refused = describeTest({ electrum: e, ...up({ error: 'tls-rejected', software: null, chain: 'unknown', height: null, certificate: { accepted: false, authorized: false, fingerprint: fp } }) });
	assert.equal(refused.state, 'tls-rejected');
	assert.match(refused.text, /AC:46:DD:A7/, 'the fingerprint is there to be pinned');
	const cert = { accepted: true, authorized: false, fingerprint: fp };
	const loose = describeTest({ electrum: { ...e, tls: true }, ...up({ certificate: cert }) });
	assert.match(loose.text, /No public authority signed the certificate for this host \(AC:46/, 'not called self-signed: it may be expired or for another name');
	assert.match(loose.text, /with verification on, pin it/);
	const pinned = describeTest({ electrum: { ...e, tls: true, tlsVerify: true, tlsFingerprints: [fp] }, ...up({ certificate: cert }) });
	assert.match(pinned.text, /matches a pinned fingerprint \(AC:46/, 'with verification on, an accepted unauthorized certificate is the pinned one');
	assert.doesNotMatch(pinned.text, /turn verification on|pin it/);
	const ca = describeTest({ electrum: { ...e, tls: true }, ...up({ certificate: { ...cert, authorized: true } }) });
	assert.match(ca.text, /signed by a public authority \(AC:46/, 'the fingerprint is shown either way');
	assert.equal(describeTest({ electrum: e, ...up({ software: null, chain: 'unknown', height: null }) }).text, 'An Electrum server answered.');
	// The TLS box the wrong way round, the likeliest mistake with these fields.
	const mismatch = up({ error: 'tls-mismatch', software: null, chain: 'unknown', height: null });
	const overTls = describeTest({ electrum: { ...e, tls: true }, ...mismatch });
	assert.equal(overTls.state, 'tls-mismatch');
	assert.match(overTls.text, /did not complete a TLS handshake.*untick TLS/);
	const inPlain = describeTest({ electrum: { ...e, tls: false }, ...mismatch });
	assert.match(inPlain.text, /did not answer plaintext.*Tick TLS/);
	const quiet = up({ error: 'timeout', software: null, chain: 'unknown', height: null });
	assert.match(describeTest({ electrum: { ...e, tls: true }, ...quiet }).text, /no Electrum answer in time\. If the server is plaintext, untick TLS/);
	assert.doesNotMatch(describeTest({ electrum: { ...e, tls: false }, ...quiet }).text, /untick TLS/);
});

test('a refusal is filed under the server and network it was for', () => {
	assert.equal(chainKey({ host: ' a.example ', port: '50001', tls: false }, 'mainnet'), chainKey({ host: 'a.example', port: 50001 }, 'mainnet'), 'as the manager would read it');
	assert.notEqual(chainKey({ host: 'a.example', port: 50001 }, 'mainnet'), chainKey({ host: 'b.example', port: 50001 }, 'mainnet'));
	assert.notEqual(chainKey({ host: 'a.example', port: 50001 }, 'mainnet'), chainKey({ host: 'a.example', port: 50001 }, 'testnet'));
	assert.notEqual(chainKey({ host: 'a.example', port: 50001, tls: true }), chainKey({ host: 'a.example', port: 50001 }));
	assert.equal(chainKey(null, 'mainnet'), chainKey(undefined, 'mainnet'), 'the app default, whatever it is');
});

test('the wrong-chain note shows the refusal and offers to save anyway', async () => {
	let proceeded = 0;
	const other = await render(ChainMismatchNote, { error: { code: 'BAD_ELECTRUM', message: 'nope' }, onProceed: () => proceeded++ });
	try {
		assert.equal(other.$('[data-testid="electrum-wrong-chain"]'), null, 'any other refusal is a toast, not this note');
	} finally {
		await other.unmount();
	}
	const error = { code: 'ELECTRUM_WRONG_CHAIN', message: 'The Electrum server at h:1 serves testnet, but this wallet is on mainnet.' };
	const r = await render(ChainMismatchNote, { error, onProceed: () => proceeded++ });
	try {
		assert.match(r.text(), /serves testnet, but this wallet is on mainnet/);
		await click(r.$('[data-testid="electrum-save-anyway"]'));
		assert.equal(proceeded, 1);
	} finally {
		await r.unmount();
	}
});
