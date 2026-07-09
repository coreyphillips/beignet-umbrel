import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { manager, walletApi } from '../api.js';
import { usePoll } from '../hooks/usePoll.js';
import { useToast } from '../components/Toast.jsx';
import { Button, Card, Modal, Field, Badge } from '../components/ui.jsx';
import ElectrumFields from '../components/ElectrumFields.jsx';
import { copy, fmtSats } from '../lib/format.js';

function statusTone(s) {
	if (s === 'running') return 'green';
	if (s === 'starting' || s === 'restarting') return 'yellow';
	return 'muted';
}

export default function WalletsPage() {
	const toast = useToast();
	const navigate = useNavigate();
	const [config, setConfig] = useState(null);
	const { data, refresh } = usePoll(
		async () => {
			const list = await manager.listWallets();
			const infos = {};
			await Promise.all(
				list
					.filter((w) => w.status === 'running')
					.map(async (w) => {
						try {
							infos[w.id] = await walletApi(w.id).get('/info');
						} catch (_) {
							/* not ready */
						}
					})
			);
			return { list, infos };
		},
		4000,
		[]
	);
	const wallets = data?.list;
	const infos = data?.infos || {};
	const [modal, setModal] = useState(null); // {type, ...}

	useEffect(() => {
		manager.config().then(setConfig).catch((e) => toast(e.message, 'error'));
	}, [toast]);

	if (!config) return <div className="container spinner">Loading…</div>;

	const act = async (fn, ok) => {
		try {
			await fn();
			await refresh();
			if (ok) toast(ok, 'success');
		} catch (e) {
			toast(e.message, 'error');
		}
	};

	const hasWallets = wallets && wallets.length > 0;
	const walletsCard = (
		<Card title="Wallets" actions={<Button className="sm" onClick={refresh}>Refresh</Button>}>
			{!hasWallets ? (
				<div className="empty">No wallets yet. Create or import one below.</div>
			) : (
				wallets.map((w) => {
					const info = infos[w.id];
					return (
						<div key={w.id} className="wallet" onClick={() => navigate(`/w/${w.id}`)}>
							<div className="wallet-main">
								<div className="wallet-name">{w.name}</div>
								<div className="wallet-meta">
									{w.network} · {w.electrum.host}:{w.electrum.port}
								</div>
								{info && (
									<div className="wallet-meta">
										{fmtSats((info.onchainBalanceSats || 0) + (info.lightningBalanceSats || 0))} ·{' '}
										{info.channelCount} channels · {info.peerCount} peers
									</div>
								)}
							</div>
							<div className="wallet-actions" onClick={(e) => e.stopPropagation()}>
								<Badge tone={statusTone(w.status)}>
									<span className="dot" />
									{w.status}
								</Badge>
								{w.status === 'running' ? (
									<Button className="sm" onClick={() => navigate(`/w/${w.id}`)}>
										Open
									</Button>
								) : (
									<Button className="sm" onClick={() => act(() => manager.startWallet(w.id))}>
										Start
									</Button>
								)}
								{w.status !== 'stopped' && (
									<Button className="sm" onClick={() => act(() => manager.stopWallet(w.id))}>
										Stop
									</Button>
								)}
								<Button className="sm" onClick={() => setModal({ type: 'delete', wallet: w })}>
									Delete
								</Button>
							</div>
						</div>
					);
				})
			)}
		</Card>
	);

	return (
		<div className="container">
			<div className="card-head" style={{ marginBottom: 14 }}>
				<div className="topbar-right" style={{ fontSize: 13 }}>
					Network: {config.defaultNetwork}
					{config.defaultElectrum
						? ` · Electrum: ${config.defaultElectrum.host}:${config.defaultElectrum.port}`
						: ' · Electrum: not set'}
				</div>
				<Button onClick={() => setModal({ type: 'settings' })}>Settings</Button>
			</div>

			{hasWallets && walletsCard}
			<NewWallet config={config} onDone={refresh} onSeed={(s) => setModal(s)} />
			{!hasWallets && walletsCard}

			{modal?.type === 'settings' && (
				<SettingsModal
					config={config}
					onClose={() => setModal(null)}
					onSaved={(c) => {
						setConfig(c);
						setModal(null);
						toast('Settings saved', 'success');
					}}
				/>
			)}
			{modal?.type === 'seed' && (
				<SeedModal name={modal.name} mnemonic={modal.mnemonic} onClose={() => setModal(null)} />
			)}
			{modal?.type === 'delete' && (
				<DeleteModal
					wallet={modal.wallet}
					onClose={() => setModal(null)}
					onDeleted={() => {
						setModal(null);
						toast('Wallet deleted', 'success');
						refresh();
					}}
				/>
			)}
		</div>
	);
}

function emptyElectrum(config) {
	return config.defaultElectrum
		? { ...config.defaultElectrum }
		: { host: '', port: 50001, tls: false };
}

