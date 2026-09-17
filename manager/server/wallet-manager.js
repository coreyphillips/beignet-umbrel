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
const { DirectFundingFallbackLog } = require('./direct-funding-fallbacks');
const { ActionLogCursor, PrintedStepReader, DirectFundingSteps, formatStep } = require('./df-steps');
const {
	GUARDIAN_SET_SIZE,
	isRecoveryMode,
	isGuardianMode,
	validateGuardianDraft,
	sameGuardianSet,
	recoveryEnv,
	parseGuardianEntry,
	validateGuardianSet
} = require('./recovery');
const {
	ArchiveError,
	assertPassphrase,
	sealArchive,
	openArchive,
	buildPayload,
	payloadFiles,
	payloadRegistry,
	payloadSettings,
	planRestore,
	backupStale,
	describePayload,
	seedDigest,
	mnemonicPath,
	tokenPath,
	backupFilename
} = require('./backup');
const {
	engineVersion,
	recoveryAvailable,
	lfbwAvailable,
	jitQuoteAvailable,
	recoveryAutoApplyAvailable,
	guardianHostingAvailable,
	guardianRotationAvailable,
	fforAvailable
} = require('./engine');
const lfbw = require('./lfbw');
const ffor = require('./ffor');

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
// How long a daemon gets to shut down on SIGTERM before it is SIGKILLed. The
// engine drains HTLCs for up to 10s and force-exits itself at 15s, so a
// shorter grace than that kills a daemon that was about to exit cleanly on
// its own. KILL_REAP_MS is the extra wait for the exit event AFTER a SIGKILL.
const KILL_GRACE_MS = 18000;
const KILL_REAP_MS = 2000;
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
// Direct-funding steps (umbrel #147) live in the daemon's action log, which it
// never prints. The log is read every DF_PULL_SLOW_MS as a backstop, and on
// every tick for DF_PULL_FAST_WINDOW_MS after anything says an exchange is
// under way: long enough for a 120 s offer window and the 45 s receipt window
// after it, which is where a slow payment spends its time.
const DF_PULL_TICK_MS = 3000;
const DF_PULL_SLOW_MS = 60000;
const DF_PULL_FAST_WINDOW_MS = 200000;
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
		// Direct fundings that degraded into an ordinary payment, kept the same
		// way and for the same reason (see direct-funding-fallbacks.js).
		this.fallbackLogs = new Map();
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
		// A wallet moving to a new guardian set with its channels running
		// (beignet #701), probed the same way.
		this.guardianRotationSupported = guardianRotationAvailable();
		// FFOR offline receive (beignet #729, #865): the routes and, from
		// 0.21.4, the role switches the daemon honours; probed on the bundle.
		this.fforSupported = fforAvailable();
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
				// The child the post-start setup (node id capture, lightning-first
				// links) has run for, so a boot promoted by either poll runs it
				// exactly once per process.
				postStartFor: null,
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
				lfbwLast: null,
				// The home channel's last splice conflict or revert (beignet
				// #760), and whether an unpaired payer's funding is in flight;
				// both narrate the Overview and die with the process.
				lfbwSplice: null,
				lfbwUnpaired: null,
				// Direct-funding steps from both of their sources, kept for the
				// payment they belong to; where the action log read has got to,
				// its timer and fast window, and the read in flight.
				dfSteps: new DirectFundingSteps(),
				dfPrinted: new PrintedStepReader(),
				dfCursor: null,
				dfWatch: null,
				dfFastUntil: 0,
				dfLastPull: 0,
				dfPull: null,
				dfPullAgain: false,
				// FFOR offline receive: what the last return (the reconcile
				// with the settlement peer after a start) produced, whether a
				// peer contradicted an ACTIVE epoch at reconnect (enforce
				// on-chain), and the guard against two returns at once.
				fforReturn: null,
				fforEnforce: null,
				fforReturning: false
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

	// `at` stamps a line with when it happened rather than when it was heard,
	// and files it in order: a step read back from the action log arrives
	// after lines printed later than it.
	_log(id, line, at) {
		const rt = this.runtimeState(id);
		const stamped = `[${at === undefined ? nowIso() : new Date(at).toISOString()}] ${line}`;
		let i = rt.logs.length;
		if (at !== undefined) while (i > 0 && rt.logs[i - 1].slice(0, 26) > stamped.slice(0, 26)) i--;
		rt.logs.splice(i, 0, stamped);
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

	guardianRotationAvailable() {
		return this.guardianRotationSupported === true;
	}

	fforAvailable() {
		return this.fforSupported === true;
	}

	recoveryAvailable() {
		return recoveryAvailable(this.engineVersion);
	}

	/**
	 * What this manager knows to be wrong with its own two files on the data
	 * volume, for /api/health. A registry that could not be read hides every
	 * wallet it lists and refuses every save; settings that could not be read
	 * are being served as defaults, and the next save writes those defaults
	 * over the file. Both keep a copy of what they could not read.
	 */
	health() {
		const failure = (err) =>
			err ? { error: err.message, backup: err.backup || null, at: err.at || null } : null;
		const registry = failure(this.registry.loadError);
		const settings = failure(this.settings.loadError);
		return { status: registry || settings ? 'degraded' : 'ok', registry, settings };
	}

	getSettings() {
		return {
			defaultNetwork: this.defaultNetwork(),
			defaultElectrum: this.defaultElectrum(),
			recoveryGuardians: this.recoveryGuardians(),
			lastBackupAt: this.settings.get().lastBackupAt || null
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

	/**
	 * The per-wallet FFOR block (beignet #729): settling offline receives
	 * for siblings needs an engine whose daemon honours the switch and a
	 * Lightning listener, so it is refused on an engine without the surface
	 * and dropped for an on-chain only wallet. Receiving needs no role.
	 */
	_normalizeFfor(input, existing, onchainOnly) {
		const next = ffor.normalizeFfor(input, existing);
		if (!next.settle.enabled) return next;
		if (!this.fforAvailable()) {
			throw httpError(
				400,
				'FFOR_UNSUPPORTED',
				'The bundled engine cannot settle offline receives yet; update the app first.'
			);
		}
		if (onchainOnly) {
			throw httpError(
				400,
				'FFOR_NEEDS_LIGHTNING',
				'An on-chain only wallet runs no Lightning listener, so it cannot settle offline receives.'
			);
		}
		return next;
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
		lfbw: lfbwInput,
		ffor: fforInput
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
			lfbw: lfbwInput,
			ffor: fforInput
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
		lfbw: lfbwInput,
		ffor: fforInput
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
			lfbw: lfbwInput,
			ffor: fforInput
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
		lfbw: lfbwInput,
		ffor: fforInput
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
			// Settling offline receives for siblings (FFOR) is opt-in per
			// wallet: an epoch locks the whole budget of its liquidity.
			ffor: this._normalizeFfor(fforInput, null, onchainOnly),
			lfbw: lfbwBlock,
			// A wallet becomes a liquidity provider when a lightning-first
			// sibling picks it as primary (setupLfbw flips this), or when the
			// operator turns it on to serve external wallets.
			liquidityProvider: false,
			jit: lfbw.normalizeJit(undefined),
			swaps: lfbw.normalizeSwaps(undefined),
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
			jit,
			swaps,
			ffor: fforInput
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
		const nextSwaps = swaps !== undefined ? lfbw.normalizeSwaps(swaps, rec.swaps) : undefined;
		const nextLfbw =
			lfbwInput !== undefined
				? this._normalizeLfbw(lfbwInput, { network: rec.network, selfId: rec.id, existing: rec.lfbw })
				: undefined;
		if (nextLfbw && (onchainOnly === true || (onchainOnly === undefined && rec.onchainOnly))) {
			throw httpError(400, 'BAD_LFBW_PEER', 'An on-chain only wallet cannot be lightning-first');
		}
		const nextOnchainOnly = onchainOnly === undefined ? !!rec.onchainOnly : !!onchainOnly;
		const nextFfor = fforInput !== undefined ? this._normalizeFfor(fforInput, rec.ffor, nextOnchainOnly) : undefined;
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
		if (nextSwaps !== undefined) rec.swaps = nextSwaps;
		if (nextFfor !== undefined) rec.ffor = nextFfor;
		if (rec.onchainOnly && rec.ffor && rec.ffor.settle && rec.ffor.settle.enabled) {
			// Parking Lightning stops the listener the settlement runs on.
			rec.ffor = ffor.normalizeFfor({ settle: { enabled: false } }, rec.ffor);
		}
		// An edit is what makes a backup stale, so it is stamped here and not
		// in upsert: the record is also saved on every start, stop and node-id
		// capture, none of which change anything an archive holds.
		rec.updatedAt = nowIso();
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
		// Settling offline receives for siblings (FFOR, beignet #729): an
		// exact 'true' plus the terms floor and caps. Off contributes nothing.
		Object.assign(env, ffor.fforEnv(rec));
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

		const reachable = await this._probeElectrum(rec.electrum);
		// A stop that arrived while the probe was out wins: stopWallet found
		// no child to kill and wrote running=false, so spawning now would
		// leave a daemon up that the record and the dashboard say is stopped.
		if (rt.stopping) {
			this._log(id, 'start cancelled: stop requested');
			return;
		}
		if (!reachable) {
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

		const emit = (line) => {
			if (!line.trim()) return;
			this._log(id, line.trim());
			this._noteStartFailure(rt, line.trim());
			this._notePrintedStep(id, rt, line.trim());
		};
		// A chunk can end mid-line, and a printed step cut there loses its
		// fields, so the unfinished tail waits for the rest of its line.
		const readLines = (stream) => {
			let rest = '';
			stream.on('data', (buf) => {
				const lines = (rest + String(buf)).split('\n');
				rest = lines.pop();
				lines.forEach(emit);
			});
			stream.on('end', () => emit(rest));
		};
		readLines(proc.stdout);
		readLines(proc.stderr);

		proc.on('error', (err) => this._log(id, `spawn error: ${err.message}`));
		proc.on('exit', (code, signal) => this._onChildExit(id, rt, proc, code, signal));

		this._startEvents(id, rec, rt);

		if (!rec.running) {
			rec.running = true;
			this.registry.upsert(rec);
		}

		rt.chainStallPolls = 0;
		// The watch handles live on rt, so overwriting them strands the old
		// intervals for the life of the manager. Stop them before spawning
		// the replacements: any path that reached here without the previous
		// child's exit handler running (a superseded child, above) still has
		// its watches ticking.
		if (rt.chainWatch) clearInterval(rt.chainWatch);
		this._stopLfbwWatch(rt);
		this._stopDfWatch(rt);
		rt.chainWatch = setInterval(() => {
			this._checkChainStall(id).catch(() => {});
		}, CHAIN_WATCH_POLL_MS);
		this._startDfWatch(id, rt);
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

	_startDfWatch(id, rt) {
		// Kept across restarts: steps the old daemon wrote after the last read
		// are still in its action log for the new one to serve.
		if (!rt.dfCursor) rt.dfCursor = new ActionLogCursor(rt.startedAt || Date.now());
		rt.dfWatch = setInterval(() => {
			const now = Date.now();
			if (now < rt.dfFastUntil || now - rt.dfLastPull >= DF_PULL_SLOW_MS) {
				this._pullDfSteps(id).catch(() => {});
			}
		}, DF_PULL_TICK_MS);
	}

	_stopDfWatch(rt) {
		if (rt.dfWatch) {
			clearInterval(rt.dfWatch);
			rt.dfWatch = null;
		}
	}

	// Something says a direct funding is moving. Read the action log now, and
	// keep reading it on every tick while the exchange can still be live;
	// a step that ends one only needs the one read that catches up.
	_nudgeDfPull(id, rt, live) {
		rt.dfFastUntil = live ? Date.now() + DF_PULL_FAST_WINDOW_MS : 0;
		// A read already out may have left before the step that nudged this.
		if (rt.dfPull) rt.dfPullAgain = true;
		this._pullDfSteps(id).catch(() => {});
	}

	_notePrintedStep(id, rt, line) {
		for (const step of rt.dfPrinted.read(line)) {
			rt.dfSteps.add(step);
			if (step.action.startsWith('df_send_')) {
				this._nudgeDfPull(id, rt, !/^df_send_(completed|refused)$/.test(step.action));
			}
		}
	}

	/**
	 * Copy the direct-funding entries the daemon logged since the last read
	 * into the wallet's log ring and step buffer. One read at a time: a nudge
	 * that lands while one is out queues one more, and the promise waiting on
	 * the first also waits on that one.
	 */
	_pullDfSteps(id) {
		const rt = this.runtimeState(id);
		if (rt.dfPull) return rt.dfPull;
		const rec = this.registry.get(id);
		if (!rec || !rt.proc || !rt.healthy || !rt.dfCursor) return Promise.resolve();
		rt.dfLastPull = Date.now();
		rt.dfPull = this._daemonCall(rec, 'GET', rt.dfCursor.path())
			.then((entries) => {
				for (const step of rt.dfCursor.take(entries)) {
					if (rt.dfSteps.add(step)) this._log(id, formatStep(step), step.timestamp);
				}
			})
			.catch(() => {
				/* the next tick asks again from the same place */
			})
			.then(() => {
				rt.dfPull = null;
				if (!rt.dfPullAgain) return undefined;
				rt.dfPullAgain = false;
				return this._pullDfSteps(id);
			});
		return rt.dfPull;
	}

	/**
	 * The steps of the latest attempt to pay a direct-funding request from this
	 * wallet, oldest first, read fresh from the daemon first so a card asking
	 * mid-exchange sees the route that is being tried now.
	 */
	async directFundingSteps(id, { requestId } = {}) {
		if (!this.registry.get(id)) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		if (!/^[0-9a-fA-F]{32}$/.test(String(requestId || ''))) {
			throw httpError(400, 'INVALID_PARAMS', 'requestId must be 32 hex characters');
		}
		await this._pullDfSteps(id);
		return this.runtimeState(id).dfSteps.forRequest(requestId);
	}

	// Resolves once the daemon's action log has been read up to now, so a
	// fallback recorded next saves the steps that explain it.
	catchUpDirectFundingSteps(id) {
		return this.registry.get(id) ? this._pullDfSteps(id) : Promise.resolve();
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
				// The receiver's side of an offer: the reasons behind it are in
				// the action log, so read it while the offer is live.
				if (name.startsWith('direct-funding:')) {
					this._nudgeDfPull(id, rt, !/:(completed|declined|failed)$/.test(name));
				}
				// A swap this provider serves (beignet #737, #743), one line per
				// step in either direction: created, funded, paying, preimage,
				// claim broadcast and confirmed, or failed, refunded, exposed.
				if (name.startsWith('swap:')) {
					this._log(id, `${name} ${JSON.stringify(data || {})}`);
				}
				// FFOR offline receive (beignet #729): an epoch's committed
				// state changes, a settlement this wallet made for a sibling,
				// and a peer contradicting an ACTIVE epoch at reconnect, which
				// is the one case the wallet must enforce on-chain; kept on the
				// runtime so the dashboard can say so until the epoch ends.
				if (name.startsWith('ffor:')) {
					const summary = name === 'ffor:state' || name === 'ffor:enforce'
						? { channelId: data && data.channelId, state: data && data.state }
						: data || {};
					this._log(id, `${name} ${JSON.stringify(summary)}`);
					if (name === 'ffor:enforce' && data && data.channelId) {
						rt.fforEnforce = { at: Date.now(), channelId: String(data.channelId) };
					}
					if (
						name === 'ffor:state' &&
						data &&
						(data.state === 'CLOSED' || data.state === 'ABORTED') &&
						rt.fforEnforce &&
						rt.fforEnforce.channelId === String(data.channelId)
					) {
						rt.fforEnforce = null;
					}
				}
				// The home channel's splice lifecycle (beignet #760): a stranger's
				// direct funding now splices the channel and locks at depth, and
				// a double spent coin is reverted with the primary. One line each,
				// and the conflict or revert is kept for the Overview.
				if (name.startsWith('splice:')) {
					this._log(id, `${name} ${JSON.stringify(data || {})}`);
					const rt = this.runtimeState(id);
					if (name === 'splice:conflicted' || name === 'splice:reverted') {
						rt.lfbwSplice = {
							state: name === 'splice:conflicted' ? 'conflicted' : 'reverted',
							spliceTxid: (data && data.spliceTxid) || null,
							conflictTxid: (data && data.conflictTxid) || null,
							at: Date.now()
						};
					}
					if (name === 'splice:complete' || name === 'splice:aborted' || name === 'splice:reverted') {
						rt.lfbwUnpaired = null;
					}
					if (name === 'splice:complete') rt.lfbwSplice = null;
				}
				// A direct funding from a payer this wallet has not paired with
				// arrives as a splice that waits for confirmations; the Overview
				// says so while it does.
				if (name === 'direct-funding:offer:accepted' && data && data.paired === false) {
					this.runtimeState(id).lfbwUnpaired = { at: Date.now() };
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
				this._runPostStart(id, rt);
			} else if (rt.proc && !rt.stopping && rt.status === 'restore-required') {
				rt.status = 'running';
				this._log(id, 'healthy (restore finished, node running)');
				this._runPostStart(id, rt);
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

	/**
	 * A child daemon exited. Extracted so a test can hold the one rule that
	 * keeps a restart from orphaning a working node: only the CURRENT child's
	 * exit may touch runtime state.
	 *
	 * A child killed during a restart can exit AFTER its replacement is
	 * already up (the kill settles, the replacement spawns, the old exit
	 * event lands a tick later). Clearing rt.proc then orphans a live daemon:
	 * it keeps the wallet's instance lock and it still answers /health on the
	 * wallet's port, so every later attempt logs healthy and then dies with
	 * START_FAILED ("Another beignet instance ... is already using this
	 * wallet"), and the manager restarts forever against a wallet that is
	 * already running. Only a container restart clears that by hand, because
	 * the lock names a live holder on this host and _clearStaleInstanceLock
	 * rightly refuses it. _pollHealth makes the same ownership check.
	 */
	_onChildExit(id, rt, proc, code, signal) {
		if (rt.proc !== proc) {
			this._log(
				id,
				`a superseded daemon exited code=${code} signal=${signal}; the running daemon is untouched`
			);
			return;
		}
		rt.proc = null;
		rt.healthy = false;
		rt.status = 'stopped';
		if (rt.chainWatch) {
			clearInterval(rt.chainWatch);
			rt.chainWatch = null;
		}
		this._stopLfbwWatch(rt);
		this._stopDfWatch(rt);
		this._stopEvents(rt);
		this._log(id, `exited code=${code} signal=${signal}`);
		this._maybeRestart(id, rt);
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
				this._runPostStart(id, rt);
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
			let hardKill = null;
			let reap = null;
			const finish = () => {
				if (done) return;
				done = true;
				if (hardKill) clearTimeout(hardKill);
				if (reap) clearTimeout(reap);
				resolve();
			};
			proc.once('exit', finish);
			try {
				proc.kill('SIGTERM');
			} catch (_) {
				finish();
				return;
			}
			hardKill = setTimeout(() => {
				try {
					proc.kill('SIGKILL');
				} catch (_) {
					/* already gone */
				}
				// Settle on the exit event the SIGKILL produces, not on the
				// timer that sent it: callers restart the wallet the moment
				// this resolves, and a replacement spawned while the old
				// daemon is still alive loses to its instance lock. The reap
				// timer is the backstop for a process wedged in the kernel.
				reap = setTimeout(finish, this.killReapMs || KILL_REAP_MS);
			}, this.killGraceMs || KILL_GRACE_MS);
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
		this.fallbackLogs.delete(id);
		if (purge) {
			fs.rmSync(p.base, { recursive: true, force: true });
		}
	}

	// ── Backup and restore of identity and settings ──

	/** An archive error as an HTTP one, with its own code kept. */
	_backupError(err) {
		if (!(err instanceof ArchiveError)) return err;
		const status = err.code === 'BACKUP_INCOMPLETE' ? 500 : 400;
		return httpError(status, err.code, err.message);
	}

	/**
	 * Every wallet already on this box, by the two things that identify one:
	 * its Lightning node id (null until a daemon has been asked for it) and
	 * the fingerprint of its seed, which needs no daemon at all.
	 */
	_identities() {
		return this.registry.list().map((rec) => {
			let seedHash = null;
			try {
				seedHash = seedDigest(fs.readFileSync(this.paths(rec.id).mnemonicFile, 'utf8'));
			} catch (_) {
				/* a record whose seed is gone cannot be matched by it */
			}
			return { id: rec.id, name: rec.name, nodeId: rec.nodeId || null, seedHash };
		});
	}

	/**
	 * One passphrase-encrypted archive of everything that is not derivable
	 * from the chain: the registry, the app settings, and each wallet's seed
	 * and API token. Exporting stamps every wallet as backed up, which is what
	 * the dashboard's reminder reads.
	 */
	async exportBackup({ passphrase } = {}) {
		try {
			assertPassphrase(passphrase);
		} catch (err) {
			throw this._backupError(err);
		}
		// The registry file is the archive's copy of every wallet record. One
		// that could not be parsed is not one to hand out as a backup.
		if (this.registry.loadError) {
			throw httpError(
				409,
				'REGISTRY_UNREADABLE',
				`The wallet list on this box could not be read (${this.registry.loadError.message}), so a backup of it would restore nothing.`
			);
		}
		// Export writes settings.json before it reads it, so one that could not
		// be parsed would be replaced by defaults and archived as defaults.
		if (this.settings.loadError) {
			throw httpError(
				409,
				'SETTINGS_UNREADABLE',
				`The app settings on this box could not be read (${this.settings.loadError.message}), and a backup would replace them with defaults. Repair or remove settings.json first` +
					(this.settings.loadError.backup
						? `; a copy of it was kept at ${this.settings.loadError.backup}.`
						: '.')
			);
		}
		const createdAt = nowIso();
		// settings.json is only written when settings are saved, and a box that
		// has never saved any still has defaults worth carrying: write them out
		// now, or the first archive off a box restores one with none.
		this.settings.save();
		const ids = this.registry.list().map((rec) => rec.id);
		let archive;
		try {
			archive = sealArchive(
				buildPayload({
					dataDir: config.dataDir,
					walletIds: ids,
					app: config.appVersion,
					engine: this.engineVersion,
					createdAt
				}),
				passphrase
			);
		} catch (err) {
			throw this._backupError(err);
		}
		// Stamped only once the archive exists, and in one write rather than
		// one per wallet: a failed export must not claim a backup happened.
		for (const rec of this.registry.list()) rec.lastBackupAt = createdAt;
		this.registry.save();
		this.settings.update({ lastBackupAt: createdAt });
		console.log(`backup: exported ${ids.length} wallet(s) at ${createdAt}`);
		return { archive, filename: backupFilename(createdAt), createdAt, walletCount: ids.length };
	}

	_openBackup({ passphrase, archive }) {
		try {
			const payload = openArchive(Buffer.from(String(archive || ''), 'base64'), passphrase);
			const files = payloadFiles(payload);
			return { payload, files, records: payloadRegistry(files) };
		} catch (err) {
			throw this._backupError(err);
		}
	}

	/** What an archive holds and what restoring it here would do. Writes nothing. */
	inspectBackup({ passphrase, archive } = {}) {
		const { payload, files, records } = this._openBackup({ passphrase, archive });
		return {
			...describePayload(payload),
			...planRestore({ records, files, existing: this._identities() }),
			settings: !!payloadSettings(files)
		};
	}

	/**
	 * Recreate records, secrets and app settings from an archive. Nothing is
	 * started: each restored wallet waits stopped until it is started by hand,
	 * and then boots exactly as an imported seed does, running its normal
	 * recovery against the chain and its guardians.
	 */
	restoreBackup({ passphrase, archive, confirm = false } = {}) {
		// Every restored record has to be written to the registry file, and a
		// file that could not be parsed is never written over.
		if (this.registry.loadError) {
			throw httpError(
				409,
				'REGISTRY_UNREADABLE',
				`The wallet list on this box could not be read (${this.registry.loadError.message}), and it will not be written over. Repair or remove it first.`
			);
		}
		const { payload, files, records } = this._openBackup({ passphrase, archive });
		const plan = planRestore({ records, files, existing: this._identities() });
		// Strictly true: the guard against running one seed twice is not one to
		// let a JSON body satisfy with "false" or a stray 1.
		if (plan.conflicts.length && confirm !== true) {
			const names = plan.conflicts
				.map((w) => `"${w.name}" (the same node as "${w.duplicateOf.name}")`)
				.join(', ');
			const err = httpError(
				409,
				'DUPLICATE_NODE_ID',
				`Restoring would leave this box holding ${names}. Running one seed from two records is how channels get lost; confirm to restore anyway.`
			);
			err.details = { conflicts: plan.conflicts };
			throw err;
		}
		// A record comes out of the archive as it went in, and its network
		// names a file the daemon writes (the engine's instance lock), so an
		// archive that names one this app does not run is refused before any
		// of it is written.
		const networks = new Map();
		for (const entry of plan.wallets) {
			if (entry.action === 'restore') networks.set(entry.id, this._validateNetwork(entry.network));
		}
		const restored = [];
		for (const entry of plan.wallets) {
			if (entry.action !== 'restore') continue;
			const rec = { ...records.find((r) => r.id === entry.id) };
			// A port another wallet here already holds would leave two daemons
			// fighting over one listener.
			if (this.registry.list().some((other) => other.id !== rec.id && other.port === rec.port)) {
				rec.port = this._allocatePort();
			}
			rec.network = networks.get(rec.id);
			rec.running = false;
			rec.lastBackupAt = payload.createdAt || null;
			const p = this.paths(rec.id);
			fs.mkdirSync(p.home, { recursive: true });
			fs.mkdirSync(p.data, { recursive: true });
			fs.mkdirSync(p.secrets, { recursive: true, mode: 0o700 });
			this._writeSecret(p.mnemonicFile, files.get(mnemonicPath(rec.id)));
			this._writeSecret(p.tokenFile, files.get(tokenPath(rec.id)));
			this.registry.upsert(rec);
			restored.push({ id: rec.id, name: rec.name, port: rec.port });
			this._log(rec.id, `restored from a backup archive written ${payload.createdAt}; start it when ready`);
		}
		// The app defaults come back too: a guardian-mode wallet cannot start
		// without the guardian set that is kept here rather than on the record.
		const settings = payloadSettings(files);
		if (settings) {
			this.settings.update({
				defaultNetwork: settings.defaultNetwork,
				defaultElectrum: settings.defaultElectrum,
				recoveryGuardians: Array.isArray(settings.recoveryGuardians)
					? settings.recoveryGuardians
					: undefined,
				lastBackupAt: payload.createdAt || null
			});
		}
		console.log(`backup: restored ${restored.length} wallet(s) from an archive written ${payload.createdAt}`);
		return {
			...describePayload(payload),
			restored,
			skipped: plan.wallets.filter((w) => w.action !== 'restore'),
			settings: !!settings
		};
	}

	// The archive carries each file's mode. It is set again after the write
	// because writeFileSync only applies one when it creates the file, and a
	// umask can narrow the one it asks for.
	_writeSecret(file, entry) {
		fs.writeFileSync(file, entry.data, { mode: entry.mode });
		fs.chmodSync(file, entry.mode);
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
		await this._fforReturn(id);
	}

	/**
	 * Run the post-start setup once for the child that just came up. Two
	 * polls can be the one to notice a daemon is healthy: the startup poll,
	 * and the chain-stall poll when a slow boot (a mainnet gossip chew, a
	 * large restore, N daemons booting at once) outlasts the startup
	 * window. The setup used to hang off the startup poll alone, so a slow
	 * boot read healthy with its node id uncaptured and its lightning-first
	 * links never re-applied; the daemon keeps zero-conf trust and the
	 * direct-funding policy in memory, so "never" meant until the next fast
	 * start.
	 */
	_runPostStart(id, rt) {
		if (!rt.proc || rt.postStartFor === rt.proc) return;
		rt.postStartFor = rt.proc;
		this._onHealthy(id).catch((err) => this._log(id, `post-start setup failed: ${err.message}`));
	}

	// A direct call to a wallet daemon with its bearer token. The reverse
	// proxy serves the browser; the manager talks to daemons itself for
	// lightning-first setup and channelize.
	/**
	 * Move a wallet to a new guardian set with its channels running (beignet
	 * #701, wire 5.9). The daemon does the work: registers with the new set
	 * under its current lease, backfills, switches, retires the old set. On
	 * success the record follows, so the next start names the new set; no
	 * restart is needed now, the daemon already runs on it.
	 */
	async rotateGuardians(id, guardians) {
		const rec = this.registry.get(id);
		if (!rec) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		if (!this.guardianRotationAvailable()) {
			throw httpError(400, 'GUARDIAN_ROTATION_UNSUPPORTED', 'The bundled engine cannot rotate guardian sets yet; update the app first.');
		}
		if (!isGuardianMode(rec.recovery && rec.recovery.mode)) {
			throw httpError(400, 'NOT_GUARDIAN_MODE', 'Only a wallet using a guardian backup mode has a guardian set to rotate.');
		}
		let entries;
		try {
			entries = validateGuardianSet(guardians);
		} catch (err) {
			throw httpError(400, 'BAD_GUARDIANS', err.message);
		}
		if (entries.length !== GUARDIAN_SET_SIZE) {
			throw httpError(400, 'BAD_GUARDIANS', `A guardian set is exactly ${GUARDIAN_SET_SIZE} entries; got ${entries.length}.`);
		}
		if (sameGuardianSet(entries, rec.recovery.guardians || [])) {
			throw httpError(400, 'BAD_GUARDIANS', 'That is the set this wallet already uses.');
		}
		if (!this.runtimeState(id).proc) throw httpError(503, 'NOT_RUNNING', 'Wallet is not running');
		let result;
		try {
			result = await this._daemonCall(rec, 'POST', '/recovery/rotate-guardians', { guardians: entries, confirm: true });
		} catch (err) {
			const code = err.code || 'DAEMON_ERROR';
			const status = code === 'ROTATION_IN_PROGRESS' || code === 'ROTATION_UNAVAILABLE' ? 409 : code === 'INVALID_PARAMS' ? 400 : 502;
			throw httpError(status, code, err.message);
		}
		// The daemon is on the new set; the record follows so the next start
		// names it too, and the status route's configuredSetStale clears.
		rec.recovery = { ...rec.recovery, guardians: entries };
		// A set the old archive no longer names: the backup is now stale.
		rec.updatedAt = nowIso();
		this.registry.upsert(rec);
		this._log(id, `guardian set rotated to generation ${result && result.generation}`);
		return { record: this.publicRecord(id), generation: result && result.generation, retired: result && result.retired };
	}

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
		if (info) this._noteListener(id, info);
	}

	/**
	 * A Lightning wallet whose listen port did not bind still reports ready,
	 * and a guardian on it still reports serving, because the engine treats
	 * a failed bind as non-fatal and says nothing (beignet #861). The only
	 * surface that knows is GET /info.listening. Without this, the symptom
	 * is that nobody can reach the wallet: a guardian pinned by its URI
	 * answers GUARDIAN_UNREACHABLE, a lightning-first primary cannot be
	 * dialled by its dependents, and every explanation points at the other
	 * end. Ports in this range belong to whatever else is on the box, so a
	 * collision is ordinary rather than exotic.
	 */
	_noteListener(id, info) {
		const rt = this.runtimeState(id);
		const listening = info.listening !== false;
		if (rt.listening === listening) return;
		rt.listening = listening;
		if (!listening) {
			const rec = this.registry.get(id);
			this._log(
				id,
				`no Lightning listener: port ${this.listenPort(rec)} did not bind, so nothing can connect to this wallet. ` +
					'Another process on this machine is probably using it.'
			);
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
				// That flag is the whole of the guard, so an archive taken
				// before it was set would open the starting channel a second
				// time on a restore: the backup is stale from here.
				rec.updatedAt = nowIso();
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

	/**
	 * The return half of an offline receive (FFOR, beignet #729). While the
	 * wallet was away its settlement peer settled payers' HTLCs against the
	 * pre-signed voucher book and sent the wallet nothing; the engine does
	 * not reconcile on reestablish by itself, so every start asks the daemon
	 * to: fetch any witnesses, then close the epoch cooperatively, which is
	 * when the settled bitmap and the preimages arrive and the credit lands
	 * on the channel. Never force-closes on its own; that stays a user
	 * action (Enforce) the dashboard offers when the peer is gone.
	 */
	async _fforReturn(id) {
		const rec = this.registry.get(id);
		if (!rec || rec.onchainOnly || !this.fforAvailable()) return;
		const epochs = await this._daemonCall(rec, 'GET', '/ffor/epochs').catch(() => null);
		for (const channelId of ffor.returnJobs(epochs)) {
			await this.fforReturn(id, { channelId, waitForPeer: true }).catch(() => {});
		}
	}

	/**
	 * Reconcile one epoch with its settlement peer: wait for the channel to
	 * reestablish (a sibling on loopback is back in seconds), then ask the
	 * daemon to recover. An unreachable peer answers 'nothing' and the record
	 * says so, which is what the dashboard's return panel reads.
	 */
	async fforReturn(id, { channelId, waitForPeer = false } = {}) {
		const rec = this.registry.get(id);
		if (!rec) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		const rt = this.runtimeState(id);
		if (!rt.proc) throw httpError(409, 'NOT_RUNNING', 'The wallet is not running');
		if (!channelId || typeof channelId !== 'string') {
			throw httpError(400, 'INVALID_PARAMS', 'channelId is required');
		}
		if (rt.fforReturning) throw httpError(409, 'FFOR_RETURN_IN_PROGRESS', 'A return is already running');
		rt.fforReturning = true;
		try {
			if (waitForPeer) await this._waitChannelNormal(rec, channelId);
			let result;
			try {
				result = await this._daemonCall(rec, 'POST', '/ffor/recover', {
					channelId,
					forceCloseIfUnreachable: false
				});
			} catch (err) {
				rt.fforReturn = { at: Date.now(), channelId, action: null, error: err.message, code: err.code || null };
				this._log(id, ffor.returnLogLine(channelId, null, err));
				throw httpError(502, err.code || 'FFOR_RETURN_FAILED', err.message);
			}
			// The recover answer carries the epoch as it stood when the close
			// was sent; the settled bitmap and the preimages arrive with the
			// peer's close_ack and the drain a moment later. Wait for the
			// epoch to settle so the record says what was actually credited.
			let epoch = result && result.epoch ? result.epoch : null;
			if (result && result.action !== 'nothing') {
				epoch = (await this._waitEpochSettled(rec, channelId)) || epoch;
			}
			if (epoch && result) result = { ...result, epoch };
			rt.fforReturn = {
				at: Date.now(),
				channelId,
				action: (result && result.action) || 'nothing',
				preimagesKnown: (result && result.preimagesKnown) || [],
				witnesses: (result && result.witnesses) || [],
				epoch: epoch
					? { state: epoch.state, epochId: epoch.epochId, slots: epoch.slots, activationMismatch: !!epoch.activationMismatch }
					: null,
				error: null
			};
			this._log(id, ffor.returnLogLine(channelId, result));
			return rt.fforReturn;
		} finally {
			rt.fforReturning = false;
		}
	}

	// Poll the epoch until the close has drained (CLOSED or ABORTED), or the
	// wait runs out; the latest view is returned either way.
	async _waitEpochSettled(rec, channelId, timeoutMs = ffor.RETURN_DRAIN_TIMEOUT_MS) {
		const deadline = Date.now() + timeoutMs;
		let last = null;
		while (Date.now() < deadline) {
			const view = await this._daemonCall(rec, 'GET', `/ffor/epoch?channelId=${channelId}`).catch(() => null);
			if (view) last = view;
			if (view && (view.state === 'CLOSED' || view.state === 'ABORTED')) return view;
			await sleep(ffor.RETURN_POLL_MS);
		}
		return last;
	}

	// Poll the daemon's channel list until the channel reads NORMAL or the
	// wait runs out; the caller reconciles either way, so an unreachable
	// peer is reported rather than retried forever.
	async _waitChannelNormal(rec, channelId, timeoutMs = ffor.RETURN_REESTABLISH_TIMEOUT_MS) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!this.runtimeState(rec.id).proc) return false;
			const channels = await this._daemonCall(rec, 'GET', '/channels').catch(() => null);
			const ch = Array.isArray(channels) ? channels.find((c) => c.channelId === channelId) : null;
			if (ch && ch.state === 'NORMAL') return true;
			await sleep(ffor.RETURN_POLL_MS);
		}
		return false;
	}

	/** The siblings this wallet can pick as its settlement peer. */
	fforCandidates(id) {
		const rec = this.registry.get(id);
		if (!rec) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		return ffor.settlementCandidates(this.registry.list(), rec, (r) => !!this.runtimeState(r.id).healthy);
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
				this._daemonCall(rec, 'GET', '/channels').catch(() => null)
			]);
			// An unanswered channel list says nothing about the previous
			// primary: only a list that was read can show its channel gone.
			if (Array.isArray(channels)) this._forgetPreviousPrimary(rec, channels);
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
					return decided({
						action: 'open-v2',
						amountSats: order.body.amountSats,
						requestedSats: order.body.requestFunds.requestedSats
					});
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
			// The same edit the dialog would make, so it stamps like one.
			rec.updatedAt = nowIso();
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
			// The backup stamp and whether the wallet has been edited since it
			// was taken: what is on this record is the half of a wallet no
			// amount of chain scanning brings back.
			lastBackupAt: rec.lastBackupAt || null,
			backupStale: backupStale(rec),
			// Lightning-first: the node id lets the dashboard name sibling
			// peers; listenPort and reach are what a payment request can
			// advertise; lfbw is the primary-node block; the provider fields
			// say what this wallet fronts for lightning-first wallets.
			nodeId: rec.nodeId || null,
			listenPort: rec.onchainOnly ? null : this.listenPort(rec),
			// null until the daemon has been asked; false means the port did
			// not bind and no peer can reach this wallet (beignet #861).
			listening: rec.onchainOnly ? null : rt.listening ?? null,
			reach: rec.onchainOnly ? null : this._reach(rec),
			lfbw: rec.lfbw
				? {
						...rec.lfbw,
						lastChannelize: rt.lfbwLast || null,
						lastSplice: rt.lfbwSplice || null,
						unpairedFunding: rt.lfbwUnpaired || null
				  }
				: null,
			liquidityProvider: !!rec.liquidityProvider && !rec.onchainOnly,
			jit: lfbw.normalizeJit(undefined, rec.jit),
			swaps: lfbw.normalizeSwaps(undefined, rec.swaps),
			lfbwDependents: this._dependents(rec).map((d) => ({ id: d.id, name: d.name })),
			// FFOR offline receive: the settlement role this wallet offers its
			// siblings, what the last return produced, and whether a peer
			// contradicted an ACTIVE epoch (enforce on-chain).
			ffor: ffor.normalizeFfor(undefined, rec.ffor),
			fforReturn: rt.fforReturn || null,
			fforEnforce: rt.fforEnforce || null
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
					warn: (m) => this._log(id, m)
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

	fallbackLog(id) {
		if (!this.fallbackLogs.has(id)) {
			this.fallbackLogs.set(
				id,
				new DirectFundingFallbackLog(this.paths(id).base, {
					warn: (m) => this._log(id, m)
				})
			);
		}
		return this.fallbackLogs.get(id);
	}

	/**
	 * A direct funding the payer could not make, recorded against the ordinary
	 * payment that went instead.
	 *
	 * Reported by the dashboard rather than observed here: the daemon answers
	 * the payer that made the call and nobody else, and the plain payment that
	 * follows is an ordinary send the daemon has no reason to connect to it.
	 * The browser that saw both is the only witness to the pair.
	 */
	recordDirectFundingFallback(id, input) {
		if (!this.registry.get(id)) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		// The steps are attached here, from what the manager saw, rather than
		// taken from the browser: they are the evidence of why it fell back.
		// A re-record (an RBF bump moving the entry to its new txid) comes
		// after the buffer may have lost them, so its own copy stands then.
		const steps =
			input && typeof input.requestId === 'string'
				? this.runtimeState(id).dfSteps.forRequest(input.requestId)
				: [];
		const recorded = this.fallbackLog(id).record(steps.length ? { ...input, steps } : input);
		if (!recorded) {
			throw httpError(
				400,
				'INVALID_PARAMS',
				'reason is required: it is the whole of what this records'
			);
		}
		const { entry, persisted } = recorded;
		const became = entry.txid
			? `paid as an ordinary transaction ${entry.txid}`
			: entry.error
			? `and the ordinary payment failed too (${entry.error})`
			: 'paid as an ordinary transaction';
		this._log(id, `direct funding not taken (${entry.reason}); ${became}`);
		return { ...entry, persisted };
	}

	// Durable direct-funding fallbacks, oldest first.
	directFundingFallbacks(id) {
		if (!this.registry.get(id)) throw httpError(404, 'NOT_FOUND', 'Wallet not found');
		return this.fallbackLog(id).list();
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
			this._stopDfWatch(rt);
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
