'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * The manager's own rules for channel backup, the ones a refused daemon
 * start would otherwise teach the user through a restart loop: a guardian
 * set is three entries or none, a wallet pins the set it first registers
 * with, and strict quorum is never left once entered.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');
const { validateGuardianSet, parseGuardianEntry, sameGuardianSet, recoveryEnv } = require('./recovery');

const K = (c) => c.repeat(64);
const G = [`${K('a')}@http://127.0.0.1:8101`, `${K('b')}@http://127.0.0.1:8102`, `${K('c')}@https://g.example`];
const OTHER = [`${K('d')}@http://127.0.0.1:8201`, `${K('e')}@http://127.0.0.1:8202`, `${K('f')}@https://h.example`];

function managerWith({ guardians = [], engine = '0.9.2', records = {}, autoApply = true } = {}) {
	const m = Object.create(WalletManager.prototype);
	const data = { defaultNetwork: 'regtest', defaultElectrum: null, recoveryGuardians: guardians };
	m.settings = {
		get: () => data,
		update: (patch) => Object.assign(data, patch)
	};
	m.engineVersion = engine;
	m.recoveryAutoApplySupported = autoApply;
	m.registry = {
		get: (id) => records[id],
		list: () => Object.values(records),
		upsert: (rec) => {
			records[rec.id] = rec;
		}
	};
	m.runtime = new Map();
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	m._killProc = async () => {};
	m.startWallet = async () => {};
	m.onionAddress = () => null;
	m.torCircuitOk = null;
	return m;
}

const rejects = (fn, code) => {
	try {
		fn();
	} catch (err) {
		assert.equal(err.code, code, err.message);
		return err;
	}
	assert.fail(`expected ${code}`);
};

test('guardian entries are pubkey@url with an http(s) URL', () => {
	assert.equal(parseGuardianEntry(` ${K('A')}@http://127.0.0.1:8101 `).pubkey, K('a'));
	assert.throws(() => parseGuardianEntry(`${K('a')}http://x`), /separator/);
	assert.throws(() => parseGuardianEntry(`abc@http://x`), /64-hex/);
	assert.throws(() => parseGuardianEntry(`${K('a')}@not a url`), /not a valid URL/);
	assert.throws(() => parseGuardianEntry(`${K('a')}@ftp://x`), /http or https/);
});

test('a guardian set is three distinct entries or none', () => {
	assert.deepEqual(validateGuardianSet([]), []);
	assert.deepEqual(validateGuardianSet(['', ' ']), [], 'blank entries are no entries');
	assert.equal(validateGuardianSet(G).length, 3);
	assert.throws(() => validateGuardianSet(G.slice(0, 2)), /exactly 3/);
	assert.throws(() => validateGuardianSet([G[0], G[0], G[1]]), /distinct/);
	assert.throws(() => validateGuardianSet('nope'), /list/);
	assert.ok(sameGuardianSet(G, [G[2], G[0], G[1]]), 'order does not make a different set');
	assert.ok(!sameGuardianSet(G, OTHER));
});

test('recoveryEnv is empty for off and whole for a guardian mode', () => {
	assert.deepEqual(recoveryEnv(undefined), {});
	assert.deepEqual(recoveryEnv({ mode: 'off' }), {});
	assert.deepEqual(recoveryEnv({ mode: 'peer-storage' }), { BEIGNET_RECOVERY_MODE: 'peer-storage' });
	assert.deepEqual(
		recoveryEnv({ mode: 'peer-storage', autoApply: true }),
		{ BEIGNET_RECOVERY_MODE: 'peer-storage', BEIGNET_RECOVERY_AUTO_APPLY: 'true' },
		'the automatic checkpoint restore rides only with peer storage'
	);
	assert.equal(recoveryEnv({ mode: 'quorum', guardians: G, autoApply: true }).BEIGNET_RECOVERY_AUTO_APPLY, undefined);
	assert.equal(recoveryEnv({ mode: 'off', autoApply: true }).BEIGNET_RECOVERY_AUTO_APPLY, undefined);
	assert.deepEqual(recoveryEnv({ mode: 'async-remote', guardians: G }), {
		BEIGNET_RECOVERY_MODE: 'async-remote',
		BEIGNET_RECOVERY_GUARDIANS: G.join(','),
		BEIGNET_RECOVERY_PROFILE: 'crash-v1'
	});
});

test('settings accept a full set, refuse a partial or malformed one, and clear on empty', () => {
	const m = managerWith();
	assert.deepEqual(m.updateSettings({ recoveryGuardians: G }).recoveryGuardians, G);
	rejects(() => m.updateSettings({ recoveryGuardians: G.slice(0, 2) }), 'BAD_GUARDIANS');
	rejects(() => m.updateSettings({ recoveryGuardians: [G[0], G[1], 'junk'] }), 'BAD_GUARDIANS');
	assert.deepEqual(m.getSettings().recoveryGuardians, G, 'a refused patch leaves the set alone');
	assert.deepEqual(m.updateSettings({ recoveryGuardians: [] }).recoveryGuardians, []);
	assert.deepEqual(m.updateSettings({ recoveryGuardians: null }).recoveryGuardians, []);
});

test('an unknown mode, an old engine, and a guardian mode with no set are refused', () => {
	rejects(() => managerWith()._normalizeRecovery('sometimes', null), 'BAD_RECOVERY_MODE');
	rejects(() => managerWith({ engine: '0.9.0' })._normalizeRecovery('peer-storage', null), 'RECOVERY_UNSUPPORTED');
	rejects(() => managerWith({ engine: null })._normalizeRecovery('quorum', null), 'RECOVERY_UNSUPPORTED');
	rejects(() => managerWith()._normalizeRecovery('quorum', null), 'NO_GUARDIANS');
	assert.deepEqual(managerWith({ engine: '0.9.0' })._normalizeRecovery('off', null), {
		mode: 'off',
		guardians: []
	});
	assert.deepEqual(managerWith()._normalizeRecovery(undefined, { mode: "peer-storage", guardians: [] }), {
		mode: 'peer-storage',
		guardians: []
	}, 'no mode in the patch keeps what the record has');
});

