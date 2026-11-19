'use strict';

/**
 * The assets backup: one file holding every row the host owns.
 *
 * A recovery phrase brings back a wallet's bitcoin and the keys its assets
 * are locked to, but not the proofs that say which assets those are. Those
 * live in the node's database, so the host writes them out as one JSON file
 * the manager puts in the app backup, and reads one back on a restore.
 *
 * The file carries the network and the chain (which testnet, for a testnet
 * wallet), a fingerprint of the wallet (the hash of a public key, never
 * anything secret), when it was written and a SHA-256 over its rows. The
 * answers to past money requests and an open preview are left out: neither
 * means anything on another machine. So is the wallet's note of its chain,
 * which the file states itself.
 *
 * Of asset channels the file carries what the library says a backup may:
 * which channels there were, where their payouts go, the proofs of what
 * funded them and the record of each close seen. Which rows those are is
 * the library's to say and never this file's: it is asked for them
 * (`lightning.backup()`, adapter.js items 26 and 27) and handed them back
 * on a restore, and no other row of its store is read or written here. They
 * sit beside the host's rows, under `lightning`, with a checksum of their
 * own. The host's activity rows are carried as ever. Left out is what only
 * this machine's node can honour: a price given, an invoice made, and the
 * host's own notes of its channels, with the marker that would have another
 * machine open one again.
 *
 * A channel itself is the node's, and is in no backup. A wallet restored
 * from this file knows its channels and cannot run them: they are listed as
 * not held by the node. So a backup is never restored over a channel the
 * node holds, and a wallet that has Lightning rows of its own keeps them:
 * the file's are then left out.
 *
 * Everything here is synchronous, so an export reads one consistent set of
 * rows and nothing can change underneath it.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { refusal, isFenced } = require('./errors');

const FORMAT = 'beignet-assets-backup';
const VERSION = 1;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
// Rows that stay on this machine.
const LEFT_OUT = [
	'h/idem/',
	'h/preview',
	'h/backup',
	'h/chain',
	'h/chan/',
	'h/committed/funding:',
	'h/l-quote/',
	'h/inv/',
	// The library's Lightning store, whole. What of it a backup may carry is
	// asked of the library, and travels beside these rows.
	'l/'
];
const COUNTER = 't/keyindex/';
const ASSET_RECORDS = 't/asset/';
const LIGHTNING = 'l/';

/** The library's Lightning rows as [key, value], for the checksum. Null when they are not rows at all. */
function lightningRows(part) {
	if (!part || typeof part !== 'object' || !Array.isArray(part.rows)) return null;
	if (!part.rows.every((r) => r && typeof r === 'object' && typeof r.key === 'string' && typeof r.value === 'string')) return null;
	return part.rows.map((r) => [r.key, r.value]);
}

const leftOut = (key) => LEFT_OUT.some((prefix) => key.startsWith(prefix));

/**
 * Whether the wallet holds anything a backup would carry, beyond the count
 * of keys it has derived: an asset, an address, a mint or a send, finished
 * or not. Any row of its asset channels counts as well: which of them a
 * backup carries is the library's to say, and a wallet that has had to do
 * with a channel on one chain is not one that holds nothing.
 */
function holdsRecords(storage) {
	return storage.list('').some((row) => (row.key.startsWith(LIGHTNING) || !leftOut(row.key)) && !row.key.startsWith(COUNTER));
}

/** Every row a backup holds, as [key, value], in key order. */
function collectRows(storage) {
	return storage
		.list('')
		.filter((row) => !leftOut(row.key))
		.map((row) => [row.key, row.value]);
}

/** SHA-256 over rows, with lengths in front so no two sets of rows read the same. */
function hashRows(rows) {
	const hash = crypto.createHash('sha256');
	for (const [key, value] of rows) {
		hash.update(`${Buffer.byteLength(key)}:${key}${Buffer.byteLength(value)}:`);
		hash.update(value);
	}
	return hash.digest('hex');
}

