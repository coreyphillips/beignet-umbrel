'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * The one contract that decides a wallet's Lightning posture, held without
 * spawning anything. On-chain only is real on the daemon side exactly insofar
 * as this environment says so: no BEIGNET_LISTEN_PORT (the daemon only starts
 * its Lightning listener when a port is configured) and
 * BEIGNET_AUTO_RECONNECT=false (or the daemon dials its channel partners back
 * and the channels quietly reestablish behind a dashboard that shows nothing).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');

// Prototype methods only: the constructor reads registry and settings files,
// none of which the env builder needs.
function bareManager() {
	return Object.create(WalletManager.prototype);
}

const PATHS = { home: '/tmp/x/home', data: '/tmp/x/data' };
const rec = (extra = {}) => ({
	id: 'w1',
	name: 'Test wallet',
	network: 'mainnet',
	electrum: { host: 'umbrel.local', port: 50001, tls: false },
	tor: false,
	announce: false,
	port: 3001,
	...extra
});

test('a Lightning wallet listens, and is left to dial its peers', () => {
	const env = bareManager()._daemonEnv(rec(), PATHS, 'seed words', 'token');
	assert.equal(env.BEIGNET_LISTEN_PORT, String(3001 + 6000));
	assert.equal(env.BEIGNET_AUTO_RECONNECT, undefined);
});

test('an on-chain only wallet neither listens nor dials', () => {
	const env = bareManager()._daemonEnv(
		rec({ onchainOnly: true }),
		PATHS,
		'seed words',
		'token'
	);
	assert.equal(env.BEIGNET_LISTEN_PORT, undefined, 'no listener port, no listener');
	assert.equal(env.BEIGNET_AUTO_RECONNECT, 'false', 'and no dialing peers back');
	assert.equal(
		env.BEIGNET_ANNOUNCE_ADDRESSES,
		undefined,
		'nothing announced, there is nothing to reach'
	);
});

test('flipping the flag flips the whole posture, both directions', () => {
	const m = bareManager();
	const parked = m._daemonEnv(rec({ onchainOnly: true }), PATHS, 's', 't');
	const revived = m._daemonEnv(rec({ onchainOnly: false }), PATHS, 's', 't');
	assert.equal(parked.BEIGNET_LISTEN_PORT, undefined);
	assert.equal(revived.BEIGNET_LISTEN_PORT, String(9001));
	assert.equal(parked.BEIGNET_AUTO_RECONNECT, 'false');
	assert.equal(revived.BEIGNET_AUTO_RECONNECT, undefined);
});

// Channel backup (the Recovery Protocol, beignet 0.9.1+). The daemon refuses
// to start on a guardian list outside the guardian modes and on any profile
// but crash-v1, so the env is all or nothing per mode.
const G = [
	`${'a'.repeat(64)}@http://127.0.0.1:8101`,
	`${'b'.repeat(64)}@http://127.0.0.1:8102`,
	`${'c'.repeat(64)}@https://guardian.example`
];

test('a wallet without the field sends the env an older engine always saw', () => {
	const env = bareManager()._daemonEnv(rec(), PATHS, 's', 't');
	assert.equal(env.BEIGNET_RECOVERY_MODE, undefined);
	assert.equal(env.BEIGNET_RECOVERY_GUARDIANS, undefined);
	assert.equal(env.BEIGNET_RECOVERY_PROFILE, undefined);
	const off = bareManager()._daemonEnv(rec({ recovery: { mode: 'off', guardians: [] } }), PATHS, 's', 't');
	assert.equal(off.BEIGNET_RECOVERY_MODE, undefined, 'off is the absence of the var');
});

test('peer storage sets the mode and nothing else', () => {
	const env = bareManager()._daemonEnv(
		rec({ recovery: { mode: 'peer-storage', guardians: [] } }),
		PATHS,
		's',
		't'
	);
	assert.equal(env.BEIGNET_RECOVERY_MODE, 'peer-storage');
	assert.equal(env.BEIGNET_RECOVERY_GUARDIANS, undefined, 'guardians outside a guardian mode refuse startup');
	assert.equal(env.BEIGNET_RECOVERY_PROFILE, undefined);
});

