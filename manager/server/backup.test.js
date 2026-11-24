'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * The backup archive is the only way the half of a wallet that is not on the
 * chain (its seed, its API token, its record, the app's settings) leaves the
 * box. So the round trip is the test: export a data dir, wipe it, restore,
 * and the secrets are the same bytes with the same modes, the records are the
 * same records, and nothing has been started. The two refusals matter as
 * much: a wrong passphrase must fail cleanly rather than half-restore, and a
 * seed already running here must not quietly start running twice.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// config reads DATA_DIR once, at require time, and wallet-manager reads
// config: the temp box has to exist before either is loaded.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-backup-'));
process.env.DATA_DIR = DATA_DIR;

const { WalletManager } = require('./wallet-manager');
const {
	backupStale,
	buildPayload,
	openArchive,
	payloadFiles,
	payloadRegistry,
	sealWithinLimit,
	MAX_ARCHIVE_BYTES,
	RESTORE_BODY_LIMIT_BYTES
} = require('./backup');

const PASSPHRASE = 'a good long passphrase';

const SEED_A =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEED_B =
	'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

/** The export and restore paths both narrate themselves; tests do not need it. */
async function quiet(fn) {
	const write = process.stdout.write;
	const log = console.log;
	// The manager's log lines are text. Under `node --test` this file's results
	// travel to the runner as binary frames on the same stream, and a result
	// written while a later test is being quiet must still get through.
	process.stdout.write = (chunk, ...rest) => (typeof chunk === 'string' ? true : write.call(process.stdout, chunk, ...rest));
	console.log = () => {};
	try {
		return await fn();
	} finally {
		process.stdout.write = write;
		console.log = log;
	}
}

function wipe() {
	for (const entry of fs.readdirSync(DATA_DIR)) {
		fs.rmSync(path.join(DATA_DIR, entry), { recursive: true, force: true });
	}
}

/** A wallet on disk exactly as _provision leaves one: record, seed, token. */
function seedWallet({ id, name, port, mnemonic, nodeId = null, extra = {} }) {
	const base = path.join(DATA_DIR, 'wallets', id);
	fs.mkdirSync(path.join(base, 'home'), { recursive: true });
	fs.mkdirSync(path.join(base, 'data'), { recursive: true });
	fs.mkdirSync(path.join(base, 'secrets'), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(base, 'secrets', 'mnemonic'), mnemonic, { mode: 0o600 });
	fs.writeFileSync(path.join(base, 'secrets', 'api_token'), crypto.randomBytes(32).toString('hex'), {
		mode: 0o600
	});
	return {
		id,
		name,
		network: 'regtest',
		electrum: { host: '10.21.21.10', port: 50001, tls: false },
		networkMode: 'hybrid',
		announce: false,
		onchainOnly: false,
		recovery: { mode: 'off', guardians: [] },
		guardianServe: false,
		lfbw: null,
		liquidityProvider: false,
		port,
		running: true,
		nodeId,
		createdAt: '2026-09-01T00:00:00.000Z',
		...extra
	};
}

function writeRegistry(records) {
	fs.writeFileSync(path.join(DATA_DIR, 'registry.json'), JSON.stringify(records, null, 2));
}

function writeSettings(settings) {
	fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify(settings, null, 2));
}

function manager() {
	const m = new WalletManager();
	m.settings.load();
	m.registry.load();
	return m;
}

const secretsOf = (id) => ({
	mnemonic: fs.readFileSync(path.join(DATA_DIR, 'wallets', id, 'secrets', 'mnemonic')),
	token: fs.readFileSync(path.join(DATA_DIR, 'wallets', id, 'secrets', 'api_token'))
});
const modeOf = (file) => fs.statSync(file).mode & 0o777;

const GUARDIANS = ['1'.repeat(64) + '@https://g1.example/', '2'.repeat(64) + '@https://g2.example/'];

