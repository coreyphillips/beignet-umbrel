import { useEffect, useRef, useState } from 'react';
import { manager } from '../api.js';
import { Button, Field, Help } from './ui.jsx';
import { ServerStatus, describeTest } from './ElectrumStatus.jsx';

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
 * for the server as it was typed, so it goes away when any field changes.
 */
function TestConnection({ value, network }) {
	const [busy, setBusy] = useState(false);
	const [outcome, setOutcome] = useState(null);
	const key = JSON.stringify(testable(value) ? electrumBody(value) : null);
	const shown = useRef(key);
	useEffect(() => {
		if (shown.current !== key) {
			shown.current = key;
			setOutcome(null);
		}
	}, [key]);
	const run = async () => {
		setBusy(true);
		try {
			const result = await manager.testElectrum({ ...electrumBody(value), ...(network ? { network } : {}) });
			shown.current = key;
			setOutcome(describeTest(result));
		} catch (e) {
			setOutcome({ state: 'error', text: e.message });
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="electrum-test-row">
			<Button className="sm" data-testid="electrum-test" busy={busy} disabled={!testable(value)} onClick={run}>
				Test connection
			</Button>
			{outcome && (
				<span className="electrum-test-result" data-testid="electrum-test-result" data-state={outcome.state} role="status">
					{outcome.text}
				</span>
			)}
		</div>
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
 */
export default function ElectrumFields({ presets = [], value, onChange, verifyAvailable = false, network = null, discover = true }) {
	const set = (patch) => onChange({ ...value, ...patch });
	const pins = Array.isArray(value.tlsFingerprints) ? value.tlsFingerprints.join(', ') : value.tlsFingerprints || '';
	const [status, setStatus] = useState({ loading: false, servers: {} });
	const alive = useRef(true);
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
			.then((r) => {
				if (!alive.current) return;
				const servers = {};
				for (const s of (r && r.servers) || []) servers[s.id] = s;
				setStatus({ loading: false, servers });
			})
			.catch(() => alive.current && setStatus((s) => ({ ...s, loading: false })));
	};
	const wanted = discover && presets.length > 0;
	useEffect(() => {
		if (wanted) load(false);
		// Once per appearance of the preset row; Refresh asks again by hand.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [wanted]);
	return (
		<div>
			{presets.length > 0 && (
				<div className="row preset-row" style={{ marginBottom: 12 }}>
					{presets.map((p) => (
						<button
							type="button"
							key={p.id}
							className="btn sm preset-btn"
							onClick={() => onChange({ host: p.host, port: p.port, tls: !!p.tls })}
							title={p.note}
						>
							<span className="preset-name">{p.label}</span>
							<span className="preset-host">
								{p.host}:{p.port}
							</span>
							{wanted && (
								<ServerStatus
									result={status.servers[p.id]}
									network={network}
									loading={status.loading}
									data-testid={`preset-status-${p.id}`}
								/>
							)}
						</button>
					))}
					{wanted && (
						<Button className="sm preset-refresh" data-testid="electrum-refresh" busy={status.loading} onClick={() => load(true)} title="Ask each preset again">
							Refresh
						</Button>
					)}
				</div>
			)}
			<div className="row">
				<Field
					label="Host"
					help={
						<>
							An IP address on this network, or the name of a container on this Umbrel (the presets
							use those). A <span className="mono">.local</span> name does not resolve inside the
							app, so for another Umbrel enter its LAN IP address. Port 50001 is usually plaintext,
							50002 is TLS.
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
