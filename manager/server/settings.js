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
		this.data = {
			defaultNetwork: seed.defaultNetwork,
			defaultElectrum: seed.defaultElectrum || null
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
				console.error(`settings: failed to read ${this.file}: ${err.message}`);
			}
		}
	}

	save() {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
		fs.renameSync(tmp, this.file);
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
		this.save();
		return this.data;
	}
}

module.exports = { Settings };
