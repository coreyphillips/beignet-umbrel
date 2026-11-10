'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * Keys derived from a wallet's seed: the LNURL-auth linking key (LUD-05) and
 * the BOLT11 tags an LNURL invoice is checked against.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { lnurlLinkingKey, masterKey } = require('./derive');
const { bech32 } = require('bech32');
const { decodeBolt11 } = require('./bolt11-tags');

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test("LUD-05's own vector: the path suffix from the hashing key and site.com", () => {
	const hashingKey = Buffer.from('7d417a6a5e9a6a4a879aeaba11a11838764c8fa2b959c242d43dea682b3e409b', 'hex');
	const material = crypto.createHmac('sha256', hashingKey).update('site.com').digest();
	assert.deepEqual(
		[0, 1, 2, 3].map((i) => material.readUInt32BE(i * 4)),
		[1588488367, 2659270754, 38110259, 4136336762]
	);
});

test('the linking key is stable per domain and differs between domains', () => {
	const hex = (k) => Buffer.from(k.publicKey).toString('hex');
	const a = lnurlLinkingKey(SEED, 'site.com');
	assert.equal(hex(a), hex(lnurlLinkingKey(SEED, 'site.com')));
	assert.notEqual(hex(a), hex(lnurlLinkingKey(SEED, 'other.com')));
	// Cross-checked once against bitcoinjs bip32 with the same seed and
	// domain; pinned so a library change cannot move every login silently.
	assert.equal(hex(a), '027da5d64331f61260eb8e2b356403446555f525bc7dc35b991ec1447e4f58991f');
});

test('an index of 2^31 and above derives as a hardened child, as wallets do', () => {
	const root = masterKey(SEED);
	const viaIndex = root.derive("m/138'").deriveChild(2659270754);
	const viaPath = root.derive(`m/138'/${2659270754 - 0x80000000}'`);
	assert.equal(Buffer.from(viaIndex.publicKey).toString('hex'), Buffer.from(viaPath.publicKey).toString('hex'));
});

test('decodeBolt11 reads the BOLT11 spec vector with a description hash', () => {
	const d = decodeBolt11(
		'lnbc20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqs9qrsgq7ea976txfraylvgzuxs8kgcw23ezlrszfnh8r6qtfpr6cxga50aj6txm9rxrydzd06dfeawfk6swupvz4erwnyutnjq7x39ymw6j38gp7ynn44'
	);
	assert.equal(d.network, 'mainnet');
	assert.equal(d.amountMsat, 2_000_000_000n);
	assert.equal(d.paymentHash, '0001020304050607080900010203040506070809000102030405060708090102');
	assert.equal(d.descriptionHash, '3925b6f67e2c340036ed12093dd44e0368df1b6ea26c53dbe4811f58fd5db8c1');
});

test('decodeBolt11 reads a plain description and refuses what is not an invoice', () => {
	// Built here rather than copied: a timestamp, a d field and a zero
	// signature, which this reader never checks (the daemon does).
	const toWords = (n, count) => Array.from({ length: count }, (_, i) => Math.floor(n / 32 ** (count - 1 - i)) % 32);
	const text = bech32.toWords(Buffer.from('Please consider supporting this project', 'utf8'));
	const words = [...toWords(1496314658, 7), 13, ...toWords(text.length, 2), ...text, ...new Array(104).fill(0)];
	const d = decodeBolt11(bech32.encode('lnbcrt', words, 2000));
	assert.equal(d.network, 'regtest');
	assert.equal(d.amountMsat, null);
	assert.equal(d.timestamp, 1496314658);
	assert.equal(d.description, 'Please consider supporting this project');
	assert.equal(d.descriptionHash, null);
	assert.equal(decodeBolt11(bech32.encode('lntb2500u', words, 2000)).amountMsat, 250_000_000n);
	for (const bad of ['', 'hello', 'lnurl1dp68gurn8ghj7', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4']) {
		assert.throws(() => decodeBolt11(bad), (e) => e.code === 'BOLT11_INVALID', bad);
	}
});
