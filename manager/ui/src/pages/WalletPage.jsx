import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, m } from 'motion/react';
import { manager, walletApi } from '../api.js';
import { usePoll } from '../hooks/usePoll.js';
import { useSSE } from '../hooks/useSSE.js';
import { describeReceive, useReceiveWatch } from '../hooks/useReceiveWatch.js';
import { useToast } from '../components/Toast.jsx';
import { AnimatedNumber, Badge, Button, CopyText, Field, Modal } from '../components/ui.jsx';
import ElectrumFields from '../components/ElectrumFields.jsx';
import RecoveryModeField from '../components/RecoveryModeField.jsx';
import RecoveryAutoApplyField from '../components/RecoveryAutoApplyField.jsx';
import GuardianServeField from '../components/GuardianServeField.jsx';
import RestorePanel, { readRestoreMarker } from '../components/RestorePanel.jsx';
import CapsuleRestoreCard from '../components/CapsuleRestoreCard.jsx';
import { shortId } from '../lib/format.js';
import { isClosedChannel } from '../lib/channels.js';
import { capsuleOffer, describeRecovery, isGuardianMode, restoreProgress } from '../lib/recovery.js';
import LfbwFields, { EMPTY_LFBW, ProviderFields, lfbwBody, lfbwComplete, primaryCandidates } from '../components/LfbwFields.jsx';
import OverviewTab from './tabs/OverviewTab.jsx';
import LfbwOverviewTab from './tabs/lfbw/LfbwOverviewTab.jsx';
import ReceiveTab from './tabs/ReceiveTab.jsx';
import SendTab from './tabs/SendTab.jsx';
import ChannelsTab from './tabs/ChannelsTab.jsx';
import PeersTab from './tabs/PeersTab.jsx';
import ActivityTab from './tabs/ActivityTab.jsx';
import OffersTab from './tabs/OffersTab.jsx';
import ToolsTab from './tabs/ToolsTab.jsx';
import LogsTab from './tabs/LogsTab.jsx';
import ConsoleTab from './tabs/ConsoleTab.jsx';

const TABS = [
	['overview', 'Overview', OverviewTab],
	['receive', 'Receive', ReceiveTab],
	['send', 'Send', SendTab],
	['channels', 'Channels', ChannelsTab],
	['peers', 'Peers', PeersTab],
	['activity', 'Activity', ActivityTab],
	['offers', 'Offers', OffersTab],
	['tools', 'Tools', ToolsTab],
	['logs', 'Logs', LogsTab],
	['console', 'Console', ConsoleTab]
];

// A lightning-first wallet's whole surface: one balance, receive, send. The
// full tab set is a toggle away, for looking under the hood.
const LFBW_TABS = [
	['overview', 'Overview', LfbwOverviewTab],
	['receive', 'Receive', ReceiveTab],
	['send', 'Send', SendTab]
];
const ADVANCED_KEY = 'beignet-lfbw-advanced';

/** Whether the edit form points the wallet at a different primary than its record holds. */
function primaryChanged(form, current) {
	if (!form || !current) return false;
	if (form.primaryWalletId === 'external') {
		return current.mode !== 'external' || (form.primaryUri || '').trim() !== (current.primaryUri || '');
	}
	return current.mode !== 'internal' || form.primaryWalletId !== current.primaryWalletId;
}
function readAdvanced() {
	try {
		return sessionStorage.getItem(ADVANCED_KEY) === '1';
	} catch (_) {
		return false;
	}
}

// Receives are absent deliberately: they are announced by the receive watcher
// below, which knows the amount and catches the ones the stream missed.
const EVENT_LABELS = {
	'payment:sent': 'Payment sent',
	'payment:failed': 'Payment failed',
	'channel:ready': 'Channel ready',
	'channel:closed': 'Channel closed',
	// Channel backup (the Recovery Protocol). Rare, and each one changes what
	// the owner should do next, so they are announced rather than left to the
	// Backup row to be noticed.
	'recovery:fenced': "Another device took over this wallet's channels",
	'recovery:guardian_unreachable': 'A recovery guardian is unreachable',
	'recovery:backfill-lost': 'Recovery journal broken: channels are held',
	'recovery:capsule-retrieved': 'A peer returned a channel checkpoint',
	// Lightning-first progress (beignet #669). On a liquidity provider: a
	// channel it is funding for a payment to one of its wallets, and the
	// delivery. On a lightning-first wallet: a beignet payer's direct funding
	// accepted, landed, or lost.
	'jit:funding': 'Funding a channel for an incoming payment',
	'jit:forwarded': 'Payment delivered through a just-in-time channel',
	'jit:failed': 'A held payment could not be delivered',
	'direct-funding:offer:accepted': 'A direct funding was accepted',
	'direct-funding:offer:completed': 'Direct funding landed in your channel',
	'direct-funding:offer:failed': 'A direct funding failed'
};
const ERROR_EVENTS = new Set([
	'payment:failed',
	'recovery:fenced',
	'recovery:guardian_unreachable',
	'recovery:backfill-lost',
	'jit:failed',
	'direct-funding:offer:failed'
]);

