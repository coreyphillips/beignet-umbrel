'use strict';

const fs = require('fs');
const os = require('os');
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
const { ChannelEventLog } = require('./channel-events');
const {
	GUARDIAN_SET_SIZE,
	isRecoveryMode,
	isGuardianMode,
	validateGuardianDraft,
	sameGuardianSet,
	recoveryEnv,
	parseGuardianEntry
} = require('./recovery');
const {
	engineVersion,
	recoveryAvailable,
	lfbwAvailable,
	jitQuoteAvailable,
	recoveryAutoApplyAvailable,
	guardianHostingAvailable
} = require('./engine');
const lfbw = require('./lfbw');

const HEALTH_TIMEOUT_MS = 45000;
const HEALTH_POLL_MS = 500;
// A daemon holding for a guardian restore answers /health with 503 until
// the restore runs, which can be never if nobody asks for it. The startup
// poll keeps watching it at this pace instead of giving up; a local GET
// every two seconds is cheap, and it is how soon the wallet reads running
// once the restore has built the node.
const RESTORE_HOLD_POLL_MS = 2000;
// How many straight restore-pending answers a peer-storage daemon may give
// while rebuilding on a checkpoint before it is read as holding after all.
const CHECKPOINT_REBUILD_MAX_POLLS = 12;
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
		// Per-wallet durable channel history (see channel-events.js). Keyed
		// separately from runtime state so it is readable while a wallet is
		// stopped and survives runtime resets.
		this.channelLogs = new Map();
		this.onion = null;
		this.torControl = null;
		// null = unknown/not applicable, true/false = last probe result.
		this.torCircuitOk = null;
		this.torProbeTimer = null;
		this.torProbeRunning = false;
		// The bundled engine's version (null when it cannot be read), which
		// decides whether the dashboard offers features the engine predates.
		this.engineVersion = engineVersion();
		// Lightning-first wallets need routes the engine gained after 0.9.3
		// (JIT receive, direct funding); probed on the bundled engine itself.
		this.lfbwSupported = lfbwAvailable();
		// The two follow-ups probed the same way: a JIT fee quote (beignet
		// #687) and the daemon applying a peer-storage checkpoint by itself
		// (beignet #690).
		this.jitQuoteSupported = jitQuoteAvailable();
		this.recoveryAutoApplySupported = recoveryAutoApplyAvailable();
		// A wallet serving the reference guardian to other beignet nodes at its
		// Lightning address, and a node URI resolving to a guardian entry
		// (beignet #699), probed on the bundle like the rest.
		this.guardianHostingSupported = guardianHostingAvailable();
		// Lightning-first setups in flight, one per wallet at a time.
		this.lfbwSetupRunning = new Set();
	}

	async init() {
		this.settings.load();
		this.registry.load();
		process.stdout.write(
			`engine: beignet ${this.engineVersion || 'unknown version'}` +
				`${this.recoveryAvailable() ? '' : ' (recovery protocol not available)'}\n`
		);
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
					// An on-chain only wallet runs no Lightning listener, so it can
					// never answer the probe; selecting it would fail the local
					// precheck below on every cycle and starve the probe for the
					// wallets that could actually answer.
					!rec.onchainOnly &&
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
				healthFailPolls: 0,
				lastStallRestartAt: 0,
				// The daemon's own reason for a failed start (its START_FAILED
				// line), kept so a wallet stuck restarting can say why.
				lastStartError: null,
				// The env the running daemon was spawned with, so a record edit
				// that changes the daemon's role can tell whether a restart is
				// due (lightning-first liquidity provider).
				spawnedEnv: null,
				// Lightning-first channelize: the backstop interval, the
				// event-driven debounce timer, and the in-flight/backoff guards.
				lfbwWatch: null,
				lfbwTimer: null,
				lfbwBusy: false,
				lfbwRetryAt: 0,
				// What the last channelize pass decided (why a deposit waits).
				lfbwLast: null
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

	recoveryGuardians() {
		const list = this.settings.get().recoveryGuardians;
		return Array.isArray(list) ? list.slice() : [];
	}

	lfbwAvailable() {
		return this.lfbwSupported === true;
	}

	jitQuoteAvailable() {
		return this.jitQuoteSupported === true;
	}

	recoveryAutoApplyAvailable() {
		return this.recoveryAutoApplySupported === true;
	}

	guardianHostingAvailable() {
		return this.guardianHostingSupported === true;
	}

	recoveryAvailable() {
		return recoveryAvailable(this.engineVersion);
	}

	getSettings() {
		return {
			defaultNetwork: this.defaultNetwork(),
			defaultElectrum: this.defaultElectrum(),
			recoveryGuardians: this.recoveryGuardians()
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
		if (patch.recoveryGuardians !== undefined) {
			// A draft, not a set: settings hold however many guardians are
			// known so far, so a set can be collected one server at a time.
			// The all-three rule belongs to the wallet that enables a
			// guardian mode, which is where _normalizeRecovery states it.
			try {
				next.recoveryGuardians = validateGuardianDraft(
					patch.recoveryGuardians === null ? [] : patch.recoveryGuardians
				);
			} catch (err) {
				throw httpError(400, 'BAD_GUARDIANS', err.message);
			}
			// A bolt8 entry names a beignet node as the guardian (beignet #699);
			// an engine without that transport would refuse to start any wallet
			// pinned to it, so the draft is refused here instead, with the reason.
			if (
				!this.guardianHostingAvailable() &&
				next.recoveryGuardians.some((entry) => parseGuardianEntry(entry).bolt8)
			) {
				throw httpError(
					400,
					'GUARDIAN_HOSTING_UNSUPPORTED',
					'A beignet node as a guardian needs an engine that speaks the bolt8 guardian transport; update the app first.'
				);
			}
		}
		this.settings.update(next);
		return this.getSettings();
	}

	/**
	 * The recovery field a wallet record should carry after a request names
	 * `mode`. The rules the daemon would otherwise enforce with a refused
	 * start, plus two of its own: a guardian set is pinned to the wallet the
	 * first time a guardian mode is enabled and never replaced (protocol v1
	 * has no set rotation; a wallet that moved sets would lose its journal),
	 * and quorum is never left once entered (a journal that holds a quorum
	 * frame refuses to run without its barrier, so the change would only
	 * produce a wallet that cannot start).
	 */
	/**
	 * The per-wallet "serve as guardian" flag (beignet #699): needs an engine
	 * that hosts guardians and a Lightning listener, so it is refused on an
	 * engine without the surface and dropped for an on-chain only wallet.
	 */
	_normalizeGuardianServe(value, onchainOnly) {
		if (value === undefined || value === null) return false;
		if (!value) return false;
		if (!this.guardianHostingAvailable()) {
			throw httpError(
				400,
				'GUARDIAN_HOSTING_UNSUPPORTED',
				'The bundled engine cannot host a guardian yet; update the app first.'
			);
		}
		if (onchainOnly) {
			throw httpError(
				400,
				'GUARDIAN_SERVE_NEEDS_LIGHTNING',
				'An on-chain only wallet runs no Lightning listener, so it cannot serve as a guardian.'
			);
		}
		return true;
	}

	_normalizeRecovery(mode, existing, autoApply) {
		const current = existing || { mode: 'off', guardians: [] };
		const resolvedMode = mode === undefined ? current.mode || 'off' : mode;
		if (!isRecoveryMode(resolvedMode)) {
			throw httpError(400, 'BAD_RECOVERY_MODE', `Unknown channel backup mode "${mode}".`);
		}
		if (mode !== undefined && mode !== 'off' && !this.recoveryAvailable()) {
			throw httpError(
				400,
				'RECOVERY_UNSUPPORTED',
				`The bundled beignet (${this.engineVersion || 'unknown version'}) predates channel backup.`
			);
		}
		if (current.mode === 'quorum' && resolvedMode !== 'quorum') {
			throw httpError(
				409,
				'RECOVERY_QUORUM_STICKY',
				'A wallet that has used strict quorum cannot move to a weaker setting: its journal refuses to run without the quorum barrier. Keep quorum, or create a new wallet.'
			);
		}
		let guardians = current.guardians || [];
		if (isGuardianMode(resolvedMode) && guardians.length === 0) {
			guardians = this.recoveryGuardians();
			if (guardians.length !== GUARDIAN_SET_SIZE) {
				throw httpError(
					400,
					'NO_GUARDIANS',
					guardians.length === 0
						? 'Guardian modes need three guardians. Set them in Settings first.'
						: `Guardian modes need three guardians. Settings has ${guardians.length}: add the rest first.`
				);
			}
		}
		// The one-time answer to "is the previous device stopped?": with it
		// the daemon applies the newest peer-storage checkpoint by itself on
		// an empty database (beignet #690). It only means anything under peer
		// storage; any other mode drops it, so the env never carries a flag
		// the daemon would refuse to start with.
		const wanted = autoApply === undefined ? current.autoApply === true : autoApply === true;
		if (autoApply === true && !this.recoveryAutoApplyAvailable()) {
			throw httpError(
				400,
				'RECOVERY_AUTO_APPLY_UNSUPPORTED',
				`The bundled beignet (${this.engineVersion || 'unknown version'}) cannot apply a checkpoint by itself.`
			);
		}
		const result = { mode: resolvedMode, guardians };
		if (resolvedMode === 'peer-storage' && wanted) result.autoApply = true;
		return result;
	}

	async createWallet({
		name,
		network,
		electrum,
		wordCount,
		tor,
		announce,
		onchainOnly,
		recoveryMode,
		recoveryAutoApply,
		guardianServe,
		lfbw: lfbwInput
	} = {}) {
		const strength = Number(wordCount) === 12 ? 128 : 256;
		const mnemonic = bip39.generateMnemonic(strength);
		return this._provision({
			name,
			network,
			electrum,
			mnemonic,
			tor,
			announce,
			onchainOnly,
			recoveryMode,
			recoveryAutoApply,
			guardianServe,
			lfbw: lfbwInput
		});
	}

	async importWallet({
		name,
		network,
		electrum,
		mnemonic,
		tor,
		announce,
		onchainOnly,
		recoveryMode,
		recoveryAutoApply,
		guardianServe,
		lfbw: lfbwInput
	} = {}) {
		const normalized = String(mnemonic || '')
			.trim()
			.toLowerCase()
			.replace(/\s+/g, ' ');
		if (!bip39.validateMnemonic(normalized)) {
			throw httpError(400, 'BAD_MNEMONIC', 'Invalid mnemonic phrase');
		}
		return this._provision({
			name,
			network,
			electrum,
			mnemonic: normalized,
			tor,
			announce,
			onchainOnly,
			recoveryMode,
			recoveryAutoApply,
			guardianServe,
			lfbw: lfbwInput
		});
	}

	async _provision({
		name,
		network,
		electrum,
		mnemonic,
		tor,
		announce,
		onchainOnly,
		recoveryMode,
		recoveryAutoApply,
		guardianServe,
		lfbw: lfbwInput
	}) {
		const net = this._validateNetwork(network);
		const resolvedElectrum = this._resolveElectrum(electrum);
		// Channel backup is a Lightning concern; an on-chain only wallet is
		// created without it (the dashboard does not offer the choice there).
		const recovery = this._normalizeRecovery(onchainOnly ? 'off' : recoveryMode, null, recoveryAutoApply);
		const id = crypto.randomUUID();
		// Lightning-first is Lightning too: an on-chain only wallet has no
		// home channel to keep, so the flag wins over the block.
		const lfbwBlock = onchainOnly ? null : this._normalizeLfbw(lfbwInput, { network: net, selfId: id });
		const port = this._allocatePort();
		const rec = {
			id,
			name: (name && String(name).trim()) || `Wallet ${id.slice(0, 4)}`,
			network: net,
			electrum: resolvedElectrum,
			tor: !!tor,
			// Announcing is inbound Lightning, which an on-chain only wallet
			// has sworn off, so the flag wins over the checkbox.
			announce: !!announce && !onchainOnly,
			onchainOnly: !!onchainOnly,
			recovery,
			// Serving the reference guardian to other beignet nodes needs the
			// Lightning listener, which an on-chain only wallet does not run.
			guardianServe: this._normalizeGuardianServe(guardianServe, onchainOnly),
			lfbw: lfbwBlock,
			// A wallet becomes a liquidity provider when a lightning-first
			// sibling picks it as primary (setupLfbw flips this), or when the
			// operator turns it on to serve external wallets.
			liquidityProvider: false,
			jit: lfbw.normalizeJit(undefined),
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
		// Lightning-first setup (trust, the direct-funding policy, the peer
		// connection, the optional first channel) needs a healthy daemon; the
		// startup health poll kicks it off and the dashboard reads progress
		// off the record's lfbw.setup field.
		return { record: this.publicRecord(id), mnemonic };
	}

	_normalizeLfbw(input, { network, selfId, existing }) {
		return lfbw.normalizeLfbw(input, {
			network,
			selfId,
			existing,
			available: this.lfbwAvailable(),
			getRecord: (id) => this.registry.get(id)
		});
	}

	/** The lightning-first wallets whose internal primary this wallet is. */
	_dependents(rec) {
		return lfbw.dependentsOf(rec, this.registry.list());
	}

	_refuseIfPrimaryInUse(rec, what) {
		const dependents = this._dependents(rec);
		if (dependents.length === 0) return;
		const names = dependents.map((d) => `"${d.name}"`).join(', ');
		const err = httpError(
			409,
			'PRIMARY_IN_USE',
			`${what}: it is the primary node of ${names}. Change their primary node or delete them first.`
		);
		err.details = { dependents: dependents.map((d) => ({ id: d.id, name: d.name })) };
		throw err;
	}

	async updateWallet(
		id,
		{
			name,
			electrum,
			tor,
			announce,
			onchainOnly,
			recoveryMode,
			recoveryAutoApply,
			guardianServe,
			lfbw: lfbwInput,
			liquidityProvider,
			jit
		} = {}
	) {
		const rec = this.registry.get(id);
		if (!rec) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		const rt = this.runtimeState(id);
		// Every update restarts a running daemon. Restarting one mid-restore
		// abandons a guardian takeover the user is watching (the engine
		// resumes it on the next attempt, but nothing on screen says so).
		if (rt.proc && rt.status === 'restore-required' && (await this._restoreInFlight(rec))) {
			throw httpError(
				409,
				'RESTORE_IN_PROGRESS',
				'This wallet is restoring from its guardians. Wait for the restore to finish before editing it.'
			);
		}
		// Validate before touching the record, so a refused mode leaves the
		// wallet exactly as it was.
		const recovery = this._normalizeRecovery(recoveryMode, rec.recovery, recoveryAutoApply);
		// A wallet other wallets depend on for their home channel cannot stop
		// serving them by a flag flip: they would lose inbound, direct
		// funding and their channelize path at once.
		if (onchainOnly === true && !rec.onchainOnly) {
			this._refuseIfPrimaryInUse(rec, 'This wallet cannot be made on-chain only');
		}
		if (liquidityProvider === false && rec.liquidityProvider) {
			this._refuseIfPrimaryInUse(rec, 'This wallet cannot stop providing liquidity');
		}
		const nextJit = jit !== undefined ? lfbw.normalizeJit(jit, rec.jit) : undefined;
		const nextLfbw =
			lfbwInput !== undefined
				? this._normalizeLfbw(lfbwInput, { network: rec.network, selfId: rec.id, existing: rec.lfbw })
				: undefined;
		if (nextLfbw && (onchainOnly === true || (onchainOnly === undefined && rec.onchainOnly))) {
			throw httpError(400, 'BAD_LFBW_PEER', 'An on-chain only wallet cannot be lightning-first');
		}
		if (name !== undefined && String(name).trim()) rec.name = String(name).trim();
		if (electrum !== undefined) rec.electrum = this._normalizeElectrum(electrum);
		if (tor !== undefined) rec.tor = !!tor;
		if (announce !== undefined) rec.announce = !!announce;
		// The same seed backs both modes, so this is freely reversible: the
		// Lightning identity derives from the mnemonic whether or not it has
		// ever been used. Turning Lightning OFF is guarded in the dashboard
		// (open channels need eyes on them), not here: the daemon keeps
		// watching its channels either way, this flag only decides whether it
		// LISTENS for new Lightning and whether the dashboard offers it.
		if (onchainOnly !== undefined) {
			rec.onchainOnly = !!onchainOnly;
			if (rec.onchainOnly) rec.announce = false;
		}
		if (guardianServe !== undefined) {
			rec.guardianServe = this._normalizeGuardianServe(guardianServe, rec.onchainOnly);
		} else if (rec.onchainOnly && rec.guardianServe) {
			// Parking Lightning stops the listener the guardian is served on.
			rec.guardianServe = false;
		}
		// Unlike announce, channel backup survives a switch to on-chain only:
		// a parked quorum wallet still has to boot with its barrier, or it
		// does not boot at all.
		rec.recovery = recovery;
		if (nextLfbw !== undefined) rec.lfbw = nextLfbw;
		if (rec.onchainOnly) rec.lfbw = null;
		if (liquidityProvider !== undefined) rec.liquidityProvider = !!liquidityProvider;
		if (nextJit !== undefined) rec.jit = nextJit;
		this.registry.upsert(rec);
		// Restart a running daemon so it reconnects with the new Electrum config.
		if (rt.proc) await this._restartWallet(id);
		return this.publicRecord(id);
	}

	/** Kill a running daemon and start it again with the record as it is now. */
	async _restartWallet(id) {
		const rt = this.runtimeState(id);
		if (!rt.proc) return;
		rt.stopping = true;
		await this._killProc(rt.proc);
		rt.proc = null;
		rt.stopping = false;
		await this.startWallet(id);
	}

	/**
	 * The daemon's environment, extracted so a test can hold the one contract
	 * that decides a wallet's Lightning posture without spawning anything:
	 * on-chain only means no BEIGNET_LISTEN_PORT (the daemon only starts its
	 * listener when a port is configured) and BEIGNET_AUTO_RECONNECT=false
	 * (or the daemon dials its channel partners back and the channels quietly
	 * reestablish). Engines before that env landed ignore it and lose only
	 * the outbound half of the quiet.
	 */
	_daemonEnv(rec, p, mnemonic, token) {
		const env = {
			PATH: process.env.PATH,
			HOME: p.home,
			BEIGNET_DATA_DIR: p.data,
			BEIGNET_MNEMONIC: mnemonic,
			BEIGNET_API_TOKEN: token,
			BEIGNET_NETWORK: rec.network,
			// The wallet's name doubles as the Lightning node alias in the
			// node_announcement. The daemon truncates values over the BOLT 7
			// 32-byte limit itself, so no validation is needed here. A rename
			// propagates because updateWallet restarts a running daemon.
			BEIGNET_ALIAS: rec.name,
			BEIGNET_DAEMON_HOST: '127.0.0.1',
			BEIGNET_DAEMON_PORT: String(rec.port),
			BEIGNET_ELECTRUM_HOST: rec.electrum.host,
			BEIGNET_ELECTRUM_PORT: String(rec.electrum.port),
			BEIGNET_ELECTRUM_TLS: rec.electrum.tls ? 'true' : 'false',
			// The daemon only builds a logger when a log level is set; without one
			// it runs silent and its stdout carries nothing to show in the Logs
			// tab. Overridable so a noisy wallet can be turned down (or up to
			// debug when diagnosing a peer).
			BEIGNET_LOG_LEVEL: process.env.BEIGNET_LOG_LEVEL || 'info'
		};
		if (!rec.onchainOnly) {
			env.BEIGNET_LISTEN_PORT = String(this.listenPort(rec));
		} else {
			env.BEIGNET_AUTO_RECONNECT = 'false';
		}
		if (process.env.TOR_PROXY_IP) env.TOR_PROXY_IP = process.env.TOR_PROXY_IP;
		if (process.env.TOR_PROXY_PORT) env.TOR_PROXY_PORT = process.env.TOR_PROXY_PORT;
		// Route Lightning peer connections through Umbrel's Tor proxy when enabled.
		if (rec.tor && config.torProxy) env.BEIGNET_TOR_PROXY = config.torProxy;
		// Advertise the onion address so peers can open inbound channels, but only
		// when the onion actually forwards this wallet's listen port.
		if (rec.announce && this.onion && this._onionMapsPort(this.listenPort(rec))) {
			env.BEIGNET_ANNOUNCE_ADDRESSES = `${this.onion}:${this.listenPort(rec)}`;
		}
		// Channel backup (the Recovery Protocol). Off contributes nothing, so
		// an engine that predates the feature sees the env it always saw. It
		// rides along even for an on-chain only wallet: the parked node still
		// watches its channels, and a journal that promised quorum refuses to
		// run without its barrier.
		Object.assign(env, recoveryEnv(rec.recovery));
		// Serve the reference guardian to other beignet nodes at this wallet's
		// Lightning address (beignet #699). Open, no token: the pool only works
		// if strangers can register, and BOLT 8 already encrypts the session;
		// the engine's quotas bound what a stranger can store.
		if (rec.guardianServe && !rec.onchainOnly) env.BEIGNET_GUARDIAN_SERVE = 'true';
		// Operator-level engine policy (routing fees, liquidity ads, the
		// direct-funding minimum) passes through from the manager's own env,
		// and a wallet that provides liquidity to lightning-first wallets runs
		// the engine's JIT role with its fee and exposure caps, plus the blind
		// relay for direct-funding frames. Everyone else sees nothing new.
		Object.assign(env, lfbw.operatorEnv(), lfbw.providerEnv(rec));
		return env;
	}

	/**
	 * Clear a single-instance lock left behind by a daemon hard-killed in a
	 * PREVIOUS container. The engine's lock records {pid, hostname} but its
	 * liveness check probes the pid in the CURRENT pid namespace, so after a
	 * container recreate (every app update) the old pid can belong to some
	 * unrelated process and the daemon refuses to start forever with
	 * START_FAILED. The manager is the only thing that spawns daemons in
	 * this container, and it only calls this with no child running for the
	 * wallet, so a lock naming another hostname cannot have a live holder
	 * here and is safe to remove. A same-hostname lock is left alone: the
	 * engine's own pid check is valid inside one container, and reclaiming
	 * or refusing it is the daemon's call to make.
	 */
	_clearStaleInstanceLock(rec, p) {
		const lockPath = path.join(p.data, `${rec.network}.lock`);
		let holder;
		try {
			holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
		} catch (_) {
			return; // no lock, or unreadable (the engine reclaims corrupt locks)
		}
		if (!holder || holder.hostname === os.hostname()) return;
		try {
			fs.unlinkSync(lockPath);
			this._log(
				rec.id,
				`cleared stale instance lock left by pid ${holder.pid} on ` +
					`${holder.hostname}; this container is ${os.hostname()}`
			);
		} catch (err) {
			this._log(
				rec.id,
				`stale instance lock could not be cleared: ${err.message}`
			);
		}
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
		this._clearStaleInstanceLock(rec, p);
		const env = this._daemonEnv(rec, p, mnemonic, token);

		const { cmd, args } = beignetSpawn();
		rt.status = 'starting';
		rt.healthy = false;
		this._log(
			id,
			`starting on 127.0.0.1:${rec.port} (network ${rec.network}, electrum ${rec.electrum.host}:${rec.electrum.port} tls=${rec.electrum.tls})`
		);

		const proc = spawn(cmd, args, { env, cwd: p.home });
		rt.proc = proc;
		rt.spawnedEnv = env;
		rt.startedAt = Date.now();

		const emit = (buf) =>
			String(buf)
				.split('\n')
				.forEach((line) => {
					if (!line.trim()) return;
					this._log(id, line.trim());
					this._noteStartFailure(rt, line.trim());
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
			this._stopLfbwWatch(rt);
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
		// Lightning-first: on-chain arrivals move into the home channel. The
		// event stream drives it (transaction:confirmed); this is the backstop
		// for an event missed while the stream reconnects.
		if (lfbw.isLfbw(rec)) {
			rt.lfbwWatch = setInterval(() => {
				this._lfbwChannelize(id).catch(() => {});
			}, lfbw.CHANNELIZE_POLL_MS);
		}

		this._pollHealth(id).catch(() => {});
	}

	_stopLfbwWatch(rt) {
		if (rt.lfbwWatch) {
			clearInterval(rt.lfbwWatch);
			rt.lfbwWatch = null;
		}
		if (rt.lfbwTimer) {
			clearTimeout(rt.lfbwTimer);
			rt.lfbwTimer = null;
		}
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
				// Channel lifecycle events (and errors naming a channel) go to the
				// durable per-wallet history, so a close that happens while nobody
				// is watching still has a story the detail view can tell later. A
				// recording that could not reach disk is flagged in the log line;
				// the log module itself warns with the reason.
				const recorded = this.channelLog(id).record(name, data);
				// Recovery events are rare and every one of them matters
				// (a fence, a lost backfill, restore progress): keep them in
				// the log ring so the Logs tab and the container output carry
				// the story even when no browser was watching.
				if (name.startsWith('recovery:')) {
					this._log(id, `recovery ${name} ${JSON.stringify(data || {})}`);
				}
				// Lightning-first progress (beignet #669): a funding this daemon
				// fronts or receives, one line each, so the Logs tab tells the
				// story of a just-in-time channel or a direct funding.
				if (name.startsWith('jit:') || name.startsWith('direct-funding:')) {
					this._log(id, `${name} ${JSON.stringify(data || {})}`);
				}
				// A deposit arriving or confirming, or the home channel becoming
				// usable, is exactly when a lightning-first wallet has something
				// to move. The pass itself checks every UTXO has confirmed.
				if (lfbw.isLfbw(rec) && lfbw.CHANNELIZE_EVENTS.includes(name)) {
					this._scheduleChannelize(id);
				}
				if (recorded && name !== 'node:error') {
					this._log(
						id,
						`channel event ${name} ${recorded.entry.channelId}${
							recorded.persisted ? '' : ' (memory only, not persisted)'
						}`
					);
				}
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
		const probe = await this._probeHealth(rec, 5000);
		const health = probe.kind === 'ok' ? probe.health : null;
		// A daemon holding for a guardian restore is up but has no node
		// underneath it; it is neither healthy nor stalled, it is waiting.
		if (probe.kind === 'restore-pending') {
			if (!this._rebuildingOnCheckpoint(rec, rt, id)) this._enterRestoreHold(id, rt);
			rt.chainStallPolls = 0;
			return;
		}
		if (probe.kind === 'restart-required') {
			await this._restartOnRestoredState(id, rt);
			return;
		}
		if (health) rt.checkpointRebuildPolls = 0;
		// healthy was set once by the startup poll and then never revisited, so a
		// daemon that stopped answering mid-life (alive but its API deadlocked)
		// kept reading healthy forever. Demote it after two straight silent polls
		// of a daemon that had finished starting; any answer restores it.
		if (health) {
			if (!rt.healthy && rt.status === 'running') {
				this._log(id, 'daemon answering /health again');
			}
			// A slow first boot (a mainnet gossip chew, a large recovery) can
			// outlast the startup poll's window, leaving the record 'starting'
			// forever even though the daemon is up: promote it here, both so
			// the status is honest and so the demotion below (gated on
			// running) is armed for a wallet that booted slowly. A restore
			// hold ends the same way: the first ok answer is the node booted.
			if (rt.proc && !rt.stopping && rt.status === 'starting') {
				rt.status = 'running';
				this._log(id, 'healthy (after the startup poll window)');
			} else if (rt.proc && !rt.stopping && rt.status === 'restore-required') {
				rt.status = 'running';
				this._log(id, 'healthy (restore finished, node running)');
			}
			rt.healthy = true;
			rt.healthFailPolls = 0;
			rt.lastStartError = null;
		} else if (rt.status === 'running') {
			rt.healthFailPolls += 1;
			if (rt.healthy && rt.healthFailPolls >= 2) {
				rt.healthy = false;
				this._log(id, 'daemon stopped answering /health; marking unhealthy');
			}
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
		const rt = this.runtimeState(id);
		// The process this poll belongs to. A restart spawns a new poll for
		// the new child; this one must stop rather than report on it.
		const proc = rt.proc;
		const deadline = Date.now() + HEALTH_TIMEOUT_MS;
		while (rt.proc && rt.proc === proc) {
			const probe = await this._probeHealth(rec, 2000);
			if (rt.proc !== proc) return;
			if (probe.kind === 'ok') {
				rt.healthy = true;
				rt.lastStartError = null;
				this._log(
					id,
					rt.status === 'restore-required' ? 'healthy (restore finished, node running)' : 'healthy'
				);
				rt.status = 'running';
				this._onHealthy(id).catch((err) => this._log(id, `post-start setup failed: ${err.message}`));
				return;
			}
			if (probe.kind === 'restore-pending') {
				// A peer-storage daemon rebuilding on a checkpoint it applied
				// by itself answers this for a moment; that is a boot still
				// in progress, not a hold.
				if (this._rebuildingOnCheckpoint(rec, rt, id)) {
					if (Date.now() >= deadline) return;
					await sleep(HEALTH_POLL_MS);
					continue;
				}
				// Up, holding, and staying that way until someone runs the
				// restore: keep watching at a slower pace with no deadline,
				// so the wallet reads running the moment the node boots.
				this._enterRestoreHold(id, rt);
				await sleep(this.restoreHoldPollMs || RESTORE_HOLD_POLL_MS);
				continue;
			}
			if (probe.kind === 'restart-required') {
				// The restart spawns a new process with its own poll.
				await this._restartOnRestoredState(id, rt);
				return;
			}
			if (Date.now() >= deadline) return;
			await sleep(HEALTH_POLL_MS);
		}
	}

	/**
	 * One /health probe, classified. A daemon booted against a fresh database
	 * whose recovery namespace its guardians hold answers every route but the
	 * recovery surface with 503 NODE_RESTORE_PENDING; that is a daemon that
	 * is up and waiting, not one that is down.
	 */
	async _probeHealth(rec, timeoutMs) {
		try {
			const res = await fetch(`http://127.0.0.1:${rec.port}/health`, {
				signal: AbortSignal.timeout(timeoutMs)
			});
			if (res.ok) return { kind: 'ok', health: (await res.json()).result };
			if (res.status === 503) {
				let body = null;
				try {
					body = await res.json();
				} catch (_) {
					/* not JSON */
				}
				if (body && body.error && body.error.code === 'NODE_RESTORE_PENDING') {
					return { kind: 'restore-pending' };
				}
				// A peer-storage capsule restore replaced the database (beignet
				// 0.9.3+): the node underneath is gone until a restart builds
				// one on the restored state, which the daemon asks for by
				// refusing everything but its recovery surface.
				if (body && body.error && body.error.code === 'NODE_RESTART_REQUIRED') {
					return { kind: 'restart-required' };
				}
			}
		} catch (_) {
			/* unreachable or timed out */
		}
		return { kind: 'silent' };
	}

	/**
	 * Whether a NODE_RESTORE_PENDING answer is the short window in which a
	 * peer-storage daemon rebuilds its node in-process on a checkpoint it
	 * applied by itself (beignet #690). Peer storage has no guardian hold to
	 * be in, so there the answer can only mean that. Said once, tolerated
	 * for a bounded run of polls; a rebuild that never ends falls through to
	 * the hold so the wallet is not read as running forever.
	 */
	_rebuildingOnCheckpoint(rec, rt, id) {
		if (!rec.recovery || rec.recovery.mode !== 'peer-storage') return false;
		rt.checkpointRebuildPolls = (rt.checkpointRebuildPolls || 0) + 1;
		if (rt.checkpointRebuildPolls === 1) {
			this._log(id, 'applying a peer checkpoint: the node is being rebuilt on it');
		}
		if (rt.checkpointRebuildPolls > CHECKPOINT_REBUILD_MAX_POLLS) {
			this._log(id, 'the rebuild on the checkpoint has not finished; treating the daemon as holding');
			return false;
		}
		return true;
	}

	_enterRestoreHold(id, rt) {
		if (!rt.proc || rt.stopping || rt.status === 'restore-required') return;
		rt.status = 'restore-required';
		// Not healthy: the daemon itself says not-ready, and the Tor probe
		// picks its target by healthy (a holding daemon has no listener).
		rt.healthy = false;
		rt.healthFailPolls = 0;
		this._log(
			id,
			'holding for a guardian restore: the database is fresh and the guardian set holds this wallet; run the restore from the dashboard'
		);
	}

	// The daemon installed a restored database and holds until it is
	// restarted: do that for it, the way the chain-stall restart does.
	async _restartOnRestoredState(id, rt) {
		if (!rt.proc || rt.stopping) return;
		this._log(id, 'a capsule restore replaced the database; restarting on the restored state');
		try {
			rt.stopping = true;
			await this._killProc(rt.proc);
			rt.proc = null;
			rt.stopping = false;
			await this.startWallet(id);
		} catch (err) {
			rt.stopping = false;
			this._log(id, `restart on restored state failed: ${err.message}`);
		}
	}

	// Whether a holding daemon's restore is running right now (its status
	// route is the one route that answers during the hold).
	async _restoreInFlight(rec) {
		try {
			const res = await fetch(`http://127.0.0.1:${rec.port}/recovery/status`, {
				headers: { Authorization: `Bearer ${this.token(rec.id)}` },
				signal: AbortSignal.timeout(3000)
			});
			if (!res.ok) return false;
			const body = await res.json();
			return !!(body && body.result && body.result.state === 'restoring');
		} catch (_) {
			return false;
		}
	}

	// The CLI reports a start that failed before the daemon listened (a
	// guardian set it refuses, no guardian quorum to decide ownership with)
	// as one JSON line on stdout and exits. Keep the reason: without it the
	// wallet reads 'restarting' with the explanation only in the Logs tab.
	_noteStartFailure(rt, line) {
		if (!line.startsWith('{')) return;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch (_) {
			return;
		}
		if (parsed && parsed.ok === false && parsed.error && parsed.error.code === 'START_FAILED') {
			rt.lastStartError = { message: String(parsed.error.message || ''), at: nowIso() };
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
		this._stopLfbwWatch(rt);
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
		const rec = this.registry.get(id);
		if (!rec) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		// Deleting a primary would orphan its lightning-first wallets: no
		// inbound, no direct funding, no channelize, and a channel whose
		// counterparty is gone for good.
		this._refuseIfPrimaryInUse(rec, 'This wallet cannot be deleted');
		await this.stopWallet(id).catch(() => {});
		const p = this.paths(id);
		this.registry.remove(id);
		this.runtime.delete(id);
		this.channelLogs.delete(id);
		if (purge) {
			fs.rmSync(p.base, { recursive: true, force: true });
		}
	}

	// ── Lightning-first wallets ──

	/**
	 * Runs once the startup poll sees a daemon healthy: record its node id,
	 * then bring every lightning-first link this daemon is part of back up.
	 * Zero-conf trust and the direct-funding policy live in daemon memory
	 * and die with the process, so they are re-applied on every start.
	 */
	async _onHealthy(id) {
		await this._captureNodeId(id);
		await this._restoreLfbwLinks(id);
	}

	// A direct call to a wallet daemon with its bearer token. The reverse
	// proxy serves the browser; the manager talks to daemons itself for
	// lightning-first setup and channelize.
	/**
	 * A beignet node's Lightning URI to a guardian entry (beignet #699): the
	 * daemon of any healthy Lightning wallet opens a bolt8 session to the
	 * node, asks its guardian for its id, and hands back the entry to pin.
	 * Nothing is adopted here; Settings is where the operator pins it.
	 */
	async resolveGuardianUri(uri) {
		if (!this.guardianHostingAvailable()) {
			throw httpError(400, 'GUARDIAN_HOSTING_UNSUPPORTED', 'The bundled engine cannot resolve guardian nodes yet.');
		}
		const text = String(uri || '').trim();
		if (!text) throw httpError(400, 'BAD_GUARDIAN_URI', 'A node URI (<node id>@host:port) is required.');
		const via = this.registry
			.list()
			.find((rec) => rec.running && !rec.onchainOnly && this.runtimeState(rec.id).healthy);
		if (!via) {
			throw httpError(
				503,
				'NO_RUNNING_WALLET',
				'Resolving a guardian node needs a running Lightning wallet on this Umbrel to ask through; start one first.'
			);
		}
		try {
			return await this._daemonCall(via, 'POST', '/recovery/resolve-guardian', { uri: text });
		} catch (err) {
			const code = err.code || 'DAEMON_ERROR';
			const status = code === 'GUARDIAN_UNREACHABLE' ? 502 : code === 'INVALID_PARAMS' ? 400 : 502;
			throw httpError(status, code, err.message);
		}
	}

	/**
	 * The wallets on this Umbrel that serve as guardians, with the addresses
	 * another node reaches them at: the onion (when announcing) for anyone,
	 * and the loopback address for sibling wallets in this same container.
	 */
	guardianCandidates() {
		return this.registry
			.list()
			.filter((rec) => rec.guardianServe && !rec.onchainOnly && rec.nodeId)
			.map((rec) => {
				const onion = this.onionAddress(rec);
				return {
					id: rec.id,
					name: rec.name,
					network: rec.network,
					nodeId: rec.nodeId,
					running: !!rec.running && !!this.runtimeState(rec.id).healthy,
					onionUri: onion ? `${rec.nodeId}@${onion}` : null,
					localUri: `${rec.nodeId}@127.0.0.1:${this.listenPort(rec)}`
				};
			});
	}

	async _daemonCall(rec, method, apiPath, body) {
		const token = this.token(rec.id);
		const res = await fetch(`http://127.0.0.1:${rec.port}${apiPath}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				...(body ? { 'Content-Type': 'application/json' } : {})
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(lfbw.CALL_TIMEOUT_MS)
		});
		let data = {};
		try {
			data = await res.json();
		} catch (_) {
			/* non-JSON body */
		}
		if (!res.ok || data.ok === false) {
			const err = new Error((data.error && data.error.message) || `${apiPath} failed (${res.status})`);
			err.code = (data.error && data.error.code) || 'DAEMON_ERROR';
			throw err;
		}
		// The splice routes answer 200 with the refusal inside the result.
		if (apiPath.startsWith('/channel/splice') && data.result && data.result.ok === false) {
			const err = new Error(data.result.error || data.result.message || `${apiPath} refused`);
			err.code = data.result.code || 'SPLICE_REFUSED';
			throw err;
		}
		return data.result;
	}

	async _waitDaemonHealthy(rec, timeoutMs = lfbw.HEALTH_TIMEOUT_MS) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!this.runtimeState(rec.id).proc) throw new Error(`wallet "${rec.name}" is not running`);
			const probe = await this._probeHealth(rec, 2000);
			if (probe.kind === 'ok') return;
			await sleep(1000);
		}
		throw new Error(`wallet "${rec.name}" did not become healthy in time`);
	}

	// Persist the wallet's Lightning node id on its record once the daemon
	// reports it, so wallet lists can map peer pubkeys back to wallet names
	// and a sibling can be named as a primary before its daemon is asked.
	async _captureNodeId(id) {
		const rec = this.registry.get(id);
		if (!rec || rec.onchainOnly) return;
		const info = await this._daemonCall(rec, 'GET', '/info').catch(() => null);
		if (info && info.nodeId && rec.nodeId !== info.nodeId) {
			rec.nodeId = info.nodeId;
			this.registry.upsert(rec);
		}
	}

	/**
	 * The primary as something to connect to and to sign into requests. An
	 * internal primary is reached on loopback inside this container (Umbrel
	 * publishes no Lightning ports), and payers off-box reach it through its
	 * onion when it announces one; an external primary is its URI.
	 */
	async _primaryEndpoint(lf) {
		if (lf.mode === 'internal') {
			const primaryRec = this.registry.get(lf.primaryWalletId);
			if (!primaryRec) throw new Error('the selected primary node no longer exists');
			if (primaryRec.onchainOnly) throw new Error(`primary node "${primaryRec.name}" is on-chain only`);
			if (!this.runtimeState(primaryRec.id).proc) {
				throw new Error(`primary node "${primaryRec.name}" is not running`);
			}
			await this._waitDaemonHealthy(primaryRec);
			await this._captureNodeId(primaryRec.id);
			if (!primaryRec.nodeId) throw new Error('primary node did not report a node id');
			const listen = this.listenPort(primaryRec);
			const onion = this.onionAddress(primaryRec);
			const relay = lfbw.walletReach({
				onionAddress: onion,
				listenPort: listen,
				publicHost: process.env.PUBLIC_HOST
			});
			return {
				pubkey: primaryRec.nodeId,
				connectHost: '127.0.0.1',
				connectPort: listen,
				relayHost: relay ? relay.host : '127.0.0.1',
				relayPort: relay ? relay.port : listen,
				rec: primaryRec
			};
		}
		const parsed = lfbw.parseNodeUri(lf.primaryUri);
		return {
			pubkey: parsed.pubkey,
			connectHost: parsed.host,
			connectPort: parsed.port,
			relayHost: parsed.host,
			relayPort: parsed.port,
			rec: null
		};
	}

	/**
	 * Make a sibling wallet a liquidity provider: flag the record, and if its
	 * daemon is running with an env that lacks the role, restart it so the
	 * JIT engine and the relay come up. One restart per role change; a
	 * daemon already spawned as a provider is left alone.
	 */
	async _ensureProviderRole(primaryRec) {
		if (!primaryRec.liquidityProvider) {
			primaryRec.liquidityProvider = true;
			this.registry.upsert(primaryRec);
		}
		const rt = this.runtimeState(primaryRec.id);
		if (rt.proc && lfbw.providerRoleChanged(rt.spawnedEnv, primaryRec)) {
			this._log(primaryRec.id, 'restarting as a liquidity provider (JIT receive, direct-funding relay)');
			await this._restartWallet(primaryRec.id);
		}
		await this._waitDaemonHealthy(primaryRec);
	}

	/**
	 * Brings a lightning-first wallet's relationship with its primary node
	 * up: the primary as a liquidity provider, zero-conf trust (mutual for a
	 * trusted internal pair), the direct-funding policy naming the primary,
	 * a peer connection, and (once, on first success) the starting channel
	 * opened from the primary. Idempotent, so it is safe to run again after
	 * a failure or a daemon restart, which is exactly when it runs.
	 */
	async setupLfbw(id) {
		const rec = this.registry.get(id);
		if (!rec) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		if (!lfbw.isLfbw(rec)) throw httpError(400, 'NOT_LFBW', 'Not a lightning-first wallet');
		if (!this.runtimeState(id).proc) throw httpError(503, 'NOT_RUNNING', 'Wallet is not running');
		if (this.lfbwSetupRunning.has(id)) return this.publicRecord(id);
		this.lfbwSetupRunning.add(id);
		const lf = rec.lfbw;
		lf.setup = 'pending';
		lf.setupError = null;
		this.registry.upsert(rec);
		try {
			await this._waitDaemonHealthy(rec);
			await this._captureNodeId(id);
			if (!rec.nodeId) throw new Error('the wallet did not report a node id');
			const primary = await this._primaryEndpoint(lf);
			lf.primaryPubkey = primary.pubkey;
			this.registry.upsert(rec);

			if (primary.rec) await this._ensureProviderRole(primary.rec);

			// The wallet trusts its chosen primary for zero-conf: a JIT open or
			// a zero-conf splice arrives as an unconfirmed funding FROM the
			// primary, and the wallet accepted that risk by pairing with it.
			// An internal primary trusts the wallet back (we run both nodes),
			// so zero-conf works in both directions and a direct-funding
			// payment from the wallet counts as paired.
			if (lf.trusted) {
				await this._daemonCall(rec, 'POST', '/trusted-peer/add', { pubkey: primary.pubkey });
				if (primary.rec) {
					await this._daemonCall(primary.rec, 'POST', '/trusted-peer/add', { pubkey: rec.nodeId });
				}
			}

			// Arm direct funding: a beignet sender's on-chain payment becomes
			// this wallet's channel funding, negotiated with the primary, and
			// the primary's address is signed into requests as the relay for
			// senders who cannot reach the wallet directly.
			await this._daemonCall(
				rec,
				'POST',
				'/direct-funding/configure',
				lfbw.directFundingConfig(lf, primary, { allowSpliceSupported: this.lfbwAvailable() })
			);

			// An already-connected peer can make /peer/connect complain; that
			// is success by another name, so check the live peer list before
			// treating it as a failure.
			try {
				await this._daemonCall(rec, 'POST', '/peer/connect', {
					pubkey: primary.pubkey,
					host: primary.connectHost,
					port: primary.connectPort
				});
			} catch (err) {
				const peers = await this._daemonCall(rec, 'GET', '/peers').catch(() => []);
				const connected = (peers || []).some((p) => p.pubkey === primary.pubkey);
				if (!connected) throw err;
			}

			if (primary.rec && lf.initialChannelSats > 0 && !lf.initialChannelOpened) {
				this._log(
					id,
					`lightning-first: opening a ${lf.initialChannelSats} sat${lf.trusted ? ' zero-conf' : ''} channel from "${primary.rec.name}"`
				);
				// Marked opened before the call resolves: a retry after a
				// timeout must never open a second starting channel.
				lf.initialChannelOpened = true;
				this.registry.upsert(rec);
				await this._daemonCall(primary.rec, 'POST', '/channel/connect-and-open', {
					pubkey: rec.nodeId,
					host: '127.0.0.1',
					port: this.listenPort(rec),
					amountSats: lf.initialChannelSats,
					trusted: lf.trusted === true
				});
			}

			lf.setup = 'ready';
			lf.setupError = null;
			lf.setupAt = nowIso();
			this.registry.upsert(rec);
			this._log(id, 'lightning-first: setup complete');
			this._scheduleChannelize(id);
		} catch (err) {
			lf.setup = 'failed';
			lf.setupError = err.message;
			this.registry.upsert(rec);
			this._log(id, `lightning-first: setup failed: ${err.message}`);
		} finally {
			this.lfbwSetupRunning.delete(id);
		}
		return this.publicRecord(id);
	}

	// Re-apply every lightning-first link a daemon is part of once it is up:
	// the wallet's own, and every lightning-first wallet whose primary it is
	// (their trust toward it and its trust toward them both died with it).
	async _restoreLfbwLinks(id) {
		const rec = this.registry.get(id);
		if (!rec) return;
		const jobs = [];
		if (lfbw.isLfbw(rec)) jobs.push(rec.id);
		for (const dep of this._dependents(rec)) {
			if (this.runtimeState(dep.id).proc) jobs.push(dep.id);
		}
		for (const walletId of jobs) {
			await this.setupLfbw(walletId).catch(() => {});
		}
	}

	// Coalesce a burst of triggers (a confirmation, then channel:ready a
	// moment later) into one channelize pass.
	_scheduleChannelize(id) {
		const rt = this.runtimeState(id);
		if (rt.lfbwTimer) clearTimeout(rt.lfbwTimer);
		rt.lfbwTimer = setTimeout(() => {
			rt.lfbwTimer = null;
			this._lfbwChannelize(id).catch(() => {});
		}, lfbw.CHANNELIZE_DEBOUNCE_MS);
	}

	/**
	 * Move a lightning-first wallet's confirmed on-chain funds into its
	 * channel with the primary: a splice-in when the home channel exists, a
	 * max open when nothing does. The decision is pure (lfbw.js); this is
	 * the I/O around it. A failure backs off rather than retrying every
	 * tick, and a pass never overlaps another.
	 */
	async _lfbwChannelize(id, { force = false } = {}) {
		const rec = this.registry.get(id);
		const rt = this.runtimeState(id);
		if (!rec || !lfbw.isLfbw(rec)) return null;
		const lf = rec.lfbw;
		if (!rt.proc || !rt.healthy || rt.stopping) return null;
		if (lf.setup !== 'ready' || !lf.primaryPubkey) return null;
		if (rt.lfbwBusy) return { action: 'busy' };
		if (!force && Date.now() < rt.lfbwRetryAt) return null;
		rt.lfbwBusy = true;
		// What the pass decided, kept on the runtime so the dashboard can say
		// why a deposit waits (the fee, say) and offer to override it. Only a
		// pass that reached a decision about real funds records one: an
		// unreadable daemon says nothing new.
		const decided = (outcome) => {
			rt.lfbwLast = { at: Date.now(), ...outcome };
			return rt.lfbwLast;
		};
		try {
			const balance = await this._daemonCall(rec, 'GET', '/balance').catch(() => null);
			if (!balance) return null;
			const onchainSats = balance.onchain || 0;
			if (onchainSats < lfbw.CHANNELIZE_FLOOR_SATS) {
				if (lf.previousPrimary) {
					const channels = await this._daemonCall(rec, 'GET', '/channels').catch(() => null);
					if (channels) this._forgetPreviousPrimary(rec, channels);
				}
				return decided({ action: 'wait', reason: 'below-floor' });
			}
			const [utxos, channels] = await Promise.all([
				this._daemonCall(rec, 'GET', '/utxos').catch(() => null),
				this._daemonCall(rec, 'GET', '/channels').catch(() => [])
			]);
			this._forgetPreviousPrimary(rec, channels);
			const target = lfbw.channelizeTarget({ onchainSats, utxos, channels, primaryPubkey: lf.primaryPubkey });
			if (target.action === 'wait') return decided(target);
			const fees = await this._daemonCall(rec, 'GET', '/fees/estimates').catch(() => null);
			const feeNormal = fees && fees.normal > 0 ? fees.normal : 0;
			const perkw = lfbw.perkwFromSatVb(feeNormal > 0 ? feeNormal : 2);
			let order;
			if (target.action === 'splice-in') {
				const spliceQuote = await this._daemonCall(rec, 'POST', '/channel/splice-quote', {
					channelId: target.channelId,
					direction: 'in',
					feeratePerkw: perkw
				}).catch(() => null);
				order = lfbw.channelizeOrder(target, { spliceQuote, feeNormal, force });
			} else {
				const txQuote = await this._daemonCall(rec, 'POST', '/tx/quote', {
					satsPerVbyte: feeNormal > 0 ? feeNormal : 2,
					max: true,
					channelFunding: true
				}).catch(() => null);
				const primary = await this._primaryEndpoint(lf);
				const info = lf.mode === 'external' ? await this._daemonCall(rec, 'GET', '/info').catch(() => null) : null;
				order = lfbw.channelizeOrder(target, {
					txQuote,
					feeNormal,
					mode: lf.mode,
					trusted: lf.trusted,
					blockHeight: (info && info.blockHeight) || 0,
					primary,
					force
				});
			}
			if (order.action === 'wait') {
				if (order.reason === 'fee-too-high' && !(rt.lfbwLast && rt.lfbwLast.reason === 'fee-too-high')) {
					this._log(
						id,
						`lightning-first: ${order.amountSats} sats wait to move: the fee would be ${order.feeSats} sats, more than a twentieth of the amount`
					);
				}
				return decided(order);
			}
			if (order.action === 'splice-in') {
				this._log(id, `lightning-first: splicing ${order.body.amountSats} sats on-chain into the home channel`);
				await this._daemonCall(rec, 'POST', '/channel/splice-in', order.body);
				return decided({ action: 'splice-in', amountSats: order.body.amountSats });
			}
			if (order.action === 'open-v2') {
				this._log(
					id,
					`lightning-first: dual-funded open of ${order.body.amountSats} sats, buying ${order.body.requestFunds.requestedSats} sats inbound from the primary`
				);
				try {
					await this._daemonCall(rec, 'POST', '/channel/open-v2', order.body);
					return;
				} catch (err) {
					this._log(id, `lightning-first: inbound purchase failed (${err.message}); opening without it`);
					order = order.fallback;
				}
			}
			this._log(id, `lightning-first: moving ${order.body.amountSats} sats on-chain into a new channel with the primary`);
			await this._daemonCall(rec, 'POST', '/channel/connect-and-open', order.body);
			return decided({ action: 'open', amountSats: order.body.amountSats });
		} catch (err) {
			rt.lfbwRetryAt = Date.now() + lfbw.CHANNELIZE_RETRY_MS;
			this._log(id, `lightning-first: channelize attempt failed: ${err.message}`);
			return decided({ action: 'failed', error: err.message });
		} finally {
			rt.lfbwBusy = false;
		}
	}

	/**
	 * The dashboard's "Move now anyway": one channelize pass that skips the
	 * fee wait (never the channel minimums), run at once whatever the
	 * backoff says. Answers with what the pass decided.
	 */
	/**
	 * The previous primary is remembered only while a channel with it
	 * exists (umbrel #86); once the wallet holds none, the record forgets it
	 * and the Overview stops listing it.
	 */
	_forgetPreviousPrimary(rec, channels) {
		const lf = rec.lfbw;
		if (!lf || !lf.previousPrimary) return false;
		if (!lfbw.previousPrimaryDone(lf.previousPrimary, channels)) return false;
		lf.previousPrimary = null;
		this.registry.upsert(rec);
		this._log(rec.id, 'lightning-first: the channel with the previous primary is gone; its funds are with the new one');
		return true;
	}

	/**
	 * "Move funds to the new primary": cooperatively close every live
	 * channel with the previous primary. The payout lands on-chain and the
	 * channelize pass carries it into the home channel once it confirms,
	 * which is the flow a deposit takes anyway.
	 */
	async moveHome(id) {
		const rec = this.registry.get(id);
		if (!rec) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		if (!lfbw.isLfbw(rec)) throw httpError(400, 'NOT_LFBW', 'Not a lightning-first wallet');
		const rt = this.runtimeState(id);
		if (!rt.proc || !rt.healthy) throw httpError(409, 'NOT_RUNNING', 'The wallet is not running');
		const previous = rec.lfbw.previousPrimary;
		if (!previous) throw httpError(409, 'NO_PREVIOUS_PRIMARY', 'This wallet has not changed its primary node');
		const channels = await this._daemonCall(rec, 'GET', '/channels').catch(() => null);
		if (!channels) throw httpError(503, 'WALLET_UNRESPONSIVE', 'The wallet did not answer');
		if (this._forgetPreviousPrimary(rec, channels)) {
			throw httpError(409, 'NO_PREVIOUS_CHANNEL', 'There is no channel with the previous primary left to move');
		}
		const open = lfbw.previousPrimaryChannels(previous, channels).filter((c) => c.state === 'NORMAL');
		if (open.length === 0) {
			throw httpError(409, 'NO_PREVIOUS_CHANNEL', 'The channel with the previous primary is already closing');
		}
		const closed = [];
		for (const c of open) {
			this._log(id, `lightning-first: closing channel ${c.channelId} with the previous primary; its funds move into the home channel once the close confirms`);
			await this._daemonCall(rec, 'POST', '/channel/close', { channelId: c.channelId });
			closed.push(c.channelId);
		}
		return { closed, pubkey: previous.pubkey };
	}

	/**
	 * Close the home channel. With `turnOff`, lightning-first is switched
	 * off FIRST (the record loses its lfbw block and the daemon restarts on
	 * the new posture, exactly as the Edit dialog would do it), and the close
	 * runs on the restarted daemon; otherwise channelize would move the
	 * payout straight back into a new channel with the primary after one
	 * confirmation, and the close would have paid a fee to end up where it
	 * started (umbrel #86).
	 */
	async closeHome(id, { channelId, turnOff = false } = {}) {
		const rec = this.registry.get(id);
		if (!rec) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		if (!lfbw.isLfbw(rec)) throw httpError(400, 'NOT_LFBW', 'Not a lightning-first wallet');
		if (!channelId || typeof channelId !== 'string') throw httpError(400, 'INVALID_PARAMS', 'channelId required');
		const rt = this.runtimeState(id);
		if (!rt.proc || !rt.healthy) throw httpError(409, 'NOT_RUNNING', 'The wallet is not running');
		if (turnOff) {
			this._log(id, 'lightning-first: turning lightning-first off before closing the home channel, so the payout stays on-chain');
			rec.lfbw = null;
			this.registry.upsert(rec);
			await this._restartWallet(id);
			await this._waitDaemonHealthy(rec);
		}
		await this._daemonCall(rec, 'POST', '/channel/close', { channelId });
		return { closed: channelId, lfbwOff: !!turnOff, record: this.publicRecord(id) };
	}

	async channelizeNow(id) {
		const rec = this.registry.get(id);
		if (!rec) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		if (!lfbw.isLfbw(rec)) throw httpError(400, 'NOT_LFBW', 'Not a lightning-first wallet');
		const rt = this.runtimeState(id);
		if (!rt.proc || !rt.healthy) throw httpError(409, 'NOT_RUNNING', 'The wallet is not running');
		if (rec.lfbw.setup !== 'ready') throw httpError(409, 'LFBW_NOT_READY', 'The link to the primary node is not set up yet');
		const outcome = await this._lfbwChannelize(id, { force: true });
		if (!outcome) throw httpError(503, 'WALLET_UNRESPONSIVE', 'The wallet did not answer');
		if (outcome.action === 'failed') throw httpError(502, 'CHANNELIZE_FAILED', outcome.error);
		return outcome;
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
			onchainOnly: !!rec.onchainOnly,
			onionAddress: this.onionAddress(rec),
			// Only meaningful for Tor-enabled wallets: false means the last
			// probe could not build a circuit, so peer connects will time out.
			torCircuitOk: rec.tor ? this.torCircuitOk : null,
			recovery: {
				mode: (rec.recovery && rec.recovery.mode) || 'off',
				guardians: (rec.recovery && rec.recovery.guardians) || [],
				autoApply: !!(rec.recovery && rec.recovery.autoApply)
			},
			guardianServe: !!rec.guardianServe && !rec.onchainOnly,
			port: rec.port,
			desiredRunning: !!rec.running,
			status: rt.status,
			healthy: rt.healthy,
			lastStartError: rt.lastStartError,
			createdAt: rec.createdAt,
			// Lightning-first: the node id lets the dashboard name sibling
			// peers; listenPort and reach are what a payment request can
			// advertise; lfbw is the primary-node block; the provider fields
			// say what this wallet fronts for lightning-first wallets.
			nodeId: rec.nodeId || null,
			listenPort: rec.onchainOnly ? null : this.listenPort(rec),
			reach: rec.onchainOnly ? null : this._reach(rec),
			lfbw: rec.lfbw ? { ...rec.lfbw, lastChannelize: rt.lfbwLast || null } : null,
			liquidityProvider: !!rec.liquidityProvider && !rec.onchainOnly,
			jit: lfbw.normalizeJit(undefined, rec.jit),
			lfbwDependents: this._dependents(rec).map((d) => ({ id: d.id, name: d.name }))
		};
	}

	_reach(rec) {
		return lfbw.walletReach({
			onionAddress: this.onionAddress(rec),
			listenPort: this.listenPort(rec),
			publicHost: process.env.PUBLIC_HOST
		});
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

	channelLog(id) {
		if (!this.channelLogs.has(id)) {
			this.channelLogs.set(
				id,
				new ChannelEventLog(this.paths(id).base, {
					// Persistence problems land in the wallet's log ring, so a
					// history that silently stopped being durable is visible in the
					// dashboard's Logs tab rather than nowhere.
					warn: (m) => this._log(id, `channel history: ${m}`)
				})
			);
		}
		return this.channelLogs.get(id);
	}

	// Durable channel history, oldest first, optionally for one channel.
	channelEvents(id, { channelId } = {}) {
		if (!this.registry.get(id)) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		return this.channelLog(id).list({ channelId });
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
