'use strict';

const fs = require('fs');
const net = require('net');
const tls = require('tls');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const bip39 = require('bip39');
const { config, SUPPORTED_NETWORKS } = require('./config');
const { Registry } = require('./registry');
const { Settings } = require('./settings');
const { TorControl, pickLocalIp } = require('./tor-control');
const { probeSocksConnect } = require('./socks-probe');
const { subscribeToEvents } = require('./node-events');

const HEALTH_TIMEOUT_MS = 45000;
const HEALTH_POLL_MS = 500;
const MAX_LOG_LINES = 300;
// Node-level errors kept per wallet. These carry the reason a channel open
// failed, which the daemon reports only as a transient `node:error` event, so
// they are retained here for the dashboard to read back.
const MAX_NODE_ERRORS = 100;
const KILL_GRACE_MS = 10000;
// The beignet daemon only subscribes to block headers on a successful
// boot-time Electrum connection. If it boots while the server is down it
// reconnects later but stays blind to new blocks, so channel funding
// confirmations are never seen. Defer the spawn until the server accepts
// connections, and restart a daemon whose chain view is stuck.
const ELECTRUM_PROBE_TIMEOUT_MS = 3000;
const ELECTRUM_WAIT_POLL_MS = 5000;
const CHAIN_WATCH_POLL_MS = 30000;
const CHAIN_STALL_POLLS = 3;
const CHAIN_STALL_RESTART_COOLDOWN_MS = 5 * 60 * 1000;
// Tor circuit health: a wallet with Tor enabled dials every peer through
// Umbrel's SOCKS proxy, so if Tor cannot build circuits every connection
// times out. Probe by connecting back to our own onion through the proxy.
const TOR_CIRCUIT_CHECK_MS = 5 * 60 * 1000;
const TOR_CIRCUIT_FIRST_CHECK_MS = 90 * 1000;
const TOR_PROBE_TIMEOUT_MS = 30000;
// Lightning listen port = HTTP daemon port + this offset.
const LISTEN_PORT_OFFSET = 6000;
// Onion virtual ports mapped for inbound (covers the first N wallets).
const ANNOUNCE_PORT_COUNT = 30;

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
		this.settings = new Settings(path.join(config.dataDir, 'settings.json'), {
			defaultNetwork: config.defaultNetwork,
			defaultElectrum: config.defaultElectrum.host ? { ...config.defaultElectrum } : null
		});
		this.runtime = new Map();
		this.onion = null;
		this.torControl = null;
		// null = unknown/not applicable, true/false = last probe result.
		this.torCircuitOk = null;
		this.torProbeTimer = null;
		this.torProbeRunning = false;
	}

	async init() {
		this.settings.load();
		this.registry.load();
		// Publish the inbound hidden service via Umbrel's system Tor before boot
		// so announce-enabled wallets advertise the onion from the start.
		if (config.torProxyIp && config.torPassword) {
			const ports = Array.from(
				{ length: ANNOUNCE_PORT_COUNT },
				(_, i) => config.childPortBase + LISTEN_PORT_OFFSET + i
			);
			this.torControl = new TorControl({
				host: config.torProxyIp,
				port: config.torControlPort,
				password: config.torPassword,
				keyFile: path.join(config.dataDir, 'onion_key'),
				ports,
				log: (m) => process.stdout.write(`${m}\n`),
				onPublished: (onion) => this._onOnion(onion)
			});
			this.onion = await this.torControl.start();
		}
		for (const rec of this.registry.list()) {
			if (rec.running) {
				this.startWallet(rec.id).catch((err) =>
					this._log(rec.id, `start on boot failed: ${err.message}`)
				);
			}
		}
		if (config.torProxy) {
			setTimeout(() => {
				this._checkTorCircuit().catch(() => {});
			}, TOR_CIRCUIT_FIRST_CHECK_MS);
			this.torProbeTimer = setInterval(() => {
				this._checkTorCircuit().catch(() => {});
			}, TOR_CIRCUIT_CHECK_MS);
		}
	}

	// Connect back to our own onion through the Tor SOCKS proxy. Success
	// requires working circuits, HSDir lookups, and a rendezvous, which is
	// the same machinery Tor-enabled wallets need for outbound peers.
	async _checkTorCircuit() {
		if (!config.torProxy || !this.onion || this.torProbeRunning) return;
		// Only a wallet whose listen port is actually onion-mapped can be probed;
		// otherwise the self-connect would fail on the mapping, not on Tor.
		const target = this.registry
			.list()
			.find(
				(rec) =>
					rec.tor &&
					rec.running &&
					this.runtimeState(rec.id).healthy &&
					this._onionMapsPort(this.listenPort(rec))
			);
		if (!target) {
			this.torCircuitOk = null;
			return;
		}
		this.torProbeRunning = true;
		try {
			const targetIp = pickLocalIp();
			const listenPort = this.listenPort(target);
			// The probe's SOCKS round-trip only succeeds if the wallet's LN listener
			// accepts the forwarded connection. If we cannot even reach that listener
			// locally, the failure is the listener (e.g. not up yet), not Tor, so
			// leave the previous verdict untouched rather than blaming Tor.
			if (targetIp && !(await this._probeTcp(targetIp, listenPort))) {
				return;
			}
			const [proxyHost, proxyPort] = config.torProxy.split(':');
			const ok = await probeSocksConnect({
				proxyHost,
				proxyPort: parseInt(proxyPort, 10),
				host: this.onion,
				port: listenPort,
				timeoutMs: TOR_PROBE_TIMEOUT_MS
			});
			if (this.torCircuitOk !== ok) {
				process.stdout.write(
					ok
						? 'tor circuit check: ok\n'
						: 'tor circuit check: failing (Tor-enabled wallets cannot reach peers; they will report connection timeouts)\n'
				);
			}
			this.torCircuitOk = ok;
		} finally {
			this.torProbeRunning = false;
		}
	}

	// True when the published onion maps this wallet's LN listen port. The onion
	// maps a fixed window of ANNOUNCE_PORT_COUNT ports from childPortBase; wallets
	// allocated beyond it cannot be reached over the onion.
	_onionMapsPort(listenPort) {
		const base = config.childPortBase + LISTEN_PORT_OFFSET;
		return listenPort >= base && listenPort < base + ANNOUNCE_PORT_COUNT;
	}

	listenPort(rec) {
		return rec.port + LISTEN_PORT_OFFSET;
	}

	// Called when the hidden service is (re)published; restart running
	// announce-enabled wallets so they advertise the (possibly new) onion.
	_onOnion(onion) {
		const changed = this.onion !== onion;
		this.onion = onion;
		if (!changed) return;
		for (const rec of this.registry.list()) {
			if (rec.announce && rec.running && this.runtimeState(rec.id).proc) {
				this.updateWallet(rec.id, {}).catch(() => {});
			}
		}
	}

	onionAvailable() {
		return !!this.onion;
	}

	onionAddress(rec) {
		if (!this.onion || !rec.announce) return null;
		const listenPort = this.listenPort(rec);
		// Do not advertise an address the onion does not actually forward.
		return this._onionMapsPort(listenPort) ? `${this.onion}:${listenPort}` : null;
	}

	runtimeState(id) {
		if (!this.runtime.has(id)) {
			this.runtime.set(id, {
				proc: null,
				status: 'stopped',
				healthy: false,
				logs: [],
				nodeErrors: [],
				events: null,
				restartCount: 0,
				stopping: false,
				spawning: false,
				startedAt: null,
				electrumWait: null,
				chainWatch: null,
				chainStallPolls: 0,
				lastStallRestartAt: 0
			});
		}
		return this.runtime.get(id);
	}

	// Resolves true once a TCP connection to host:port is established.
	_probeTcp(host, port, timeoutMs = ELECTRUM_PROBE_TIMEOUT_MS) {
		return new Promise((resolve) => {
			const socket = net.connect({ host, port });
			let done = false;
			const finish = (ok) => {
				if (done) return;
				done = true;
				socket.destroy();
				resolve(ok);
			};
			socket.setTimeout(timeoutMs);
			socket.once('connect', () => finish(true));
			socket.once('timeout', () => finish(false));
			socket.once('error', () => finish(false));
		});
	}

	_probeElectrum({ host, port }) {
		return this._probeTcp(host, port);
	}

	// Queries an Electrum server for its current chain tip height. Resolves null
	// if the tip cannot be determined. Honors TLS so it works with either preset.
	_electrumTip({ host, port, tls: useTls }) {
		return new Promise((resolve) => {
			let done = false;
			let buf = '';
			let socket;
			const finish = (val) => {
				if (done) return;
				done = true;
				try {
					socket.destroy();
				} catch (_) {
					/* already gone */
				}
				resolve(val);
			};
			try {
				socket = useTls
					? tls.connect({ host, port, rejectUnauthorized: false })
					: net.connect({ host, port });
			} catch (_) {
				return resolve(null);
			}
			socket.setTimeout(ELECTRUM_PROBE_TIMEOUT_MS);
			socket.once(useTls ? 'secureConnect' : 'connect', () => {
				socket.write(
					`${JSON.stringify({ id: 1, method: 'blockchain.headers.subscribe', params: [] })}\n`
				);
			});
			socket.on('data', (chunk) => {
				buf += chunk.toString('utf8');
				const nl = buf.indexOf('\n');
				if (nl === -1) return;
				try {
					const msg = JSON.parse(buf.slice(0, nl));
					const height =
						msg && msg.result && typeof msg.result.height === 'number'
							? msg.result.height
							: null;
					finish(height);
				} catch (_) {
					finish(null);
				}
			});
			socket.once('timeout', () => finish(null));
			socket.once('error', () => finish(null));
		});
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

	_normalizeElectrum(input) {
		const host = String((input && input.host) || '').trim();
		if (!host) throw httpError(400, 'BAD_ELECTRUM', 'Electrum host is required');
		const port = parseInt(input.port, 10);
		if (!Number.isFinite(port) || port <= 0 || port > 65535) {
			throw httpError(400, 'BAD_ELECTRUM', 'Invalid Electrum port');
		}
		return { host, port, tls: !!input.tls };
	}

	defaultElectrum() {
		const def = this.settings.get().defaultElectrum;
		return def && def.host ? { ...def } : null;
	}

	defaultNetwork() {
		const n = this.settings.get().defaultNetwork || config.defaultNetwork || 'mainnet';
		// Guard against a previously-persisted unsupported network (e.g. testnet4).
		return SUPPORTED_NETWORKS.includes(n) ? n : 'mainnet';
	}

	_resolveElectrum(input) {
		if (input && input.host) return this._normalizeElectrum(input);
		const def = this.defaultElectrum();
		if (def) return def;
		throw httpError(
			400,
			'NO_ELECTRUM',
			'No Electrum server set. Choose one for this wallet or set an app default in Settings.'
		);
	}

	_validateNetwork(network) {
		const net = network || this.defaultNetwork();
		if (!SUPPORTED_NETWORKS.includes(net)) {
			throw httpError(
				400,
				'BAD_NETWORK',
				`Unsupported network "${net}". Supported: ${SUPPORTED_NETWORKS.join(', ')}.`
			);
		}
		return net;
	}

	getSettings() {
		return {
			defaultNetwork: this.defaultNetwork(),
			defaultElectrum: this.defaultElectrum()
		};
	}

	updateSettings(patch = {}) {
		const next = {};
		if (patch.defaultNetwork !== undefined) {
			if (!SUPPORTED_NETWORKS.includes(patch.defaultNetwork)) {
				throw httpError(
					400,
					'BAD_NETWORK',
					`Unsupported network "${patch.defaultNetwork}".`
				);
			}
			next.defaultNetwork = patch.defaultNetwork;
		}
		if (patch.defaultElectrum !== undefined) {
			next.defaultElectrum =
				patch.defaultElectrum === null
					? null
					: this._normalizeElectrum(patch.defaultElectrum);
		}
		this.settings.update(next);
		return this.getSettings();
	}

	async createWallet({ name, network, electrum, wordCount, tor, announce } = {}) {
		const strength = Number(wordCount) === 12 ? 128 : 256;
		const mnemonic = bip39.generateMnemonic(strength);
		return this._provision({ name, network, electrum, mnemonic, tor, announce });
	}

	async importWallet({ name, network, electrum, mnemonic, tor, announce } = {}) {
		const normalized = String(mnemonic || '')
			.trim()
			.toLowerCase()
			.replace(/\s+/g, ' ');
		if (!bip39.validateMnemonic(normalized)) {
			throw httpError(400, 'BAD_MNEMONIC', 'Invalid mnemonic phrase');
		}
		return this._provision({ name, network, electrum, mnemonic: normalized, tor, announce });
	}

	async _provision({ name, network, electrum, mnemonic, tor, announce }) {
		const net = this._validateNetwork(network);
		const resolvedElectrum = this._resolveElectrum(electrum);
		const id = crypto.randomUUID();
		const port = this._allocatePort();
		const rec = {
			id,
			name: (name && String(name).trim()) || `Wallet ${id.slice(0, 4)}`,
			network: net,
			electrum: resolvedElectrum,
			tor: !!tor,
			announce: !!announce,
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

	async updateWallet(id, { name, electrum, tor, announce } = {}) {
		const rec = this.registry.get(id);
		if (!rec) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		if (name !== undefined && String(name).trim()) rec.name = String(name).trim();
		if (electrum !== undefined) rec.electrum = this._normalizeElectrum(electrum);
		if (tor !== undefined) rec.tor = !!tor;
		if (announce !== undefined) rec.announce = !!announce;
		this.registry.upsert(rec);
		// Restart a running daemon so it reconnects with the new Electrum config.
		const rt = this.runtimeState(id);
		if (rt.proc) {
			rt.stopping = true;
			await this._killProc(rt.proc);
			rt.proc = null;
			rt.stopping = false;
			await this.startWallet(id);
		}
		return this.publicRecord(id);
	}

	async startWallet(id) {
		const rec = this.registry.get(id);
		if (!rec) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		const rt = this.runtimeState(id);
		if (rt.proc || rt.spawning) return;
		rt.spawning = true;
		try {
			await this._startWalletLocked(id, rec, rt);
		} finally {
			rt.spawning = false;
		}
	}

	async _startWalletLocked(id, rec, rt) {
		rt.stopping = false;
		if (rt.electrumWait) {
			clearTimeout(rt.electrumWait);
			rt.electrumWait = null;
		}

		if (!(await this._probeElectrum(rec.electrum))) {
			rt.status = 'waiting-electrum';
			rt.healthy = false;
			this._log(
				id,
				`electrum ${rec.electrum.host}:${rec.electrum.port} unreachable; waiting for it before starting`
			);
			if (!rec.running) {
				rec.running = true;
				this.registry.upsert(rec);
			}
			rt.electrumWait = setTimeout(() => {
				rt.electrumWait = null;
				const current = this.registry.get(id);
				if (!current || !current.running || rt.stopping || rt.proc) return;
				this.startWallet(id).catch((err) =>
					this._log(id, `deferred start failed: ${err.message}`)
				);
			}, ELECTRUM_WAIT_POLL_MS);
			return;
		}

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
			// Enable an inbound Lightning listen port so other nodes can connect.
			// Derived from the (unique) HTTP port; matches the torrc mapping.
			BEIGNET_LISTEN_PORT: String(this.listenPort(rec)),
			BEIGNET_ELECTRUM_HOST: rec.electrum.host,
			BEIGNET_ELECTRUM_PORT: String(rec.electrum.port),
			BEIGNET_ELECTRUM_TLS: rec.electrum.tls ? 'true' : 'false',
			// The daemon only builds a logger when a log level is set; without one
			// it runs silent and its stdout carries nothing to show in the Logs
			// tab. Overridable so a noisy wallet can be turned down (or up to
			// debug when diagnosing a peer).
			BEIGNET_LOG_LEVEL: process.env.BEIGNET_LOG_LEVEL || 'info'
		};
		if (process.env.TOR_PROXY_IP) env.TOR_PROXY_IP = process.env.TOR_PROXY_IP;
		if (process.env.TOR_PROXY_PORT) env.TOR_PROXY_PORT = process.env.TOR_PROXY_PORT;
		// Route Lightning peer connections through Umbrel's Tor proxy when enabled.
		if (rec.tor && config.torProxy) env.BEIGNET_TOR_PROXY = config.torProxy;
		// Advertise the onion address so peers can open inbound channels, but only
		// when the onion actually forwards this wallet's listen port.
		if (rec.announce && this.onion && this._onionMapsPort(this.listenPort(rec))) {
			env.BEIGNET_ANNOUNCE_ADDRESSES = `${this.onion}:${this.listenPort(rec)}`;
		}

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
			if (rt.chainWatch) {
				clearInterval(rt.chainWatch);
				rt.chainWatch = null;
			}
			this._stopEvents(rt);
			this._log(id, `exited code=${code} signal=${signal}`);
			this._maybeRestart(id, rt);
		});

		this._startEvents(id, rec, rt);

		if (!rec.running) {
			rec.running = true;
			this.registry.upsert(rec);
		}

		rt.chainStallPolls = 0;
		rt.chainWatch = setInterval(() => {
			this._checkChainStall(id).catch(() => {});
		}, CHAIN_WATCH_POLL_MS);

		this._pollHealth(id).catch(() => {});
	}

	// Subscribe to the daemon's event stream. The reason a channel open failed
	// (peer rejection, funding build/broadcast failure, disconnect mid-open) is
	// only ever reported as a `node:error` event: it is not part of any resource
	// and nothing can poll for it. Without this subscription the pending channel
	// simply disappears from /channels and the reason is lost, which is exactly
	// what made failed opens look like they had silently succeeded.
	_startEvents(id, rec, rt) {
		this._stopEvents(rt);
		let token;
		try {
			token = this.token(id);
		} catch (_) {
			return; // no token yet; the daemon cannot be subscribed to
		}
		rt.events = subscribeToEvents({
			port: rec.port,
			token,
			log: (m) => this._log(id, m),
			onEvent: (name, data) => {
				if (name !== 'node:error' || !data) return;
				const entry = {
					code: data.code || 'ERROR',
					message: data.message || 'Unknown error',
					channelId: data.channelId || null,
					timestamp: data.timestamp || Date.now()
				};
				rt.nodeErrors.push(entry);
				if (rt.nodeErrors.length > MAX_NODE_ERRORS) rt.nodeErrors.shift();
				// Also put it in the log ring so it shows up in the dashboard's
				// Logs tab alongside the daemon's own output.
				this._log(id, `node error [${entry.code}] ${entry.message}`);
			}
		});
	}

	_stopEvents(rt) {
		if (rt.events) {
			rt.events.stop();
			rt.events = null;
		}
	}

	// A daemon that reports an Electrum connection but a block height of zero
	// has lost (or never made) its header subscription; nothing on-chain will
	// ever confirm for it. A restart with Electrum reachable recovers it.
	async _checkChainStall(id) {
		const rec = this.registry.get(id);
		const rt = this.runtimeState(id);
		if (!rec || !rt.proc || rt.stopping) return;
		let health = null;
		try {
			const res = await fetch(`http://127.0.0.1:${rec.port}/health`, {
				signal: AbortSignal.timeout(5000)
			});
			if (res.ok) health = (await res.json()).result;
		} catch (_) {
			/* daemon unreachable; not a chain stall */
		}
		if (!health || health.electrumConnected !== true || health.blockHeight !== 0) {
			rt.chainStallPolls = 0;
			return;
		}
		// blockHeight 0 while Electrum is connected is only a lost subscription if
		// the chain actually has blocks past genesis. On regtest (or any chain
		// whose tip really is 0) it is legitimate, so confirm the server's tip
		// before restarting; if the tip is unknown or 0, do not treat it as a
		// stall (avoids a perpetual restart loop on a fresh regtest wallet).
		const tip = await this._electrumTip(rec.electrum);
		if (tip === null || tip <= 0) {
			rt.chainStallPolls = 0;
			return;
		}
		// The daemon may have stopped while awaiting the tip; re-check before using
		// rt.proc so a concurrent stop cannot turn into a restart or a null kill.
		if (!rt.proc || rt.stopping) {
			rt.chainStallPolls = 0;
			return;
		}
		rt.chainStallPolls += 1;
		if (rt.chainStallPolls < CHAIN_STALL_POLLS) return;
		if (Date.now() - rt.lastStallRestartAt < CHAIN_STALL_RESTART_COOLDOWN_MS) return;
		rt.lastStallRestartAt = Date.now();
		rt.chainStallPolls = 0;
		this._log(
			id,
			'electrum connected but block height stuck at 0; restarting daemon to restore header subscription'
		);
		try {
			rt.stopping = true;
			await this._killProc(rt.proc);
			rt.proc = null;
			rt.stopping = false;
			await this.startWallet(id);
		} catch (err) {
			rt.stopping = false;
			this._log(id, `stall restart failed: ${err.message}`);
		}
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
		if (rt.electrumWait) {
			clearTimeout(rt.electrumWait);
			rt.electrumWait = null;
		}
		rec.running = false;
		this.registry.upsert(rec);
		this._stopEvents(rt);
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
			tor: !!rec.tor,
			announce: !!rec.announce,
			onionAddress: this.onionAddress(rec),
			// Only meaningful for Tor-enabled wallets: false means the last
			// probe could not build a circuit, so peer connects will time out.
			torCircuitOk: rec.tor ? this.torCircuitOk : null,
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

	// Append a line to a wallet's log ring from outside the supervisor, so a
	// failure the manager sees on the wallet's behalf (a rejected daemon call,
	// say) is visible in the dashboard's Logs tab alongside the daemon's own
	// output, rather than only in the browser that happened to make the request.
	recordLog(id, line) {
		this._log(id, line);
	}

	// Recent node-level errors, newest last. `since` filters by timestamp so a
	// caller watching a channel open can ask only for what happened after it
	// started, rather than re-reading errors from an earlier attempt.
	nodeErrors(id, { since } = {}) {
		const errors = this.runtimeState(id).nodeErrors;
		if (!since) return errors.slice();
		return errors.filter((e) => e.timestamp >= since);
	}

	async shutdown() {
		if (this.torControl) this.torControl.stop();
		if (this.torProbeTimer) {
			clearInterval(this.torProbeTimer);
			this.torProbeTimer = null;
		}
		const pending = [];
		for (const rt of this.runtime.values()) {
			if (rt.electrumWait) {
				clearTimeout(rt.electrumWait);
				rt.electrumWait = null;
			}
			if (rt.chainWatch) {
				clearInterval(rt.chainWatch);
				rt.chainWatch = null;
			}
			this._stopEvents(rt);
			if (rt.proc) {
				rt.stopping = true;
				pending.push(this._killProc(rt.proc));
			}
		}
		await Promise.all(pending);
	}
}

module.exports = { WalletManager };
