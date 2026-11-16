'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * An asset channel is enforced by the wallet's assets host, with its
 * Lightning side on. An edit that would take that away (on-chain only, a
 * channel backup kept by guardians, assets off) is refused while the wallet
 * still has one, in words that say what to do, and leaves the record alone.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');

const K = (c) => c.repeat(64);
const G = [`${K('a')}@http://127.0.0.1:8101`, `${K('b')}@http://127.0.0.1:8102`, `${K('c')}@https://g.example`];

function managerWith({ records, channels = [], supported = true, running = true }) {
	const m = Object.create(WalletManager.prototype);
	const data = { defaultNetwork: 'regtest', defaultElectrum: null, recoveryGuardians: G };
	m.settings = { get: () => data, update: (patch) => Object.assign(data, patch) };
	m.engineVersion = '0.43.0';
	m.recoveryAutoApplySupported = true;
	m.assetsSupported = true;
	m.assetsModulesDir = '/opt/beignet/node_modules';
	m.assetChannelsSupported = supported;
	m.registry = {
		get: (id) => records[id],
		list: () => Object.values(records),
		upsert: (rec) => {
			records[rec.id] = rec;
		}
	};
	m.runtime = new Map();
	if (running) m.runtime.set('w1', { proc: { pid: 1 }, status: 'running', healthy: true, stopping: false });
	m._log = () => {};
	m._killProc = async () => {};
	m.startWallet = async () => {};
	m.onionAddress = () => null;
	m.torCircuitOk = null;
	m.asked = 0;
	m._liveAssetChannels = async () => {
		m.asked += 1;
		return channels === null ? null : channels.filter((c) => c !== 'CLOSED' && c !== 'FORCE_CLOSED').length;
	};
	return m;
}

const wallet = (extra = {}) => ({
	w1: { id: 'w1', name: 'w', network: 'regtest', electrum: {}, port: 3001, running: true, recovery: { mode: 'off', guardians: [] }, ...extra }
});

test('a wallet with an asset channel cannot be made on-chain only, put on a guardian backup, or have assets turned off', async () => {
	const records = wallet();
	const m = managerWith({ records, channels: ['NORMAL'] });
	const refused = async (patch, why) => {
		await assert.rejects(m.updateWallet('w1', { name: 'renamed', ...patch }), (err) => {
			assert.equal(err.code, 'ASSET_CHANNELS_OPEN');
			assert.equal(err.statusCode, 409);
			assert.equal(
				err.message,
				`This wallet has an asset channel open. ${why} Close it on the Channels tab first, and wait for the assets to be back on-chain.`
			);
			return true;
		});
		assert.equal(records.w1.name, 'w', 'the refused edit changed nothing');
	};
	await refused({ onchainOnly: true }, 'An on-chain only wallet cannot keep one.');
	await refused({ recoveryMode: 'async-remote' }, 'A channel backup kept by guardians does not cover asset channels.');
	await refused({ recoveryMode: 'quorum' }, 'A channel backup kept by guardians does not cover asset channels.');
	await refused({ assets: { enabled: false } }, 'Turning assets off would leave it with nothing to enforce it.');

	// Edits that keep asset Lightning are not held up, and the daemon is not even asked.
	m.asked = 0;
	assert.equal((await m.updateWallet('w1', { name: 'renamed' })).name, 'renamed');
	assert.equal((await m.updateWallet('w1', { recoveryMode: 'peer-storage' })).recovery.mode, 'peer-storage');
	assert.equal(m.asked, 0);
});

test('several channels are counted, and one that is opening or closing still counts', async () => {
	const m = managerWith({ records: wallet(), channels: ['OPENING', 'CLOSING', 'FORCE_CLOSING', 'CLOSED', 'FORCE_CLOSED'] });
	await assert.rejects(m.updateWallet('w1', { onchainOnly: true }), (err) => /^This wallet has 3 asset channels open\. .* Close them on the Channels tab first/.test(err.message));
});

test('a wallet whose asset channels are all over, or that never had asset Lightning, is edited as before', async () => {
	// Every channel closed and its assets home.
	let m = managerWith({ records: wallet(), channels: ['CLOSED', 'FORCE_CLOSED'] });
	assert.equal((await m.updateWallet('w1', { onchainOnly: true })).onchainOnly, true);

	// An install that cannot carry asset channels: nothing to ask.
	m = managerWith({ records: wallet(), channels: ['NORMAL'], supported: false });
	assert.equal((await m.updateWallet('w1', { recoveryMode: 'quorum' })).recovery.mode, 'quorum');
	assert.equal(m.asked, 0);

	// A wallet already on a guardian backup has no asset Lightning to lose.
	m = managerWith({ records: wallet({ recovery: { mode: 'async-remote', guardians: G } }), channels: ['NORMAL'] });
	assert.equal((await m.updateWallet('w1', { recoveryMode: 'quorum' })).recovery.mode, 'quorum');
	assert.equal(m.asked, 0);

	// A wallet that is not running cannot be asked. The engine is the one
	// that then refuses to start with a channel it has nothing to enforce.
	m = managerWith({ records: wallet({ running: false }), channels: ['NORMAL'], running: false });
	assert.equal((await m.updateWallet('w1', { onchainOnly: true })).onchainOnly, true);
	assert.equal(m.asked, 0);

	// An assets host that does not answer is not taken for "no channels" by
	// mistake: the answer is unknown, and the edit goes ahead as it would
	// for a wallet that is not running.
	m = managerWith({ records: wallet(), channels: null });
	assert.equal((await m.updateWallet('w1', { onchainOnly: true })).onchainOnly, true);
	assert.equal(m.asked, 1);
});