function twoWalletBox() {
	wipe();
	const a = seedWallet({ id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Spending', port: 3101, mnemonic: SEED_A, nodeId: '02' + 'ab'.repeat(32) });
	const b = seedWallet({
		id: 'bbbbbbbb-0000-4000-8000-000000000002',
		name: 'Savings',
		port: 3102,
		mnemonic: SEED_B,
		extra: { onchainOnly: true, running: false }
	});
	writeRegistry([a, b]);
	writeSettings({
		defaultNetwork: 'regtest',
		defaultElectrum: { host: '10.21.21.10', port: 50001, tls: false },
		recoveryGuardians: GUARDIANS,
		lastBackupAt: null
	});
	return { a, b };
}

test('a box round-trips: export, wipe, restore, and the secrets are the same bytes with the same modes', async () => {
	const { a, b } = twoWalletBox();
	const before = { [a.id]: secretsOf(a.id), [b.id]: secretsOf(b.id) };
	const registryBytes = fs.readFileSync(path.join(DATA_DIR, 'registry.json'));

	const out = await quiet(() => manager().exportBackup({ passphrase: PASSPHRASE }));
	assert.equal(out.walletCount, 2);
	assert.match(out.filename, /^beignet-backup-.*\.beignet$/);

	// The archive carries the files themselves, not a re-serialization of them.
	const files = payloadFiles(openArchive(out.archive, PASSPHRASE));
	assert.deepEqual(files.get('registry.json').data, registryBytes);
	assert.deepEqual(files.get(`wallets/${a.id}/secrets/mnemonic`).data, before[a.id].mnemonic);
	assert.equal(files.get(`wallets/${a.id}/secrets/mnemonic`).mode, 0o600);
	assert.equal(payloadRegistry(files).length, 2);
	// Nothing from data/ is in it: that is the recovery protocol's job.
	assert.equal([...files.keys()].some((k) => k.includes('/data/')), false);

	// Exporting is what makes a wallet count as backed up.
	const stamped = manager();
	assert.equal(stamped.publicRecord(a.id).lastBackupAt, out.createdAt);
	assert.equal(stamped.publicRecord(a.id).backupStale, false);
	assert.equal(stamped.getSettings().lastBackupAt, out.createdAt);

	wipe();
	const fresh = manager();
	assert.equal(fresh.list().length, 0);
	const result = await quiet(() =>
		fresh.restoreBackup({ passphrase: PASSPHRASE, archive: out.archive.toString('base64') })
	);
	assert.deepEqual(result.restored.map((w) => w.name).sort(), ['Savings', 'Spending']);
	assert.equal(result.settings, true);

	for (const rec of [a, b]) {
		const got = secretsOf(rec.id);
		assert.deepEqual(got.mnemonic, before[rec.id].mnemonic, `${rec.name} seed is the same bytes`);
		assert.deepEqual(got.token, before[rec.id].token, `${rec.name} token is the same bytes`);
		assert.equal(modeOf(path.join(DATA_DIR, 'wallets', rec.id, 'secrets', 'mnemonic')), 0o600);
		assert.equal(modeOf(path.join(DATA_DIR, 'wallets', rec.id, 'secrets', 'api_token')), 0o600);
	}

	// The records come back as they were, but stopped: a restore starts
	// nothing, and every wallet counts as backed up as of the archive.
	const restored = manager();
	for (const rec of [a, b]) {
		const got = restored.registry.get(rec.id);
		assert.deepEqual(got, { ...rec, running: false, lastBackupAt: out.createdAt });
		assert.equal(restored.publicRecord(rec.id).desiredRunning, false);
		assert.equal(restored.publicRecord(rec.id).backupStale, false);
	}
	// The app defaults are back too: a guardian-mode wallet cannot start
	// without the set, and the set lives here rather than on the record.
	assert.deepEqual(restored.getSettings().recoveryGuardians, GUARDIANS);
	assert.deepEqual(restored.getSettings().defaultElectrum, { host: '10.21.21.10', port: 50001, tls: false });
	// The daemon needs its directories, which no longer come from a create.
	for (const rec of [a, b]) {
		assert.ok(fs.existsSync(path.join(DATA_DIR, 'wallets', rec.id, 'data')));
		assert.ok(fs.existsSync(path.join(DATA_DIR, 'wallets', rec.id, 'home')));
	}
});

test('a wrong passphrase fails cleanly and writes nothing', async () => {
	const { a } = twoWalletBox();
	const out = await quiet(() => manager().exportBackup({ passphrase: PASSPHRASE }));
	wipe();
	const fresh = manager();
	assert.throws(
		() => fresh.restoreBackup({ passphrase: 'not the passphrase', archive: out.archive.toString('base64') }),
		(err) => err.code === 'BAD_PASSPHRASE' && err.statusCode === 400
	);
	assert.equal(fresh.list().length, 0);
	assert.equal(fs.existsSync(path.join(DATA_DIR, 'wallets', a.id)), false);
	// A file that is not one of ours says so rather than blaming the passphrase.
	assert.throws(
		() => fresh.restoreBackup({ passphrase: PASSPHRASE, archive: Buffer.from('hello there, not an archive').toString('base64') }),
		(err) => err.code === 'BAD_ARCHIVE'
	);
	// A header asking for more work than the app ever writes is refused
	// before scrypt is asked for it: logN, r and p sit at 16, 17 and 18,
	// after the 14-byte magic and the format and kdf bytes.
	const greedy = Buffer.from(out.archive);
	greedy.set([18, 255, 255], 16);
	assert.throws(
		() => fresh.restoreBackup({ passphrase: PASSPHRASE, archive: greedy.toString('base64') }),
		(err) => err.code === 'BAD_ARCHIVE'
	);
});

test('a passphrase too short to be worth typing is refused before anything is read', async () => {
	twoWalletBox();
	await assert.rejects(
		() => manager().exportBackup({ passphrase: 'short' }),
		(err) => err.code === 'WEAK_PASSPHRASE' && err.statusCode === 400
	);
	assert.equal(manager().getSettings().lastBackupAt, null, 'a refused export claims no backup');
});

test('settings that could not be read are not replaced by the export that would archive them', async () => {
	twoWalletBox();
	// Truncated, and holding a guardian set that exists nowhere else.
	const corrupt = `{"defaultNetwork":"regtest","recoveryGuardians":["${GUARDIANS[0]}"`;
	fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), corrupt);
	const error = console.error;
	console.error = () => {};
	let m;
	try {
		m = manager();
	} finally {
		console.error = error;
	}
	await assert.rejects(
		() => m.exportBackup({ passphrase: PASSPHRASE }),
		(err) => err.code === 'SETTINGS_UNREADABLE' && err.statusCode === 409
	);
	assert.equal(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'), corrupt);
});

test('a wallet whose node id is already here is refused until it is confirmed', async () => {
	const { a, b } = twoWalletBox();
	const out = await quiet(() => manager().exportBackup({ passphrase: PASSPHRASE }));
	const archive = out.archive.toString('base64');

	// A fresh box holding the same seed under another record: the same node,
	// twice, which is how channels get lost.
	wipe();
	const twin = seedWallet({
		id: 'cccccccc-0000-4000-8000-000000000003',
		name: 'The same node under another name',
		port: 3101,
		mnemonic: SEED_A
	});
	writeRegistry([twin]);
	const m = manager();

	const preview = m.inspectBackup({ passphrase: PASSPHRASE, archive });
	assert.equal(preview.conflicts.length, 1);
	assert.equal(preview.conflicts[0].id, a.id);
	assert.deepEqual(preview.conflicts[0].duplicateOf, { id: twin.id, name: twin.name });
	assert.equal(preview.wallets.find((w) => w.id === b.id).duplicateOf, null);

	assert.throws(
		() => m.restoreBackup({ passphrase: PASSPHRASE, archive }),
		(err) => err.code === 'DUPLICATE_NODE_ID' && err.statusCode === 409 && err.details.conflicts.length === 1
	);
	assert.equal(m.registry.get(a.id), undefined, 'nothing was written, not even the wallet with no conflict');

	const result = await quiet(() => m.restoreBackup({ passphrase: PASSPHRASE, archive, confirm: true }));
	assert.deepEqual(result.restored.map((w) => w.id).sort(), [a.id, b.id].sort());
	// The wallet already here kept its port; the restored twin was moved off it.
	assert.equal(manager().registry.get(twin.id).port, 3101);
	assert.notEqual(manager().registry.get(a.id).port, 3101);
});

test('two records on one seed inside one archive are the same conflict', async () => {
	// A box can hold the same seed twice (importing it twice is allowed), so
	// its archive can too; restoring both silently would leave the new box in
	// the state the confirm exists to stop.
	wipe();
	const one = seedWallet({ id: 'dddddddd-0000-4000-8000-000000000004', name: 'Spending', port: 3101, mnemonic: SEED_A });
	const two = seedWallet({ id: 'eeeeeeee-0000-4000-8000-000000000005', name: 'The same seed again', port: 3102, mnemonic: SEED_A });
	writeRegistry([one, two]);
	const out = await quiet(() => manager().exportBackup({ passphrase: PASSPHRASE }));
	const archive = out.archive.toString('base64');

	wipe();
	const m = manager();
	const preview = m.inspectBackup({ passphrase: PASSPHRASE, archive });
	assert.equal(preview.conflicts.length, 1);
	assert.equal(preview.conflicts[0].id, two.id);
	assert.deepEqual(preview.conflicts[0].duplicateOf, { id: one.id, name: one.name });

	assert.throws(
		() => m.restoreBackup({ passphrase: PASSPHRASE, archive }),
		(err) => err.code === 'DUPLICATE_NODE_ID' && err.statusCode === 409
	);
	assert.equal(m.list().length, 0);
	const result = await quiet(() => m.restoreBackup({ passphrase: PASSPHRASE, archive, confirm: true }));
	assert.equal(result.restored.length, 2);
});

test('an archive naming a network this app does not run is refused before anything is written', async () => {
	// The record is written to the registry as the archive states it, and the
	// network names the instance lock file the daemon writes beside its data.
	wipe();
	const rogue = seedWallet({ id: 'ffffffff-0000-4000-8000-000000000006', name: 'Rogue', port: 3105, mnemonic: SEED_B });
	writeRegistry([{ ...rogue, network: '../../../victim' }]);
	const out = await quiet(() => manager().exportBackup({ passphrase: PASSPHRASE }));

	wipe();
	const m = manager();
	assert.throws(
		() => m.restoreBackup({ passphrase: PASSPHRASE, archive: out.archive.toString('base64') }),
		(err) => err.code === 'BAD_NETWORK' && err.statusCode === 400
	);
	assert.equal(m.list().length, 0);
	assert.equal(fs.existsSync(path.join(DATA_DIR, 'wallets', rogue.id)), false);
});

test('a wallet already here under the same id is left exactly as it is', async () => {
	const { a, b } = twoWalletBox();
	const out = await quiet(() => manager().exportBackup({ passphrase: PASSPHRASE }));
	// Wallet A stays, with an edit the archive predates; B is gone.
	const kept = manager();
	// Stamped after the export it is compared with, not on a calendar date the
	// clock will one day pass.
	const editedAt = new Date(Date.parse(out.createdAt) + 60_000).toISOString();
	const edited = { ...kept.registry.get(a.id), name: 'Renamed since the backup', updatedAt: editedAt };
	writeRegistry([edited]);
	fs.rmSync(path.join(DATA_DIR, 'wallets', b.id), { recursive: true, force: true });

	const m = manager();
	assert.equal(m.publicRecord(a.id).backupStale, true, 'an edit since the export asks for a new one');
	const result = await quiet(() =>
		m.restoreBackup({ passphrase: PASSPHRASE, archive: out.archive.toString('base64') })
	);
	assert.deepEqual(result.restored.map((w) => w.id), [b.id]);
	assert.deepEqual(result.skipped.map((w) => [w.id, w.action]), [[a.id, 'present']]);
	assert.equal(manager().registry.get(a.id).name, 'Renamed since the backup');
});

test('the assets file an archive asks for does not make that archive stale', async () => {
	const { a } = twoWalletBox();
	writeRegistry([{ ...a, assetsHeld: true }]);
	const m = manager();
	const dir = path.join(DATA_DIR, 'wallets', a.id, 'assets');
	// A running wallet whose assets changed a moment ago: the archive asks
	// its host to write the file, and the host's word that it did reaches the
	// manager only after the archive is made.
	m.runtimeState(a.id).proc = {};
	m.runtimeState(a.id).healthy = true;
	m.runtimeState(a.id).spawnedEnv = { BEIGNET_EXTENSIONS: '/x' };
	let written = 0;
	m._daemonCall = async (rec, method, route) => {
		assert.equal(route, '/x/assets/backup/export');
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(dir, 'backup.json'), '{"rows":[]}', { mode: 0o600 });
		written = Date.now();
		await new Promise((r) => setTimeout(r, 5));
		return { exportedAt: written, changed: true };
	};
	const out = await quiet(() => m.exportBackup({ passphrase: PASSPHRASE }));
	assert.ok(Date.parse(out.createdAt) >= written, 'the archive is stamped after the file it carries');
	m._onAssetsEvent(a.id, 'assets:backup', { exportedAt: written, dirty: false, changed: true });
	assert.equal(m.publicRecord(a.id).backupStale, false);
	// A file written after the archive is a change the archive does not hold.
	m._onAssetsEvent(a.id, 'assets:backup', { exportedAt: Date.parse(out.createdAt) + 1000, dirty: false, changed: true });
	assert.equal(m.publicRecord(a.id).backupStale, true);
});

