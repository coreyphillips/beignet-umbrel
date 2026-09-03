import { useEffect, useState } from 'react';
import { m } from 'motion/react';
import { usePoll } from '../../../hooks/usePoll.js';
import { useToast } from '../../../components/Toast.jsx';
import {
	Badge,
	BalanceBar,
	Button,
	Card,
	CopyText,
	Modal,
	Stat,
	staggerContainer,
	staggerItem
} from '../../../components/ui.jsx';
import { fmtSats, shortId } from '../../../lib/format.js';
import { lfbwStatus } from '../../../lib/lfbw.js';
import { manager } from '../../../api.js';

const CLOSED = new Set(['CLOSED', 'FORCE_CLOSED']);

/**
 * The whole dashboard for a lightning-first wallet: one balance, one
 * primary node, the home channel, and the state of the link between them.
 * Channel mechanics stay out of sight; the Advanced view has them.
 */
export default function LfbwOverviewTab({ id, api, info, rec, tick, bump }) {
	const toast = useToast();
	const lf = rec?.lfbw;
	const [closing, setClosing] = useState(null);
	const [closingBusy, setClosingBusy] = useState(null);
	const [retrying, setRetrying] = useState(false);
	const [moving, setMoving] = useState(false);
	const [movingHome, setMovingHome] = useState(false);
	const [confirmMoveHome, setConfirmMoveHome] = useState(false);

	const { data, refresh } = usePoll(
		async () => {
			const [balance, liquidity, channels, utxos, peers] = await Promise.all([
				api.get('/balance').catch(() => null),
				api.get('/liquidity').catch(() => null),
				api.get('/channels').catch(() => []),
				api.get('/utxos').catch(() => null),
				api.get('/peers').catch(() => [])
			]);
			return { balance, liquidity, channels, utxos, peers };
		},
		8000,
		[id, tick]
	);

	const status = lfbwStatus({ rec, info, ...(data || {}) });
	const primaryPubkey = status.primaryPubkey;

	// An external primary may gossip an alias; an internal one is named from
	// the manager's own records, which also say whether it is running.
	const { data: primaryNode } = usePoll(
		() =>
			primaryPubkey && lf?.mode === 'external'
				? api.get(`/graph/node?pubkey=${primaryPubkey}`).catch(() => null)
				: Promise.resolve(null),
		60000,
		[id, primaryPubkey, lf?.mode]
	);
	const { data: wallets } = usePoll(() => manager.listWallets().catch(() => []), 15000, [tick]);
	const primaryWallet =
		lf?.mode === 'internal' ? (wallets || []).find((w) => w.id === lf.primaryWalletId) || null : null;

	const hasClosed = (data?.channels || []).some((c) => CLOSED.has(c.state) && c.peerPubkey === primaryPubkey);

	const retrySetup = async () => {
		setRetrying(true);
		try {
			const r = await manager.lfbwSetup(id);
			if (r?.lfbw?.setup === 'failed') toast(r.lfbw.setupError || 'Setup failed again', 'error');
			else toast('Primary node connected', 'success');
			bump();
			refresh();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setRetrying(false);
		}
	};

	// "Move now anyway": one channelize pass past the fee wait, for a deposit
	// the owner wants in Lightning at any price. The channel minimums hold.
	const moveNow = async () => {
		setMoving(true);
		try {
			const r = await manager.lfbwChannelize(id);
			if (r?.action === 'splice-in' || r?.action === 'open') {
				toast(`Moving ${fmtSats(r.amountSats)} into your channel.`, 'success');
			} else if (r?.action === 'wait') {
				toast(
					r.reason === 'quote-too-small'
						? 'Too little to move: a channel has minimums and an on-chain fee to cover.'
						: 'Nothing moved: the deposit is not ready yet.',
					'info'
				);
			} else if (r?.action === 'busy') {
				toast('A move is already in progress.', 'info');
			}
			bump();
			refresh();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setMoving(false);
		}
	};

	// Close the home channel. Plain: the payout returns on-chain and
	// channelize moves it into a new channel with the primary after one
	// confirmation. With turnOff: lightning-first is switched off first (the
	// manager restarts the daemon on the new posture, then closes), so the
	// funds stay on-chain (umbrel #86).
	const closeChannel = async (channel, { turnOff = false } = {}) => {
		setClosingBusy(turnOff ? 'off' : 'close');
		try {
			if (turnOff) {
				await manager.lfbwCloseHome(id, { channelId: channel.channelId, turnOff: true });
				toast('Lightning-first is off. Closing; your balance returns on-chain and stays there.', 'success');
			} else {
				await api.post('/channel/close', { channelId: channel.channelId });
				toast('Closing. Your balance returns on-chain, and moves back into a channel with the primary once it confirms.', 'success');
			}
			setClosing(null);
			bump();
			refresh();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setClosingBusy(null);
		}
	};

	// "Move funds to the new primary": the manager closes the channel with
	// the previous primary; channelize carries the payout into the home
	// channel once it confirms.
	const moveHome = async () => {
		setMovingHome(true);
		try {
			const r = await manager.lfbwMoveHome(id);
			toast(
				`Closing ${r.closed.length === 1 ? 'the channel' : `${r.closed.length} channels`} with your previous primary. The funds move into your new channel once the close confirms.`,
				'success'
			);
			setConfirmMoveHome(false);
			bump();
			refresh();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setMovingHome(false);
		}
	};

	return (
		<div>
			{lf?.setup === 'pending' && (
				<div className="info-note" style={{ marginBottom: 14 }}>
					Setting up the link to your primary node. This takes a moment after the wallet starts.
				</div>
			)}
			{lf?.setup === 'failed' && (
				<div className="error-note" style={{ marginBottom: 14 }}>
					Could not finish setting up the primary node: {lf.setupError}
					<div className="center-actions">
						<Button className="sm" busy={retrying} onClick={retrySetup}>
							Retry setup
						</Button>
					</div>
				</div>
			)}

			<m.div className="grid cols-4" style={{ marginBottom: 18 }} variants={staggerContainer} initial="hidden" animate="show">
				{[
					<Stat key="total" label="Total balance" num={status.total} suffix=" sats" />,
					<Stat key="send" label="Can send" num={status.canSend} suffix=" sats" />,
					<Stat key="recv" label="Can receive" num={status.canReceive} suffix=" sats" sub={lf?.setup === 'ready' ? 'more is provisioned as needed' : undefined} />,
					<Stat key="pending" label="Pending" num={status.pending} suffix=" sats" sub={status.pending > 0 ? 'arriving' : undefined} />
				].map((stat, i) => (
					<m.div key={i} variants={staggerItem}>
						{stat}
					</m.div>
				))}
			</m.div>

			{status.notes.map((note) => (
				<div key={note} className="info-note" style={{ marginBottom: 14 }} role="status">
					{note}
				</div>
			))}
			{status.feeWait && (
				<div className="center-actions" style={{ marginTop: -6, marginBottom: 14 }}>
					<Button className="sm" busy={moving} onClick={moveNow}>
						Move now anyway
					</Button>
				</div>
			)}

			<div className="grid cols-2">
				<Card title="Primary node">
					{!primaryPubkey ? (
						<div className="empty">Not linked yet.</div>
					) : (
						<div>
							<div className="peer-id" style={{ marginBottom: 10 }}>
								{primaryWallet?.name || primaryNode?.alias ? (
									<span className="peer-alias">{primaryWallet?.name || primaryNode?.alias}</span>
								) : lf?.mode === 'internal' ? (
									<span className="peer-alias">Your node on this Umbrel</span>
								) : (
									<span className="peer-alias muted">External node</span>
								)}
								<CopyText value={primaryPubkey} label={shortId(primaryPubkey)} />
							</div>
							<div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
								<Badge tone={status.primaryConnected ? 'green' : 'red'}>
									{status.primaryConnected ? 'connected' : 'offline'}
								</Badge>
								{primaryWallet && primaryWallet.status !== 'running' && (
									<Badge tone="yellow">wallet {primaryWallet.status}</Badge>
								)}
								{lf?.trusted ? (
									<Badge tone="blue">zero-conf trusted</Badge>
								) : (
									<Badge tone="muted">confirms first</Badge>
								)}
								{lf?.mode === 'external' && <Badge tone="muted">external</Badge>}
							</div>
							<div className="wallet-meta">
								{lf?.mode === 'internal'
									? 'One of your own wallets. It provides the other side of your channel, fronts inbound capacity the moment a payment needs it, and relays payment requests for you.'
									: 'The node on the other side of your channel. It provides inbound capacity just in time and relays payment requests for you.'}
							</div>
						</div>
					)}
				</Card>

				<Card title="Your channel">
					{status.channels.length === 0 ? (
						<div className="empty">
							No channel with the primary node yet. Deposit bitcoin or create an invoice on the
							Receive tab, and the channel appears by itself.
						</div>
					) : (
						status.channels.map((c) => (
							<div key={c.channelId} style={{ marginBottom: 12 }}>
								<div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
									<Badge tone={c.htlcUsable ?? c.state === 'NORMAL' ? 'green' : 'yellow'}>
										{c.htlcUsable ?? c.state === 'NORMAL' ? 'active' : c.state === 'SPLICING' ? 'splicing' : 'confirming'}
									</Badge>
									<span className="wallet-meta">capacity {fmtSats(c.capacitySats)}</span>
								</div>
								<BalanceBar local={c.localBalanceSats} remote={c.remoteBalanceSats} />
								<div className="wallet-meta" style={{ marginTop: 4 }}>
									{fmtSats(c.localBalanceSats)} yours / {fmtSats(c.remoteBalanceSats)} theirs
								</div>
								{(c.htlcUsable ?? c.state === 'NORMAL') && (
									<div style={{ marginTop: 10 }}>
										<Button className="sm" onClick={() => setClosing(c)}>
											Close
										</Button>
									</div>
								)}
							</div>
						))
					)}
				</Card>

				{status.previousChannels.length > 0 && (
					<Card title="Channel with your previous primary" className="grid-full">
						<div className="wallet-meta" style={{ marginBottom: 10 }}>
							You changed your primary node. This channel stays open with the previous one, and its
							balance is part of your Total; it moves into your new channel once the channel below is
							closed and the payout confirms.
						</div>
						{status.previousChannels.map((c) => {
							const open = c.htlcUsable ?? c.state === 'NORMAL';
							return (
								<div key={c.channelId} style={{ marginBottom: 12 }} data-testid="previous-primary-channel">
									<div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
										<Badge tone={open ? 'yellow' : 'muted'}>{open ? 'previous primary' : 'moving'}</Badge>
										<span className="wallet-meta">
											{shortId(c.peerPubkey)} · capacity {fmtSats(c.capacitySats)}
										</span>
									</div>
									<BalanceBar local={c.localBalanceSats} remote={c.remoteBalanceSats} />
									<div className="wallet-meta" style={{ marginTop: 4 }}>
										{fmtSats(c.localBalanceSats)} yours / {fmtSats(c.remoteBalanceSats)} theirs
										{!open && ' · closing; the funds move into your new channel once this confirms'}
									</div>
								</div>
							);
						})}
						{status.previousChannels.some((c) => c.htlcUsable ?? c.state === 'NORMAL') && (
							<Button className="sm" busy={movingHome} onClick={() => setConfirmMoveHome(true)}>
								Move funds to the new primary
							</Button>
						)}
					</Card>
				)}

				{hasClosed && status.channels.length === 0 && (
					<RecoverCloseFunds
						api={api}
						onDone={() => {
							bump();
							refresh();
						}}
					/>
				)}

				<DirectFundingPolicy api={api} tick={tick} />
			</div>

			{closing && (
				<Modal title="Close the channel with your primary node" onClose={() => setClosing(null)}>
					<p className="wallet-meta">
						This cooperatively closes the channel. Your Lightning balance ({fmtSats(closing.localBalanceSats)})
						returns to this wallet on-chain. While the wallet stays lightning-first, that balance moves
						back into a new channel with the primary by itself after one confirmation, so a plain close
						pays a fee to end up where you started. To keep the funds on-chain, close and turn
						lightning-first off in one step: the wallet keeps its balance and gets the full tab set back.
					</p>
					<div className="center-actions">
						<Button
							variant="primary"
							busy={closingBusy === 'close'}
							disabled={closingBusy === 'off'}
							onClick={() => closeChannel(closing)}
						>
							Close channel
						</Button>
						<Button
							busy={closingBusy === 'off'}
							disabled={closingBusy === 'close'}
							onClick={() => closeChannel(closing, { turnOff: true })}
						>
							Close and turn lightning-first off
						</Button>
						<Button onClick={() => setClosing(null)}>Cancel</Button>
					</div>
				</Modal>
			)}
			{confirmMoveHome && (
				<Modal title="Move funds to the new primary" onClose={() => setConfirmMoveHome(false)}>
					<p className="wallet-meta">
						This cooperatively closes your channel with the previous primary, which pays an on-chain
						fee. The balance ({fmtSats(status.previousChannels.reduce((s, c) => s + (c.localBalanceSats || 0), 0))})
						returns to this wallet on-chain and moves into your channel with the new primary by itself
						once the close confirms.
					</p>
					<div className="center-actions">
						<Button variant="primary" busy={movingHome} onClick={moveHome}>
							Close and move
						</Button>
						<Button onClick={() => setConfirmMoveHome(false)}>Cancel</Button>
					</div>
				</Modal>
			)}
		</div>
	);
}

