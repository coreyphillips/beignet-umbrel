import { Field, Help } from './ui.jsx';

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

/**
 * Host / port / TLS inputs plus one-click presets. Controlled via `value`/`onChange`.
 * With `verifyAvailable` (an engine that verifies Electrum certificates), a TLS
 * server also gets the verify switch and its pinned certificates.
 */
export default function ElectrumFields({ presets = [], value, onChange, verifyAvailable = false }) {
	const set = (patch) => onChange({ ...value, ...patch });
	const pins = Array.isArray(value.tlsFingerprints) ? value.tlsFingerprints.join(', ') : value.tlsFingerprints || '';
	return (
		<div>
			{presets.length > 0 && (
				<div className="row" style={{ marginBottom: 12 }}>
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
						</button>
					))}
				</div>
			)}
			<div className="row">
				<Field
					label="Host"
					help={
						<>
							Use an IP address, not a <span className="mono">.local</span> name (mDNS does not
							resolve inside the app). Port 50001 is usually plaintext, 50002 is TLS.
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
