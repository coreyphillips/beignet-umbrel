import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, m } from 'motion/react';
import { manager, walletApi } from '../api.js';
import { usePoll } from '../hooks/usePoll.js';
import { useSSE } from '../hooks/useSSE.js';
import { useToast } from '../components/Toast.jsx';
import { AnimatedNumber, Badge, Button, Field, Modal } from '../components/ui.jsx';
import ElectrumFields from '../components/ElectrumFields.jsx';
import { shortId } from '../lib/format.js';
import OverviewTab from './tabs/OverviewTab.jsx';
import ReceiveTab from './tabs/ReceiveTab.jsx';
import SendTab from './tabs/SendTab.jsx';
import ChannelsTab from './tabs/ChannelsTab.jsx';
import PeersTab from './tabs/PeersTab.jsx';
import ActivityTab from './tabs/ActivityTab.jsx';
import OffersTab from './tabs/OffersTab.jsx';
import LogsTab from './tabs/LogsTab.jsx';

const TABS = [
	['overview', 'Overview', OverviewTab],
	['receive', 'Receive', ReceiveTab],
	['send', 'Send', SendTab],
	['channels', 'Channels', ChannelsTab],
	['peers', 'Peers', PeersTab],
	['activity', 'Activity', ActivityTab],
	['offers', 'Offers', OffersTab],
	['logs', 'Logs', LogsTab]
];

const EVENT_LABELS = {
	'payment:received': 'Payment received',
	'payment:sent': 'Payment sent',
	'payment:failed': 'Payment failed',
	'channel:ready': 'Channel ready',
	'channel:closed': 'Channel closed'
};

export default function WalletPage() {
	const { id, tab = 'overview' } = useParams();
	const navigate = useNavigate();
	const location = useLocation();
	const toast = useToast();
	const api = useMemo(() => walletApi(id), [id]);
	const [tick, setTick] = useState(0);
	const bump = useCallback(() => setTick((t) => t + 1), []);

	const { data: polledRec, refresh: refreshRec } = usePoll(() => manager.getWallet(id), 5000, [id]);
	// The list page hands the wallet summary over via navigation state, so the
	// morphing header renders real content immediately instead of flashing.
	const rec = polledRec || location.state?.wallet || null;
	const running = rec?.status === 'running';
	const [config, setConfig] = useState(null);
	const [editing, setEditing] = useState(null); // click origin or null
	useEffect(() => {
		manager.config().then(setConfig).catch(() => {});
	}, []);

	const { data: polledInfo } = usePoll(
		() => (running ? api.get('/info') : Promise.resolve(null)),
		8000,
		[id, running, tick]
	);
	const info = polledInfo || location.state?.info || null;
	const { data: health } = usePoll(
		() => (running ? api.get('/health') : Promise.resolve(null)),
		8000,
		[id, running, tick]
	);

	useSSE(running ? api.eventsUrl() : null, (name) => {
		bump();
		if (EVENT_LABELS[name]) toast(EVENT_LABELS[name], name === 'payment:failed' ? 'error' : 'success');
	});

	const ActiveTab = (TABS.find((t) => t[0] === tab) || TABS[0])[2];

	return (
		<div className="container">
			<Link to="/" className="back-link">
				← All wallets
			</Link>

			<m.div layoutId={`wallet-card-${id}`} className="whead">
				<div className="wallet-title">
					<m.div layoutId={`wallet-name-${id}`}>
						<h2>{rec?.name || 'Wallet'}</h2>
					</m.div>
					{rec && (
						<m.span layoutId={`wallet-status-${id}`}>
							<Badge tone={running ? 'green' : rec.status === 'stopped' ? 'muted' : 'yellow'}>
								<span className="dot" />
								{rec.status}
							</Badge>
						</m.span>
					)}
					{rec && <Badge tone="blue">{rec.network}</Badge>}
					{health && (
						<Badge tone={health.electrumConnected ? 'green' : 'red'}>
							{health.electrumConnected ? 'electrum ok' : 'electrum down'}
						</Badge>
					)}
					<Button className="sm" onClick={(e) => setEditing({ x: e.clientX, y: e.clientY })}>
						Edit
					</Button>
				</div>
				<div className="wallet-meta">
					{info ? (
						<>
							<AnimatedNumber value={info.onchainBalanceSats} suffix=" sats" /> on-chain ·{' '}
							<AnimatedNumber value={info.lightningBalanceSats} suffix=" sats" /> lightning · node{' '}
							{shortId(info.nodeId)} · height {info.blockHeight}
						</>
					) : rec?.electrum ? (
						`electrum ${rec.electrum.host}:${rec.electrum.port}`
					) : (
						'Loading…'
					)}
				</div>
			</m.div>

			{!running ? (
				<div className="card">
					<div className="empty">
						This wallet is not running.
						<div className="center-actions" style={{ justifyContent: 'center' }}>
							<Button
								variant="primary"
								onClick={async () => {
									try {
										await manager.startWallet(id);
										toast('Starting…', 'info');
										refreshRec();
									} catch (e) {
										toast(e.message, 'error');
									}
								}}
							>
								Start wallet
							</Button>
							<Button onClick={() => navigate('/')}>Back</Button>
						</div>
					</div>
				</div>
			) : (
				<div className="wallet-layout">
					{rec?.tor && rec.torCircuitOk === false && (
						<div className="error-note" style={{ gridColumn: '1 / -1', marginBottom: 14 }}>
							Tor on this Umbrel cannot build circuits right now, so this wallet's peer
							connections (channel opens included) will time out. Restart Tor on your Umbrel,
							or edit this wallet and turn Tor off to connect directly.
						</div>
					)}
					<nav className="wnav">
						{TABS.map(([key, label]) => (
							<NavLink key={key} to={`/w/${id}/${key}`} className={key === tab ? 'active' : ''}>
								{key === tab && (
									<m.span
										layoutId="wnav-indicator"
										className="wnav-indicator"
										transition={{ type: 'spring', stiffness: 500, damping: 40 }}
									/>
								)}
								{label}
							</NavLink>
						))}
						<a href={`/swagger.html?id=${id}`} target="_blank" rel="noreferrer">
							Raw API ↗
						</a>
					</nav>
					<AnimatePresence mode="wait" initial={false}>
						<m.div
							key={tab}
							initial={{ opacity: 0, y: 10 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -6 }}
							transition={{ duration: 0.18, ease: 'easeOut' }}
						>
							<ActiveTab id={id} api={api} info={info} health={health} rec={rec} tick={tick} bump={bump} />
						</m.div>
					</AnimatePresence>
				</div>
			)}

			{editing && rec && (
				<EditWalletModal
					rec={rec}
					origin={editing}
					presets={config?.electrumPresets || []}
					torAvailable={!!config?.torAvailable}
					onionAvailable={!!config?.onionAvailable}
					onClose={() => setEditing(null)}
					onSaved={() => {
						setEditing(null);
						toast('Wallet updated', 'success');
						refreshRec();
						bump();
					}}
				/>
			)}
		</div>
	);
}

