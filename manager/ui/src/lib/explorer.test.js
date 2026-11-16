// Run: cd manager/ui && npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { addressUrl, txUrl } from './explorer.js';

const TXID = 'ab'.repeat(32);

test('a transaction links to the explorer of its own chain, and regtest to none', () => {
	assert.equal(txUrl('mainnet', TXID), `https://mempool.space/tx/${TXID}`);
	assert.equal(txUrl('testnet', TXID), `https://mempool.space/testnet/tx/${TXID}`);
	assert.equal(txUrl('testnet4', TXID), `https://mempool.space/testnet4/tx/${TXID}`);
	assert.equal(txUrl('regtest', TXID), null);
	assert.equal(txUrl('signet', TXID), null);
	assert.equal(txUrl('testnet4', ''), null);
	assert.equal(addressUrl('testnet4', 'tb1qexample'), 'https://mempool.space/testnet4/address/tb1qexample');
	assert.equal(addressUrl('regtest', 'bcrt1qexample'), null);
});
