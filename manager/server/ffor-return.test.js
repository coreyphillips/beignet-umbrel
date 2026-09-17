'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * The return half of an offline receive (FFOR, beignet #729), held against
 * a stubbed daemon: a fresh start reconciles every ACTIVE epoch the wallet
 * receives on, once the channel to the settlement peer is back; an
 * unreachable peer is reported, not retried forever; and the record model
 * refuses the settlement role where the daemon would.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');
const ffor = require('./ffor');

function managerWith(records, { fforSupported = true } = {}) {
	const m = Object.create(WalletManager.prototype);
	const store = { ...records };
	m.registry = {
		get: (id) => store[id],
		list: () => Object.values(store),
		upsert: (r) => {
			store[r.id] = r;
		}
	};
	m.runtime = new Map();
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	m.fforSupported = fforSupported;
	m.lfbwSupported = true;
	m.guardianHostingSupported = true;
	m.engineVersion = '0.21.4';
	m.settings = { get: () => ({ defaultNetwork: 'regtest', defaultElectrum: null, recoveryGuardians: [] }) };
	m._restartWallet = async () => {};
	m._restoreInFlight = async () => false;
	m._normalizeElectrum = (e) => e;
	m.calls = [];
	return { m, store };
}

const receiver = () => ({
	id: 'r1',
	name: 'Receiver',
	network: 'regtest',
	port: 3901,
	electrum: { host: 'h', port: 1, tls: false },
	onchainOnly: false,
	recovery: { mode: 'off', guardians: [] }
});

const CH = 'ab'.repeat(32);
const activeEpoch = (state = 'ACTIVE') => ({
	channelId: CH,
	role: 'R',
	state,
	epochId: 'e1',
	slots: [
		{ k: 1, amountMsat: '50000000', state: 'exposed' },
		{ k: 2, amountMsat: '50000000', state: 'unissued' }
	]
});

function stubDaemon(m, { epochs, channelState = 'NORMAL', recover }) {
	m._daemonCall = async (_rec, method, path, body) => {
		m.calls.push([method, path, body]);
		if (path === '/ffor/epochs') {
			if (epochs instanceof Error) throw epochs;
			return epochs;
		}
		if (path === '/channels') return [{ channelId: CH, state: channelState }];
		if (path.startsWith('/ffor/epoch?')) return recover && recover.epoch ? recover.epoch : activeEpoch();
		if (path === '/ffor/recover') {
			if (recover instanceof Error) throw recover;
			return recover;
		}
		throw new Error(`unexpected ${method} ${path}`);
	};
}

test('a start reconciles every receiver epoch once its channel is back, and keeps the outcome', async () => {
	const { m } = managerWith({ r1: receiver() });
	m.runtimeState('r1').proc = {};
	const closed = {
		action: 'closed',
		preimagesKnown: [1],
		witnesses: [],
		epoch: { ...activeEpoch('CLOSED'), slots: [{ k: 1, state: 'settled' }, { k: 2, state: 'unsettled' }] }
	};
	stubDaemon(m, { epochs: [activeEpoch(), { channelId: 'cc', role: 'S', state: 'ACTIVE' }], recover: closed });
	await m._fforReturn('r1');
	const recovers = m.calls.filter(([, p]) => p === '/ffor/recover');
	assert.equal(recovers.length, 1, 'the S-side record is the sibling\'s business, not a return');
	assert.deepEqual(recovers[0][2], { channelId: CH, forceCloseIfUnreachable: false });
	const rec = m.publicRecord('r1');
	assert.equal(rec.fforReturn.action, 'closed');
	assert.deepEqual(rec.fforReturn.preimagesKnown, [1]);
	assert.equal(rec.fforReturn.epoch.state, 'CLOSED');
	assert.equal(ffor.describeReturn(rec.fforReturn).complete, false, 'slot 2 still reads unsettled');
	assert.match(m.logs.join('\n'), /ffor return abababababababab: closed, 1 of 2 slots settled, 1 preimage known/);
});

test('no epochs, or an engine that predates the routes, means no return', async () => {
	const { m } = managerWith({ r1: receiver() });
	m.runtimeState('r1').proc = {};
	stubDaemon(m, { epochs: [] });
	await m._fforReturn('r1');
	assert.equal(m.calls.filter(([, p]) => p === '/ffor/recover').length, 0);

	const notFound = new Error('Not found');
	notFound.code = 'NOT_FOUND';
	stubDaemon(m, { epochs: notFound });
	await m._fforReturn('r1');
	assert.equal(m.calls.filter(([, p]) => p === '/ffor/recover').length, 0);

	const { m: old } = managerWith({ r1: receiver() }, { fforSupported: false });
	old.runtimeState('r1').proc = {};
	stubDaemon(old, { epochs: [activeEpoch()] });
	await old._fforReturn('r1');
	assert.equal(old.calls.length, 0, 'an engine without the surface is never asked');
});

