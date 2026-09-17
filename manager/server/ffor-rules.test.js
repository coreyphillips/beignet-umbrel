'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * The FFOR rules held without a daemon: what a settlement peer's block
 * accepts, the env it turns into, when a role edit needs a restart, which
 * siblings a receiver may pick, which epochs a fresh start reconciles, and
 * when a return counts as complete.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ffor = require('./ffor');

const settler = (extra = {}) => ({
	id: 's1',
	name: 'Settler',
	network: 'regtest',
	nodeId: '02' + 'ab'.repeat(32),
	ffor: { settle: { enabled: true } },
	...extra
});

test('normalizeFfor fills defaults, validates the caps and clears an optional one on null', () => {
	assert.deepEqual(ffor.normalizeFfor(undefined), { settle: { ...ffor.SETTLE_DEFAULTS } });
	const on = ffor.normalizeFfor({ settle: { enabled: 1, maxBudgetMsat: '5000000', feePpm: 250 } });
	assert.deepEqual(on.settle, { enabled: true, maxBudgetMsat: 5000000, maxEpochBlocks: null, feeBaseMsat: 0, feePpm: 250 });
	const kept = ffor.normalizeFfor({ settle: { maxBudgetMsat: null } }, on);
	assert.equal(kept.settle.enabled, true, 'an edit keeps what it does not name');
	assert.equal(kept.settle.maxBudgetMsat, null, 'null clears an optional cap');
	assert.equal(kept.settle.feePpm, 250);
	for (const bad of [
		{ settle: { feePpm: null } },
		{ settle: { feePpm: 'x' } },
		{ settle: { maxEpochBlocks: 100 } },
		{ settle: { feeBaseMsat: -1 } },
		{ settle: 'yes' },
		'yes'
	]) {
		assert.throws(() => ffor.normalizeFfor(bad), (err) => err.code === 'BAD_FFOR' && err.statusCode === 400);
	}
});

test('fforEnv is exactly the daemon switch plus the caps that are set, and nothing for everyone else', () => {
	assert.deepEqual(ffor.fforEnv({}), {});
	assert.deepEqual(ffor.fforEnv({ ffor: { settle: { enabled: false } } }), {});
	assert.deepEqual(ffor.fforEnv(settler({ onchainOnly: true })), {}, 'no listener, no settlement');
	assert.deepEqual(ffor.fforEnv(settler()), {
		BEIGNET_FFOR_SETTLE: 'true',
		BEIGNET_FFOR_FEE_BASE_MSAT: '0',
		BEIGNET_FFOR_FEE_PPM: '0'
	});
	const capped = ffor.fforEnv(settler({ ffor: { settle: { enabled: true, maxBudgetMsat: 10, maxEpochBlocks: 2016, feeBaseMsat: 1000, feePpm: 100 } } }));
	assert.equal(capped.BEIGNET_FFOR_MAX_BUDGET_MSAT, '10');
	assert.equal(capped.BEIGNET_FFOR_MAX_EPOCH_BLOCKS, '2016');
	assert.equal(capped.BEIGNET_FFOR_FEE_BASE_MSAT, '1000');
	assert.equal(capped.BEIGNET_FFOR_FEE_PPM, '100');
});

test('fforRoleChanged compares what a running daemon was spawned with against what the record wants', () => {
	const s = settler();
	assert.equal(ffor.fforRoleChanged({}, s), true, 'spawned plain, now a settler');
	assert.equal(ffor.fforRoleChanged(ffor.fforEnv(s), s), false);
	assert.equal(ffor.fforRoleChanged(ffor.fforEnv(s), { ffor: { settle: { enabled: false } } }), true, 'role dropped');
	assert.equal(ffor.fforRoleChanged(ffor.fforEnv(s), settler({ ffor: { settle: { enabled: true, feePpm: 5 } } })), true, 'a fee edit');
	assert.equal(ffor.fforRoleChanged({ BEIGNET_NETWORK: 'regtest' }, {}), false);
});

test('settlementCandidates are the opted-in siblings on the same network with a node id', () => {
	const self = { id: 'r1', network: 'regtest' };
	const records = [
		self,
		settler(),
		settler({ id: 's2', network: 'mainnet' }),
		settler({ id: 's3', nodeId: null }),
		settler({ id: 's4', ffor: { settle: { enabled: false } } }),
		settler({ id: 's5', onchainOnly: true })
	];
	assert.deepEqual(ffor.settlementCandidates(records, self, (rec) => rec.id === 's1'), [
		{ id: 's1', name: 'Settler', nodeId: '02' + 'ab'.repeat(32), running: true }
	]);
});

test('returnJobs picks the receiver epochs a settlement peer may hold credits for', () => {
	const epochs = [
		{ channelId: 'aa', role: 'R', state: 'ACTIVE' },
		{ channelId: 'bb', role: 'R', state: 'DRAINING' },
		{ channelId: 'cc', role: 'R', state: 'CLOSED' },
		{ channelId: 'dd', role: 'R', state: 'NEGOTIATING' },
		{ channelId: 'ee', role: 'S', state: 'ACTIVE' }
	];
	assert.deepEqual(ffor.returnJobs(epochs), ['aa', 'bb']);
	assert.deepEqual(ffor.returnJobs(null), []);
});

test('describeReturn is complete only once the epoch closed with every slot accounted for', () => {
	const slots = (...states) => states.map((state, i) => ({ k: i + 1, state }));
	const closedRaw = { action: 'closed', preimagesKnown: [1], epoch: { state: 'CLOSED', slots: slots('settled', 'unsettled') } };
	const closed = ffor.describeReturn(closedRaw);
	assert.equal(closed.complete, false, 'a slot the wallet could be owed still reads unsettled');
	assert.equal(closed.credited, 1);
	assert.equal(closed.settled, 1);
	const doneRaw = { action: 'closed', preimagesKnown: [1, 2], epoch: { state: 'CLOSED', slots: slots('settled', 'settled') } };
	assert.equal(ffor.describeReturn(doneRaw).complete, true);
	const awayRaw = { action: 'nothing', preimagesKnown: [], epoch: { state: 'ACTIVE', slots: slots('exposed', 'unissued') } };
	assert.equal(ffor.describeReturn(awayRaw).complete, false, 'the peer was not reachable');
	assert.match(ffor.returnLogLine('abcd', awayRaw), /not reachable/);
	assert.match(ffor.returnLogLine('abcd', doneRaw), /closed, 2 of 2 slots settled, 2 preimages known/);
	assert.match(ffor.returnLogLine('abcd', null, new Error('boom')), /failed, boom/);
	assert.equal(ffor.describeReturn(null), null);
});

test('describeReturn credits through the settled bitmap when no witness returned a preimage', () => {
	const d = ffor.describeReturn({ action: 'closed', preimagesKnown: [], epoch: { state: 'CLOSED', slots: [{ k: 1, state: 'settled' }, { k: 2, state: 'unsettled' }] } });
	assert.equal(d.credited, 1);
	assert.equal(d.settled, 1);
});
