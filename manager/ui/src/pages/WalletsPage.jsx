import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, m } from 'motion/react';
import { manager, walletApi } from '../api.js';
import { describeReceive, useReceiveWatch } from '../hooks/useReceiveWatch.js';
import { useToast } from '../components/Toast.jsx';
import {
	AnimatedNumber,
	Badge,
	BalanceBar,
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

// The last list this page showed and the config it read, kept across mounts:
// coming back from a wallet then renders at once, the hero morphs back into
// its card, and a fresh poll corrects the figures quietly.
let cache = null; // { list, infos }
let cachedConfig = null;
let refreshSeq = 0;

/**
 * One running wallet's figures: /info plus, from /channels, the count of open
 * channels and the local/remote split for the liquidity bar. Null until the
 * daemon answers.
 */
async function loadInfo(id) {
	const api = walletApi(id);
	try {
		const [info, channels] = await Promise.all([api.get('/info'), api.get('/channels').catch(() => null)]);
		// The daemon's /info channelCount is every channel it has ever had,
		// closed ones included, so a wallet whose channels all closed still
		// reads "2 channels" forever. Count open ones from the list itself; on
		// any hiccup fall back to the daemon figure rather than showing nothing.
		const open = channels ? channels.filter((c) => !isClosedChannel(c)) : null;
		info.openChannelCount = open ? open.length : info.channelCount;
		if (open) {
			info.outboundSats = open.reduce((a, c) => a + (c.localBalanceSats || 0), 0);
			info.inboundSats = open.reduce((a, c) => a + (c.remoteBalanceSats || 0), 0);
		}
		return info;
	} catch (_) {
		return null; // not ready
	}
}

/**
 * The wallet list with each running wallet's figures. The list is published
 * as soon as it arrives (names and statuses), and each wallet's figures the
 * moment that wallet answers, so one slow node never holds the others back.
 */
function useWalletList(intervalMs) {
	const [data, setData] = useState(cache);
	const refresh = useCallback(async () => {
		const seq = ++refreshSeq;
		let list;
		try {
			list = await manager.listWallets();
		} catch (_) {
			return; // keep what is shown; the next poll tries again
		}
		if (seq !== refreshSeq) return; // a newer refresh has overtaken this one
		const publish = (next) => {
			cache = next;
			setData(next);
		};
		const running = list.filter((w) => w.status === 'running').map((w) => w.id);
		const kept = {};
		for (const id of running) if (cache?.infos?.[id]) kept[id] = cache.infos[id];
		publish({ list, infos: kept });
		await Promise.all(
			running.map(async (id) => {
				const info = await loadInfo(id);
				// Dropped when the wallet has since stopped or been deleted.
				if (!info || !cache?.list.some((w) => w.id === id && w.status === 'running')) return;
				publish({ list: cache.list, infos: { ...cache.infos, [id]: info } });
			})
		);
	}, []);
	useEffect(() => {
		refresh();
		const t = setInterval(refresh, intervalMs);
		return () => clearInterval(t);
	}, [refresh, intervalMs]);
	return { data, refresh };
}

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
	// Lightning wallets with an open channel show how their capacity splits.
	const showBar = !!info && !w.onchainOnly && info.outboundSats != null && info.openChannelCount > 0;
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
				<m.div className="wallet-balance" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
					<AnimatedNumber value={total} />
					<span className="unit">sats</span>
				</m.div>
			) : (
				<div className="wallet-balance" aria-hidden="true">
					<span style={{ color: 'var(--faint)' }}>·</span>
				</div>
			)}
			{showBar && (
				<div className="wallet-liq">
					<BalanceBar local={info.outboundSats} remote={info.inboundSats} />
				</div>
			)}
			<div className="wallet-meta meta-row">
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
	const [config, setConfig] = useState(cachedConfig);
	const { data, refresh } = useWalletList(4000);
	const wallets = data?.list;
	const infos = data?.infos || {};
	const [modal, setModal] = useState(null); // {type, origin?, ...}
	// Stagger the grid entrance only once, and not at all when the page comes
	// back with its list already in hand; later polls re-render silently.
	const staggered = useRef(!!cache);
	useEffect(() => {
		if (wallets) staggered.current = true;
	}, [wallets]);

	useEffect(() => {
		const take = (c) => {
			cachedConfig = c;
			setConfig(c);
		};
		manager.config().then(take).catch((e) => toast(e.message, 'error'));
		// The header's Settings dialog broadcasts saved config so ours stays fresh.
		const onCfg = (e) => take(e.detail);
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