test("a wallet's assets ride in the archive and wait for its assets host after a restore", async () => {
	const { a, b } = twoWalletBox();
	const blob = Buffer.from(JSON.stringify({ v: 1, network: 'regtest', rows: [['assets/x', 'y']] }));
	const dir = path.join(DATA_DIR, 'wallets', a.id, 'assets');
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(dir, 'backup.json'), blob, { mode: 0o600 });
	// Not part of a backup: only the one file is.
	fs.writeFileSync(path.join(dir, 'pending-import.json.imported'), 'old');
	writeRegistry([{ ...a, assetsHeld: true }, { ...b, assetsHeld: true }]);

	const out = await quiet(() => manager().exportBackup({ passphrase: PASSPHRASE }));
	const files = payloadFiles(openArchive(out.archive, PASSPHRASE));
	assert.deepEqual(files.get(`wallets/${a.id}/assets/backup.json`).data, blob);
	assert.equal([...files.keys()].filter((k) => k.includes('/assets/')).length, 1);
	// The other wallet holds assets and has no file: the archive says so.
	assert.deepEqual(out.assetsMissing, [{ id: b.id, name: 'Savings', reason: 'no-file' }]);
	// And each record keeps saying it after the download is gone.
	assert.equal(manager().publicRecord(a.id).assets.notArchived, null);
	assert.equal(manager().publicRecord(a.id).assets.backupFile, true);
	assert.equal(manager().publicRecord(b.id).assets.notArchived, 'no-file');
	assert.equal(manager().publicRecord(b.id).assets.backupFile, false);

	wipe();
	await quiet(() => manager().restoreBackup({ passphrase: PASSPHRASE, archive: out.archive.toString('base64') }));
	const pending = path.join(DATA_DIR, 'wallets', a.id, 'assets', 'pending-import.json');
	assert.deepEqual(fs.readFileSync(pending), blob);
	assert.equal(modeOf(pending), 0o600);
	assert.equal(modeOf(path.dirname(pending)), 0o700);
	// It waits for the host; it is not put back as if it had been imported.
	assert.equal(fs.existsSync(path.join(DATA_DIR, 'wallets', a.id, 'assets', 'backup.json')), false);
	assert.equal(fs.existsSync(path.join(DATA_DIR, 'wallets', b.id, 'assets')), false);
	assert.equal(manager().publicRecord(a.id).assets.holdsAssets, true);
});

