'use strict';

/**
 * The assets backup file: what goes into it, what is refused coming back,
 * and the rows of the node's database it is kept in (store.js).
 *
 * Run: cd manager && npm test
 * Or:  cd manager && node --test server/assets-host/backup.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const backup = require('./backup');
const { parseConfig, onChain } = require('./config');
const { memoryStorage, hostRows, tapBackend, createHostLock } = require('./store');

const MODULES = '/opt/engine/node_modules';
const WALLET = 'f1'.repeat(32);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'assets-backup-test-'));
const config = (file, network = 'regtest') => parseConfig(network, { BEIGNET_ASSETS_MODULES: MODULES, ...(file ? { BEIGNET_ASSETS_BACKUP_FILE: file } : {}) });

function refusedBy(fn) {
	try {
		fn();
	} catch (err) {
		return err;
	}
	throw new Error('expected a refusal');
}

/** A store with what a wallet that minted once would hold. */
function filled() {
	const mem = memoryStorage();
	const s = mem.storage;
	s.set('t/asset/aa:0', '{"amount":"1000"}');
	s.set('t/proof/aa', 'cafe');
	s.set('t/keyindex/212', '7');
	s.set('h/row/mint-1', '{"id":"mint-1","state":"complete"}');
	s.set('h/committed/b1', '{"kind":"mint","at":1}');
	s.set('h/asset/aa', '{"assetId":"aa"}');
	s.set('h/idem/mint/abc', '{"rowId":"mint-1"}');
	s.set('h/preview', '{"previewId":"p"}');
	return mem;
}

