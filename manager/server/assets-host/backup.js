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
 * Everything here is synchronous, so an export reads one consistent set of
 * rows and nothing can change underneath it.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { refusal } = require('./errors');

const FORMAT = 'beignet-assets-backup';
const VERSION = 1;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
// Rows that stay on this machine.
const LEFT_OUT = ['h/idem/', 'h/preview', 'h/backup', 'h/chain'];
const COUNTER = 't/keyindex/';
const ASSET_RECORDS = 't/asset/';

const leftOut = (key) => LEFT_OUT.some((prefix) => key.startsWith(prefix));

/**
 * Whether the wallet holds anything a backup would carry, beyond the count
 * of keys it has derived: an asset, an address, a mint or a send, finished
 * or not.
 */
function holdsRecords(storage) {
	return storage.list('').some((row) => !leftOut(row.key) && !row.key.startsWith(COUNTER));
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
 * Returns { exportedAt, bytes, changed }. `changed` is true only when the
 * rows differ from those of the previous export.
 */
function exportBackup({ storage, rows, cfg, fingerprint, now = Date.now() }) {
	if (!cfg.backupFile) {
		throw refusal('BACKUP_UNAVAILABLE', 'This wallet was not given a place to write its assets backup.', 503);
	}
	const data = collectRows(storage);
	const hash = hashRows(data);
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
		rowsHash: hash,
		rows: data
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
 * Returns { imported, same }: rows written, and whether nothing needed to be.
 */
function importBackup({ storage, cfg, fingerprint, backup }) {
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
