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
import { ChainMismatchNote, colonFingerprint, describeProbe, describeTest } from './ElectrumStatus.jsx';

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
	const self = describeTest({ electrum: e, ...up({ certificate: { accepted: true, authorized: false, fingerprint: fp } }) });
	assert.match(self.text, /self-signed \(AC:46/);
	const ca = describeTest({ electrum: e, ...up({ certificate: { accepted: true, authorized: true, fingerprint: fp } }) });
	assert.match(ca.text, /signed by a public authority/);
	assert.equal(describeTest({ electrum: e, ...up({ software: null, chain: 'unknown', height: null }) }).text, 'An Electrum server answered.');
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
