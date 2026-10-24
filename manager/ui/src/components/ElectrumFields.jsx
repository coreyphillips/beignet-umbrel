import { useEffect, useRef, useState } from 'react';
import { manager } from '../api.js';
import { Button, Field, Help } from './ui.jsx';
import { ServerStatus, chainKey, describeProbe, describeTest } from './ElectrumStatus.jsx';

/** Pinned fingerprints as typed (one string) or as stored (an array), as a list. */
function pinList(pins) {
	if (Array.isArray(pins)) return pins;
	return String(pins || '')
		.replace(/sha256\s+fingerprint\s*=\s*/gi, ' ')
		.split(/[\s,]+/)
		.filter(Boolean);
}

/**
 * The `electrum` body the manager takes, from the fields' value. Certificate
 * verification (beignet #1776) rides along only for a TLS server and only
 * when it is on; the manager checks the pins again.
 */
export function electrumBody(value) {
	const body = { host: value.host.trim(), port: parseInt(value.port, 10), tls: !!value.tls };
	if (body.tls && value.tlsVerify) {
		body.tlsVerify = true;
		const pins = pinList(value.tlsFingerprints);
		if (pins.length) body.tlsFingerprints = pins;
	}
	return body;
}

/** Whether the fields name a server the manager would accept asking about. */
function testable(value) {
	const port = parseInt(value.port, 10);
	return !!(value.host && value.host.trim()) && Number.isFinite(port) && port > 0 && port <= 65535;
}

/**
 * The Test button under the host and port: asks the manager to probe the
 * server as typed and says what answered, on the same line. The answer is
 * filed under the server, certificate rule and network it was asked for,
 * and shown only while the fields still say that, so an answer that lands
 * after the user has moved on (a probe takes up to a few seconds) is never
 * read as being about the new server.
 */
function TestConnection({ value, network }) {
	const [busy, setBusy] = useState(false);
	const [outcome, setOutcome] = useState(null);
	const key = testable(value) ? JSON.stringify([electrumBody(value), network || null]) : null;
	const latest = useRef(key);
	latest.current = key;
	const run = async () => {
		const asked = key;
		setBusy(true);
		try {
			const result = await manager.testElectrum({ ...electrumBody(value), ...(network ? { network } : {}) });
			if (latest.current === asked) setOutcome({ key: asked, ...describeTest(result) });
		} catch (e) {
			if (latest.current === asked) setOutcome({ key: asked, state: 'error', text: e.message });
		} finally {
			setBusy(false);
		}
	};
	const shown = outcome && outcome.key === key ? outcome : null;
	return (
		<div className="electrum-test-row">
			<Button className="sm" data-testid="electrum-test" busy={busy} disabled={!testable(value)} onClick={run}>
				Test connection
			</Button>
			{shown && (
				<span className="electrum-test-result" data-testid="electrum-test-result" data-state={shown.state} role="status">
					{shown.text}
				</span>
			)}
		</div>
	);
}

/** The probe results of a discovery answer, by server id. */
function byId(r) {
	const servers = {};
	for (const s of (r && r.servers) || []) servers[s.id] = s;
	return servers;
}

/** One server as a button that fills the fields, with what its probe said. */
function PresetButton({ preset: p, onPick, status, network, showStatus }) {
	return (
		<button type="button" className="btn sm preset-btn" data-testid={`preset-${p.id}`} onClick={() => onPick(p)} title={p.note}>
			<span className="preset-name">{p.label}</span>
			<span className="preset-host">
				{p.host}:{p.port}
			</span>
			{showStatus && (
				<ServerStatus
					result={status.servers[p.id]}
					network={network}
					loading={status.loading}
					data-testid={`preset-status-${p.id}`}
				/>
			)}
		</button>
	);
}

/**
 * Host / port / TLS inputs plus one-click presets. Controlled via `value`/`onChange`.
 * With `verifyAvailable` (an engine that verifies Electrum certificates), a TLS
 * server also gets the verify switch and its pinned certificates.
 *
 * Each preset is probed when the fields appear (and again on Refresh), so the
 * row says which servers are actually there, on which chain and how far
 * along, instead of leaving the user to try each one. `network` is the chain
 * the server is meant for; a preset known to be on another chain says so.
 *
 * When no preset answers on that chain, `publicServers` (the manager's
 * public list) are offered under them instead, probed the same way. They are
 * asked about only then, so a box with its own Electrum server never
 * contacts them.
 */
