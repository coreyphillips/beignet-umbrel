import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, m } from 'motion/react';
import { manager, walletApi } from '../api.js';
import { usePoll } from '../hooks/usePoll.js';
import { describeReceive, useReceiveWatch } from '../hooks/useReceiveWatch.js';
import { useToast } from '../components/Toast.jsx';
import {
	AnimatedNumber,
	Badge,
	Button,
	Empty,
	Menu,
	Modal,
	Skeleton,
	StatusDot,
	staggerContainer,
	staggerItem
} from '../components/ui.jsx';
import DeleteWalletModal from '../components/DeleteWalletModal.jsx';
import NewWalletModal from '../components/NewWalletModal.jsx';
import { copy } from '../lib/format.js';
import { isClosedChannel } from '../lib/channels.js';
import { openBackup } from '../lib/backup.js';
import { walletStatusLabel } from '../lib/labels.js';

const clickOrigin = (e) => ({ x: e?.clientX ?? 0, y: e?.clientY ?? 0 });
const TRANSIENT = new Set(['starting', 'restarting', 'stopping', 'waiting-electrum']);

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

function walletType(w) {
	if (w.lfbw?.enabled) return 'Lightning-first';
	if (w.onchainOnly) return 'On-chain only';
	return 'Lightning';
}

/**
 * One wallet on the home page. The whole card opens it; what else can be
 * done to it waits in the menu, so the page holds balances rather than
 * buttons. The card morphs into the wallet's hero through the shared ids.
 */