/** Write `text` to `file` so a reader sees the old file or the new one, never half of either. */
function writeAtomic(file, text) {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	const fd = fs.openSync(tmp, 'w', 0o600);
	try {
		fs.writeSync(fd, text);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, file);
	try {
		const dfd = fs.openSync(dir, 'r');
		try {
			fs.fsyncSync(dfd);
		} finally {
			fs.closeSync(dfd);
		}
	} catch (_) {
		/* a directory that cannot be synced is still a file that was renamed */
	}
}

/**
 * Write the backup file if its content would differ from the last one, or if
 * it is missing. Cheap when nothing changed: the rows are read and hashed,
 * and nothing is written.
 *
 * `lightning` is the wallet's asset channels (adapter.js createLightning),
 * or null for a wallet that has none: its `backup()` gives the rows of the
 * library's a backup may carry.
 *
 * Returns { exportedAt, bytes, changed }. `changed` is true only when the
 * rows differ from those of the previous export.
 */
function exportBackup({ storage, rows, cfg, fingerprint, now = Date.now(), lightning = null }) {
	if (!cfg.backupFile) {
		throw refusal('BACKUP_UNAVAILABLE', 'This wallet was not given a place to write its assets backup.', 503);
	}
	const data = collectRows(storage);
	const rowsHash = hashRows(data);
	// Read in the same breath as the host's rows: nothing runs in between.
	const carried = lightning ? lightning.backup() : null;
	const channelRows = carried ? lightningRows(carried) : null;
	const part = channelRows && channelRows.length > 0 ? { lightning: carried, lightningHash: hashRows(channelRows) } : {};
	// What tells one export from the next: both sets of rows. A wallet with
	// no channel rows has the hash it always had.
	const hash = part.lightningHash ? crypto.createHash('sha256').update(`${rowsHash}:${part.lightningHash}`).digest('hex') : rowsHash;
	const state = rows.get('backup') || {};
	let present = false;
	try {
		present = fs.statSync(cfg.backupFile).isFile();
	} catch (_) {
		present = false;
	}
	if (present && state.hash === hash && state.exportedAt) {
		if (state.dirty) rows.put('backup', { ...state, dirty: false });
		return { exportedAt: state.exportedAt, bytes: state.bytes || 0, changed: false };
	}
	const text = JSON.stringify({
		format: FORMAT,
		version: VERSION,
		network: cfg.network,
		chain: cfg.tapNetwork,
		wallet: fingerprint,
		exportedAt: now,
		rowsHash,
		rows: data,
		...part
	});
	writeAtomic(cfg.backupFile, text);
	const bytes = Buffer.byteLength(text);
	rows.put('backup', { exportedAt: now, hash, bytes, dirty: false });
	return { exportedAt: now, bytes, changed: state.hash !== hash };
}

const counterValue = (text) => {
	try {
		return /^[0-9]+$/.test(String(text)) ? BigInt(text) : 0n;
	} catch (_) {
		return 0n;
	}
};

/**
 * Put a backup's rows into the store.
 *
 * Refused unless the file is whole, for this chain and for this wallet. A
 * store that already holds asset records takes a backup only when every
 * record it has is in the backup unchanged: the backup is then the same
 * data, or the same data and more. Anything else would mix two histories.
 * A key counter keeps the higher of its two values, so no key is handed out
 * twice.
 *
 * The file's record of asset channels goes to the library, which writes it
 * into a Lightning store that holds nothing and into no other: a wallet
 * with Lightning rows of its own keeps them, and the file's are left out.
 * It is restored first, and whole or not at all. A file whose channel
 * records the library will not take is refused before anything is written.
 * `lightning` is the wallet's asset channels, or null for a wallet that has
 * none, which leaves that part of the file alone.
 *
 * Returns { imported, same }: rows written, and whether nothing needed to be.
 */