export default function ElectrumFields({ presets: allPresets = [], publicServers: allPublic = [], value, onChange, verifyAvailable = false, network = null, discover = true }) {
	const set = (patch) => onChange({ ...value, ...patch });
	const pins = Array.isArray(value.tlsFingerprints) ? value.tlsFingerprints.join(', ') : value.tlsFingerprints || '';
	// A server that names the networks it serves (the rbitcoin app runs
	// mainnet only, each public server one chain) is offered for those
	// alone; one without serves any.
	const forNetwork = (p) => !Array.isArray(p.networks) || !network || p.networks.includes(network);
	const presets = allPresets.filter(forNetwork);
	const publicServers = allPublic.filter(forNetwork);
	const [status, setStatus] = useState({ loading: false, loaded: false, servers: {} });
	const [publicStatus, setPublicStatus] = useState({ loading: false, servers: {} });
	const alive = useRef(true);
	// Which public discovery is the latest, so an answer for the network the
	// fields were on before does not land after the one they are on now.
	const publicAsk = useRef(0);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	const load = (refresh) => {
		setStatus((s) => ({ ...s, loading: true }));
		manager
			.discoverElectrum(refresh)
			.then((r) => alive.current && setStatus({ loading: false, loaded: true, servers: byId(r) }))
			.catch(() => alive.current && setStatus((s) => ({ ...s, loading: false, loaded: true })));
	};
	const loadPublic = (refresh) => {
		const ask = ++publicAsk.current;
		const current = () => alive.current && ask === publicAsk.current;
		setPublicStatus((s) => ({ ...s, loading: true }));
		manager
			.discoverElectrum(refresh, { scope: 'public', network })
			.then((r) => current() && setPublicStatus({ loading: false, servers: byId(r) }))
			.catch(() => current() && setPublicStatus((s) => ({ ...s, loading: false })));
	};
	const wanted = discover && presets.length > 0;
	useEffect(() => {
		if (wanted) load(false);
		// Once per appearance of the preset row; Refresh asks again by hand.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [wanted]);
	// Usable is what the preset badge shows green: there, and on this chain
	// as far as it said. Until the presets have answered once nothing is
	// known, so the public row waits for that; during a Refresh it keeps to
	// the last answer rather than flickering away.
	const localFound = presets.some((p) => describeProbe(status.servers[p.id], network).state === 'reachable');
	const offerPublic = discover && publicServers.length > 0 && (presets.length === 0 || status.loaded) && !localFound;
	const publicFor = offerPublic ? network || '' : null;
	useEffect(() => {
		if (publicFor !== null) loadPublic(false);
		// Once each time the row appears or the chain it is for changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [publicFor]);
	const refresh = () => {
		load(true);
		if (offerPublic) loadPublic(true);
	};
	// A public server is reached over the internet with a certificate a
	// public authority signed, so picking one holds the wallet to it where
	// the engine can.
	const pick = (p) => onChange({ host: p.host, port: p.port, tls: !!p.tls, ...(verifyAvailable && p.tls && p.tlsVerify ? { tlsVerify: true } : {}) });
	return (
		<div>
			{presets.length > 0 && (
				<div className="row preset-row" style={{ marginBottom: 12 }}>
					{presets.map((p) => (
						<PresetButton key={p.id} preset={p} onPick={pick} status={status} network={network} showStatus={wanted} />
					))}
					{wanted && (
						<Button className="sm preset-refresh" data-testid="electrum-refresh" busy={status.loading} onClick={refresh} title="Ask each server again">
							Refresh
						</Button>
					)}
				</div>
			)}
			{offerPublic && (
				<div data-testid="electrum-public">
					<div className="field-label" style={{ marginBottom: 4 }}>
						Public servers
						<Help>
							Someone else runs each of these. The server sees this wallet&apos;s addresses and balance and
							this Umbrel&apos;s IP address, and a dishonest one could hide transactions from it. To keep
							that on this Umbrel, install an Electrum server app such as Electrs or Fulcrum; once it
							answers above, these go away.
						</Help>
					</div>
					<div className="field-hint" style={{ marginBottom: 8 }}>
						No Electrum server on this Umbrel answered{network ? ` on ${network}` : ''}, so here are public ones. Each is
						run by someone else, who can see this wallet&apos;s addresses.
					</div>
					<div className="row preset-row" style={{ marginBottom: 12 }}>
						{publicServers.map((p) => (
							<PresetButton key={p.id} preset={p} onPick={pick} status={publicStatus} network={network} showStatus />
						))}
					</div>
				</div>
			)}
			<div className="row">
				<Field
					label="Host"
					help={
						<>
							An IP address on this network, or the name of a container on this Umbrel (the presets
							use those). A <span className="mono">.local</span> name does not resolve inside the
							app, so for another Umbrel enter its LAN IP address. Port 50001 is usually plaintext
							and 50002 often TLS, though not always (Umbrel's Fulcrum is plaintext on 50002); Test
							says when the TLS box does not match the server.
						</>
					}
				>
					<input
						value={value.host || ''}
						placeholder="192.168.1.10 or electrum.example.com"
						onChange={(e) => set({ host: e.target.value })}
					/>
				</Field>
				<Field label="Port">
					<input
						value={value.port ?? ''}
						onChange={(e) => set({ port: e.target.value })}
						style={{ maxWidth: 120 }}
					/>
				</Field>
				<Field label="TLS">
					<label className="checkbox" style={{ marginTop: 8 }}>
						<input
							type="checkbox"
							checked={!!value.tls}
							onChange={(e) => set({ tls: e.target.checked })}
						/>
						Use TLS
					</label>
				</Field>
			</div>
			<TestConnection value={value} network={network} />
			{verifyAvailable && value.tls && (
				<>
					<label className="checkbox field">
						<input
							type="checkbox"
							data-testid="electrum-tls-verify"
							checked={!!value.tlsVerify}
							onChange={(e) => set({ tlsVerify: e.target.checked })}
						/>
						Verify the server's certificate
						<Help>
							Without this, the connection is encrypted but any certificate is accepted, so anyone
							between this box and the server could answer in its place. With it, the wallet only
							talks to a server whose certificate a public authority signed for this host name, or
							one you pin below. The public fallback servers the wallet may switch to are checked
							the same way, so the ones with self-signed certificates are then refused.
						</Help>
					</label>
					{value.tlsVerify && (
						<Field
							label="Pinned certificates (optional)"
							help={
								<>
									For a server with a self-signed certificate: its SHA-256 fingerprint, as{' '}
									<span className="mono">openssl x509 -noout -fingerprint -sha256</span> prints it.
									Separate several with commas. The wallet's log names the fingerprint of a certificate
									it refused; confirm it with whoever runs the server before pinning it.
								</>
							}
						>
							<input
								data-testid="electrum-tls-pins"
								className="mono"
								value={pins}
								placeholder="AB:CD:... (64 hex characters)"
								onChange={(e) => set({ tlsFingerprints: e.target.value })}
							/>
						</Field>
					)}
				</>
			)}
		</div>
	);
}