test('a wallet pins the set it first enables with and keeps it afterwards', async () => {
	const records = {
		w1: { id: 'w1', name: 'w', network: 'regtest', electrum: {}, running: false, recovery: { mode: 'off', guardians: [] } }
	};
	const m = managerWith({ guardians: G, records });
	let rec = await m.updateWallet('w1', { recoveryMode: 'async-remote' });
	assert.deepEqual(rec.recovery, { mode: 'async-remote', guardians: G, autoApply: false });
	// Settings move on; the wallet does not.
	m.updateSettings({ recoveryGuardians: OTHER });
	rec = await m.updateWallet('w1', { recoveryMode: 'quorum' });
	assert.deepEqual(rec.recovery, { mode: 'quorum', guardians: G, autoApply: false }, 'the pinned set rides into quorum');
	rec = await m.updateWallet('w1', { name: 'renamed' });
	assert.deepEqual(rec.recovery, { mode: 'quorum', guardians: G, autoApply: false }, 'a patch without a mode changes nothing');
});

test('leaving quorum is refused, and the record is untouched by a refused edit', async () => {
	const records = {
		w1: { id: 'w1', name: 'w', network: 'regtest', electrum: {}, running: false, recovery: { mode: 'quorum', guardians: G } }
	};
	const m = managerWith({ guardians: G, records });
	await assert.rejects(m.updateWallet('w1', { name: 'x', recoveryMode: 'async-remote' }), (err) => err.code === 'RECOVERY_QUORUM_STICKY');
	await assert.rejects(m.updateWallet('w1', { recoveryMode: 'off' }), (err) => err.code === 'RECOVERY_QUORUM_STICKY');
	assert.equal(records.w1.name, 'w', 'the rename in the refused patch did not land');
	const rec = await m.updateWallet('w1', { recoveryMode: 'quorum', onchainOnly: true });
	assert.deepEqual(rec.recovery, { mode: 'quorum', guardians: G, autoApply: false }, 'parking keeps the barrier config');
	assert.equal(rec.onchainOnly, true);
});

test('an edit mid-restore is refused; an edit while merely holding is not', async () => {
	const records = {
		w1: { id: 'w1', name: 'w', network: 'regtest', electrum: {}, port: 3001, running: true, recovery: { mode: 'quorum', guardians: G } }
	};
	const m = managerWith({ guardians: G, records });
	m.runtime.set('w1', { proc: { pid: 1 }, status: 'restore-required', healthy: false, stopping: false });
	m._restoreInFlight = async () => true;
	await assert.rejects(m.updateWallet('w1', { name: 'x' }), (err) => err.code === 'RESTORE_IN_PROGRESS');
	m._restoreInFlight = async () => false;
	const rec = await m.updateWallet('w1', { name: 'x' });
	assert.equal(rec.name, 'x');
});

test('the automatic checkpoint restore is a peer-storage answer, kept until the mode leaves peer storage', async () => {
	const records = {
		w1: { id: 'w1', name: 'w', network: 'regtest', electrum: {}, running: false, recovery: { mode: 'off', guardians: [] } }
	};
	const m = managerWith({ guardians: G, records });
	assert.deepEqual(m._normalizeRecovery('peer-storage', null, true), { mode: 'peer-storage', guardians: [], autoApply: true });
	assert.deepEqual(m._normalizeRecovery('peer-storage', null, false), { mode: 'peer-storage', guardians: [] });
	assert.deepEqual(m._normalizeRecovery('off', null, true), { mode: 'off', guardians: [] }, 'dropped outside peer storage');
	assert.deepEqual(m._normalizeRecovery('quorum', null, true), { mode: 'quorum', guardians: G });
	let rec = await m.updateWallet('w1', { recoveryMode: 'peer-storage', recoveryAutoApply: true });
	assert.deepEqual(rec.recovery, { mode: 'peer-storage', guardians: [], autoApply: true });
	rec = await m.updateWallet('w1', { name: 'renamed' });
	assert.equal(rec.recovery.autoApply, true, 'a patch that says nothing keeps the answer');
	rec = await m.updateWallet('w1', { recoveryAutoApply: false });
	assert.equal(rec.recovery.autoApply, false, 'and the answer can be withdrawn');
	rec = await m.updateWallet('w1', { recoveryAutoApply: true });
	rec = await m.updateWallet('w1', { recoveryMode: 'async-remote' });
	assert.equal(rec.recovery.autoApply, false, 'leaving peer storage drops it');
	rec = await m.updateWallet('w1', { recoveryMode: 'peer-storage' });
	assert.equal(rec.recovery.autoApply, false, 'and coming back does not resurrect it');
});

test('an engine that cannot apply a checkpoint by itself refuses the answer rather than losing it', () => {
	const m = managerWith({ autoApply: false });
	rejects(() => m._normalizeRecovery('peer-storage', null, true), 'RECOVERY_AUTO_APPLY_UNSUPPORTED');
	assert.deepEqual(m._normalizeRecovery('peer-storage', null, false), { mode: 'peer-storage', guardians: [] });
	assert.deepEqual(
		m._normalizeRecovery(undefined, { mode: 'peer-storage', guardians: [], autoApply: true }),
		{ mode: 'peer-storage', guardians: [], autoApply: true },
		'a record that already carries it keeps it; only a fresh request is refused'
	);
});
