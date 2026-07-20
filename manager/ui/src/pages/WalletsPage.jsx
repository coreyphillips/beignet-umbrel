import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { m } from 'motion/react';
import { manager, walletApi } from '../api.js';
import { usePoll } from '../hooks/usePoll.js';
import { useToast } from '../components/Toast.jsx';
import {
	Button,
	Card,
	Modal,
	Field,
	Badge,
	Segmented,
	Skeleton,
	staggerContainer,
	staggerItem
} from '../components/ui.jsx';
import ElectrumFields from '../components/ElectrumFields.jsx';
import { copy, fmtSats } from '../lib/format.js';

function statusTone(s) {
	if (s === 'running') return 'green';
	if (s === 'starting' || s === 'restarting' || s === 'waiting-electrum') return 'yellow';
	return 'muted';
}

const clickOrigin = (e) => ({ x: e.clientX, y: e.clientY });

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
	const [modal, setModal] = useState(null); // {type, origin?, ...}
	// Stagger the list entrance only once; later polls re-render silently.
	const staggered = useRef(false);
	useEffect(() => {
		if (wallets) staggered.current = true;
	}, [wallets]);

	useEffect(() => {
		manager.config().then(setConfig).catch((e) => toast(e.message, 'error'));
		// The header's Settings dialog broadcasts saved config so ours stays fresh.
		const onCfg = (e) => setConfig(e.detail);
		window.addEventListener('beignet:config', onCfg);
		return () => window.removeEventListener('beignet:config', onCfg);
	}, [toast]);

	if (!config) {
		return (
			<div className="container">
				<Skeleton height={180} style={{ marginBottom: 18 }} />
				<Skeleton height={280} />
			</div>
		);
	}

	const act = async (fn, ok) => {
		try {
			await fn();
			await refresh();
			if (ok) toast(ok, 'success');
		} catch (e) {
			toast(e.message, 'error');
		}
	};

	const openWallet = (w) =>
		navigate(`/w/${w.id}`, { state: { wallet: w, info: infos[w.id] || null } });

	const hasWallets = wallets && wallets.length > 0;
	const walletsCard = (
		<Card title="Wallets" actions={<Button className="sm" onClick={refresh}>Refresh</Button>}>
			{!wallets ? (
				<>
					<Skeleton height={74} style={{ marginBottom: 10 }} />
					<Skeleton height={74} />
				</>
			) : !hasWallets ? (
				<div className="empty">No wallets yet. Create or import one below.</div>
			) : (
				<m.div
					variants={staggerContainer}
					initial={staggered.current ? false : 'hidden'}
					animate="show"
				>
					{wallets.map((w) => {
						const info = infos[w.id];
						return (
							<m.div
								key={w.id}
								layoutId={`wallet-card-${w.id}`}
								variants={staggerItem}
								className="wallet"
								onClick={() => openWallet(w)}
							>
								<div className="wallet-main">
									<m.div layoutId={`wallet-name-${w.id}`} className="wallet-name">
										{w.name}
									</m.div>
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
									<m.span layoutId={`wallet-status-${w.id}`}>
										<Badge tone={statusTone(w.status)}>
											<span className="dot" />
											{w.status}
										</Badge>
									</m.span>
									{w.status === 'running' ? (
										<Button className="sm" onClick={() => openWallet(w)}>
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
									<Button
										className="sm"
										onClick={(e) => setModal({ type: 'delete', wallet: w, origin: clickOrigin(e) })}
									>
										Delete
									</Button>
								</div>
							</m.div>
						);
					})}
				</m.div>
			)}
		</Card>
	);

	return (
		<div className="container">
			{hasWallets && walletsCard}
			<NewWallet config={config} onDone={refresh} onSeed={(s) => setModal(s)} />
			{!hasWallets && walletsCard}

			{modal?.type === 'seed' && (
				<SeedModal name={modal.name} mnemonic={modal.mnemonic} onClose={() => setModal(null)} />
			)}
			{modal?.type === 'delete' && (
				<DeleteModal
					wallet={modal.wallet}
					origin={modal.origin}
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
			<Segmented
				id="new-wallet"
				value={tab}
				onChange={setTab}
				options={[
					['create', 'Create wallet'],
					['import', 'Import wallet']
				]}
			/>

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

			{(config.torAvailable || config.onionAvailable) && (
				<div className="field-label" style={{ marginTop: 4, marginBottom: 8 }}>
					Tor
				</div>
			)}
			{config.torAvailable && (
				<label className="checkbox field">
					<input type="checkbox" checked={tor} onChange={(e) => setTor(e.target.checked)} />
					Outbound: connect to peers over Tor
				</label>
			)}
			{config.onionAvailable && (
				<label className="checkbox field">
					<input type="checkbox" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} />
					Inbound: publish a Tor address so peers can open channels to you
				</label>
			)}

			<Button variant="primary" busy={busy} onClick={submit}>
				{tab === 'create' ? 'Create wallet' : 'Import wallet'}
			</Button>
		</Card>
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
			<m.div
				className="seed-grid"
				variants={staggerContainer}
				initial="hidden"
				animate="show"
			>
				{words.map((w, i) => (
					<m.div key={i} variants={staggerItem} className="seed-word">
						<span>{i + 1}</span>
						{w}
					</m.div>
				))}
			</m.div>
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

function DeleteModal({ wallet, origin, onClose, onDeleted }) {
	const toast = useToast();
	const [purge, setPurge] = useState(false);
	const [busy, setBusy] = useState(false);
	return (
		<Modal title={`Delete "${wallet.name}"`} onClose={onClose} origin={origin}>
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