test('a guardian mode carries the pinned set in order and the crash-v1 profile', () => {
	const env = bareManager()._daemonEnv(
		rec({ recovery: { mode: 'quorum', guardians: G } }),
		PATHS,
		's',
		't'
	);
	assert.equal(env.BEIGNET_RECOVERY_MODE, 'quorum');
	assert.equal(env.BEIGNET_RECOVERY_GUARDIANS, G.join(','));
	assert.equal(env.BEIGNET_RECOVERY_PROFILE, 'crash-v1');
});

test('a parked quorum wallet still boots with its barrier', () => {
	// The journal of a wallet that promised quorum refuses to run without an
	// enforcing barrier, so on-chain only must not strip the recovery env.
	const env = bareManager()._daemonEnv(
		rec({ onchainOnly: true, recovery: { mode: 'quorum', guardians: G } }),
		PATHS,
		's',
		't'
	);
	assert.equal(env.BEIGNET_LISTEN_PORT, undefined);
	assert.equal(env.BEIGNET_RECOVERY_MODE, 'quorum');
	assert.equal(env.BEIGNET_RECOVERY_GUARDIANS, G.join(','));
});

// Lightning-first: a wallet that provides liquidity to lightning-first
// siblings runs the engine's JIT role and the direct-funding relay; the
// lightning-first wallet itself, and everyone else, sees nothing new.
test('only a liquidity provider gets the JIT role and the relay', () => {
	const m = bareManager();
	const plain = m._daemonEnv(rec(), PATHS, 's', 't');
	assert.equal(plain.BEIGNET_JIT_RECEIVE, undefined);
	assert.equal(plain.BEIGNET_DF_RELAY, undefined);
	const client = m._daemonEnv(
		rec({ lfbw: { enabled: true, mode: 'internal', primaryWalletId: 'p1' } }),
		PATHS,
		's',
		't'
	);
	assert.equal(client.BEIGNET_JIT_RECEIVE, undefined, 'a lightning-first wallet is a client, not an LSP');
	assert.equal(client.BEIGNET_LISTEN_PORT, String(3001 + 6000), 'and it listens like any Lightning wallet');
	const provider = m._daemonEnv(
		rec({ liquidityProvider: true, jit: { flatFeeSat: 100, maxTotalFundingSats: 2000000 } }),
		PATHS,
		's',
		't'
	);
	assert.equal(provider.BEIGNET_JIT_RECEIVE, 'true');
	assert.equal(provider.BEIGNET_DF_RELAY, 'true');
	assert.equal(provider.BEIGNET_JIT_FLAT_FEE_SAT, '100');
	assert.equal(provider.BEIGNET_JIT_FEE_PPM, '0');
	assert.equal(provider.BEIGNET_JIT_MAX_CLIENT_FUNDING_SAT, '1000000');
	assert.equal(provider.BEIGNET_JIT_MAX_CONCURRENT_FUNDINGS, '3');
	assert.equal(provider.BEIGNET_JIT_MAX_TOTAL_FUNDING_SAT, '2000000');
	const parkedProvider = m._daemonEnv(rec({ liquidityProvider: true, onchainOnly: true }), PATHS, 's', 't');
	assert.equal(parkedProvider.BEIGNET_JIT_RECEIVE, undefined, 'an on-chain only wallet fronts nothing');
});