test('Porch set by hand in config.json, proxy and token included, comes back from a restore as it was', async () => {
	const { a } = twoWalletBox();
	const native = path.join(DATA_DIR, 'wallets', a.id, 'home', '.beignet', 'config.json');
	fs.mkdirSync(path.dirname(native), { recursive: true });
	const hand = JSON.stringify({ porchRelays: ['wss://relay.example'], porchToken: 'hand-set', porchProxy: '10.21.21.11:9050' });
	fs.writeFileSync(native, hand, { mode: 0o600 });
	const m = manager();
	m.porchSupported = true;
	const out = await quiet(() => m.exportBackup({ passphrase: PASSPHRASE }));
	// Exporting takes nothing over, so a later edit to the file still counts.
	assert.equal(manager().registry.get(a.id).porch, undefined);

	wipe();
	const fresh = manager();
	fresh.porchSupported = true;
	await quiet(() => fresh.restoreBackup({ passphrase: PASSPHRASE, archive: out.archive.toString('base64') }));
	assert.equal(fs.readFileSync(native, 'utf8'), hand);
	assert.equal(modeOf(native), 0o600);
	const state = fresh._porchState(fresh.registry.get(a.id));
	assert.equal(state.source, 'native');
	assert.deepEqual(state.tokens, { 'wss://relay.example': 'hand-set' });
});

