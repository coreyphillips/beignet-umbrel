import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { m } from 'motion/react';
import { manager, walletApi } from '../api.js';
import { usePoll } from '../hooks/usePoll.js';
import { describeReceive, useReceiveWatch } from '../hooks/useReceiveWatch.js';
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
import LfbwFields, { EMPTY_LFBW, lfbwBody, lfbwComplete, primaryCandidates } from '../components/LfbwFields.jsx';
import RecoveryModeField from '../components/RecoveryModeField.jsx';
import { copy, fmtSats } from '../lib/format.js';
import { isClosedChannel } from '../lib/channels.js';

function statusTone(s) {
	if (s === 'running') return 'green';
	if (s === 'starting' || s === 'restarting' || s === 'waiting-electrum' || s === 'restore-required') {
		return 'yellow';
	}
	return 'muted';
}

const clickOrigin = (e) => ({ x: e.clientX, y: e.clientY });

/**
 * Renders nothing; watches one running wallet for money arriving. The list
 * page is where balances are stared at, and it used to be the one page a
 * receive said nothing on: the figure changed on the next poll and nothing
 * pointed at it. Named per wallet, because more than one can be running.
 */
// The list page announces receives by POLLING alone, never by holding an
// event stream per wallet. A browser allows six connections per origin, and
// an EventSource holds one open for as long as the page lives: with seven
// running wallets every later request (creating a wallet, opening Settings,
// the transaction polls themselves) queued behind the streams and the page
// read as stuck. The wallet page holds the one stream for the wallet it
// shows; here the watcher's ten-second poll is the whole of it.
function ReceiveWatcher({ wallet }) {
	const toast = useToast();
	const api = useMemo(() => walletApi(wallet.id), [wallet.id]);
	useReceiveWatch(api, true, (r) => {
		toast(describeReceive(r, wallet.name), 'success', { duration: 8000 });
	});
	return null;
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
							const api = walletApi(w.id);
							const info = await api.get('/info');
							// The daemon's /info channelCount is every channel it has ever
							// had, closed ones included, so a wallet whose channels all
							// closed still reads "2 channels" forever. Count open ones from
							// the list itself; on any hiccup fall back to the daemon figure
							// rather than showing nothing.
							try {
								const channels = await api.get('/channels');
								info.openChannelCount = channels.filter(
									(c) => !isClosedChannel(c)
								).length;
							} catch (_) {
								info.openChannelCount = info.channelCount;
							}
							infos[w.id] = info;
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
										{w.onchainOnly ? ' · on-chain only' : ''}
										{w.lfbw?.enabled ? ' · lightning first' : ''}
										{w.lfbwDependents?.length > 0
											? ` · primary for ${w.lfbwDependents.length}`
											: ''}
									</div>
									{w.lfbw?.enabled && w.lfbw.setup === 'failed' && (
										<div className="wallet-meta">Primary node setup failed: {w.lfbw.setupError}</div>
									)}
									{w.status === 'restore-required' && (
										<div className="wallet-meta">Channels waiting to be restored from guardians</div>
									)}
									{w.status === 'restarting' && w.lastStartError && (
										<div className="wallet-meta">Last start failed: {w.lastStartError.message}</div>
									)}
									{info && (
										<div className="wallet-meta">
											{w.onchainOnly ? (
												fmtSats(info.onchainBalanceSats || 0)
											) : (
												<>
													{fmtSats((info.onchainBalanceSats || 0) + (info.lightningBalanceSats || 0))} ·{' '}
													{info.openChannelCount ?? info.channelCount} channels ·{' '}
													{info.peerCount} peers
												</>
											)}
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
									{w.status === 'running' || w.status === 'restore-required' ? (
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
			{(wallets || [])
				.filter((w) => w.status === 'running')
				.map((w) => (
					<ReceiveWatcher key={w.id} wallet={w} />
				))}
			{hasWallets && walletsCard}
			<NewWallet config={config} wallets={wallets} onDone={refresh} onSeed={(s) => setModal(s)} onOpen={openWallet} />
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

function NewWallet({ config, onDone, onSeed, onOpen, wallets }) {
	const toast = useToast();
	const [tab, setTab] = useState('create');
	const [lfbw, setLfbw] = useState({ ...EMPTY_LFBW });
	const [name, setName] = useState('');
	const [network, setNetwork] = useState(config.defaultNetwork);
	const [wordCount, setWordCount] = useState(24);
	const [mnemonic, setMnemonic] = useState('');
	const [custom, setCustom] = useState(!config.defaultElectrum);
	const [electrum, setElectrum] = useState(emptyElectrum(config));
	const [tor, setTor] = useState(false);
	const [announce, setAnnounce] = useState(false);
	const [onchainOnly, setOnchainOnly] = useState(false);
	// Channel backup defaults to seed only until peer-storage restore is
	// reachable end to end; the choice is there for anyone opting in now.
	const [recoveryMode, setRecoveryMode] = useState('off');
	const [busy, setBusy] = useState(false);
	const guardiansConfigured = (config.recoveryGuardians || []).length === 3;

	const submit = async () => {
		setBusy(true);
		try {
			const elec = custom
				? { host: electrum.host.trim(), port: parseInt(electrum.port, 10), tls: !!electrum.tls }
				: undefined;
			if (tab === 'create') {
				const r = await manager.createWallet({
					name,
					network,
					wordCount,
					electrum: elec,
					tor,
					announce,
					onchainOnly,
					recoveryMode: onchainOnly ? 'off' : recoveryMode,
					...(config.lfbwAvailable && !onchainOnly ? { lfbw: lfbwBody(lfbw) } : {})
				});
				onSeed({ type: 'seed', name: r.record.name, mnemonic: r.mnemonic });
			} else {
				const r = await manager.importWallet({
					name,
					network,
					mnemonic,
					electrum: elec,
					tor,
					announce,
					onchainOnly,
					recoveryMode: onchainOnly ? 'off' : recoveryMode,
					...(config.lfbwAvailable && !onchainOnly ? { lfbw: lfbwBody(lfbw) } : {})
				});
				toast('Wallet imported. It will sync in the background.', 'success');
				// A guardian-mode import may land in the restore hold (the
				// guardians already hold this seed's channels); the wallet page
				// is where that is answered, so go there.
				if (!onchainOnly && (recoveryMode === 'async-remote' || recoveryMode === 'quorum') && r?.record?.id) {
					setName('');
					setMnemonic('');
					onDone();
					onOpen(r.record);
					return;
				}
			}
			setName('');
			setMnemonic('');
			setLfbw({ ...EMPTY_LFBW });
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

			<label className="checkbox field">
				<input
					type="checkbox"
					checked={onchainOnly}
					onChange={(e) => setOnchainOnly(e.target.checked)}
				/>
				On-chain only (no Lightning)
			</label>
			{onchainOnly && (
				<div className="info-note">
					A plain Bitcoin wallet: addresses, transactions and coins, with the Lightning
					apparatus put away and no Lightning listener running. The same seed backs both
					modes, so Lightning can be switched on later from the wallet's Edit dialog
					without touching the seed.
					{tab === 'import'
						? " Importing reads the seed's history off the chain itself, reaching back to before this wallet existed, as far as the standard address scan finds use."
						: ''}
				</div>
			)}

			{config.recoveryAvailable && !onchainOnly && (
				<RecoveryModeField
					value={recoveryMode}
					onChange={setRecoveryMode}
					guardiansConfigured={guardiansConfigured}
					importing={tab === 'import'}
				/>
			)}

			{config.lfbwAvailable && !onchainOnly && (
				<LfbwFields value={lfbw} onChange={setLfbw} candidates={primaryCandidates(wallets, { network })} />
			)}

			{(config.torAvailable || config.onionAvailable) && !onchainOnly && (
				<div className="field-label" style={{ marginTop: 4, marginBottom: 8 }}>
					Tor
				</div>
			)}
			{config.torAvailable && !onchainOnly && (
				<label className="checkbox field">
					<input type="checkbox" checked={tor} onChange={(e) => setTor(e.target.checked)} />
					Outbound: connect to peers over Tor
				</label>
			)}
			{config.onionAvailable && !onchainOnly && (
				<label className="checkbox field">
					<input type="checkbox" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} />
					Inbound: publish a Tor address so peers can open channels to you
				</label>
			)}

			<Button variant="primary" busy={busy} onClick={submit} disabled={!onchainOnly && !lfbwComplete(lfbw)}>
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
	const [refused, setRefused] = useState(null);
	const dependents = refused?.dependents || wallet.lfbwDependents || [];
	return (
		<Modal title={`Delete "${wallet.name}"`} onClose={onClose} origin={origin}>
			<div className="error-note">
				Deleting removes this wallet from Beignet. If you also erase its data and have not backed
				up the seed, any funds will be lost permanently.
			</div>
			{dependents.length > 0 && (
				<div className="error-note" role="alert">
					This wallet is the primary node of {dependents.map((d) => `"${d.name}"`).join(', ')}: their
					home channel, inbound capacity and deposits all run through it. Change their primary node
					or delete them first.
				</div>
			)}
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
							if (e.code === 'PRIMARY_IN_USE') setRefused(e.details || { dependents: [] });
							toast(e.message, 'error');
							setBusy(false);
						}
					}}
					disabled={dependents.length > 0}
				>
					Delete wallet
				</Button>
				<Button onClick={onClose}>Cancel</Button>
			</div>
		</Modal>
	);
}
