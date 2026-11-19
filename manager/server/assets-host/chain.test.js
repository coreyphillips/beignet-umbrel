'use strict';

/**
 * Which chain a wallet is on: reading it off the Electrum server's block 0,
 * remembering it once the wallet holds assets, and refusing every other.
 *
 * Run: cd manager && npm test
 * Or:  cd manager && node --test server/assets-host/chain.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ROW, headerHash, askChain, knownChain, settleChain, laterCheck } = require('./chain');
const { GENESIS, parseConfig } = require('./config');
const { memoryStorage, hostRows } = require('./store');
const { MODULES } = require('./test-fakes');

// The first block header of each chain, as an Electrum server returns it.
const HEADERS = {
	mainnet: '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c',
	testnet3: '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff001d1aa4ae18',
	testnet4: '0100000000000000000000000000000000000000000000000000000000000000000000004e7b2b9128fe0291db0693af2ae418b767e657cd407e80cb1434221eaea7a07a046f3566ffff001dbb0c7817',
	regtest: '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f2002000000'
};
// A header that is nobody's block 0: signet's.
const SIGNET = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a008f4d5fae77031e8ad22203';

const ok = (value) => ({ isErr: () => false, value });
const failedResult = (message) => ({ isErr: () => true, error: new Error(message) });
const walletOn = (chain) => ({ electrum: { getBlockHex: async () => ok(HEADERS[chain]) } });
const answer = (chain) => ({ answered: true, genesis: headerHash(HEADERS[chain]), chain });
const SILENT = { answered: false, genesis: null, chain: null };
const cfgFor = (network) => parseConfig(network, { BEIGNET_ASSETS_MODULES: MODULES });

async function thrown(fn) {
	try {
		await fn();
	} catch (err) {
		return err;
	}
	throw new Error('expected a refusal');
}

test('block 0 of each chain hashes to the chain the host calls it', () => {
	for (const [chain, header] of Object.entries(HEADERS)) assert.equal(GENESIS[headerHash(header)], chain, chain);
	assert.equal(Object.keys(GENESIS).length, 4);
	assert.equal(GENESIS[headerHash(SIGNET)], undefined);
	for (const bad of ['', 'zz', HEADERS.mainnet.slice(2), `${HEADERS.mainnet}00`, null, undefined, 7, {}]) assert.equal(headerHash(bad), null);
});

test('asking: the engine\'s answer, a bare string, and every way of not answering', async () => {
	for (const chain of Object.keys(HEADERS)) {
		assert.deepEqual(await askChain(walletOn(chain)), answer(chain));
	}
	let asked = null;
	const bare = {
		electrum: {
			getBlockHex: async (args) => {
				asked = args;
				return HEADERS.testnet4;
			}
		}
	};
	assert.deepEqual(await askChain(bare), answer('testnet4'));
	assert.deepEqual(asked, { height: 0 });
	// A chain this app does not know is still an answer.
	assert.deepEqual(await askChain({ electrum: { getBlockHex: async () => ok(SIGNET) } }), { answered: true, genesis: headerHash(SIGNET), chain: null });

	const silent = [
		{ electrum: { getBlockHex: async () => failedResult('electrum is not connected') } },
		{ electrum: { getBlockHex: async () => ok('not a header') } },
		{ electrum: { getBlockHex: async () => null } },
		{
			electrum: {
				getBlockHex: () => {
					throw new Error('no connection');
				}
			}
		},
		{ electrum: { getBlockHex: () => new Promise(() => {}) } },
		{ electrum: {} },
		{},
		null
	];
	for (const wallet of silent) assert.deepEqual(await askChain(wallet, { timeoutMs: 20 }), SILENT);
});

test('a network that is one chain knows it without asking, and testnet does not', () => {
	const { storage } = memoryStorage();
	assert.equal(knownChain({ cfg: cfgFor('mainnet'), storage }), 'mainnet');
	assert.equal(knownChain({ cfg: cfgFor('regtest'), storage }), 'regtest');
	assert.equal(knownChain({ cfg: cfgFor('testnet'), storage }), null);
	hostRows(storage).put(ROW, { name: 'testnet4' });
	assert.equal(knownChain({ cfg: cfgFor('testnet'), storage }), 'testnet4');
	// A note of a chain this network cannot be is not believed.
	hostRows(storage).put(ROW, { name: 'mainnet' });
	assert.equal(knownChain({ cfg: cfgFor('testnet'), storage }), null);
});

test('a testnet wallet runs on the testnet its server names, and remembers it', () => {
	for (const chain of ['testnet3', 'testnet4']) {
		const { storage } = memoryStorage();
		const cfg = cfgFor('testnet');
		assert.deepEqual(settleChain({ cfg, storage, asked: answer(chain) }), { chain, verified: true });
		assert.deepEqual(hostRows(storage).get(ROW), { name: chain, genesis: headerHash(HEADERS[chain]) });
		// Asked again, the same answer changes nothing.
		assert.deepEqual(settleChain({ cfg, storage, asked: answer(chain) }), { chain, verified: true });
		// With no answer the wallet starts on the chain it remembers, unverified.
		assert.deepEqual(settleChain({ cfg, storage, asked: SILENT }), { chain, verified: false });
	}
});

test('a testnet wallet that holds nothing follows its server to the other testnet', () => {
	const { storage } = memoryStorage();
	const cfg = cfgFor('testnet');
	settleChain({ cfg, storage, asked: answer('testnet3') });
	// A count of derived keys, an answered request and a backup note are not assets.
	storage.set('t/keyindex/212', '4');
	storage.set('h/idem/abc', '{}');
	storage.set('h/backup', '{}');
	assert.deepEqual(settleChain({ cfg, storage, asked: answer('testnet4') }), { chain: 'testnet4', verified: true });
	assert.equal(hostRows(storage).get(ROW).name, 'testnet4');
});

test('a testnet wallet that holds assets will not run on the other testnet', async () => {
	for (const key of ['t/asset/abc', 't/batch/abc', 't/receive/abc', 'h/row/mint-1']) {
		const { storage } = memoryStorage();
		const cfg = cfgFor('testnet');
		settleChain({ cfg, storage, asked: answer('testnet3') });
		storage.set(key, '{}');
		const err = await thrown(() => settleChain({ cfg, storage, asked: answer('testnet4') }));
		assert.equal(err.message, "This wallet's assets are on testnet3, and its Electrum server is on testnet4. Point the wallet at a testnet3 server to use them.", key);
		assert.equal(hostRows(storage).get(ROW).name, 'testnet3', key);
	}
});

test('a server on another network, or on no chain this app knows, turns assets off', async () => {
	const cases = [
		['mainnet', answer('testnet3'), 'This is a mainnet wallet, and its Electrum server is on testnet3. Assets stay off until the two match.'],
		['testnet', answer('mainnet'), 'This is a testnet wallet, and its Electrum server is on mainnet. Assets stay off until the two match.'],
		['regtest', answer('testnet4'), 'This is a regtest wallet, and its Electrum server is on testnet4. Assets stay off until the two match.'],
		['mainnet', { answered: true, genesis: headerHash(SIGNET), chain: null }, "This wallet's Electrum server is on a chain this app does not know, so assets are off."]
	];
	for (const [network, asked, sentence] of cases) {
		const { storage } = memoryStorage();
		const err = await thrown(() => settleChain({ cfg: cfgFor(network), storage, asked }));
		assert.equal(err.message, sentence);
		assert.equal(hostRows(storage).get(ROW), null, 'nothing is remembered about a chain that was refused');
		assert.ok(!err.message.includes('\u2014'));
	}
});

test('no answer: one-chain networks start unverified, an unnamed testnet cannot start', async () => {
	for (const network of ['mainnet', 'regtest']) {
		const { storage } = memoryStorage();
		assert.deepEqual(settleChain({ cfg: cfgFor(network), storage, asked: SILENT }), { chain: network, verified: false });
		assert.equal(hostRows(storage).get(ROW), null, 'only a server\'s word is remembered');
	}
	const { storage } = memoryStorage();
	const err = await thrown(() => settleChain({ cfg: cfgFor('testnet'), storage, asked: SILENT }));
	assert.match(err.message, /has not said which testnet it is on/);
});

test('the later check: passes on the right chain and remembers it', async () => {
	const { storage } = memoryStorage();
	const cfg = cfgFor('mainnet');
	const check = laterCheck({ cfg, storage, wallet: walletOn('mainnet'), chain: 'mainnet' });
	assert.equal(await check(), undefined);
	assert.deepEqual(hostRows(storage).get(ROW), { name: 'mainnet', genesis: headerHash(HEADERS.mainnet) });
});

test('the later check: waits on a silent server and stops on the wrong chain', async () => {
	const cfg = cfgFor('testnet');
	const fresh = () => {
		const { storage } = memoryStorage();
		hostRows(storage).put(ROW, { name: 'testnet3' });
		return storage;
	};
	// Silent: the same reason every time it is asked, and nothing is changed.
	let storage = fresh();
	let err = await thrown(laterCheck({ cfg, storage, wallet: {}, chain: 'testnet3', ask: async () => SILENT }));
	assert.equal(err.message, "The wallet's Electrum server has not said which chain it is on");

	// The other testnet, with assets held.
	storage = fresh();
	storage.set('t/asset/abc', '{}');
	err = await thrown(laterCheck({ cfg, storage, wallet: walletOn('testnet4'), chain: 'testnet3' }));
	assert.equal(err.message, "This wallet's assets are on testnet3, and its Electrum server is on testnet4. Point the wallet at a testnet3 server to use them.");
	assert.equal(hostRows(storage).get(ROW).name, 'testnet3');

	// The other testnet, with nothing held: a restart is all it takes.
	storage = fresh();
	err = await thrown(laterCheck({ cfg, storage, wallet: walletOn('testnet4'), chain: 'testnet3' }));
	assert.equal(err.message, "The wallet's Electrum server is on testnet4. Stop the wallet and start it again to use assets there.");

	// Another network altogether.
	storage = fresh();
	err = await thrown(laterCheck({ cfg, storage, wallet: walletOn('mainnet'), chain: 'testnet3' }));
	assert.equal(err.message, 'This is a testnet wallet, and its Electrum server is on mainnet. Assets stay off until the two match.');
});