test('a restore without a config file drops relays a deleted wallet left behind, and keeps its other keys', async () => {
	const { a } = twoWalletBox();
	const out = await quiet(() => manager().exportBackup({ passphrase: PASSPHRASE }));
	const native = path.join(DATA_DIR, 'wallets', a.id, 'home', '.beignet', 'config.json');
	fs.mkdirSync(path.dirname(native), { recursive: true });
	fs.writeFileSync(native, JSON.stringify({ porchRelays: [{ url: 'wss://relay.example', token: 'later' }], porchVia: 'direct', other: 1 }));
	writeRegistry([]);
	const fresh = manager();
	fresh.porchSupported = true;
	await quiet(() => fresh.restoreBackup({ passphrase: PASSPHRASE, archive: out.archive.toString('base64') }));
	assert.deepEqual(JSON.parse(fs.readFileSync(native, 'utf8')), { other: 1 });
	assert.equal(fresh._porchState(fresh.registry.get(a.id)).source, null);
});

test('a Porch save writes config.json before any restart: a removed token is gone at once, and a file it cannot write refuses the save', async () => {
	const { a } = twoWalletBox();
	const m = manager();
	m.porchSupported = true;
	let restarts = 0;
	m._restartWallet = async () => {
		restarts += 1;
	};
	m.runtimeState(a.id).proc = {};
	const native = path.join(DATA_DIR, 'wallets', a.id, 'home', '.beignet', 'config.json');
	await quiet(() => m.updateWallet(a.id, { porch: { enabled: true, relays: [{ url: 'wss://relay.example', token: 'sekrit' }] } }));
	assert.deepEqual(JSON.parse(fs.readFileSync(native, 'utf8')).porchRelays, [{ url: 'wss://relay.example', token: 'sekrit' }]);
	await quiet(() => m.updateWallet(a.id, { porch: { relays: [{ url: 'wss://relay.example', token: null }] } }));
	assert.deepEqual(JSON.parse(fs.readFileSync(native, 'utf8')).porchRelays, ['wss://relay.example']);
	assert.equal(restarts, 2);

	fs.chmodSync(path.dirname(native), 0o500);
	try {
		await assert.rejects(
			quiet(() => m.updateWallet(a.id, { porch: { relays: [{ url: 'wss://relay.example', token: 'next' }] } })),
			(err) => err.code === 'PORCH_CONFIG_UNWRITABLE'
		);
	} finally {
		fs.chmodSync(path.dirname(native), 0o700);
	}
	assert.equal(restarts, 2);
	assert.deepEqual(m.publicRecord(a.id).porch.relays, [{ url: 'wss://relay.example', hasToken: false }]);
});