export default function WalletPage() {
	const { id, tab = 'overview' } = useParams();
	const navigate = useNavigate();
	const location = useLocation();
	const toast = useToast();
	const api = useMemo(() => walletApi(id), [id]);
	const [tick, setTick] = useState(0);
	const bump = useCallback(() => setTick((t) => t + 1), []);
	const [advanced, setAdvanced] = useState(readAdvanced);
	const toggleAdvanced = () => {
		const next = !advanced;
		setAdvanced(next);
		try {
			sessionStorage.setItem(ADVANCED_KEY, next ? '1' : '0');
		} catch (_) {
			/* no storage, no memory of the choice */
		}
	};

	// Re-read on every bump too: a tab that just changed the record (a
	// lightning-first setup retry) must not wait out the poll to show it.
	const { data: polledRec, refresh: refreshRec } = usePoll(() => manager.getWallet(id), 5000, [id, tick]);
	// The list page hands the wallet summary over via navigation state, so the
	// morphing header renders real content immediately instead of flashing.
	const rec = polledRec || location.state?.wallet || null;
	const running = rec?.status === 'running';
	// A daemon holding for a guardian restore is up but has no node: the
	// manager reports restore-required, the daemon's own status route says
	// restore-required or restoring. The panel takes the tab area for the
	// hold, and keeps it (a session marker, so a reload lands back here) until
	// the owner leaves it after the channels have landed.
	const restoreHold = rec?.status === 'restore-required';
	const [restoreMarker, setRestoreMarker] = useState(() => readRestoreMarker(id));
	useEffect(() => {
		setRestoreMarker(readRestoreMarker(id));
	}, [id]);
	// Leaving the panel after the node booted waits for the manager to report
	// the wallet running (its hold poll runs every two seconds), so the tabs
	// appear once instead of the list page for a beat.
	const [leavingRestore, setLeavingRestore] = useState(false);
	useEffect(() => {
		if (leavingRestore && running) {
			setLeavingRestore(false);
			setRestoreMarker(false);
			bump();
		}
	}, [leavingRestore, running, bump]);
	const showRestore = restoreHold || (running && restoreMarker);
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
	// Channel backup. A 404 is an engine that predates the feature, which
	// reads as seed only; any other failure keeps the last answer (usePoll
	// leaves data alone on a throw) rather than flashing a tier away.
	const { data: recovery } = usePoll(
		() =>
			running
				? api.get('/recovery/status').catch((e) => {
						if (e && e.status === 404) return { state: 'unsupported' };
						throw e;
				  })
				: Promise.resolve(null),
		8000,
		[id, running, tick]
	);
	const backup = running && rec && recovery ? describeRecovery(recovery, rec) : null;

	// Money arriving is the one event a wallet's owner did nothing to cause, so
	// it must not depend on them causing anything to see it. The watcher is fed
	// by the SSE stream below for immediacy and backstopped by its own poll of
	// the payment and transaction lists, so a receive is announced even when the
	// stream died without saying so. The last one is handed to the tabs: the
	// Receive tab flips its on-screen invoice to paid the moment it settles.
	const [lastReceive, setLastReceive] = useState(null);
	const { onEvent: receiveEvent } = useReceiveWatch(api, running, (r) => {
		setLastReceive(r);
		toast(describeReceive(r), 'success', { duration: 8000 });
		bump();
	});

	// The stream is open during the hold too: the daemon's /events arm
	// bypasses the hold, and restore progress rides it.
	useSSE(running || restoreHold ? api.eventsUrl() : null, (name, data) => {
		bump();
		receiveEvent(name, data);
		if (EVENT_LABELS[name]) toast(EVENT_LABELS[name], ERROR_EVENTS.has(name) ? 'error' : 'success');
	});

	// An on-chain only wallet gets no Lightning apparatus: not hidden features,
	// absent ones. A URL pointing at a withheld tab falls back to Overview the
	// same way an unknown tab always has.
	const LIGHTNING_TABS = ['channels', 'peers', 'offers'];
	const isLfbw = !!rec?.lfbw?.enabled;
	const simple = isLfbw && !advanced;
	const tabs = simple
		? LFBW_TABS
		: rec?.onchainOnly
		? TABS.filter(([key]) => !LIGHTNING_TABS.includes(key))
		: TABS;
	const ActiveTab = (tabs.find((t) => t[0] === tab) || tabs[0])[2];
	// A URL pointing at a tab the simple view withholds lands on Overview,
	// and the address bar says so.
	useEffect(() => {
		if (simple && !tabs.some((t) => t[0] === tab)) navigate(`/w/${id}/overview`, { replace: true });
	}, [simple, tab, tabs, id, navigate]);

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
					{rec?.onchainOnly && <Badge tone="muted">on-chain only</Badge>}
					{isLfbw && <Badge tone="blue">lightning first</Badge>}
					{rec?.lfbwDependents?.length > 0 && (
						<Badge tone="muted">
							primary for {rec.lfbwDependents.length}
						</Badge>
					)}
					{health && (
						<Badge tone={health.electrumConnected ? 'green' : 'red'}>
							{health.electrumConnected ? 'electrum ok' : 'electrum down'}
						</Badge>
					)}
					{backup?.degraded && !rec?.onchainOnly && (
						<Badge tone={backup.tone}>{backup.tier}</Badge>
					)}
					<Button className="sm" onClick={(e) => setEditing({ x: e.clientX, y: e.clientY })}>
						Edit
					</Button>
				</div>
				<div className="wallet-meta">
					{info ? (
						<>
							{simple ? (
								// One balance: a lightning-first wallet does not present its
								// two rails as two figures, the arriving part is said on its
								// Overview instead.
								<>
									<AnimatedNumber
										value={(info.onchainBalanceSats || 0) + (info.lightningBalanceSats || 0)}
										suffix=" sats"
									/>{' '}
									·{' '}
								</>
							) : (
								<>
									<AnimatedNumber value={info.onchainBalanceSats} suffix=" sats" /> on-chain ·{' '}
									{!rec?.onchainOnly && (
										<>
											<AnimatedNumber value={info.lightningBalanceSats} suffix=" sats" /> lightning ·{' '}
										</>
									)}
								</>
							)}
							node <CopyText value={info.nodeId} label={shortId(info.nodeId)} /> · height{' '}
							{info.blockHeight}
						</>
					) : rec?.electrum ? (
						`electrum ${rec.electrum.host}:${rec.electrum.port}`
					) : (
						'Loading…'
					)}
				</div>
			</m.div>

			{rec?.status === 'restarting' && rec.lastStartError && (
				<div className="error-note" style={{ marginBottom: 14 }}>
					The wallet's last start failed and it is retrying: {rec.lastStartError.message}
				</div>
			)}

			{showRestore ? (
				<RestorePanel
					id={id}
					api={api}
					rec={rec}
					tick={tick}
					onStarted={() => setRestoreMarker(true)}
					onDone={(landed) => {
						if (landed && !running) {
							setLeavingRestore(true);
							refreshRec();
							return;
						}
						setRestoreMarker(false);
						if (!running) navigate('/');
						else bump();
					}}
				/>
			) : !running ? (
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
					<ResumeBanner recovery={recovery} />
					{capsuleOffer(recovery, info) && (
						<div style={{ gridColumn: '1 / -1', marginBottom: 14 }}>
							<CapsuleRestoreCard
								api={api}
								offer={capsuleOffer(recovery, info)}
								onRestored={() => {
									toast('Checkpoint restored', 'success');
									refreshRec();
									bump();
								}}
							/>
						</div>
					)}
					{rec?.tor && !rec.onchainOnly && rec.torCircuitOk === false && (
						<div className="error-note" style={{ gridColumn: '1 / -1', marginBottom: 14 }}>
							Tor on this Umbrel cannot build circuits right now. Peers reached over Tor,
							onion addresses and, while Tor is on, public ones, will time out. Peers on
							your own network still connect directly and are unaffected. Restart Tor on
							your Umbrel, or edit this wallet to turn Tor off and route every peer directly.
						</div>
					)}
					<nav className="wnav">
						{tabs.map(([key, label]) => (
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
						{!simple && (
							<a href={`/swagger.html?id=${id}`} target="_blank" rel="noreferrer">
								Raw API ↗
							</a>
						)}
						{isLfbw && (
							<button type="button" className="wnav-toggle" onClick={toggleAdvanced}>
								{advanced ? 'Simple view' : 'Advanced view'}
							</button>
						)}
					</nav>
					<AnimatePresence mode="wait" initial={false}>
						<m.div
							key={tab}
							initial={{ opacity: 0, y: 10 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -6 }}
							transition={{ duration: 0.18, ease: 'easeOut' }}
						>
							<ActiveTab
								id={id}
								api={api}
								info={info}
								health={health}
								recovery={recovery}
								rec={rec}
								tick={tick}
								bump={bump}
								lastReceive={lastReceive}
								config={config}
							/>
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
					recoveryAvailable={!!config?.recoveryAvailable}
					recoveryAutoApplyAvailable={!!config?.recoveryAutoApplyAvailable}
					guardianHostingAvailable={!!config?.guardianHostingAvailable}
					lfbwAvailable={!!config?.lfbwAvailable}
					settingsGuardians={config?.recoveryGuardians || []}
					restoring={rec.status === 'restore-required' || recovery?.state === 'restoring'}
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

// Channels still reconciling after a restore (or held behind the guardian
// gate after a restart) are said so above the tabs, whatever page the owner
// came in through: a restore is never presented as finished while a channel
// is quarantined or reestablishing.
function ResumeBanner({ recovery }) {
	if (!recovery || recovery.mode === 'off' || !recovery.node) return null;
	const { channels, complete } = restoreProgress(recovery);
	if (complete || channels.total === 0 || channels.pending === 0) return null;
	const landed = channels.resumed + channels.closing;
	return (
		<div className="info-note" style={{ gridColumn: '1 / -1', marginBottom: 14 }}>
			Channels resuming: {landed} of {channels.total}
			{channels.closing > 0 ? ` (${channels.closing} closing safely, funds return on-chain)` : ''}.
			Each channel reconciles with its peer the moment the peer is reachable
			{isGuardianMode(recovery.mode)
				? ', and the guardians must confirm this device owns them before any payment moves.'
				: '.'}
		</div>
	);
}

function EditWalletModal({
	rec,
	origin,
	presets,
	torAvailable,
	onionAvailable,
	recoveryAvailable = false,
	recoveryAutoApplyAvailable = false,
	guardianHostingAvailable = false,
	lfbwAvailable = false,
	settingsGuardians = [],
	restoring = false,
	onClose,
	onSaved
}) {
	const toast = useToast();
	const [name, setName] = useState(rec.name);
	// Lightning-first: the primary node this wallet pairs with, and whether
	// this wallet provides liquidity to others. Sibling candidates come from
	// the wallet list, asked once the dialog opens.
	const [lfbw, setLfbw] = useState(() =>
		rec.lfbw?.enabled
			? {
					enabled: true,
					primaryWalletId: rec.lfbw.mode === 'internal' ? rec.lfbw.primaryWalletId : 'external',
					primaryUri: rec.lfbw.primaryUri || '',
					trusted: !!rec.lfbw.trusted,
					initialChannelSats: ''
			  }
			: { ...EMPTY_LFBW }
	);
	const [provider, setProvider] = useState(!!rec.liquidityProvider);
	const [jit, setJit] = useState(() => ({ ...(rec.jit || {}) }));
	const [wallets, setWallets] = useState([]);
	useEffect(() => {
		if (!lfbwAvailable) return undefined;
		let alive = true;
		manager
			.listWallets()
			.then((list) => alive && setWallets(list))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [lfbwAvailable]);
	const candidates = primaryCandidates(wallets, { network: rec.network, selfId: rec.id });
	const dependents = rec.lfbwDependents || [];
	const currentPrimary =
		rec.lfbw?.mode === 'internal'
			? wallets.find((w) => w.id === rec.lfbw.primaryWalletId)?.name || null
			: rec.lfbw?.primaryUri || null;
	const [electrum, setElectrum] = useState({ ...rec.electrum });
	const [tor, setTor] = useState(!!rec.tor);
	const [announce, setAnnounce] = useState(!!rec.announce);
	const [onchainOnly, setOnchainOnly] = useState(!!rec.onchainOnly);
	const [recoveryMode, setRecoveryMode] = useState(rec.recovery?.mode || 'off');
	const [recoveryAutoApply, setRecoveryAutoApply] = useState(!!rec.recovery?.autoApply);
	const [guardianServe, setGuardianServe] = useState(!!rec.guardianServe);
	const pinnedGuardians = rec.recovery?.guardians || [];
	const [busy, setBusy] = useState(false);
	// Whether this wallet has OPEN channels, asked the moment the modal opens.
	// Spinning Lightning down with channels open is the owner's call to make,
	// so the count does not lock anything; it decides how much the dialog has
	// to say about what going quiet means for those channels.
	const [openChannels, setOpenChannels] = useState(null);
	const [channelsUnknown, setChannelsUnknown] = useState(false);
	useEffect(() => {
		let alive = true;
		walletApi(rec.id)
			.get('/channels')
			.then((chs) => alive && setOpenChannels(chs.filter((c) => !isClosedChannel(c)).length))
			.catch(() => alive && setChannelsUnknown(true));
		return () => {
			alive = false;
		};
	}, [rec.id]);
	const parkingChannels =
		onchainOnly && !rec.onchainOnly && ((openChannels ?? 0) > 0 || channelsUnknown);

	const save = async () => {
		setBusy(true);
		try {
			const body = {
				name,
				tor,
				announce: onchainOnly ? false : announce,
				onchainOnly,
				// Channel backup survives parking: a quorum journal refuses to
				// run without its barrier, so the mode is never sent as off
				// just because Lightning is switched off.
				recoveryMode,
				// The automatic checkpoint restore is a peer-storage answer; the
				// manager drops it under any other mode.
				...(recoveryAutoApplyAvailable && recoveryMode === 'peer-storage'
					? { recoveryAutoApply }
					: {}),
				// Serving a guardian rides the Lightning listener; parking
				// Lightning drops it, and the manager drops it too.
				...(guardianHostingAvailable ? { guardianServe: onchainOnly ? false : guardianServe } : {}),
				electrum: {
					host: electrum.host.trim(),
					port: parseInt(electrum.port, 10),
					tls: !!electrum.tls
				}
			};
			if (lfbwAvailable) {
				body.lfbw = onchainOnly ? { enabled: false } : lfbwBody(lfbw);
				body.liquidityProvider = onchainOnly ? rec.liquidityProvider : provider;
				body.jit = jit;
			}
			await manager.updateWallet(rec.id, body);
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
			<div className="field-label" style={{ marginTop: 4, marginBottom: 8 }}>
				Lightning
			</div>
			<label className="checkbox field">
				<input
					type="checkbox"
					checked={!onchainOnly}
					disabled={dependents.length > 0}
					onChange={(e) => setOnchainOnly(!e.target.checked)}
				/>
				Lightning enabled
			</label>
			{dependents.length > 0 && (
				<div className="info-note">
					Lightning stays on: this wallet is the primary node of{' '}
					{dependents.map((d) => `"${d.name}"`).join(', ')}.
				</div>
			)}
			{parkingChannels && (
				<div className="error-note">
					{openChannels > 0
						? `This wallet has ${openChannels} open channel${openChannels === 1 ? '' : 's'}. `
						: 'This wallet may have open channels (they could not be read just now). '}
					They stay open and the daemon keeps watching the chain for them, but the node
					goes quiet: to its peers it is simply offline, payments through these channels
					stop, and the dashboard puts the Channels tab away until Lightning is switched
					back on. Parked for more than about two weeks, the node force-closes channels
					it cannot reach, by design, and the funds return on-chain.
				</div>
			)}
			{onchainOnly && !rec.onchainOnly && !parkingChannels && (
				<div className="info-note">
					The wallet stops listening for Lightning peers and the dashboard puts the
					Lightning apparatus away. The seed is untouched and the node identity stays
					derived from it, so flipping this back on later loses nothing.
				</div>
			)}
			{!onchainOnly && rec.onchainOnly && (
				<div className="info-note">
					The wallet starts listening for Lightning peers on its next start. Open a
					channel in the Channels tab and it is a Lightning node like any other.
				</div>
			)}
			{recoveryAvailable && !onchainOnly && (
				<>
					<RecoveryModeField
						value={recoveryMode}
						onChange={setRecoveryMode}
						guardiansConfigured={settingsGuardians.length === 3}
						disabled={restoring}
						pinnedGuardians={pinnedGuardians}
						settingsGuardians={settingsGuardians}
						lockedToQuorum={rec.recovery?.mode === 'quorum'}
					/>
					{recoveryAutoApplyAvailable && recoveryMode === 'peer-storage' && (
						<RecoveryAutoApplyField value={recoveryAutoApply} onChange={setRecoveryAutoApply} disabled={restoring} />
					)}
					{restoring && (
						<div className="info-note">
							Channel backup cannot change while this wallet is waiting for, or running,
							a restore from its guardians.
						</div>
					)}
					{recoveryMode === (rec.recovery?.mode || 'off') &&
						recoveryMode === 'peer-storage' &&
						recoveryAutoApply !== !!rec.recovery?.autoApply && (
							<div className="info-note">Changing this restarts the wallet.</div>
						)}
					{recoveryMode !== (rec.recovery?.mode || 'off') && (
						<div className="info-note">
							Changing channel backup restarts this wallet.
							{pinnedGuardians.length === 0 && isGuardianMode(recoveryMode)
								? ' A guardian mode registers the wallet with the guardians in Settings on its next start, and that set stays with the wallet from then on.'
								: ''}
						</div>
					)}
				</>
			)}
			{guardianHostingAvailable && !onchainOnly && (
				<>
					<GuardianServeField value={guardianServe} onChange={setGuardianServe} announce={announce} />
					{guardianServe !== !!rec.guardianServe && (
						<div className="info-note">
							Changing this restarts the wallet.
							{!guardianServe && rec.guardianServe
								? ' Nodes that pinned this wallet as a guardian lose one of their three until it serves again; their sets cannot be changed.'
								: ''}
						</div>
					)}
				</>
			)}
			{lfbwAvailable && !onchainOnly && (
				<>
					<LfbwFields value={lfbw} onChange={setLfbw} candidates={candidates} editing currentPrimary={currentPrimary} />
					{lfbw.enabled && rec.lfbw?.enabled && primaryChanged(lfbw, rec.lfbw) && (
						<div className="info-note">
							The channel with your current primary stays open after the change. The Overview lists it as
							your previous primary's channel and offers to move its funds into the new one.
						</div>
					)}
					{lfbw.enabled !== !!rec.lfbw?.enabled && (
						<div className="info-note">
							{lfbw.enabled
								? 'The wallet pairs with its primary node on its next start: mutual zero-conf trust when the primary is your own wallet, direct funding armed, and its confirmed on-chain balance moves into the channel from then on. Its existing channels are untouched.'
								: 'The wallet keeps its channels and its balance; only the lightning-first behaviour stops (no automatic channel funding, the full tab set back).'}
						</div>
					)}
					{!lfbw.enabled && (
						<ProviderFields value={provider} jit={jit} onChange={setProvider} onJit={setJit} dependents={dependents} />
					)}
				</>
			)}
			{(torAvailable || onionAvailable) && (
				<div className="field-label" style={{ marginTop: 4, marginBottom: 8 }}>
					Tor
				</div>
			)}
			{torAvailable && (
				<label className="checkbox field">
					<input type="checkbox" checked={tor} onChange={(e) => setTor(e.target.checked)} />
					Outbound: connect to peers over Tor
				</label>
			)}
			{onionAvailable && !onchainOnly && (
				<label className="checkbox field">
					<input type="checkbox" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} />
					Inbound: publish a Tor address so peers can open channels to you
				</label>
			)}
			<div className="center-actions">
				{/* The consequence rides the button: saving while parking channels
				    is a deliberate act, named at the moment of the click rather
				    than behind a second dialog. */}
				<Button variant="primary" busy={busy} onClick={save} disabled={!electrum.host || !lfbwComplete(lfbw)}>
					{parkingChannels && openChannels > 0
						? `Save and park ${openChannels} channel${openChannels === 1 ? '' : 's'}`
						: 'Save changes'}
				</Button>
				<Button onClick={onClose}>Cancel</Button>
			</div>
		</Modal>
	);
}
