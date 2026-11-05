'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * A pending transaction the network dropped (#285): the other signed version
 * of a cooperative close confirmed, so this one can never confirm, yet the
 * daemon lists it at height 0 like any transaction waiting for a block.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { markDropped, electrumLookup, createTransactionsRoute, scriptHash, GRACE_MS, CHECK_TTL_MS } = require('./dropped-transactions');

// The mainnet case the issue was filed from.
const address = 'bc1qww0s9hf837l0nzttck8qzk4w6xf2wd5wkuvwf4';
const confirmedClose = 'a2a16a190f2baa8316a57554988a25bfaabdb0de94abbe51f97e85bb760fd418';
const losingClose = 'e399ce0431c1ae3e330ffea0a4ba380b33ae4f654877afbfe7a3f0bc1902cf87';
const now = 1793851500000;
const rows = () => [
	{ txid: confirmedClose, type: 'received', valueSats: 1150, address, confirmed: true, height: 974620, timestamp: now - 5 * 60000 },
	{ txid: losingClose, type: 'received', valueSats: 979, address, confirmed: false, timestamp: now - 6 * 60000 }
];
const hash = scriptHash(address, 'mainnet');
const historyOf = (entries) => async (hashes) => new Map(hashes.map((h) => [h, h === hash ? entries : []]));

test('a pending transaction missing from its address history is dropped, and the one that confirmed is untouched', async () => {
	const marked = await markDropped(rows(), { network: 'mainnet', lookup: historyOf([{ tx_hash: confirmedClose, height: 974620 }]), now });
	assert.equal(marked[0].dropped, undefined);
	assert.equal(marked[0].confirmed, true);
	assert.equal(marked[1].dropped, true);
	// The daemon's own fields stay as it reported them.
	assert.equal(marked[1].confirmed, false);
	assert.equal(marked[1].valueSats, 979);
});

test('a transaction the server still has, in the mempool or a block, stays pending', async () => {
	for (const height of [0, -1, 974621]) {
		const marked = await markDropped(rows(), { network: 'mainnet', lookup: historyOf([{ tx_hash: confirmedClose, height: 974620 }, { tx_hash: losingClose, height }]), now });
		assert.equal(marked[1].dropped, undefined, `height ${height}`);
	}
});

test('a fresh transaction, one that cannot be looked up, or an unreadable answer is left as the daemon reported it', async () => {
	let asked = 0;
	const counting = async (hashes) => { asked += 1; return new Map(hashes.map((h) => [h, []])); };
	const fresh = rows(); fresh[1].timestamp = now - GRACE_MS + 1000;
	assert.equal((await markDropped(fresh, { network: 'mainnet', lookup: counting, now }))[1].dropped, undefined);
	assert.equal(asked, 0);
	for (const lookup of [async () => { throw new Error('server down'); }, async () => new Map()]) {
		assert.equal((await markDropped(rows(), { network: 'mainnet', lookup, now }))[1].dropped, undefined);
	}
	const noAddress = rows(); delete noAddress[1].address;
	assert.equal((await markDropped(noAddress, { network: 'mainnet', lookup: counting, now }))[1].dropped, undefined);
	// An address from another network does not decode, so it is not looked up.
	assert.equal((await markDropped(rows(), { network: 'regtest', lookup: counting, now }))[1].dropped, undefined);
	assert.equal(asked, 0);
});

test('the engine saying a transaction is gone is enough, and a timestamp in seconds is read as seconds', async () => {
	let asked = 0;
	const lookup = async () => { asked += 1; return new Map(); };
	// Beignet 0.38.0 lists it with dropped: true, and earlier engines' raw record carries exists: false.
	for (const flag of [{ dropped: true }, { exists: false }]) {
		// First seen six minutes ago, so without the flag it would be looked up.
		const gone = rows(); Object.assign(gone[1], flag);
		const marked = await markDropped(gone, { network: 'mainnet', lookup, now });
		assert.equal(marked[1].dropped, true, JSON.stringify(flag));
		assert.equal(marked[0].dropped, undefined);
	}
	assert.equal(asked, 0);
	const seconds = rows(); seconds[1].timestamp = Math.floor((now - 6 * 60000) / 1000);
	assert.equal((await markDropped(seconds, { network: 'mainnet', lookup: historyOf([]), now }))[1].dropped, true);
});

test('histories come from one connection, and an error reply is no answer', async () => {
	const other = scriptHash('bc1q5jpll29naunqx6px27nh4rwrsadjwaatpjgru3', 'mainnet');
	let seen;
	const lookup = electrumLookup({ host: 'electrum.local', port: 50001 }, {
		requests: async (electrum, requests) => {
			seen = { electrum, requests };
			return { replies: { 1: { result: [{ tx_hash: confirmedClose, height: 974620 }] }, 2: { error: { message: 'busy' } } } };
		}
	});
	const histories = await lookup([hash, other]);
	assert.deepEqual(seen.requests.map((r) => [r.id, r.method, r.params[0]]), [[1, 'blockchain.scripthash.get_history', hash], [2, 'blockchain.scripthash.get_history', other]]);
	assert.equal(seen.electrum.host, 'electrum.local');
	assert.deepEqual(histories.get(hash), [{ tx_hash: confirmedClose, height: 974620 }]);
	assert.equal(histories.has(other), false);
});

test('the route asks the wallet server at most every half minute for the same pending set', async () => {
	let time = now;
	let lookups = 0;
	let daemonRows = rows();
	const calls = [];
	const manager = {
		registry: { get: () => ({ id: 'w1', network: 'mainnet', electrum: { host: 'electrum.local', port: 50001 } }) },
		_daemonCall: async (_rec, method, path) => { calls.push(`${method} ${path}`); return daemonRows; }
	};
	const route = createTransactionsRoute(manager, {
		now: () => time,
		lookupFor: () => async (hashes) => { lookups += 1; return new Map(hashes.map((h) => [h, [{ tx_hash: confirmedClose, height: 974620 }]])); }
	});
	assert.equal((await route('w1', '?limit=50'))[1].dropped, true);
	assert.deepEqual(calls, ['GET /transactions?limit=50']);
	time += CHECK_TTL_MS - 1;
	assert.equal((await route('w1'))[1].dropped, true);
	assert.equal(lookups, 1);
	time += 1;
	await route('w1');
	assert.equal(lookups, 2);
	// A new pending transaction is checked at once.
	daemonRows = [...rows(), { txid: 'ff'.repeat(32), type: 'received', valueSats: 5000, address, confirmed: false, timestamp: time - 3 * 60000 }];
	const next = await route('w1');
	assert.equal(lookups, 3);
	assert.equal(next[2].dropped, true);
	// Nothing pending, or no server on record, asks nothing.
	daemonRows = rows().slice(0, 1);
	await route('w1');
	manager.registry.get = () => ({ id: 'w1', network: 'mainnet' });
	daemonRows = rows();
	assert.equal((await route('w1'))[1].dropped, undefined);
	assert.equal(lookups, 3);
});
