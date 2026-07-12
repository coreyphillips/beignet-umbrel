'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');

const RECONNECT_MS = 15000;
const CONNECT_TIMEOUT_MS = 8000;
// A wedged Tor can accept the control connection and then never reply to
// AUTHENTICATE/ADD_ONION. Without deadlines that would block start() forever,
// and with it the whole manager (the app then hangs at "Starting..." on
// install). Cap replies per command and the first publish attempt overall.
const CONTROL_REPLY_TIMEOUT_MS = 10000;
const FIRST_ATTEMPT_TIMEOUT_MS = 20000;

// The manager's address on Umbrel's shared app network (10.21.x.x), which the
// system Tor container (10.21.21.11) can reach for hidden-service forwarding.
function pickLocalIp() {
	const addrs = [];
	for (const list of Object.values(os.networkInterfaces())) {
		for (const ni of list || []) {
			if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
		}
	}
	return addrs.find((a) => a.startsWith('10.21.')) || addrs[0] || null;
}

/**
 * Registers a single v3 hidden service with Umbrel's system Tor via the control
 * port (ADD_ONION), mapping each wallet listen port to an onion virtual port.
 * The connection is kept open so the onion lives with the manager; on drop it
 * reconnects and re-adds using the persisted key, keeping a stable address.
 */
class TorControl {
	constructor({ host, port, password, keyFile, ports, log, onPublished }) {
		this.host = host;
		this.port = port;
		this.password = password;
		this.keyFile = keyFile;
		this.ports = ports;
		this.log = log || (() => {});
		this.onPublished = onPublished || (() => {});
		this.onion = null;
		this.socket = null;
		this.stopped = false;
		this._resolveFirst = null;
	}

	// Resolves with the onion (or null) after the first publish attempt; keeps
	// reconnecting in the background and calls onPublished on (re)publish.
	// Never blocks longer than FIRST_ATTEMPT_TIMEOUT_MS: the dashboard must
	// come up even when Tor is unresponsive.
	start() {
		return new Promise((resolve) => {
			const deadline = setTimeout(() => {
				this.log('tor-control: first publish attempt timed out; continuing in background');
				this._firstDone(null);
			}, FIRST_ATTEMPT_TIMEOUT_MS);
			this._resolveFirst = (onion) => {
				clearTimeout(deadline);
				resolve(onion);
			};
			this._connect();
		});
	}

	stop() {
		this.stopped = true;
		if (this.socket) this.socket.destroy();
	}

	available() {
		return !!this.onion;
	}

	_firstDone(onion) {
		if (this._resolveFirst) {
			this._resolveFirst(onion);
			this._resolveFirst = null;
		}
	}

	_connect() {
		const targetIp = pickLocalIp();
		if (!targetIp) {
			this.log('tor-control: no reachable local IP for onion target');
			this._firstDone(null);
			return;
		}
		const socket = net.connect({ host: this.host, port: this.port });
		this.socket = socket;
		socket.setKeepAlive(true);
		socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy());

