/**
 * Run with: npm test (from manager/ui).
 *
 * What a pubky's published payment details become on the Send tab: one
 * request the existing parser reads, made only of what this wallet can
 * actually pay.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestFromEndpoints, shortPubky } from './paykit.js';
import { encodeFundingEnvelope } from './funding-envelope.js';
import { parsePayment } from './payment-uri.js';

const ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const TESTNET_ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const OFFER = `lno1${'qwerty0123456789'.repeat(6)}`;
const ENVELOPE = encodeFundingEnvelope({ nodeId: '02' + 'a'.repeat(64), expiresAt: Date.now() + 7 * 86400000 });

test('an offer, an address and a direct funding request become one unified request', () => {
	const r = requestFromEndpoints(
		[
			{ identifier: 'btc-bitcoin-bip21', value: `bitcoin:${ADDR}?bgnq=${ENVELOPE}` },
			{ identifier: 'btc-bitcoin-p2wpkh', value: ADDR },
			{ identifier: 'btc-lightning-bolt12', value: OFFER }
		],
		{ network: 'mainnet' }
	);
	assert.equal(r.text, `bitcoin:${ADDR}?lightning=${OFFER}&bgnq=${ENVELOPE}`);
	const read = parsePayment(r.text, { network: 'mainnet' });
	assert.equal(read.kind, 'onchain');
	assert.equal(read.funding.envelope, ENVELOPE, 'direct funding rides along');
	assert.equal(read.lightning.kind, 'bolt12', 'and so does the offer');
});

test('a plain address and an offer: no direct funding is made up', () => {
	const r = requestFromEndpoints(
		[
			{ identifier: 'btc-lightning-bolt12', value: OFFER },
			{ identifier: 'btc-bitcoin-p2wpkh', value: ADDR }
		],
		{ network: 'mainnet' }
	);
	assert.equal(r.text, `bitcoin:${ADDR}?lightning=${OFFER}`);
	assert.equal(r.funding, null);
});

test('Lightning alone comes back as the offer itself', () => {
	const r = requestFromEndpoints([{ identifier: 'btc-lightning-bolt12', value: OFFER }], { network: 'mainnet' });
	assert.deepEqual(r, { text: OFFER, address: null, lightning: OFFER, funding: null });
});

test('what is for another network, or does not parse, is skipped rather than paid', () => {
	const r = requestFromEndpoints(
		[
			{ identifier: 'btc-bitcoin-p2wpkh', value: TESTNET_ADDR },
			{ identifier: 'btc-bitcoin-p2wpkh', value: 'not an address' },
			{ identifier: 'btc-bitcoin-p2wpkh', value: ADDR }
		],
		{ network: 'mainnet' }
	);
	assert.equal(r.address, ADDR);
	assert.throws(
		() => requestFromEndpoints([{ identifier: 'btc-bitcoin-p2wpkh', value: TESTNET_ADDR }], { network: 'mainnet' }),
		/no way this wallet can pay \(btc-bitcoin-p2wpkh\)/
	);
});

test('a pubky that publishes nothing payable says what it does publish', () => {
	assert.throws(
		() => requestFromEndpoints([{ identifier: 'usdt-tron-address', value: 'T123' }], { network: 'mainnet' }),
		(e) => e.code === 'PAYKIT_NOTHING_PAYABLE' && /usdt-tron-address/.test(e.message)
	);
	assert.throws(() => requestFromEndpoints([], { network: 'mainnet' }), /no payment details published/);
});

test('shortPubky keeps both ends', () => {
	assert.equal(shortPubky('aihfhgdfshrj8nz9ofo7khayc1mgcqa4wrrdjahs5tmgo4pna3iy'), 'aihfhgdf…pna3iy');
});
