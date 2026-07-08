'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Persists wallet metadata (not secrets) to a JSON file on the data volume.
 * Secrets (mnemonic, api token) live per-wallet under wallets/<id>/secrets.
 */
class Registry {
	constructor(file) {
		this.file = file;
		this.records = new Map();
	}

	load() {
		try {
			const raw = fs.readFileSync(this.file, 'utf8');
			const arr = JSON.parse(raw);
			for (const rec of arr) this.records.set(rec.id, rec);
		} catch (err) {
			if (err.code !== 'ENOENT') {
				console.error(`registry: failed to read ${this.file}: ${err.message}`);
			}
		}
	}

	save() {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify([...this.records.values()], null, 2));
		fs.renameSync(tmp, this.file);
	}

	list() {
		return [...this.records.values()];
	}

	get(id) {
		return this.records.get(id);
	}

	upsert(rec) {
		this.records.set(rec.id, rec);
		this.save();
	}

	remove(id) {
		this.records.delete(id);
		this.save();
	}
}

module.exports = { Registry };
