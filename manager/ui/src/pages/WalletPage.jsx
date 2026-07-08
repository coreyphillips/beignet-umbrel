import { useCallback, useMemo, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import { manager, walletApi } from '../api.js';
import { usePoll } from '../hooks/usePoll.js';
import { useSSE } from '../hooks/useSSE.js';
import { useToast } from '../components/Toast.jsx';
import { Badge, Button } from '../components/ui.jsx';
import { fmtSats, shortId } from '../lib/format.js';
import OverviewTab from './tabs/OverviewTab.jsx';
import ReceiveTab from './tabs/ReceiveTab.jsx';
import SendTab from './tabs/SendTab.jsx';
import ChannelsTab from './tabs/ChannelsTab.jsx';
import PeersTab from './tabs/PeersTab.jsx';
import ActivityTab from './tabs/ActivityTab.jsx';
import OffersTab from './tabs/OffersTab.jsx';

const TABS = [
	['overview', 'Overview', OverviewTab],
	['receive', 'Receive', ReceiveTab],
	['send', 'Send', SendTab],
	['channels', 'Channels', ChannelsTab],
	['peers', 'Peers', PeersTab],
	['activity', 'Activity', ActivityTab],
	['offers', 'Offers', OffersTab]
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
	const toast = useToast();
	const api = useMemo(() => walletApi(id), [id]);
	const [tick, setTick] = useState(0);
	const bump = useCallback(() => setTick((t) => t + 1), []);

	const { data: rec } = usePoll(() => manager.getWallet(id), 5000, [id]);
	const running = rec?.status === 'running';

	const { data: info } = usePoll(
		() => (running ? api.get('/info') : Promise.resolve(null)),
		8000,
		[id, running, tick]
	);
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

			<div className="wallet-title">
				<h2>{rec?.name || 'Wallet'}</h2>
				{rec && (
					<Badge tone={running ? 'green' : rec.status === 'stopped' ? 'muted' : 'yellow'}>
						<span className="dot" />
						{rec.status}
					</Badge>
				)}
				{rec && <Badge tone="blue">{rec.network}</Badge>}
				{health && (
					<Badge tone={health.electrumConnected ? 'green' : 'red'}>
						{health.electrumConnected ? 'electrum ok' : 'electrum down'}
					</Badge>
				)}
			</div>
			<div className="wallet-meta" style={{ marginBottom: 16 }}>
				{info ? (
					<>
						{fmtSats(info.onchainBalanceSats)} on-chain · {fmtSats(info.lightningBalanceSats)}{' '}
						lightning · node {shortId(info.nodeId)} · height {info.blockHeight}
					</>
				) : rec ? (
					`electrum ${rec.electrum.host}:${rec.electrum.port}`
				) : (
					'Loading…'
				)}
			</div>

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
					<nav className="wnav">
						{TABS.map(([key, label]) => (
							<NavLink
								key={key}
								to={`/w/${id}/${key}`}
								className={key === tab ? 'active' : ''}
							>
								{label}
							</NavLink>
						))}
						<a href={`/swagger.html?id=${id}`} target="_blank" rel="noreferrer">
							Raw API ↗
						</a>
					</nav>
					<div>
						<ActiveTab id={id} api={api} info={info} health={health} tick={tick} bump={bump} />
					</div>
				</div>
			)}
		</div>
	);
}