function WalletCard({ w, info, onOpen, onStart, onStop, onDelete }) {
	const status = walletStatusLabel(w.status);
	const openable = w.status === 'running' || w.status === 'restore-required';
	const total = w.onchainOnly
		? info?.onchainBalanceSats || 0
		: (info?.onchainBalanceSats || 0) + (info?.lightningBalanceSats || 0);
	const menu = [
		openable
			? { label: 'Open', icon: 'chevron', onSelect: () => onOpen(w) }
			: { label: 'Start', icon: 'play', onSelect: () => onStart(w) },
		...(w.status !== 'stopped' ? [{ label: 'Stop', icon: 'stop', onSelect: () => onStop(w) }] : []),
		'sep',
		{ label: 'Delete', icon: 'trash', danger: true, onSelect: (e) => onDelete(w, e) }
	];
	const warning =
		w.lfbw?.enabled && w.lfbw.setup === 'failed'
			? `Primary node setup failed: ${w.lfbw.setupError}`
			: w.status === 'restore-required'
			? 'Channels waiting to be restored from guardians'
			: w.status === 'restarting' && w.lastStartError
			? `Last start failed: ${w.lastStartError.message}`
			: null;

	return (
		<m.div
			layoutId={`wallet-card-${w.id}`}
			variants={staggerItem}
			className="wallet-card"
			role="link"
			tabIndex={0}
			aria-label={`Open ${w.name}`}
			onClick={() => onOpen(w)}
			onKeyDown={(e) => {
				if (e.target !== e.currentTarget) return;
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onOpen(w);
				}
			}}
		>
			<div className="wallet-card-top">
				<m.div layoutId={`wallet-name-${w.id}`} className="wallet-name" layout="position">
					{w.name}
				</m.div>
				<Badge chip>{walletType(w)}</Badge>
				{w.lfbwDependents?.length > 0 && <Badge chip>Primary for {w.lfbwDependents.length}</Badge>}
				<Menu label={`Actions for ${w.name}`} items={menu} />
			</div>
			{info ? (
				<div className="wallet-balance">
					<AnimatedNumber value={total} />
					<span className="unit">sats</span>
				</div>
			) : (
				<div className="wallet-balance" aria-hidden="true">
					<span style={{ color: 'var(--faint)' }}>·</span>
				</div>
			)}
			<div className="wallet-meta">
				<m.span
					layoutId={`wallet-status-${w.id}`}
					layout="position"
					style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
				>
					<StatusDot tone={status.tone} pulse={TRANSIENT.has(w.status)} />
					{status.label}
				</m.span>
				{info && !w.onchainOnly && (
					<>
						<span>·</span>
						<span>
							{info.openChannelCount ?? info.channelCount} {(info.openChannelCount ?? info.channelCount) === 1 ? 'channel' : 'channels'}
						</span>
						<span>·</span>
						<span>
							{info.peerCount} {info.peerCount === 1 ? 'peer' : 'peers'}
						</span>
					</>
				)}
				{w.network !== 'mainnet' && (
					<>
						<span>·</span>
						<span>{w.network}</span>
					</>
				)}
			</div>
			{warning && <div className="wallet-warn">{warning}</div>}
		</m.div>
	);
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
								info.openChannelCount = channels.filter((c) => !isClosedChannel(c)).length;
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
	// Stagger the grid entrance only once; later polls re-render silently.
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

	const act = async (fn, ok) => {
		try {
			await fn();
			await refresh();
			if (ok) toast(ok, 'success');
		} catch (e) {
			toast(e.message, 'error');
		}
	};

	const openWallet = (w) => navigate(`/w/${w.id}`, { state: { wallet: w, info: infos[w.id] || null } });
	const runningCount = (wallets || []).filter((w) => w.status === 'running').length;
	const hasWallets = wallets && wallets.length > 0;

	if (!config) {
		return (
			<div className="container">
				<div className="page-head">
					<div>
						<h2>Wallets</h2>
					</div>
				</div>
				<div className="wallet-grid" aria-busy="true">
					<Skeleton height={132} />
					<Skeleton height={132} />
					<Skeleton height={132} />
					<Skeleton height={132} />
				</div>
			</div>
		);
	}

	return (
		<div className="container">
			{(wallets || [])
				.filter((w) => w.status === 'running')
				.map((w) => (
					<ReceiveWatcher key={w.id} wallet={w} />
				))}

			<div className="page-head">
				<div>
					<h2>Wallets</h2>
					{hasWallets && (
						<div className="sub">
							{wallets.length} {wallets.length === 1 ? 'wallet' : 'wallets'} · {runningCount} running
						</div>
					)}
				</div>
				<div className="page-actions">
					<Button variant="primary" icon="plus" onClick={(e) => setModal({ type: 'new', origin: clickOrigin(e) })}>
						New wallet
					</Button>
				</div>
			</div>

			{!wallets ? (
				<div className="wallet-grid" aria-busy="true">
					<Skeleton height={132} />
					<Skeleton height={132} />
				</div>
			) : !hasWallets ? (
				<div className="card">
					<Empty
						title="No wallets yet"
						actions={
							<>
								<Button variant="primary" icon="plus" onClick={(e) => setModal({ type: 'new', origin: clickOrigin(e) })}>
									Create a wallet
								</Button>
								<Button
									data-testid="first-run-restore"
									onClick={(e) => openBackup('restore', { x: e.clientX, y: e.clientY })}
								>
									Restore from backup
								</Button>
							</>
						}
					>
						Create or import one, or put a box back as it was.
					</Empty>
				</div>
			) : (
				<m.div
					className="wallet-grid"
					variants={staggerContainer}
					initial={staggered.current ? false : 'hidden'}
					animate="show"
				>
					{wallets.map((w) => (
						<WalletCard
							key={w.id}
							w={w}
							info={infos[w.id]}
							onOpen={openWallet}
							onStart={(x) => act(() => manager.startWallet(x.id))}
							onStop={(x) => act(() => manager.stopWallet(x.id))}
							onDelete={(x, e) => setModal({ type: 'delete', wallet: x, origin: clickOrigin(e) })}
						/>
					))}
				</m.div>
			)}

			<AnimatePresence>
				{modal?.type === 'new' && (
					<NewWalletModal
						key="new"
						config={config}
						wallets={wallets}
						origin={modal.origin}
						onClose={() => setModal(null)}
						onDone={refresh}
						onSeed={(s) => setModal(s)}
						onOpen={openWallet}
					/>
				)}
				{modal?.type === 'seed' && (
					<SeedModal key="seed" name={modal.name} mnemonic={modal.mnemonic} onClose={() => setModal(null)} />
				)}
				{modal?.type === 'delete' && (
					<DeleteWalletModal
						key="delete"
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
			</AnimatePresence>
		</div>
	);
}

function SeedModal({ name, mnemonic, onClose }) {
	const toast = useToast();
	const words = useMemo(() => mnemonic.split(' '), [mnemonic]);
	return (
		<Modal
			title={`Backup seed for "${name}"`}
			onClose={onClose}
			foot={
				<>
					<Button
						icon="copy"
						onClick={async () => {
							const ok = await copy(mnemonic);
							toast(ok ? 'Seed copied' : 'Copy failed', ok ? 'info' : 'error');
						}}
					>
						Copy phrase
					</Button>
					<span className="spacer" />
					<Button variant="primary" onClick={onClose}>
						I have saved it
					</Button>
				</>
			}
		>
			<div className="note error">
				Write these words down in order and keep them offline. Anyone with this phrase can spend your
				funds. This is the only time it is shown here.
			</div>
			<m.div className="seed-grid" variants={staggerContainer} initial="hidden" animate="show">
				{words.map((w, i) => (
					<m.div key={i} variants={staggerItem} className="seed-word">
						<span>{i + 1}</span>
						{w}
					</m.div>
				))}
			</m.div>
		</Modal>
	);
}
