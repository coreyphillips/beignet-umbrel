import { useState } from 'react';
import { manager } from '../api.js';
import { useToast } from './Toast.jsx';
import { Button, Field, Modal } from './ui.jsx';
import ElectrumFields from './ElectrumFields.jsx';

/** App-level defaults dialog, opened from the header. */
export default function SettingsModal({ config, origin, onClose, onSaved }) {
	const toast = useToast();
	const [network, setNetwork] = useState(config.defaultNetwork);
	const [electrum, setElectrum] = useState(
		config.defaultElectrum || { host: '', port: 50001, tls: false }
	);
	const [busy, setBusy] = useState(false);

	const save = async () => {
		setBusy(true);
		try {
			const patch = { defaultNetwork: network };
			patch.defaultElectrum = electrum.host.trim()
				? { host: electrum.host.trim(), port: parseInt(electrum.port, 10), tls: !!electrum.tls }
				: null;
			await manager.updateSettings(patch);
			const c = await manager.config();
			onSaved(c);
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal title="Settings" onClose={onClose} origin={origin}>
			<div className="info-note">
				Defaults for new wallets (each wallet can override). No full node required, point at any
				Electrum server, or use a preset if you run Electrs/Fulcrum here.
			</div>
			<Field label="Default network">
				<select value={network} onChange={(e) => setNetwork(e.target.value)}>
					{config.supportedNetworks.map((n) => (
						<option key={n} value={n}>
							{n}
						</option>
					))}
				</select>
			</Field>
			<div className="field-label" style={{ marginBottom: 8 }}>
				Default Electrum server
			</div>
			<ElectrumFields presets={config.electrumPresets} value={electrum} onChange={setElectrum} />
			<div className="center-actions">
				<Button variant="primary" busy={busy} onClick={save}>
					Save settings
				</Button>
				<Button onClick={() => setElectrum({ host: '', port: 50001, tls: false })}>
					Clear Electrum default
				</Button>
			</div>
		</Modal>
	);
}