// Reverse swaps (beignet #737): off by default, and only a Lightning-running
// liquidity provider that switched them on runs the role.
test('only a liquidity provider that opted in serves reverse swaps', () => {
	const m = bareManager();
	const provider = m._daemonEnv(rec({ liquidityProvider: true }), PATHS, 's', 't');
	assert.equal(provider.BEIGNET_SWAPS, undefined, 'off until the operator switches it on');
	const serving = m._daemonEnv(
		rec({ liquidityProvider: true, swaps: { enabled: true, flatFeeSat: 250, maxSat: 200000, maxExposureSat: 400000 } }),
		PATHS,
		's',
		't'
	);
	assert.equal(serving.BEIGNET_SWAPS, 'true');
	assert.equal(serving.BEIGNET_SWAP_FLAT_FEE_SAT, '250');
	assert.equal(serving.BEIGNET_SWAP_FEE_PPM, '1000');
	assert.equal(serving.BEIGNET_SWAP_MIN_SAT, '10000');
	assert.equal(serving.BEIGNET_SWAP_MAX_SAT, '200000');
	assert.equal(serving.BEIGNET_SWAP_MAX_EXPOSURE_SAT, '400000');
	assert.equal(serving.BEIGNET_SWAP_MAX_CONCURRENT, '8');
	const notProvider = m._daemonEnv(rec({ swaps: { enabled: true } }), PATHS, 's', 't');
	assert.equal(notProvider.BEIGNET_SWAPS, undefined, 'the role rides the liquidity provider switch');
	const parked = m._daemonEnv(rec({ liquidityProvider: true, onchainOnly: true, swaps: { enabled: true } }), PATHS, 's', 't');
	assert.equal(parked.BEIGNET_SWAPS, undefined, 'an on-chain only wallet has no Lightning side to swap');
});

test('operator engine policy passes through from the manager env', () => {
	const prev = { ...process.env };
	process.env.BEIGNET_FEE_PPM = '250';
	process.env.BEIGNET_DF_MIN_AMOUNT = '';
	try {
		const env = bareManager()._daemonEnv(rec(), PATHS, 's', 't');
		assert.equal(env.BEIGNET_FEE_PPM, '250');
		assert.equal(env.BEIGNET_DF_MIN_AMOUNT, undefined, 'an empty value is not a policy');
	} finally {
		delete process.env.BEIGNET_FEE_PPM;
		delete process.env.BEIGNET_DF_MIN_AMOUNT;
		Object.assign(process.env, prev);
	}
});

test('the automatic checkpoint restore rides with peer storage only', () => {
	const on = bareManager()._daemonEnv(
		rec({ recovery: { mode: 'peer-storage', guardians: [], autoApply: true } }),
		PATHS,
		's',
		't'
	);
	assert.equal(on.BEIGNET_RECOVERY_MODE, 'peer-storage');
	assert.equal(on.BEIGNET_RECOVERY_AUTO_APPLY, 'true');
	const off = bareManager()._daemonEnv(rec({ recovery: { mode: 'peer-storage', guardians: [] } }), PATHS, 's', 't');
	assert.equal(off.BEIGNET_RECOVERY_AUTO_APPLY, undefined, 'absent unless answered');
	const G = [`${'a'.repeat(64)}@http://127.0.0.1:8101`, `${'b'.repeat(64)}@http://127.0.0.1:8102`, `${'c'.repeat(64)}@https://g.example`];
	const quorum = bareManager()._daemonEnv(
		rec({ recovery: { mode: 'quorum', guardians: G, autoApply: true } }),
		PATHS,
		's',
		't'
	);
	assert.equal(quorum.BEIGNET_RECOVERY_AUTO_APPLY, undefined, 'the daemon refuses the flag under a guardian mode');
});

test('serving as a guardian rides the Lightning listener (beignet #699)', () => {
	const m = bareManager();
	const serving = m._daemonEnv(rec({ guardianServe: true }), PATHS, 's', 't');
	assert.equal(serving.BEIGNET_GUARDIAN_SERVE, 'true');
	assert.equal(serving.BEIGNET_LISTEN_PORT, String(3001 + 6000), 'a guardian is reached at the listen port');
	assert.equal(serving.BEIGNET_GUARDIAN_TOKEN, undefined, 'open by default: the pool needs strangers to register');
	const quiet = m._daemonEnv(rec(), PATHS, 's', 't');
	assert.equal(quiet.BEIGNET_GUARDIAN_SERVE, undefined, 'off contributes nothing an older engine would trip on');
	const parked = m._daemonEnv(rec({ guardianServe: true, onchainOnly: true }), PATHS, 's', 't');
	assert.equal(parked.BEIGNET_GUARDIAN_SERVE, undefined, 'no listener, no guardian');
});
