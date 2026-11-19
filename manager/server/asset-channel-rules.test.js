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

test('a wallet that is stopped, or whose assets host does not answer, is held to what its host last said', async () => {
	// Stopped, with two asset channels on record from when it last ran.
	let m = managerWith({ records: wallet({ running: false, assetChannelsLive: 2 }), channels: ['NORMAL'], running: false });
	await assert.rejects(m.updateWallet('w1', { recoveryMode: 'quorum' }), (err) => {
		assert.equal(err.code, 'ASSET_CHANNELS_OPEN');
		assert.equal(
			err.message,
			'This wallet has 2 asset channels open. A channel backup kept by guardians does not cover asset channels. Close them on the Channels tab first, and wait for the assets to be back on-chain.'
		);
		return true;
	});
	assert.equal(m.asked, 0);
	// Running, and its assets host does not answer.
	m = managerWith({ records: wallet({ assetChannelsLive: 1 }), channels: null });
	await assert.rejects(m.updateWallet('w1', { onchainOnly: true }), { code: 'ASSET_CHANNELS_OPEN' });
	assert.equal(m.asked, 1);
	// A host that answers is believed over what was remembered.
	m = managerWith({ records: wallet({ assetChannelsLive: 1 }), channels: ['CLOSED'] });
	assert.equal((await m.updateWallet('w1', { onchainOnly: true })).onchainOnly, true);
});

test('the manager remembers how many asset channels a wallet has, and a host that cannot say changes nothing', () => {
	const records = wallet();
	const m = managerWith({ records });
	m.runtimeState = (id) => m.runtime.get(id);
	const status = (assetChannels) => ({ phase: 'ready', ready: true, holdsAssets: true, assetChannels });
	m._noteAssetsStatus('w1', status(2));
	assert.equal(records.w1.assetChannelsLive, 2);
	// Still starting, or a host from before it said so.
	m._noteAssetsStatus('w1', status(null));
	m._noteAssetsStatus('w1', { phase: 'ready', ready: true, holdsAssets: true });
	m._noteAssetsStatus('w1', status(-1));
	assert.equal(records.w1.assetChannelsLive, 2);
	m._noteAssetsStatus('w1', status(0));
	assert.equal(records.w1.assetChannelsLive, 0);
});

test('a wallet on a guardian backup whose assets host last listed an asset channel is not started, and says why', async () => {
	const start = (m) => WalletManager.prototype.startWallet.call(m, 'w1');
	const made = (extra, opts = {}) => {
		const records = wallet({ running: false, ...extra });
		const m = managerWith({ records, running: false, ...opts });
		m.runtime.set('w1', { proc: null, spawning: false, status: 'stopped', healthy: false, lastStartError: null });
		m.runtimeState = (id) => m.runtime.get(id);
		m.started = 0;
		m._startWalletLocked = async () => {
			m.started += 1;
		};
		m.logged = [];
		m._log = (id, line) => m.logged.push(line);
		return m;
	};
	const said =
		'This wallet has an asset channel open and is on a channel backup kept by guardians, which does not cover asset channels, so it was not started. Take it off the guardian backup, start it, and close the channel on the Channels tab. Once the assets are back on-chain it can go back on a guardian backup.';
	for (const mode of ['async-remote', 'quorum']) {
		const m = made({ recovery: { mode, guardians: G }, assetChannelsLive: 1 });
		await assert.rejects(start(m), (err) => {
			assert.deepEqual([err.code, err.statusCode, err.message], ['ASSET_CHANNELS_OPEN', 409, said]);
			return true;
		});
		// The daemon is never spawned, and the wallet says why it is not running.
		assert.equal(m.started, 0);
		const rt = m.runtime.get('w1');
		assert.deepEqual([rt.status, rt.lastStartError.code, rt.lastStartError.message, rt.spawning], ['stopped', 'ASSET_CHANNELS_OPEN', said, false]);
		assert.equal(m.logged.length, 1);
	}
	const several = made({ recovery: { mode: 'quorum', guardians: G }, assetChannelsLive: 3 });
	await assert.rejects(start(several), (err) => /^This wallet has 3 asset channels open .* close the channels on the Channels tab\./.test(err.message));

	// Started as before: no channel on record, a backup that covers them, or an install that cannot have one.
	for (const m of [
		made({ recovery: { mode: 'quorum', guardians: G }, assetChannelsLive: 0 }),
		made({ recovery: { mode: 'quorum', guardians: G } }),
		made({ recovery: { mode: 'peer-storage', guardians: [] }, assetChannelsLive: 3 }),
		made({ recovery: { mode: 'off', guardians: [] }, assetChannelsLive: 3 }),
		made({ recovery: { mode: 'quorum', guardians: G }, assetChannelsLive: 3 }, { supported: false })
	]) {
		await start(m);
		assert.equal(m.started, 1);
	}
});