test('an archive is never written larger than a restore accepts: the largest assets backups are left out and named', () => {
	// A restore carries the archive as base64 in one request body.
	assert.ok(Math.ceil((MAX_ARCHIVE_BYTES * 4) / 3) < RESTORE_BODY_LIMIT_BYTES);

	// The seal here is the payload's size, so the arithmetic is the test.
	const sizes = new Map([['small', 10], ['huge', 500], ['big', 300], ['none', 0]]);
	const build = (without) => [...sizes].filter(([id]) => !without.includes(id)).reduce((sum, [, n]) => sum + n, 100);
	const seal = (bytes) => Buffer.alloc(bytes);
	// Fits: nothing is left out.
	assert.deepEqual(sealWithinLimit({ build, seal, sizes, maxBytes: 1000 }).skipped, []);
	// Too large: the largest goes first, and only as many as it takes.
	const one = sealWithinLimit({ build, seal, sizes, maxBytes: 500 });
	assert.deepEqual(one.skipped, ['huge']);
	assert.equal(one.archive.length, 410);
	assert.deepEqual(sealWithinLimit({ build, seal, sizes, maxBytes: 150 }).skipped, ['huge', 'big']);
	// A wallet with no assets file is never named, and the seeds are archived
	// even when nothing else fits.
	const all = sealWithinLimit({ build, seal, sizes, maxBytes: 50 });
	assert.deepEqual(all.skipped, ['huge', 'big', 'small']);
	assert.equal(all.archive.length, 100);
});

