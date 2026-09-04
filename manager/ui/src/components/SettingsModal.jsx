import { useEffect, useState } from 'react';
import { manager } from '../api.js';
import { useToast } from './Toast.jsx';
import { Button, Field, Modal } from './ui.jsx';
import ElectrumFields from './ElectrumFields.jsx';
import { guardianEntryLabel, isNodeUri } from '../lib/recovery.js';

/** App-level defaults dialog, opened from the header. */
export default function SettingsModal({ config, origin, onClose, onSaved }) {
	const toast = useToast();
	const [network, setNetwork] = useState(config.defaultNetwork);
	const [electrum, setElectrum] = useState(
		config.defaultElectrum || { host: '', port: 50001, tls: false }
	);
	// Three guardian slots, shown as three inputs; blank ones are dropped
	// before the save. A partial list saves as it stands: a set is often
	// collected one server at a time, and the all-three rule only has to
	// hold when a wallet turns a guardian mode on.
	const [guardians, setGuardians] = useState(() => {
		const list = (config.recoveryGuardians || []).slice(0, 3);
		while (list.length < 3) list.push('');
		return list;
	});
	const [busy, setBusy] = useState(false);
	// A slot may hold a beignet node's Lightning URI rather than a finished
	// entry (beignet #699): the daemon asks that node's guardian for its id
	// and hands back the entry. Resolving happens on the Resolve button or
	// on save, so pasting a node URI and saving just works.
	const [resolving, setResolving] = useState(null);
	// The wallets on this Umbrel that serve as guardians, offered as one-click
	// candidates. A sibling on the same box protects against nothing this box
	// can suffer, so the note says to pair with other Umbrels for the rest.
	const [candidates, setCandidates] = useState([]);
	const [pick, setPick] = useState('');
	const hosting = !!config.recoveryAvailable && !!config.guardianHostingAvailable;
	useEffect(() => {
		if (!hosting) return undefined;
		let alive = true;
		manager
			.guardianCandidates()
			.then((list) => alive && setCandidates(list || []))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [hosting]);

	const resolveSlot = async (i, uri) => {
		setResolving(i);
		try {
			const r = await manager.resolveGuardian(uri);
			setGuardians((prev) => prev.map((x, j) => (j === i ? r.entry : x)));
			return r.entry;
		} finally {
			setResolving(null);
		}
	};

	const addCandidate = async (id) => {
		const c = candidates.find((x) => x.id === id);
		setPick('');
		if (!c) return;
		const slot = guardians.findIndex((g) => !g.trim());
		if (slot < 0) {
			toast('All three guardian slots are filled. Clear one first.', 'error');
			return;
		}
		try {
			await resolveSlot(slot, c.onionUri || c.localUri);
		} catch (e) {
			toast(e.message, 'error');
		}
	};

	const save = async () => {
		setBusy(true);
		try {
			const patch = { defaultNetwork: network };
			patch.defaultElectrum = electrum.host.trim()
				? { host: electrum.host.trim(), port: parseInt(electrum.port, 10), tls: !!electrum.tls }
				: null;
			if (config.recoveryAvailable) {
				const entries = [];
				for (let i = 0; i < guardians.length; i++) {
					const g = guardians[i].trim();
					if (!g) continue;
					entries.push(isNodeUri(g) && hosting ? await resolveSlot(i, g) : g);
				}
				patch.recoveryGuardians = entries;
			}
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
			{config.recoveryAvailable && (
				<>
					<div className="field-label" style={{ marginTop: 4, marginBottom: 8 }}>
						Recovery guardians
					</div>
					<div className="info-note">
						Three guardians that hold an encrypted journal of channel state for wallets
						using a guardian backup mode. Fill in as many as you have and come back for
						the rest; a wallet needs all three before it can use a guardian mode. A
						wallet pins the set it first registers with and cannot move to another set
						later, so choose guardians you expect to keep.
						{hosting
							? ' Any beignet node that serves as a guardian counts: paste its Lightning address (<node id>@host:port) and it resolves to an entry. Three independent operators is the point, so pair with other Umbrels; a wallet on this box protects against nothing this box can suffer.'
							: ''}
					</div>
					{guardians.map((g, i) => (
						<Field key={i} label={`Guardian ${i + 1}`}>
							<div style={{ display: 'flex', gap: 6 }}>
								<input
									value={g}
									placeholder={
										hosting
											? '<node id>@host:port, or <64-hex pubkey>@https://guardian.example'
											: '<64-hex pubkey>@https://guardian.example'
									}
									spellCheck={false}
									data-testid={`guardian-${i}`}
									onChange={(e) =>
										setGuardians((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
									}
								/>
								{hosting && isNodeUri(g) && (
									<Button
										busy={resolving === i}
										onClick={() => resolveSlot(i, g.trim()).catch((e) => toast(e.message, 'error'))}
									>
										Resolve
									</Button>
								)}
							</div>
							{g.trim() && !isNodeUri(g) && (
								<div className="wallet-meta" style={{ marginTop: 4 }}>
									{guardianEntryLabel(g)}
								</div>
							)}
						</Field>
					))}
					{hosting && candidates.length > 0 && (
						<Field label="Add a wallet from this Umbrel">
							<select value={pick} data-testid="guardian-candidate" onChange={(e) => addCandidate(e.target.value)}>
								<option value="">Choose a wallet that serves as a guardian</option>
								{candidates.map((c) => (
									<option key={c.id} value={c.id} disabled={!c.running}>
										{c.name}
										{c.onionUri ? '' : ' (no Tor address: reachable from this box only)'}
										{c.running ? '' : ' (not running)'}
									</option>
								))}
							</select>
						</Field>
					)}
				</>
			)}
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
