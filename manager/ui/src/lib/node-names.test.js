/**
 * Run with: npm test (from manager/ui).
 *
 * Peer names are asked of the wallet's map once per peer and remembered, a
 * private peer's NOT_FOUND included, so a table polled every 8 seconds stops
 * logging a miss for a phone wallet on every poll.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_MS, PRIVATE_MS, createNodeNames, peerLabel } from './node-names.js';

const PUBLIC = '02' + 'a'.repeat(64);
const PHONE = '03' + 'c'.repeat(64);
const NAMELESS = '02' + 'e'.repeat(64);

/** A daemon stub that counts what it is asked, and answers as the daemon does. */
function stubApi({ fail = false } = {}) {
	const asked = [];
	return {
		asked,
		get: async (path) => {
			const pk = new URLSearchParams(path.split('?')[1]).get('pubkey');
			asked.push(pk);
			if (fail) {
				const err = new Error('Wallet is not responding');
				err.code = 'WALLET_UNRESPONSIVE';
				throw err;
			}
			if (pk === PUBLIC) return { pubkey: pk, alias: 'Seven of Nine' };
			if (pk === NAMELESS) return { pubkey: pk, alias: '' };
			const err = new Error('Node not found in graph');
			err.code = 'NOT_FOUND';
			err.status = 404;
			throw err;
		}
	};
}

test('each peer is asked about once however many rows name it', async () => {
	const names = createNodeNames();
	const api = stubApi();
	const out = await names.lookup(api, 'w1', [PUBLIC, PHONE, PUBLIC, PHONE, PHONE]);
	assert.deepEqual(api.asked.sort(), [PHONE, PUBLIC].sort());
	assert.deepEqual(out[PUBLIC], { alias: 'Seven of Nine', private: false });
	assert.deepEqual(out[PHONE], { alias: null, private: true });
});

test('a known alias and a private peer are remembered, then asked again once stale', async () => {
	let now = 1_000_000;
	const names = createNodeNames({ now: () => now });
	const api = stubApi();
	await names.lookup(api, 'w1', [PUBLIC, PHONE]);
	now += PRIVATE_MS - 1;
	await names.lookup(api, 'w1', [PUBLIC, PHONE]);
	assert.equal(api.asked.length, 2, 'nothing is asked again while the names are fresh');
	now += 1;
	await names.lookup(api, 'w1', [PUBLIC, PHONE]);
	assert.deepEqual(api.asked.slice(2), [PHONE], 'a private peer is asked about again first');
	now += KNOWN_MS - PRIVATE_MS;
	await names.lookup(api, 'w1', [PUBLIC, PHONE]);
	assert.ok(api.asked.slice(3).includes(PUBLIC), 'a known alias is asked about again once stale');
});

test('a failed lookup is not remembered, and names nothing', async () => {
	const names = createNodeNames();
	const down = stubApi({ fail: true });
	const out = await names.lookup(down, 'w1', [PUBLIC]);
	assert.equal(out[PUBLIC], null);
	const up = stubApi();
	const again = await names.lookup(up, 'w1', [PUBLIC]);
	assert.deepEqual(up.asked, [PUBLIC], 'the next poll asks again');
	assert.equal(again[PUBLIC].alias, 'Seven of Nine');
});

test('every wallet has a map of its own', async () => {
	const names = createNodeNames();
	const api = stubApi();
	await names.lookup(api, 'w1', [PHONE]);
	await names.lookup(api, 'w2', [PHONE]);
	assert.equal(api.asked.length, 2, 'what one wallet learned is not taken for the other');
	await names.lookup(api, 'w1', [PHONE]);
	await names.lookup(api, 'w2', [PHONE]);
	assert.equal(api.asked.length, 2, 'each remembers its own answer');
});

test('lookups in flight together share one request', async () => {
	const names = createNodeNames();
	const api = stubApi();
	const [a, b] = await Promise.all([
		names.lookup(api, 'w1', [PHONE]),
		names.lookup(api, 'w1', [PHONE])
	]);
	assert.equal(api.asked.length, 1);
	assert.deepEqual(a[PHONE], b[PHONE]);
});

test('a node known without an alias is unnamed, not private', async () => {
	const names = createNodeNames();
	const out = await names.lookup(stubApi(), 'w1', [NAMELESS]);
	assert.deepEqual(out[NAMELESS], { alias: null, private: false });
});

test('labels say why a peer has no name', () => {
	assert.deepEqual(peerLabel({ alias: 'Seven of Nine', private: false }), {
		text: 'Seven of Nine',
		muted: false,
		title: null
	});
	const phone = peerLabel({ alias: null, private: true });
	assert.equal(phone.text, 'Private peer');
	assert.equal(phone.muted, true);
	assert.match(phone.title, /has not announced itself/);
	assert.equal(peerLabel({ alias: null, private: false }).text, 'Unnamed node');
	assert.equal(peerLabel(null).text, 'Unknown node');
});
