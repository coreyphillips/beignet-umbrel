import { Field } from './ui.jsx';

/** Host / port / TLS inputs plus one-click presets. Controlled via `value`/`onChange`. */
export default function ElectrumFields({ presets = [], value, onChange }) {
	const set = (patch) => onChange({ ...value, ...patch });
	return (
		<div>
			{presets.length > 0 && (
				<div className="row" style={{ marginBottom: 12 }}>
					{presets.map((p) => (
						<button
							type="button"
							key={p.id}
							className="btn sm"
							onClick={() => onChange({ host: p.host, port: p.port, tls: !!p.tls })}
							title={p.note}
							style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}
						>
							<span style={{ color: 'var(--text)' }}>{p.label}</span>
							<span style={{ color: 'var(--muted)', fontSize: 11 }}>
								{p.host}:{p.port}
							</span>
						</button>
					))}
				</div>
			)}
			<div className="row">
				<Field label="Host">
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
			<div className="field-hint">
				Tip: use an IP address, not a <span className="mono">.local</span> name (mDNS does not
				resolve inside the app). Port 50001 is usually plaintext, 50002 is TLS.
			</div>
		</div>
	);
}
