/**
 * Run with: npm test (from manager/ui).
 *
 * The light decoder reads the frozen head of a v3 envelope at fixed offsets.
 * It fails closed: anything it cannot read is null, never a guess, because a
 * wrong node id or amount on screen is worse than no reading at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	base64urlDecode,
	base64urlEncode,
	chainHashFor,
	decodeFundingEnvelope,
	encodeFundingEnvelope
} from './funding-envelope.js';

const NODE = '02' + 'ab'.repeat(32);
const EXPIRES = 1_800_000_000_000;

test('base64url round-trips and refuses padding, non-canonical tails and foreign characters', () => {
	const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
	const text = base64urlEncode(bytes);
	assert.match(text, /^[A-Za-z0-9_-]+$/);
	assert.deepEqual([...base64urlDecode(text)], [...bytes]);
	assert.equal(base64urlDecode(text + '='), null, 'padding');
	assert.equal(base64urlDecode('abc+'), null, 'plain base64 alphabet');
	assert.equal(base64urlDecode('a'), null, 'impossible length');
	assert.equal(base64urlDecode(''), null);
	// A non-canonical last character carries bits the signer never signed.
	assert.equal(base64urlDecode('AB'), null);
});

test('decodes the node id, expiry, amount and chain at the frozen offsets', () => {
	const text = encodeFundingEnvelope({ nodeId: NODE, expiresAt: EXPIRES, amountSats: 250_000, network: 'regtest' });
	const env = decodeFundingEnvelope(text);
	assert.equal(env.version, 3);
	assert.equal(env.nodeId, NODE);
	assert.equal(env.expiresAt, EXPIRES);
	assert.equal(env.amountSats, 250_000);
	assert.equal(env.network, 'regtest');
	assert.equal(env.chainHash, chainHashFor('regtest'));
	assert.equal(env.requestId.length, 32);
});

test('an amountless request leaves the amount to the payer', () => {
	const env = decodeFundingEnvelope(encodeFundingEnvelope({ nodeId: NODE, expiresAt: EXPIRES }));
	assert.equal(env.amountSats, null);
	assert.equal(env.network, 'mainnet');
});

test('the fixed offsets hold against the raw bytes, whatever the transport list is', () => {
	const text = encodeFundingEnvelope({
		nodeId: NODE,
		expiresAt: EXPIRES,
		amountSats: 21,
		transports: [{ host: 'abcd.onion', port: 9735 }]
	});
	const bytes = base64urlDecode(text);
	assert.equal(bytes[0], 3);
	assert.equal(Buffer.from(bytes.subarray(49, 82)).toString('hex'), NODE);
	assert.equal(Buffer.from(bytes).readUIntBE(82, 6), EXPIRES);
	assert.equal(bytes[88] & 1, 1);
	assert.equal(Buffer.from(bytes).readBigUInt64BE(89), 21n);
});

test('anything it cannot read is null, never a partial reading', () => {
	assert.equal(decodeFundingEnvelope(''), null);
	assert.equal(decodeFundingEnvelope('not base64url!'), null);
	assert.equal(decodeFundingEnvelope(base64urlEncode(new Uint8Array(40))), null, 'too short');
	const wrongVersion = base64urlDecode(encodeFundingEnvelope({ nodeId: NODE, expiresAt: EXPIRES }));
	wrongVersion[0] = 2;
	assert.equal(decodeFundingEnvelope(base64urlEncode(wrongVersion)), null);
	// Amount flag set on a buffer too short to hold the amount.
	const truncated = base64urlDecode(encodeFundingEnvelope({ nodeId: NODE, expiresAt: EXPIRES })).slice(0, 89);
	truncated[88] = 1;
	assert.equal(decodeFundingEnvelope(base64urlEncode(truncated)), null);
});

test('a chain the table has no name for reads as unknown rather than as any network', () => {
	const bytes = base64urlDecode(encodeFundingEnvelope({ nodeId: NODE, expiresAt: EXPIRES }));
	bytes[17] ^= 0xff;
	const env = decodeFundingEnvelope(base64urlEncode(bytes));
	assert.equal(env.network, null);
	assert.equal(env.nodeId, NODE);
});