function importBackup({ storage, cfg, fingerprint, backup, lightning = null }) {
	const b = backup;
	if (!b || typeof b !== 'object' || b.format !== FORMAT) {
		throw refusal('BAD_BACKUP', 'That file is not an assets backup from this app.');
	}
	if (b.version !== VERSION) {
		throw refusal('BAD_BACKUP', `That assets backup is version ${String(b.version)}, which this app cannot read.`);
	}
	const shaped =
		Array.isArray(b.rows) && b.rows.every((r) => Array.isArray(r) && r.length === 2 && typeof r[0] === 'string' && typeof r[1] === 'string');
	if (!shaped || typeof b.rowsHash !== 'string' || hashRows(b.rows) !== b.rowsHash) {
		throw refusal('BAD_BACKUP', 'That assets backup is damaged: its contents do not match its checksum.');
	}
	// The record of asset channels and its checksum travel together: a file
	// that has either must have both, and they must agree. One whose record
	// was cut short, or lost, is not restored as though it had none.
	const channelRows = b.lightning === undefined || b.lightning === null ? [] : lightningRows(b.lightning);
	const summed = b.lightningHash !== undefined && b.lightningHash !== null;
	if (!channelRows || ((summed || channelRows.length > 0) && hashRows(channelRows) !== b.lightningHash)) {
		throw refusal('BAD_BACKUP', 'That assets backup is damaged: its record of asset channels does not match its checksum.');
	}
	if (b.network !== cfg.network) {
		throw refusal('WRONG_NETWORK', `That assets backup is for ${String(b.network)}, and this wallet is on ${cfg.network}.`);
	}
	// A network that is one chain needs no more said. Testnet is two, and
	// assets made on one do not exist on the other.
	const chain = typeof b.chain === 'string' && b.chain ? b.chain : cfg.chains.length === 1 ? cfg.chains[0] : null;
	if (!chain) {
		throw refusal('WRONG_NETWORK', `That assets backup does not say which ${cfg.network} it was made on, so it cannot be restored.`);
	}
	if (chain !== cfg.tapNetwork) {
		throw refusal('WRONG_NETWORK', `That assets backup is for ${chain}, and this wallet is on ${cfg.tapNetwork}.`);
	}
	if (!fingerprint || b.wallet !== fingerprint) {
		throw refusal('WRONG_WALLET', 'That assets backup belongs to another wallet: its recovery phrase is not this one.');
	}
	const incoming = new Map(b.rows.filter(([key]) => /^[tTh]\//.test(key) && key.length <= 512 && !leftOut(key)));
	const existing = storage.list('');
	if (existing.some((row) => row.key.startsWith(ASSET_RECORDS))) {
		for (const row of existing) {
			if (!/^[tT]\//.test(row.key) || row.key.startsWith(COUNTER)) continue;
			if (incoming.get(row.key) !== row.value) {
				throw refusal('BACKUP_CONFLICT', 'This wallet already holds assets that are not in that backup, so nothing was restored.', 409);
			}
		}
	}
	let imported = 0;
	// The library's rows first, in a transaction of its own: one cannot be
	// opened inside another. Should the daemon stop between the two, the
	// wallet has its channel records and the file is restored again from
	// the dashboard, where they then count as the wallet's own.
	if (lightning && channelRows.length > 0 && storage.list(LIGHTNING).length === 0) {
		try {
			imported += lightning.restore(b.lightning);
		} catch (err) {
			if (isFenced(err)) throw err;
			throw refusal('BAD_BACKUP', 'That assets backup holds a record of asset channels that this app cannot read, so nothing was restored.');
		}
	}
	storage.transaction(() => {
		for (const [key, value] of incoming) {
			const current = storage.get(key);
			if (current === value) continue;
			if (key.startsWith(COUNTER) && current !== null && counterValue(current) >= counterValue(value)) continue;
			storage.set(key, value);
			imported += 1;
		}
	});
	return { imported, same: imported === 0 };
}

/** Read and parse a backup file. Throws a refusal when it is not one. */
function readBackupFile(file) {
	let stat;
	try {
		stat = fs.statSync(file);
	} catch (_) {
		throw refusal('BAD_BACKUP', 'There is no assets backup waiting to be restored.', 404);
	}
	if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw refusal('BAD_BACKUP', 'That file is not an assets backup from this app.');
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (_) {
		throw refusal('BAD_BACKUP', 'That assets backup is damaged: it could not be read.');
	}
}

module.exports = { FORMAT, VERSION, collectRows, holdsRecords, hashRows, writeAtomic, exportBackup, importBackup, readBackupFile };
