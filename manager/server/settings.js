'use strict';

const fs = require('fs');
const path = require('path');

/**
 * App-level settings persisted to the data volume. Holds the default network
 * and default Electrum server applied to new wallets (each wallet can still
 * override them). Seeded from environment defaults on first boot; the file
 * takes over once written.
 */
class Settings {
	constructor(file, seed) {
		this.file = file;
		// A file that exists but could not be read: { message }. Settings are
		// only ever written whole, so while it is set the file on disk holds
		// something these defaults would replace.
		this.loadError = null;
		this.data = {
			defaultNetwork: seed.defaultNetwork,
			defaultElectrum: seed.defaultElectrum || null,
			// The guardian set new guardian-mode wallets register with (empty
			// when none is configured). Each wallet pins its own copy at the
			// moment it first enables a guardian mode; this is only the default.
			recoveryGuardians: [],
			// When this box last wrote a backup archive. Per-wallet stamps live
			// on the records; this is the one the wallet list shows.
			lastBackupAt: null
		};
	}

	load() {
		try {
			const raw = fs.readFileSync(this.file, 'utf8');
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') {
				this.data = { ...this.data, ...parsed };
			}
		} catch (err) {
			if (err.code !== 'ENOENT') {
				this.loadError = { message: err.message };
				console.error(`settings: failed to read ${this.file}: ${err.message}`);
			}
		}
	}

	save() {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
		fs.renameSync(tmp, this.file);
		// What could not be read has now been replaced deliberately, so there
		// is nothing left on disk to preserve.
		this.loadError = null;
	}

	get() {
		return this.data;
	}

	update(patch) {
		if (patch.defaultNetwork !== undefined) {
			this.data.defaultNetwork = patch.defaultNetwork;
		}
		if (patch.defaultElectrum !== undefined) {
			// null clears the default (wallets must then specify a server).
			this.data.defaultElectrum = patch.defaultElectrum;
		}
		if (patch.recoveryGuardians !== undefined) {
			this.data.recoveryGuardians = patch.recoveryGuardians;
		}
		if (patch.lastBackupAt !== undefined) {
			this.data.lastBackupAt = patch.lastBackupAt;
		}
		this.save();
		return this.data;
	}
}

module.exports = { Settings };