test("a wallet's assets backup can be left out of a payload without touching its seed", () => {
	const { a, b } = twoWalletBox();
	for (const rec of [a, b]) {
		const dir = path.join(DATA_DIR, 'wallets', rec.id, 'assets');
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(dir, 'backup.json'), `{"of":"${rec.id}"}`, { mode: 0o600 });
	}
	const payload = buildPayload({ dataDir: DATA_DIR, walletIds: [a.id, b.id], createdAt: 'now', withoutAssets: [a.id] });
	const paths = payload.files.map((f) => f.path);
	assert.equal(paths.includes(`wallets/${a.id}/assets/backup.json`), false);
	assert.equal(paths.includes(`wallets/${b.id}/assets/backup.json`), true);
	assert.equal(paths.includes(`wallets/${a.id}/secrets/mnemonic`), true);
});

test('an archive cannot name another file under a wallet', () => {
	const entry = (rel) => ({ files: [{ path: rel, mode: 0o600, data: '' }] });
	const id = 'aaaaaaaa-0000-4000-8000-000000000001';
	assert.equal(payloadFiles(entry(`wallets/${id}/assets/backup.json`)).size, 1);
	for (const rel of [
		`wallets/${id}/assets/pending-import.json`,
		`wallets/${id}/assets/../secrets/mnemonic`,
		`wallets/${id}/assets/backup.json.tmp`,
		`wallets/${id}/data/beignet.db`,
		`wallets/../assets/backup.json`
	]) {
		assert.throws(() => payloadFiles(entry(rel)), (err) => err.code === 'BAD_ARCHIVE', rel);
	}
});

test('the stale rule: never backed up, backed up, edited since', () => {
	// Assets that changed since the archive make it stale without any edit.
	assert.equal(
		backupStale({ createdAt: '2026-09-01T00:00:00.000Z', lastBackupAt: '2026-09-02T00:00:00.000Z', assetsChangedAt: '2026-09-03T00:00:00.000Z' }),
		true
	);
	assert.equal(
		backupStale({ createdAt: '2026-09-01T00:00:00.000Z', lastBackupAt: '2026-09-02T00:00:00.000Z', assetsChangedAt: '2026-09-01T12:00:00.000Z' }),
		false
	);
	const created = '2026-09-01T00:00:00.000Z';
	assert.equal(backupStale({ createdAt: created }), true);
	assert.equal(backupStale({ createdAt: created, lastBackupAt: '2026-09-02T00:00:00.000Z' }), false);
	assert.equal(
		backupStale({ createdAt: created, updatedAt: '2026-09-03T00:00:00.000Z', lastBackupAt: '2026-09-02T00:00:00.000Z' }),
		true
	);
	// A record made before the stamp existed has no updatedAt; creation stands
	// in for it, so a wallet created after the last export still asks.
	assert.equal(backupStale({ createdAt: '2026-09-04T00:00:00.000Z', lastBackupAt: '2026-09-02T00:00:00.000Z' }), true);
});