function NewWallet({ config, onDone, onSeed }) {
	const toast = useToast();
	const [tab, setTab] = useState('create');
	const [name, setName] = useState('');
	const [network, setNetwork] = useState(config.defaultNetwork);
	const [wordCount, setWordCount] = useState(24);
	const [mnemonic, setMnemonic] = useState('');
	const [custom, setCustom] = useState(!config.defaultElectrum);
	const [electrum, setElectrum] = useState(emptyElectrum(config));
	const [tor, setTor] = useState(false);
	const [announce, setAnnounce] = useState(false);
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		setBusy(true);
		try {
			const elec = custom
				? { host: electrum.host.trim(), port: parseInt(electrum.port, 10), tls: !!electrum.tls }
				: undefined;
			if (tab === 'create') {
				const r = await manager.createWallet({ name, network, wordCount, electrum: elec, tor, announce });
				onSeed({ type: 'seed', name: r.record.name, mnemonic: r.mnemonic });
			} else {
				await manager.importWallet({ name, network, mnemonic, electrum: elec, tor, announce });
				toast('Wallet imported. It will sync in the background.', 'success');
			}
			setName('');
			setMnemonic('');
			onDone();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card>
			<div className="pills">
				<button className={`pill ${tab === 'create' ? 'active' : ''}`} onClick={() => setTab('create')}>
					Create wallet
				</button>
				<button className={`pill ${tab === 'import' ? 'active' : ''}`} onClick={() => setTab('import')}>
					Import wallet
				</button>
			</div>

			<div className="row">
				<Field label="Name">
					<input value={name} placeholder="My wallet" onChange={(e) => setName(e.target.value)} />
				</Field>
				<Field label="Network">
					<select value={network} onChange={(e) => setNetwork(e.target.value)}>
						{config.supportedNetworks.map((n) => (
							<option key={n} value={n}>
								{n}
							</option>
						))}
					</select>
				</Field>
				{tab === 'create' && (
					<Field label="Seed length">
						<select value={wordCount} onChange={(e) => setWordCount(parseInt(e.target.value, 10))}>
							<option value={24}>24 words</option>
							<option value={12}>12 words</option>
						</select>
					</Field>
				)}
			</div>

			{tab === 'import' && (
				<Field label="Recovery phrase">
					<textarea
						rows={3}
						value={mnemonic}
						placeholder="Enter your 12 or 24 word seed phrase"
						onChange={(e) => setMnemonic(e.target.value)}
					/>
				</Field>
			)}

			<label className="checkbox field" style={{ marginTop: 4 }}>
				<input type="checkbox" checked={custom} onChange={(e) => setCustom(e.target.checked)} />
				{config.defaultElectrum ? 'Use a different Electrum server for this wallet' : 'Electrum server'}
			</label>
			{!config.defaultElectrum && !custom && (
				<div className="info-note">No default Electrum server set. Choose one here or in Settings.</div>
			)}
			{custom && (
				<ElectrumFields presets={config.electrumPresets} value={electrum} onChange={setElectrum} />
			)}

			{config.torAvailable && (
				<label className="checkbox field" style={{ marginTop: 4 }}>
					<input type="checkbox" checked={tor} onChange={(e) => setTor(e.target.checked)} />
					Route Lightning connections over Tor
				</label>
			)}
			{config.onionAvailable && (
				<label className="checkbox field">
					<input type="checkbox" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} />
					Advertise a Tor address for inbound channels
				</label>
			)}

			<Button variant="primary" busy={busy} onClick={submit}>
				{tab === 'create' ? 'Create wallet' : 'Import wallet'}
			</Button>
		</Card>
	);
}

function SettingsModal({ config, onClose, onSaved }) {
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
		<Modal title="Settings" onClose={onClose}>
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

function SeedModal({ name, mnemonic, onClose }) {
	const toast = useToast();
	const words = useMemo(() => mnemonic.split(' '), [mnemonic]);
	return (
		<Modal title={`Backup seed for "${name}"`} onClose={onClose}>
			<div className="error-note">
				Write these words down in order and keep them offline. Anyone with this phrase can spend
				your funds. This is the only time it is shown here.
			</div>
			<div className="seed-grid">
				{words.map((w, i) => (
					<div key={i} className="seed-word">
						<span>{i + 1}</span>
						{w}
					</div>
				))}
			</div>
			<div className="center-actions">
				<Button
					onClick={async () => {
						const ok = await copy(mnemonic);
						toast(ok ? 'Seed copied' : 'Copy failed', ok ? 'info' : 'error');
					}}
				>
					Copy phrase
				</Button>
				<Button variant="primary" onClick={onClose}>
					I have saved it
				</Button>
			</div>
		</Modal>
	);
}

function DeleteModal({ wallet, onClose, onDeleted }) {
	const toast = useToast();
	const [purge, setPurge] = useState(false);
	const [busy, setBusy] = useState(false);
	return (
		<Modal title={`Delete "${wallet.name}"`} onClose={onClose}>
			<div className="error-note">
				Deleting removes this wallet from Beignet. If you also erase its data and have not backed
				up the seed, any funds will be lost permanently.
			</div>
			<label className="checkbox field">
				<input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
				Also erase wallet data (seed, database) from disk
			</label>
			<div className="center-actions">
				<Button
					variant="danger"
					busy={busy}
					onClick={async () => {
						setBusy(true);
						try {
							await manager.deleteWallet(wallet.id, purge);
							onDeleted();
						} catch (e) {
							toast(e.message, 'error');
							setBusy(false);
						}
					}}
				>
					Delete wallet
				</Button>
				<Button onClick={onClose}>Cancel</Button>
			</div>
		</Modal>
	);
}