function EditWalletModal({ rec, origin, presets, torAvailable, onionAvailable, onClose, onSaved }) {
	const toast = useToast();
	const [name, setName] = useState(rec.name);
	const [electrum, setElectrum] = useState({ ...rec.electrum });
	const [tor, setTor] = useState(!!rec.tor);
	const [announce, setAnnounce] = useState(!!rec.announce);
	const [busy, setBusy] = useState(false);

	const save = async () => {
		setBusy(true);
		try {
			await manager.updateWallet(rec.id, {
				name,
				tor,
				announce,
				electrum: {
					host: electrum.host.trim(),
					port: parseInt(electrum.port, 10),
					tls: !!electrum.tls
				}
			});
			onSaved();
		} catch (e) {
			toast(e.message, 'error');
			setBusy(false);
		}
	};

	return (
		<Modal title="Edit wallet" onClose={onClose} origin={origin}>
			<div className="info-note">
				Changing the Electrum server restarts this wallet so it reconnects. The network
				({rec.network}) and seed stay the same.
			</div>
			<Field label="Name">
				<input value={name} onChange={(e) => setName(e.target.value)} />
			</Field>
			<div className="field-label" style={{ marginBottom: 8 }}>
				Electrum server
			</div>
			<ElectrumFields presets={presets} value={electrum} onChange={setElectrum} />
			{torAvailable && (
				<label className="checkbox field">
					<input type="checkbox" checked={tor} onChange={(e) => setTor(e.target.checked)} />
					Route Lightning connections over Tor
				</label>
			)}
			{onionAvailable && (
				<label className="checkbox field">
					<input type="checkbox" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} />
					Advertise a Tor address for inbound channels
				</label>
			)}
			<div className="center-actions">
				<Button variant="primary" busy={busy} onClick={save} disabled={!electrum.host}>
					Save changes
				</Button>
				<Button onClick={onClose}>Cancel</Button>
			</div>
		</Modal>
	);
}