test('a peer that never reestablishes is reported as unreachable, after one recover call', async () => {
	const { m } = managerWith({ r1: receiver() });
	m.runtimeState('r1').proc = {};
	const nothing = { action: 'nothing', preimagesKnown: [], witnesses: [], epoch: activeEpoch() };
	stubDaemon(m, { epochs: [activeEpoch()], channelState: 'AWAITING_REESTABLISH', recover: nothing });
	const realTimeout = ffor.RETURN_REESTABLISH_TIMEOUT_MS;
	// The wait is a module constant; shorten it through the method's argument.
	const orig = m._waitChannelNormal;
	m._waitChannelNormal = (rec, ch) => orig.call(m, rec, ch, 10);
	await m._fforReturn('r1');
	assert.equal(realTimeout, 90000);
	assert.equal(m.calls.filter(([, p]) => p === '/ffor/recover').length, 1);
	const rec = m.publicRecord('r1');
	assert.equal(rec.fforReturn.action, 'nothing');
	assert.equal(ffor.describeReturn(rec.fforReturn).complete, false);
	assert.match(m.logs.join('\n'), /settlement peer not reachable, 0 of 2 slots settled so far/);
});

test('a refused recover is kept on the record with its reason, and surfaces as a 502 to the caller', async () => {
	const { m } = managerWith({ r1: receiver() });
	m.runtimeState('r1').proc = {};
	const refused = new Error('no FFOR epoch on this channel');
	refused.code = 'NOT_FOUND';
	stubDaemon(m, { epochs: [activeEpoch()], recover: refused });
	await assert.rejects(m.fforReturn('r1', { channelId: CH }), (err) => err.statusCode === 502 && err.code === 'NOT_FOUND');
	assert.equal(m.publicRecord('r1').fforReturn.error, 'no FFOR epoch on this channel');
	await assert.rejects(m.fforReturn('r1', {}), (err) => err.code === 'INVALID_PARAMS');
	m.runtimeState('r1').proc = null;
	await assert.rejects(m.fforReturn('r1', { channelId: CH }), (err) => err.code === 'NOT_RUNNING');
});

test('the settlement role is validated like the daemon would, on create and on edit', async () => {
	const { m, store } = managerWith({ r1: receiver() });
	assert.deepEqual(m._normalizeFfor(undefined, null, false), { settle: { ...ffor.SETTLE_DEFAULTS } });
	assert.throws(() => m._normalizeFfor({ settle: { enabled: true } }, null, true), (err) => err.code === 'FFOR_NEEDS_LIGHTNING');
	const { m: old } = managerWith({});
	old.fforSupported = false;
	assert.throws(() => old._normalizeFfor({ settle: { enabled: true } }, null, false), (err) => err.code === 'FFOR_UNSUPPORTED');
	assert.equal(old._normalizeFfor({ settle: { enabled: false } }, null, false).settle.enabled, false, 'off is always fine');

	const edited = await m.updateWallet('r1', { ffor: { settle: { enabled: true, feePpm: 50 } } });
	assert.equal(edited.ffor.settle.enabled, true);
	assert.equal(edited.ffor.settle.feePpm, 50);
	assert.equal(store.r1.ffor.settle.enabled, true);
	const parked = await m.updateWallet('r1', { onchainOnly: true });
	assert.equal(parked.ffor.settle.enabled, false, 'parking Lightning drops the settlement role');
	assert.equal(parked.ffor.settle.feePpm, 50, 'but keeps the terms for when it comes back');
});

test('settlement candidates are the opted-in siblings, marked by health', () => {
	const { m } = managerWith({
		r1: receiver(),
		s1: { ...receiver(), id: 's1', name: 'Settler', nodeId: '02' + 'cd'.repeat(32), ffor: { settle: { enabled: true } } },
		s2: { ...receiver(), id: 's2', name: 'Quiet', nodeId: '02' + 'ef'.repeat(32) }
	});
	m.runtimeState('s1').healthy = true;
	assert.deepEqual(m.fforCandidates('r1'), [{ id: 's1', name: 'Settler', nodeId: '02' + 'cd'.repeat(32), running: true }]);
	assert.throws(() => m.fforCandidates('nope'), (err) => err.code === 'NOT_FOUND');
});