/**
 * Receiver policy for direct funding: the smallest payment a request will
 * accept. Values under the daemon's floor (5,000 sats) clamp up to it, and
 * the readback after saving makes that visible.
 */
function DirectFundingPolicy({ api, tick }) {
	const toast = useToast();
	const [config, setConfig] = useState(null);
	const [editing, setEditing] = useState(false);
	const [minVal, setMinVal] = useState('');
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		let alive = true;
		api
			.get('/direct-funding/config')
			.then((c) => alive && setConfig(c))
			.catch(() => alive && setConfig(null));
		return () => {
			alive = false;
		};
	}, [api, tick]);

	if (!config || !config.lspPubkey) return null;
	return (
		<Card title="Direct funding policy">
			<div className="wallet-meta" style={{ marginBottom: 8 }}>
				A beignet wallet paying your request funds your channel directly, in one transaction.
				{config.allowSplice ? ' Paired senders grow your existing channel; others open a new one that confirms first.' : ''}
			</div>
			{!editing ? (
				<div className="wallet-meta">
					Smallest direct funding accepted: {fmtSats(config.minAmountSat)}{' '}
					<Button
						className="sm"
						onClick={() => {
							setMinVal(String(config.minAmountSat));
							setEditing(true);
						}}
					>
						Edit
					</Button>
				</div>
			) : (
				<div>
					<div className="wallet-meta" style={{ marginBottom: 8 }}>
						Direct fundings below this are declined and paid as ordinary transactions. 5,000 sats is the
						floor; anything lower is raised to it.
					</div>
					<input value={minVal} onChange={(e) => setMinVal(e.target.value.replace(/[^0-9]/g, ''))} style={{ width: 140 }} />
					<div className="center-actions">
						<Button
							className="sm"
							busy={saving}
							onClick={async () => {
								const v = parseInt(minVal, 10);
								if (!Number.isFinite(v) || v < 0) {
									toast('Enter a whole number of sats.', 'error');
									return;
								}
								setSaving(true);
								try {
									const res = await api.post('/direct-funding/configure', { minAmountSat: v });
									setConfig(res);
									setEditing(false);
									toast(
										`Minimum set to ${fmtSats(res.minAmountSat)}${res.minAmountSat !== v ? ' (raised to the floor)' : ''}.`,
										'success'
									);
								} catch (e) {
									toast(`Could not update: ${e.message}`, 'error');
								} finally {
									setSaving(false);
								}
							}}
						>
							Save
						</Button>
						<Button className="sm" onClick={() => setEditing(false)}>
							Cancel
						</Button>
					</div>
				</div>
			)}
		</Card>
	);
}

/**
 * A cooperative close can pay this wallet out to its fallback script, which
 * the balance does not pick up on its own; the daemon has a sweep for
 * exactly that. Offered whenever a closed channel exists and none is open.
 */
function RecoverCloseFunds({ api, onDone }) {
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	const recover = async () => {
		setBusy(true);
		try {
			const r = await api.post('/recover-fallback-funds', {});
			if (r?.amountSat > 0) toast(`Recovered ${fmtSats(r.amountSat)} to your balance.`, 'success');
			else toast('Nothing to recover; the close already paid out.', 'info');
			onDone();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};
	return (
		<Card title="After a close" className="grid-full">
			<div className="wallet-meta" style={{ marginBottom: 12 }}>
				If your balance looks low after closing, the close payout may still be sitting on its payout
				address. This sweeps it into your balance.
			</div>
			<Button busy={busy} onClick={recover}>
				Recover closed-channel funds
			</Button>
		</Card>
	);
}