test('what the engine refuses over asset channels at boot is said in the manager\'s words, from one table', () => {
	const m = managerWith({ records: wallet() });
	const failed = (error) => {
		const rt = { lastStartError: null };
		m._noteStartFailure(rt, JSON.stringify({ ok: false, error }));
		return rt.lastStartError;
	};
	const provider = failed({ code: 'ASSET_PROVIDER_REQUIRED', message: 'channel 03ab needs its auxiliary provider' });
	assert.equal(provider.code, 'ASSET_PROVIDER_REQUIRED');
	assert.equal(
		provider.message,
		'This wallet has an asset channel, and the assets part of the wallet did not come up, so the wallet was not started: an asset channel is never run unwatched. The channels and the assets in them are untouched. Start the wallet again with assets turned on.'
	);
	assert.equal(provider.message.includes('03ab'), false);
	// The assets part coming up twice, or failing as it starts, is said as that, with the same way forward.
	const way = /so the wallet was not started: an asset channel is never run unwatched\. The channels and the assets in them are untouched\. Start the wallet again with assets turned on\.$/;
	const twice = failed({ code: 'ASSET_PROVIDER_CONFLICT', message: 'two providers registered' });
	assert.match(twice.message, /the assets part of the wallet came up twice, /);
	assert.match(twice.message, way);
	const broke = failed({ code: 'ASSET_PROVIDER_FAILED', message: 'provider threw: ENOENT /data/x' });
	assert.match(broke.message, /the assets part of the wallet failed while it was starting, /);
	assert.match(broke.message, way);
	assert.equal(broke.message.includes('ENOENT'), false);
	// The daemon's own refusal of a wallet on a guardian backup: the advice of the manager's own.
	const guarded = failed({ code: 'ASSET_GUARDIAN_START_REFUSED', message: 'auxiliary channels and guardian recovery' });
	assert.equal(guarded.code, 'ASSET_GUARDIAN_START_REFUSED');
	assert.match(guarded.message, /is on a channel backup kept by guardians, which does not cover asset channels, so it was not started and nothing was sent to the guardians\./);
	assert.match(guarded.message, /Take it off the guardian backup, start it, and close the channel on the Channels tab\. Once the assets are back on-chain it can go back on a guardian backup\.$/);
	// Named only in the text of a failed start.
	const restore = failed({ code: 'START_FAILED', message: 'restore refused: ASSET_RESTORE_REFUSED (2 channels)' });
	assert.equal(restore.code, 'ASSET_RESTORE_REFUSED');
	assert.match(restore.message, /holds an asset channel, which a restore does not bring back, so nothing was restored and nothing was written\. The wallet is as it was\.$/);
	const fromGuardians = failed({ code: 'AUXILIARY_GUARDIAN_RESTORE_REFUSED', message: 'no' });
	assert.equal(fromGuardians.code, 'AUXILIARY_GUARDIAN_RESTORE_REFUSED');
	assert.match(fromGuardians.message, /The channel state the guardians keep for this wallet holds an asset channel, which a guardian backup does not cover, so nothing was restored and nothing was written\./);
	// Any other failed start is kept as the daemon wrote it.
	assert.equal(failed({ code: 'START_FAILED', message: 'Another beignet instance is already using this directory' }).message, 'Another beignet instance is already using this directory');
	assert.equal(failed({ code: 'SOMETHING_ELSE', message: 'no' }), null);
});

test("how many asset channels a running wallet has is its host's own count, the one its status gives, and not a count of rows", async () => {
	const http = require('node:http');
	let said = { result: { assetChannels: 1 } };
	let code = 200;
	const asked = [];
	const server = http.createServer((req, res) => {
		asked.push([req.url, req.headers.authorization]);
		res.statusCode = req.url === '/x/assets/status' ? code : 200;
		res.setHeader('content-type', 'application/json');
		// The list has no row at all, and one the manager's own words would have counted wrongly.
		res.end(JSON.stringify(req.url === '/x/assets/status' ? said : { result: { channels: [] } }));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const m = Object.create(WalletManager.prototype);
		m.token = () => 'tok';
		const rec = { id: 'w1', port: server.address().port };
		assert.equal(await m._liveAssetChannels(rec), 1);
		assert.deepEqual(asked, [['/x/assets/status', 'Bearer tok']]);
		said = { result: { assetChannels: 0 } };
		assert.equal(await m._liveAssetChannels(rec), 0);
		// A host that cannot say, or does not answer, is not a host with none.
		for (const cannot of [{ result: { assetChannels: null } }, { result: {} }, { result: { assetChannels: -1 } }, {}]) {
			said = cannot;
			assert.equal(await m._liveAssetChannels(rec), null);
		}
		said = { result: { assetChannels: 2 } };
		code = 503;
		assert.equal(await m._liveAssetChannels(rec), null);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
	assert.equal(await Object.assign(Object.create(WalletManager.prototype), { token: () => 'tok' })._liveAssetChannels({ id: 'w1', port: 1 }), null);
});
