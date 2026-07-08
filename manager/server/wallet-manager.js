'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const bip39 = require('bip39');
const { config, SUPPORTED_NETWORKS } = require('./config');
const { Registry } = require('./registry');

const HEALTH_TIMEOUT_MS = 45000;
const HEALTH_POLL_MS = 500;
const MAX_LOG_LINES = 300;
const KILL_GRACE_MS = 10000;

function nowIso() {
	return new Date().toISOString();
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpError(status, code, message) {
	const err = new Error(message);
	err.statusCode = status;
	err.code = code;
	return err;
}

/**
 * Resolves how to invoke the beignet daemon. In the container beignet is a
 * global npm install (`beignet` on PATH). For local dev, set BEIGNET_BIN to a
 * built dist entry (e.g. .../dist/cli/cli.js) and it is run with node.
 */
function beignetSpawn() {
	const bin = process.env.BEIGNET_BIN;
	if (bin && bin.endsWith('.js')) return { cmd: process.execPath, args: [bin, 'start'] };
	if (bin) return { cmd: bin, args: ['start'] };
	return { cmd: 'beignet', args: ['start'] };
}

class WalletManager {
	constructor() {
		this.registry = new Registry(path.join(config.dataDir, 'registry.json'));
		this.runtime = new Map();
	}

	async init() {
		this.registry.load();
		for (const rec of this.registry.list()) {
			if (rec.running) {
				this.startWallet(rec.id).catch((err) =>
					this._log(rec.id, `start on boot failed: ${err.message}`)
				);
			}
		}
	}

	runtimeState(id) {
		if (!this.runtime.has(id)) {
			this.runtime.set(id, {
				proc: null,
				status: 'stopped',
				healthy: false,
				logs: [],
				restartCount: 0,
				stopping: false,
				startedAt: null
			});
		}
		return this.runtime.get(id);
	}

	_log(id, line) {
		const rt = this.runtimeState(id);
		rt.logs.push(`[${nowIso()}] ${line}`);
		if (rt.logs.length > MAX_LOG_LINES) rt.logs.shift();
		process.stdout.write(`wallet ${String(id).slice(0, 8)}: ${line}\n`);
	}

	paths(id) {
		const base = path.join(config.dataDir, 'wallets', id);
		return {
			base,
			home: path.join(base, 'home'),
			data: path.join(base, 'data'),
			secrets: path.join(base, 'secrets'),
			mnemonicFile: path.join(base, 'secrets', 'mnemonic'),
			tokenFile: path.join(base, 'secrets', 'api_token')
		};
	}

	token(id) {
		return fs.readFileSync(this.paths(id).tokenFile, 'utf8').trim();
	}

	target(id) {
		const rec = this.registry.get(id);
		if (!rec) return null;
		return `http://127.0.0.1:${rec.port}`;
	}

	_allocatePort() {
		const used = new Set(
			this.registry
				.list()
				.map((rec) => rec.port)
				.filter(Boolean)
		);
		for (let port = config.childPortBase; port <= config.childPortMax; port++) {
			if (!used.has(port)) return port;
		}
		throw httpError(507, 'NO_PORT', 'No free wallet port available');
	}

	_resolveElectrum(input) {
		if (input && input.host) {
			const port = parseInt(input.port, 10);
			if (!Number.isFinite(port) || port <= 0) {
				throw httpError(400, 'BAD_ELECTRUM', 'Invalid Electrum port');
			}
			return { host: String(input.host).trim(), port, tls: !!input.tls };
		}
		if (!config.defaultElectrum.host) {
			throw httpError(
				400,
				'NO_ELECTRUM',
				'No Electrum server configured. Provide one for this wallet.'
			);
		}
		return { ...config.defaultElectrum };
	}

	_validateNetwork(network) {
		const net = network || config.defaultNetwork;
		if (!SUPPORTED_NETWORKS.includes(net)) {
			throw httpError(
				400,
				'BAD_NETWORK',
				`Unsupported network "${net}". Supported: ${SUPPORTED_NETWORKS.join(', ')}.`
			);
		}
		return net;
	}

	async createWallet({ name, network, electrum, wordCount } = {}) {
		const strength = Number(wordCount) === 12 ? 128 : 256;
		const mnemonic = bip39.generateMnemonic(strength);
		return this._provision({ name, network, electrum, mnemonic });
	}

	async importWallet({ name, network, electrum, mnemonic } = {}) {
		const normalized = String(mnemonic || '')
			.trim()
			.toLowerCase()
			.replace(/\s+/g, ' ');
		if (!bip39.validateMnemonic(normalized)) {
			throw httpError(400, 'BAD_MNEMONIC', 'Invalid mnemonic phrase');
		}
		return this._provision({ name, network, electrum, mnemonic: normalized });
	}

	async _provision({ name, network, electrum, mnemonic }) {
		const net = this._validateNetwork(network);
		const resolvedElectrum = this._resolveElectrum(electrum);
		const id = crypto.randomUUID();
		const port = this._allocatePort();
		const rec = {
			id,
			name: (name && String(name).trim()) || `Wallet ${id.slice(0, 4)}`,
			network: net,
			electrum: resolvedElectrum,
			port,
			running: true,
			createdAt: nowIso()
		};

		const p = this.paths(id);
		fs.mkdirSync(p.home, { recursive: true });
		fs.mkdirSync(p.data, { recursive: true });
		fs.mkdirSync(p.secrets, { recursive: true, mode: 0o700 });
		fs.writeFileSync(p.mnemonicFile, mnemonic, { mode: 0o600 });
		fs.writeFileSync(p.tokenFile, crypto.randomBytes(32).toString('hex'), {
			mode: 0o600
		});

		this.registry.upsert(rec);
		await this.startWallet(id);
		return { record: this.publicRecord(id), mnemonic };
	}

	async startWallet(id) {
		const rec = this.registry.get(id);
		if (!rec) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		const rt = this.runtimeState(id);
		if (rt.proc) return;
		rt.stopping = false;

		const p = this.paths(id);
		// Remove any stale pid file so `beignet start` does not report ALREADY_RUNNING.
		try {
			fs.unlinkSync(path.join(p.home, '.beignet', 'daemon.pid'));
		} catch (_) {
			/* no pid file */
		}

		const mnemonic = fs.readFileSync(p.mnemonicFile, 'utf8').trim();
		const token = this.token(id);
		const env = {
			PATH: process.env.PATH,
			HOME: p.home,
			BEIGNET_DATA_DIR: p.data,
			BEIGNET_MNEMONIC: mnemonic,
			BEIGNET_API_TOKEN: token,
			BEIGNET_NETWORK: rec.network,
			BEIGNET_DAEMON_HOST: '127.0.0.1',
			BEIGNET_DAEMON_PORT: String(rec.port),
			BEIGNET_ELECTRUM_HOST: rec.electrum.host,
			BEIGNET_ELECTRUM_PORT: String(rec.electrum.port),
			BEIGNET_ELECTRUM_TLS: rec.electrum.tls ? 'true' : 'false'
		};
		if (process.env.TOR_PROXY_IP) env.TOR_PROXY_IP = process.env.TOR_PROXY_IP;
		if (process.env.TOR_PROXY_PORT) env.TOR_PROXY_PORT = process.env.TOR_PROXY_PORT;

		const { cmd, args } = beignetSpawn();
		rt.status = 'starting';
		rt.healthy = false;
		this._log(
			id,
			`starting on 127.0.0.1:${rec.port} (network ${rec.network}, electrum ${rec.electrum.host}:${rec.electrum.port} tls=${rec.electrum.tls})`
		);

		const proc = spawn(cmd, args, { env, cwd: p.home });
		rt.proc = proc;
		rt.startedAt = Date.now();

		const emit = (buf) =>
			String(buf)
				.split('\n')
				.forEach((line) => {
					if (line.trim()) this._log(id, line.trim());
				});
		proc.stdout.on('data', emit);
		proc.stderr.on('data', emit);

		proc.on('error', (err) => this._log(id, `spawn error: ${err.message}`));
		proc.on('exit', (code, signal) => {
			rt.proc = null;
			rt.healthy = false;
			rt.status = 'stopped';
			this._log(id, `exited code=${code} signal=${signal}`);
			this._maybeRestart(id, rt);
		});

		if (!rec.running) {
			rec.running = true;
			this.registry.upsert(rec);
		}

		this._pollHealth(id).catch(() => {});
	}

	_maybeRestart(id, rt) {
		const rec = this.registry.get(id);
		if (rt.stopping || !rec || !rec.running) return;
		const uptime = Date.now() - (rt.startedAt || 0);
		if (uptime > 60000) rt.restartCount = 0;
		rt.restartCount += 1;
		const delay = Math.min(30000, 1000 * 2 ** Math.min(rt.restartCount, 5));
		rt.status = 'restarting';
		this._log(id, `restarting in ${delay}ms (attempt ${rt.restartCount})`);
		setTimeout(() => {
			const current = this.registry.get(id);
			if (current && current.running && !this.runtimeState(id).proc) {
				this.startWallet(id).catch((err) =>
					this._log(id, `restart failed: ${err.message}`)
				);
			}
		}, delay);
	}

	async _pollHealth(id) {
		const rec = this.registry.get(id);
		if (!rec) return;
		const deadline = Date.now() + HEALTH_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const rt = this.runtimeState(id);
			if (!rt.proc) return;
			try {
				const res = await fetch(`http://127.0.0.1:${rec.port}/health`, {
					signal: AbortSignal.timeout(2000)
				});
				if (res.ok) {
					rt.healthy = true;
					rt.status = 'running';
					this._log(id, 'healthy');
					return;
				}
			} catch (_) {
				/* not up yet */
			}
			await sleep(HEALTH_POLL_MS);
		}
	}

	async stopWallet(id) {
		const rec = this.registry.get(id);
		if (!rec) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		const rt = this.runtimeState(id);
		rt.stopping = true;
		rec.running = false;
		this.registry.upsert(rec);
		if (rt.proc) {
			await this._killProc(rt.proc);
			rt.proc = null;
		}
		rt.status = 'stopped';
		rt.healthy = false;
	}

	_killProc(proc) {
		return new Promise((resolve) => {
			let done = false;
			const finish = () => {
				if (!done) {
					done = true;
					resolve();
				}
			};
			proc.once('exit', finish);
			try {
				proc.kill('SIGTERM');
			} catch (_) {
				finish();
				return;
			}
			setTimeout(() => {
				try {
					proc.kill('SIGKILL');
				} catch (_) {
					/* already gone */
				}
				finish();
			}, KILL_GRACE_MS);
		});
	}

	async deleteWallet(id, { purge = false } = {}) {
		if (!this.registry.get(id)) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		await this.stopWallet(id).catch(() => {});
		const p = this.paths(id);
		this.registry.remove(id);
		this.runtime.delete(id);
		if (purge) {
			fs.rmSync(p.base, { recursive: true, force: true });
		}
	}

	publicRecord(id) {
		const rec = this.registry.get(id);
		if (!rec) return null;
		const rt = this.runtimeState(id);
		return {
			id: rec.id,
			name: rec.name,
			network: rec.network,
			electrum: rec.electrum,
			port: rec.port,
			desiredRunning: !!rec.running,
			status: rt.status,
			healthy: rt.healthy,
			createdAt: rec.createdAt
		};
	}

	list() {
		return this.registry.list().map((rec) => this.publicRecord(rec.id));
	}

	logs(id) {
		return this.runtimeState(id).logs.slice();
	}

	async shutdown() {
		const pending = [];
		for (const rt of this.runtime.values()) {
			if (rt.proc) {
				rt.stopping = true;
				pending.push(this._killProc(rt.proc));
			}
		}
		await Promise.all(pending);
	}
}

module.exports = { WalletManager };