		socket.once('connect', async () => {
			// Reply deadline for the command phase; a Tor that goes silent here
			// gets its socket destroyed, which resolves start() and schedules a
			// background reconnect instead of hanging the manager.
			socket.setTimeout(CONTROL_REPLY_TIMEOUT_MS, () => socket.destroy());
			try {
				await this._cmd(socket, `AUTHENTICATE "${this._escape(this.password)}"`);
				const state = this._readState();
				const keyArg = state.key || 'NEW:ED25519-V3';
				const portArgs = this.ports.map((p) => `Port=${p},${targetIp}:${p}`).join(' ');
				let onion = null;
				try {
					// Flags=Detach keeps the onion alive after this control connection
					// closes, so it survives manager restarts and connection blips
					// (instead of being torn down and briefly unreachable).
					const lines = await this._cmd(socket, `ADD_ONION ${keyArg} Flags=Detach ${portArgs}`);
					const { serviceId, privKey } = this._parseAddOnion(lines);
					if (!serviceId) throw new Error('no ServiceID in ADD_ONION response');
					onion = `${serviceId}.onion`;
					this._writeState(privKey || state.key, onion, targetIp);
				} catch (addErr) {
					// A detached onion from a previous run is still registered with
					// Tor. Its port map forwards to the target IP from that run; if
					// this container's IP has since changed, that mapping is stale and
					// inbound would silently break, so drop and re-add with the current
					// target. Otherwise adopt it as-is (no re-publish, no gap).
					if (!(/collision|already/i.test(addErr.message) && state.address)) throw addErr;
					const serviceId = state.address.replace(/\.onion$/i, '');
					if (state.target && state.target !== targetIp) {
						this.log(
							`tor-control: onion target changed ${state.target} -> ${targetIp}; republishing`
						);
						try {
							await this._cmd(socket, `DEL_ONION ${serviceId}`);
							const lines = await this._cmd(
								socket,
								`ADD_ONION ${keyArg} Flags=Detach ${portArgs}`
							);
							const parsed = this._parseAddOnion(lines);
							if (!parsed.serviceId) throw new Error('no ServiceID in ADD_ONION response');
							onion = `${parsed.serviceId}.onion`;
							this._writeState(parsed.privKey || state.key, onion, targetIp);
						} catch (reErr) {
							// Re-publish failed; keep the stable identity so outbound and
							// the known address survive, and retry on the next reconnect.
							onion = state.address;
							this.log(`tor-control: republish failed (${reErr.message}); adopting ${onion}`);
							this._writeState(state.key, onion, state.target);
						}
					} else {
						onion = state.address;
						this.log(`tor-control: onion already published, adopting ${onion}`);
						// Record the current target for legacy state that predates it.
						this._writeState(state.key, onion, state.target || targetIp);
					}
				}
				this.onion = onion;
				// Publish done; the connection now just sits idle to keep the onion
				// association, so disable the inactivity deadline.
				socket.setTimeout(0);
				this.log(`tor-control: onion ready ${this.onion} -> ${targetIp}`);
				this._firstDone(this.onion);
				this.onPublished(this.onion);
			} catch (err) {
				this.log(`tor-control: publish failed: ${err.message}`);
				this._firstDone(null);
				socket.destroy();
			}
		});

		socket.on('error', (err) => this.log(`tor-control: socket error: ${err.message}`));
		socket.on('close', () => {
			this.onion = null;
			this.socket = null;
			this._firstDone(null);
			if (!this.stopped) setTimeout(() => this._connect(), RECONNECT_MS);
		});
	}

	// Sends one control command and resolves with all response lines once the
	// final "<code> " line arrives; rejects on a non-2xx reply.
	_cmd(socket, command) {
		return new Promise((resolve, reject) => {
			let buf = '';
			const onData = (chunk) => {
				buf += chunk.toString('utf8');
				const lines = buf.split('\r\n');
				for (const line of lines) {
					if (/^\d{3} /.test(line)) {
						socket.removeListener('data', onData);
						const code = parseInt(line.slice(0, 3), 10);
						const collected = lines.filter((l) => l.length > 0);
						if (code >= 200 && code < 300) resolve(collected);
						else reject(new Error(line));
						return;
					}
				}
			};
			socket.on('data', onData);
			socket.write(`${command}\r\n`);
		});
	}

	_escape(s) {
		return String(s).replace(/([\\"])/g, '\\$1');
	}

	// Extracts the ServiceID and (on first publish) PrivateKey from an ADD_ONION
	// reply's collected lines.
	_parseAddOnion(lines) {
		let serviceId = null;
		let privKey = null;
		for (const line of lines) {
			const s = line.match(/ServiceID=([a-z2-7]+)/i);
			if (s) serviceId = s[1].toLowerCase();
			const k = line.match(/PrivateKey=(\S+)/);
			if (k) privKey = k[1];
		}
		return { serviceId, privKey };
	}

	// Persisted state is JSON { key, address, target }, where target is the
	// container IP the detached onion's port map forwards to (used to detect a
	// changed IP on restart). Falls back to reading a legacy file that held just
	// the raw key (pre-Detach), so upgrades keep the onion.
	_readState() {
		try {
			const raw = fs.readFileSync(this.keyFile, 'utf8').trim();
			if (!raw) return { key: null, address: null, target: null };
			try {
				const parsed = JSON.parse(raw);
				return {
					key: parsed.key || null,
					address: parsed.address || null,
					target: parsed.target || null
				};
			} catch (_) {
				return { key: raw, address: null, target: null };
			}
		} catch (_) {
			return { key: null, address: null, target: null };
		}
	}

	_writeState(key, address, target) {
		if (!key) return;
		try {
			fs.writeFileSync(this.keyFile, JSON.stringify({ key, address, target }), { mode: 0o600 });
		} catch (err) {
			this.log(`tor-control: could not persist onion state: ${err.message}`);
		}
	}
}

module.exports = { TorControl, pickLocalIp };