function exported(mem = filled()) {
	const dir = tmp();
	const file = path.join(dir, 'assets', 'backup.json');
	const cfg = config(file);
	const res = backup.exportBackup({ storage: mem.storage, rows: hostRows(mem.storage), cfg, fingerprint: WALLET, now: 1_700_000_000_000 });
	return { mem, dir, file, cfg, res, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('export writes the file, its directory and a checksum, for the owner only', () => {
	const { file, res, read } = exported();
	assert.deepEqual(Object.keys(res), ['exportedAt', 'bytes', 'changed']);
	assert.equal(res.exportedAt, 1_700_000_000_000);
	assert.equal(res.changed, true);
	assert.equal(res.bytes, fs.statSync(file).size);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
	const body = read();
	assert.equal(body.format, 'beignet-assets-backup');
	assert.equal(body.version, 1);
	assert.equal(body.network, 'regtest');
	assert.equal(body.wallet, WALLET);
	assert.equal(body.rowsHash, backup.hashRows(body.rows));
	assert.deepEqual(fs.readdirSync(path.dirname(file)), ['backup.json']);
});

test('what stays on this machine is left out: request keys, the open preview, the backup state', () => {
	const { read } = exported();
	const keys = read().rows.map(([key]) => key);
	assert.deepEqual(keys, ['h/asset/aa', 'h/committed/b1', 'h/row/mint-1', 't/asset/aa:0', 't/keyindex/212', 't/proof/aa']);
});

test('export is cheap when nothing changed, and writes again when the file is gone', () => {
	const { mem, file, cfg, res } = exported();
	const rows = hostRows(mem.storage);
	const before = fs.statSync(file).mtimeMs;
	const again = backup.exportBackup({ storage: mem.storage, rows, cfg, fingerprint: WALLET, now: 1_700_000_500_000 });
	assert.deepEqual(again, { exportedAt: res.exportedAt, bytes: res.bytes, changed: false });
	assert.equal(fs.statSync(file).mtimeMs, before);

	fs.unlinkSync(file);
	const rewritten = backup.exportBackup({ storage: mem.storage, rows, cfg, fingerprint: WALLET, now: 1_700_000_600_000 });
	assert.equal(rewritten.changed, false);
	assert.equal(rewritten.exportedAt, 1_700_000_600_000);
	assert.equal(fs.existsSync(file), true);

	mem.storage.set('t/asset/bb:1', '{"amount":"5"}');
	const changed = backup.exportBackup({ storage: mem.storage, rows, cfg, fingerprint: WALLET, now: 1_700_000_700_000 });
	assert.equal(changed.changed, true);
	assert.equal(rows.get('backup').dirty, false);
});

test('a wallet with nowhere to write its backup says so', () => {
	const mem = filled();
	const err = refusedBy(() => backup.exportBackup({ storage: mem.storage, rows: hostRows(mem.storage), cfg: config(null), fingerprint: WALLET }));
	assert.equal(err.extensionCode, 'BACKUP_UNAVAILABLE');
	assert.equal(err.status, 503);
});

test('round trip: an empty store takes every row of the backup', () => {
	const { cfg, read } = exported();
	const target = memoryStorage();
	const res = backup.importBackup({ storage: target.storage, cfg, fingerprint: WALLET, backup: read() });
	assert.deepEqual(res, { imported: 6, same: false });
	assert.deepEqual(backup.collectRows(target.storage), read().rows);
	assert.equal(target.storage.get('h/idem/mint/abc'), null);
	assert.equal(target.storage.get('h/preview'), null);
	// The same backup again changes nothing.
	assert.deepEqual(backup.importBackup({ storage: target.storage, cfg, fingerprint: WALLET, backup: read() }), { imported: 0, same: true });
});

test('a backup for another network is refused', () => {
	const { cfg, read } = exported();
	const body = { ...read(), network: 'mainnet' };
	const target = memoryStorage();
	const err = refusedBy(() => backup.importBackup({ storage: target.storage, cfg, fingerprint: WALLET, backup: body }));
	assert.equal(err.extensionCode, 'WRONG_NETWORK');
	assert.equal(err.message, 'That assets backup is for mainnet, and this wallet is on regtest.');
	assert.equal(target.data.size, 0);
});

test('the file names the chain, and the wallet\'s own note of it stays behind', () => {
	const mem = filled();
	mem.storage.set('h/chain', '{"name":"regtest"}');
	const { read } = exported(mem);
	assert.equal(read().chain, 'regtest');
	assert.ok(!read().rows.some(([key]) => key === 'h/chain'));
	// Nor is one taken from a file that carries it.
	const body = read();
	body.rows = [...body.rows, ['h/chain', '{"name":"testnet4"}']].sort((a, b) => (a[0] < b[0] ? -1 : 1));
	body.rowsHash = backup.hashRows(body.rows);
	const target = memoryStorage();
	backup.importBackup({ storage: target.storage, cfg: config(null), fingerprint: WALLET, backup: body });
	assert.equal(target.storage.get('h/chain'), null);
});

test('the record of asset channels is the library\'s part of the file: made by it, checked, and restored by it into a store that has none', () => {
	const mem = filled();
	// The library's Lightning store: what a backup may carry, and what only this machine can honour.
	mem.storage.set('l/tap/channel/v1/last/bb', 'last seen');
	mem.storage.set('l/tap/quotes/01', 'a price');
	mem.storage.set('l/tap/funding/v1/flow/cc', 'a funding under way');
	const part = { version: 1, rows: [{ key: 'tap/channel/v1/last/bb', value: 'last seen' }] };
	const restored = [];
	const lightning = (storage) => ({
		backup: () => part,
		restore: (given) => {
			restored.push(given);
			for (const row of given.rows) storage.set(`l/${row.key}`, row.value);
			return given.rows.length;
		}
	});
	const dir = tmp();
	const file = path.join(dir, 'backup.json');
	const cfg = config(file);
	backup.exportBackup({ storage: mem.storage, rows: hostRows(mem.storage), cfg, fingerprint: WALLET, now: 1_700_000_000_000, lightning: lightning(mem.storage) });
	const written = JSON.parse(fs.readFileSync(file, 'utf8'));
	// No row of the library's Lightning store is copied as it is: the host does not choose among them.
	assert.equal(written.rows.some(([key]) => key.startsWith('l/')), false);
	assert.equal(written.rowsHash, backup.hashRows(written.rows));
	assert.deepEqual(written.lightning, part);
	assert.equal(written.lightningHash, backup.hashRows(part.rows.map((r) => [r.key, r.value])));
	// Any row of that store is a record of this wallet's own.
	assert.equal(backup.holdsRecords(mem.storage), true);
	const only = memoryStorage();
	only.storage.set('l/tap/quotes/01', 'a price');
	assert.equal(backup.holdsRecords(only.storage), true);

	// An empty wallet: the library is handed its part and writes it itself.
	const target = memoryStorage();
	const taken = backup.importBackup({ storage: target.storage, cfg, fingerprint: WALLET, backup: written, lightning: lightning(target.storage) });
	assert.equal(taken.same, false);
	assert.deepEqual(restored, [part]);
	assert.deepEqual(target.storage.list('l/'), [{ key: 'l/tap/channel/v1/last/bb', value: 'last seen' }]);
	assert.deepEqual(backup.collectRows(target.storage), written.rows);
	// The same file again: the wallet has Lightning rows now, and they stand.
	backup.importBackup({ storage: target.storage, cfg, fingerprint: WALLET, backup: written, lightning: lightning(target.storage) });
	assert.equal(restored.length, 1);
	// A wallet that cannot have asset channels takes the rest and leaves that part alone.
	const plain = memoryStorage();
	assert.equal(backup.importBackup({ storage: plain.storage, cfg, fingerprint: WALLET, backup: written }).imported > 0, true);
	assert.deepEqual(plain.storage.list('l/'), []);

	// Changed after it was written, or refused by the library: nothing at all is restored.
	const fresh = memoryStorage();
	const changed = refusedBy(() => backup.importBackup({ storage: fresh.storage, cfg, fingerprint: WALLET, backup: { ...written, lightning: { version: 1, rows: [] } }, lightning: lightning(fresh.storage) }));
	assert.deepEqual([changed.extensionCode, changed.message], ['BAD_BACKUP', 'That assets backup is damaged: its record of asset channels does not match its checksum.']);
	// So is one whose record is gone and whose checksum of it is still there.
	const { lightning: gone, ...cut } = written;
	assert.equal(refusedBy(() => backup.importBackup({ storage: fresh.storage, cfg, fingerprint: WALLET, backup: cut, lightning: lightning(fresh.storage) })).extensionCode, 'BAD_BACKUP');
	assert.deepEqual(gone, part);
	const refusing = {
		backup: () => part,
		restore: () => {
			throw Object.assign(new Error('ERR_BEIGNET_LN_INVALID: row 0 is not one a backup carries'), { code: 'ERR_BEIGNET_LN_INVALID' });
		}
	};
	const unread = refusedBy(() => backup.importBackup({ storage: fresh.storage, cfg, fingerprint: WALLET, backup: written, lightning: refusing }));
	assert.deepEqual([unread.extensionCode, unread.message], ['BAD_BACKUP', 'That assets backup holds a record of asset channels that this app cannot read, so nothing was restored.']);
	assert.deepEqual(backup.collectRows(fresh.storage), []);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('holding records: assets, addresses and work in progress count, a key counter and local notes do not', () => {
	const mem = memoryStorage();
	assert.equal(backup.holdsRecords(mem.storage), false);
	for (const key of ['t/keyindex/212', 'h/idem/mint/abc', 'h/preview', 'h/backup', 'h/chain']) mem.storage.set(key, '{}');
	assert.equal(backup.holdsRecords(mem.storage), false);
	mem.storage.set('t/receive/abc', '{}');
	assert.equal(backup.holdsRecords(mem.storage), true);
	assert.equal(backup.holdsRecords(filled().storage), true);
});

test('a testnet backup is for one testnet, and a file that does not say which is refused', () => {
	const mem = filled();
	const dir = tmp();
	const file = path.join(dir, 'assets', 'backup.json');
	const three = onChain(config(file, 'testnet'), 'testnet3');
	const four = onChain(config(file, 'testnet'), 'testnet4');
	backup.exportBackup({ storage: mem.storage, rows: hostRows(mem.storage), cfg: three, fingerprint: WALLET, now: 1_700_000_000_000 });
	const body = JSON.parse(fs.readFileSync(file, 'utf8'));
	assert.deepEqual([body.network, body.chain], ['testnet', 'testnet3']);

	const other = memoryStorage();
	let err = refusedBy(() => backup.importBackup({ storage: other.storage, cfg: four, fingerprint: WALLET, backup: body }));
	assert.equal(err.extensionCode, 'WRONG_NETWORK');
	assert.equal(err.message, 'That assets backup is for testnet3, and this wallet is on testnet4.');
	assert.equal(other.data.size, 0);

	const { chain, ...unnamed } = body;
	assert.equal(chain, 'testnet3');
	err = refusedBy(() => backup.importBackup({ storage: other.storage, cfg: three, fingerprint: WALLET, backup: unnamed }));
	assert.equal(err.extensionCode, 'WRONG_NETWORK');
	assert.equal(err.message, 'That assets backup does not say which testnet it was made on, so it cannot be restored.');
	assert.equal(other.data.size, 0);

	assert.deepEqual(backup.importBackup({ storage: other.storage, cfg: three, fingerprint: WALLET, backup: body }), { imported: 6, same: false });
	fs.rmSync(dir, { recursive: true, force: true });
});

test('a backup of a network that is one chain needs no chain named', () => {
	const { cfg, read } = exported();
	const { chain, ...unnamed } = read();
	assert.equal(chain, 'regtest');
	const target = memoryStorage();
	assert.deepEqual(backup.importBackup({ storage: target.storage, cfg, fingerprint: WALLET, backup: unnamed }), { imported: 6, same: false });
});

test('a backup of another wallet is refused', () => {
	const { cfg, read } = exported();
	const target = memoryStorage();
	const err = refusedBy(() => backup.importBackup({ storage: target.storage, cfg, fingerprint: 'e2'.repeat(32), backup: read() }));
	assert.equal(err.extensionCode, 'WRONG_WALLET');
	assert.equal(target.data.size, 0);
	// A wallet whose fingerprint could not be worked out restores nothing.
	assert.equal(refusedBy(() => backup.importBackup({ storage: target.storage, cfg, fingerprint: null, backup: read() })).extensionCode, 'WRONG_WALLET');
});

test('a backup that was changed after it was written is refused', () => {
	const { cfg, read } = exported();
	const target = memoryStorage();
	const attempt = (body) => refusedBy(() => backup.importBackup({ storage: target.storage, cfg, fingerprint: WALLET, backup: body }));

	const value = read();
	value.rows[3][1] = '{"amount":"999999"}';
	assert.equal(attempt(value).extensionCode, 'BAD_BACKUP');
	assert.match(attempt(value).message, /do not match its checksum/);

	const added = read();
	added.rows.push(['t/asset/zz:0', '{"amount":"1"}']);
	assert.equal(attempt(added).extensionCode, 'BAD_BACKUP');

	const dropped = read();
	dropped.rows.pop();
	assert.equal(attempt(dropped).extensionCode, 'BAD_BACKUP');

	assert.equal(attempt({ ...read(), rowsHash: '00'.repeat(32) }).extensionCode, 'BAD_BACKUP');
	assert.equal(attempt({ ...read(), rows: 'not rows' }).extensionCode, 'BAD_BACKUP');
	assert.equal(attempt({ ...read(), format: 'something-else' }).extensionCode, 'BAD_BACKUP');
	assert.equal(attempt({ ...read(), version: 2 }).extensionCode, 'BAD_BACKUP');
	assert.equal(attempt(null).extensionCode, 'BAD_BACKUP');
	assert.equal(attempt('text').extensionCode, 'BAD_BACKUP');
	assert.equal(target.data.size, 0);
});

test('key counters take the higher value, so no key is ever handed out twice', () => {
	const { cfg, read } = exported();
	const ahead = memoryStorage();
	ahead.storage.set('t/keyindex/212', '12');
	backup.importBackup({ storage: ahead.storage, cfg, fingerprint: WALLET, backup: read() });
	assert.equal(ahead.storage.get('t/keyindex/212'), '12');

	const behind = memoryStorage();
	behind.storage.set('t/keyindex/212', '3');
	backup.importBackup({ storage: behind.storage, cfg, fingerprint: WALLET, backup: read() });
	assert.equal(behind.storage.get('t/keyindex/212'), '7');

	const equal = memoryStorage();
	equal.storage.set('t/keyindex/212', '7');
	backup.importBackup({ storage: equal.storage, cfg, fingerprint: WALLET, backup: read() });
	assert.equal(equal.storage.get('t/keyindex/212'), '7');
});

test('a wallet that holds assets the backup does not know is not written over', () => {
	const { cfg, read } = exported();
	const busy = memoryStorage();
	busy.storage.set('t/asset/other:0', '{"amount":"42"}');
	busy.storage.set('t/keyindex/212', '2');
	const before = new Map(busy.data);
	const err = refusedBy(() => backup.importBackup({ storage: busy.storage, cfg, fingerprint: WALLET, backup: read() }));
	assert.equal(err.extensionCode, 'BACKUP_CONFLICT');
	assert.equal(err.status, 409);
	assert.deepEqual(new Map(busy.data), before);

	// The same asset row with a different value is a conflict too.
	const differs = memoryStorage();
	differs.storage.set('t/asset/aa:0', '{"amount":"1"}');
	assert.equal(refusedBy(() => backup.importBackup({ storage: differs.storage, cfg, fingerprint: WALLET, backup: read() })).extensionCode, 'BACKUP_CONFLICT');
});

test('a wallet whose assets are all in the backup takes the rest of it', () => {
	const { cfg, read } = exported();
	const partial = memoryStorage();
	partial.storage.set('t/asset/aa:0', '{"amount":"1000"}');
	partial.storage.set('h/row/local', '{"id":"local"}');
	const res = backup.importBackup({ storage: partial.storage, cfg, fingerprint: WALLET, backup: read() });
	assert.equal(res.imported, 5);
	assert.equal(partial.storage.get('t/proof/aa'), 'cafe');
	assert.equal(partial.storage.get('h/row/local'), '{"id":"local"}');
});

test('rows that are not the host\'s or the library\'s are not taken from a backup', () => {
	const { cfg, read } = exported();
	const body = read();
	body.rows.push(['wallet/seed', 'x'], ['h/idem/mint/zzz', '{}'], ['h/preview', '{}'], [`t/${'k'.repeat(600)}`, 'x']);
	body.rowsHash = backup.hashRows(body.rows);
	const target = memoryStorage();
	backup.importBackup({ storage: target.storage, cfg, fingerprint: WALLET, backup: body });
	assert.equal(target.data.size, 6);
	assert.equal(target.storage.get('wallet/seed'), null);
});

test('reading a backup file: missing, not a file, or not JSON', () => {
	const dir = tmp();
	const missing = refusedBy(() => backup.readBackupFile(path.join(dir, 'none.json')));
	assert.equal(missing.extensionCode, 'BAD_BACKUP');
	assert.equal(missing.status, 404);
	assert.equal(refusedBy(() => backup.readBackupFile(dir)).extensionCode, 'BAD_BACKUP');
	const junk = path.join(dir, 'junk.json');
	fs.writeFileSync(junk, '{"format":');
	assert.equal(refusedBy(() => backup.readBackupFile(junk)).extensionCode, 'BAD_BACKUP');
	const { file, read } = exported();
	assert.deepEqual(backup.readBackupFile(file), read());
});

/* ------------------------------------------------------- the rows it reads */

test('library rows: any key fits, however long, and a prefix lists what is under it', async () => {
	const mem = memoryStorage();
	const kv = tapBackend(mem.storage);
	const long = `proof/${'ab'.repeat(400)}`;
	const other = `proof/${'ab'.repeat(399)}cd`;
	await kv.write([
		{ key: 'asset/one', value: 'v1' },
		{ key: long, value: 'long value' },
		{ key: other, value: 'other value' }
	]);
	assert.equal(await kv.get('asset/one'), 'v1');
	assert.equal(await kv.get(long), 'long value');
	assert.equal(await kv.get(other), 'other value');
	assert.equal(await kv.get(`proof/${'ab'.repeat(398)}`), undefined);
	assert.equal(await kv.get('asset/two'), undefined);
	for (const key of mem.data.keys()) assert.ok(key.length <= 512, `stored key of ${key.length} characters`);
	assert.deepEqual((await kv.keys('proof/')).sort(), [long, other].sort());
	assert.deepEqual(await kv.keys(long), [long]);
	assert.deepEqual(await kv.keys('asset/'), ['asset/one']);
	assert.deepEqual(await kv.keys(''), ['asset/one', long, other]);
	await kv.write([{ key: long, value: undefined }]);
	assert.equal(await kv.get(long), undefined);
	assert.equal(await kv.get(other), 'other value');
});

test('library rows: one write is all or nothing', async () => {
	const mem = memoryStorage();
	const kv = tapBackend(mem.storage);
	await kv.write([{ key: 'asset/one', value: 'v1' }]);
	await assert.rejects(
		kv.write([
			{ key: 'asset/two', value: 'v2' },
			{ key: 'asset/three', value: 42 }
		])
	);
	assert.deepEqual(await kv.keys(''), ['asset/one']);
});

test('host rows are JSON under their own prefix, and a failed transaction writes nothing', () => {
	const mem = memoryStorage();
	const rows = hostRows(mem.storage);
	rows.put('row/a', { id: 'a', amount: '18446744073709551615' });
	assert.deepEqual(rows.get('row/a'), { id: 'a', amount: '18446744073709551615' });
	assert.equal(mem.storage.get('h/row/a'), '{"id":"a","amount":"18446744073709551615"}');
	assert.equal(rows.get('row/none'), null);
	assert.throws(() =>
		rows.tx(() => {
			rows.put('committed/x', { kind: 'send' });
			rows.put('row/b', { id: 'b' });
			throw new Error('power cut');
		})
	);
	assert.equal(rows.get('committed/x'), null);
	assert.equal(rows.get('row/b'), null);
	assert.deepEqual(rows.list('row/').map((r) => r.key), ['row/a']);
	rows.del('row/a');
	assert.equal(rows.get('row/a'), null);
});

test('after the node is rebuilt every storage call throws', () => {
	const mem = memoryStorage();
	const rows = hostRows(mem.storage);
	rows.put('row/a', { id: 'a' });
	mem.fence();
	for (const call of [() => rows.get('row/a'), () => rows.put('row/b', {}), () => rows.del('row/a'), () => rows.list('row/'), () => rows.tx(() => {})]) {
		assert.throws(call, /database connection is not open/);
	}
});

test('the one lock: sections run one at a time, and the library can take it again from inside', async () => {
	const lock = createHostLock();
	const order = [];
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const first = lock.run(async () => {
		order.push('first in');
		await sleep(15);
		// The adapter takes the same lock for its own flows.
		await lock.flowLock('send', async () => {
			order.push('library inside first');
		});
		order.push('first out');
	});
	const second = lock.run(async () => {
		order.push('second in');
	});
	const third = lock.flowLock('mint', async () => {
		order.push('library alone');
		return 'value';
	});
	await Promise.all([first, second]);
	assert.equal(await third, 'value');
	assert.deepEqual(order, ['first in', 'library inside first', 'first out', 'second in', 'library alone']);
});

test('a timer started through the lock\'s way out waits its turn, even while its own section still runs', async () => {
	const lock = createHostLock();
	const order = [];
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	let done;
	const finished = new Promise((resolve) => (done = resolve));
	await lock.run(async () => {
		order.push('section in');
		const handle = lock.outside(() =>
			setTimeout(() => {
				order.push('timer fired');
				lock.run(async () => order.push('timer body')).then(done);
			}, 5)
		);
		assert.equal(typeof handle.unref, 'function');
		// Still inside when the timer fires, as a slow broadcast would be.
		await sleep(40);
		order.push('section out');
	});
	await finished;
	assert.deepEqual(order, ['section in', 'timer fired', 'section out', 'timer body']);
	// The section itself still passes through its own lock.
	assert.equal(await lock.run(() => lock.run(async () => 'nested')), 'nested');
});

test('the one lock is free again after a section throws', async () => {
	const lock = createHostLock();
	await assert.rejects(
		lock.run(async () => {
			throw new Error('refused');
		}),
		/refused/
	);
	assert.equal(await lock.run(async () => 'next'), 'next');
});
