import { useEffect, useMemo, useState } from 'react';
import { usePoll } from '../hooks/usePoll.js';
import { useToast } from './Toast.jsx';
import { Badge, Button, Card, CopyText, Field, QR } from './ui.jsx';
import { fmtSats } from '../lib/format.js';
import { manager } from '../api.js';
import {
	DEFAULT_FEE,
	bookFits,
	currentEpoch,
	describeEpoch,
	planEpoch,
	refusalText,
	rememberSlotInvoice,
	settlementChannels,
	slotInvoices,
	slotLabel,
	slotTone
} from '../lib/ffor.js';

const SETUP_STATES = ['NEGOTIATING', 'VOUCHERS_COMMITTED', 'ACTIVATING'];

/**
 * Receive while offline (FFOR, beignet #729). Before going away, the wallet
 * pre-signs a book of fixed-amount vouchers with a settlement peer on one
 * of its channels (an epoch), then hands out one invoice per voucher. A
 * payer's payment to one of them is settled by the peer at once, daemon
 * off or not, and the credit lands when the wallet returns: the manager
 * reconciles with the peer after every start, and the panel above the
 * tabs says what came of it.
 *
 * The peer must be a sibling that opted in (its Edit dialog) and on the
 * other end of an open channel; every beignet node advertises the protocol
 * whether or not it settles, so the list comes from the manager's records.
 */
export default function OfflineReceiveCard({ id, api, rec, tick, info }) {
	const toast = useToast();
	const tip = info?.blockHeight || 0;
	// A 404 is an engine that predates the routes; the card then says so
	// rather than offering a form the daemon would refuse.
	const { data: epochs } = usePoll(
		() =>
			api.get('/ffor/epochs').catch((e) => {
				if (e && e.status === 404) return { unsupported: true };
				throw e;
			}),
		10000,
		[id, tick]
	);
	const { data: candidates } = usePoll(() => manager.fforCandidates(id).catch(() => []), 15000, [id, tick]);
	const { data: channels } = usePoll(() => api.get('/channels').catch(() => null), 15000, [id, tick]);
	const unsupported = !!(epochs && epochs.unsupported);
	const epoch = useMemo(() => (Array.isArray(epochs) ? currentEpoch(epochs) : null), [epochs]);
	const eligible = useMemo(() => settlementChannels(channels, candidates), [channels, candidates]);

	const [channelId, setChannelId] = useState('');
	const [amount, setAmount] = useState('');
	const [count, setCount] = useState('5');
	const [awayDays, setAwayDays] = useState('7');
	const [feeBase, setFeeBase] = useState(String(DEFAULT_FEE.baseMsat));
	const [feePpm, setFeePpm] = useState(String(DEFAULT_FEE.ppm));
	const [advanced, setAdvanced] = useState(false);
	const [busy, setBusy] = useState(false);
	const [refusal, setRefusal] = useState(null);
	const [another, setAnother] = useState(false);
	// The invoice for a slot is minted once; from beignet 0.21.5 the epoch
	// view carries it back on the slot (bolt11), and before that only what
	// this session minted is known, kept per epoch.
	const [minted, setMinted] = useState({});
	const [openSlot, setOpenSlot] = useState(null);
	useEffect(() => {
		setMinted(epoch ? slotInvoices(id, epoch.epochId) : {});
		setOpenSlot(null);
	}, [id, epoch?.epochId]);
	// Default to the one eligible channel, and forget a pick that closed.
	useEffect(() => {
		if (eligible.length > 0 && !eligible.some((c) => c.channelId === channelId)) setChannelId(eligible[0].channelId);
	}, [eligible, channelId]);

	const plan = useMemo(
		() => planEpoch({ channelId, amountSats: parseInt(amount, 10), count: parseInt(count, 10), awayDays: Number(awayDays), tip, feeBaseMsat: feeBase, feePpm }),
		[channelId, amount, count, awayDays, tip, feeBase, feePpm]
	);
	const chosen = eligible.find((c) => c.channelId === channelId) || null;
	const fit = plan.body ? bookFits(plan.budgetSats, chosen) : null;

	const start = async () => {
		if (!plan.body) return;
		setBusy(true);
		setRefusal(null);
		try {
			await api.post('/ffor/epoch/start', plan.body);
			setAnother(false);
			toast('Setting up the voucher book with your settlement peer', 'success');
		} catch (e) {
			setRefusal(refusalText(e));
		} finally {
			setBusy(false);
		}
	};
	const cancelSetup = async () => {
		setBusy(true);
		try {
			await api.post('/ffor/epoch/abort', { channelId: epoch.channelId, reason: 0, text: 'cancelled from the dashboard' });
			toast('Setup cancelled', 'info');
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};
	const mint = async (k) => {
		setBusy(true);
		try {
			const r = await api.post('/ffor/invoice', { channelId: epoch.channelId, k, description: `Voucher ${k} of ${epoch.slots.length}` });
			rememberSlotInvoice(id, epoch.epochId, k, r);
			setMinted((m) => ({ ...m, [k]: r }));
			setOpenSlot(k);
			toast('Invoice created. It stays payable while this wallet is off.', 'success');
		} catch (e) {
			toast(refusalText(e), 'error');
		} finally {
			setBusy(false);
		}
	};
	const closeNow = async () => {
		setBusy(true);
		try {
			await manager.fforReturn(id, { channelId: epoch.channelId });
			toast('Closing the epoch with your settlement peer', 'success');
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	const epochChannel = epoch && Array.isArray(channels) ? channels.find((c) => c.channelId === epoch.channelId) || null : null;
	const described = epoch ? describeEpoch(epoch, tip, epochChannel) : null;
	// An aborted setup goes straight back to the form with the reason above
	// it; a closed book waits for "Start another" so its summary can be read.
	const showForm = !epoch || epoch.state === 'ABORTED' || (epoch.state === 'CLOSED' && another);
	const peerName = (c) => (c && c.settler ? c.settler.name : 'settlement peer');
	const epochPeer = epoch ? peerName(eligible.find((c) => c.channelId === epoch.channelId)) : null;

	return (
		<Card title="Receive while offline" className="grid-full">
			<div className="wallet-meta" style={{ marginBottom: 10 }}>
				Pre-sign a book of fixed-amount vouchers with a sibling wallet that stays online, hand out one
				invoice per voucher, and get paid while this wallet is off. The sibling settles each payment at
				once; the money lands in your channel balance when this wallet is back and closes the book.
			</div>
			{unsupported ? (
				<div className="info-note">The bundled engine predates offline receive; update the app first.</div>
			) : !epochs ? (
				<div className="wallet-meta">Reading the offline-receive status…</div>
			) : showForm ? (
				<>
					{epoch && described && (
						<div className={epoch.state === 'ABORTED' ? 'error-note' : 'info-note'} style={{ marginBottom: 10 }} data-testid="ffor-last">
							Last book: {described.detail}
						</div>
					)}
					{eligible.length === 0 ? (
						<div className="info-note" data-testid="ffor-no-peer">
							{!channels
								? 'Reading your channels…'
								: (candidates || []).length === 0
								? 'No sibling wallet settles offline receives yet. On the wallet that stays online (your primary node, say), open Edit and turn on "Settle offline receives"; it restarts with the role.'
								: `Open a channel to ${candidates.map((c) => `"${c.name}"`).join(' or ')} first: that wallet settles offline receives, but this one has no open channel with it.`}
						</div>
					) : (
						<>
							<div className="row">
								<Field label="Settlement peer">
									<select value={channelId} onChange={(e) => setChannelId(e.target.value)} data-testid="ffor-channel">
										{eligible.map((c) => (
											<option key={c.channelId} value={c.channelId}>
												{peerName(c)} · {fmtSats(c.remoteBalanceSats || 0)} on their side
											</option>
										))}
									</select>
								</Field>
							</div>
							<div className="row">
								<Field label="Amount per voucher (sats)">
									<input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))} placeholder="50000" data-testid="ffor-amount" />
								</Field>
								<Field label="Vouchers">
									<input value={count} onChange={(e) => setCount(e.target.value.replace(/[^0-9]/g, ''))} data-testid="ffor-count" />
								</Field>
								<Field label="Away for (days)">
									<input value={awayDays} onChange={(e) => setAwayDays(e.target.value.replace(/[^0-9.]/g, ''))} data-testid="ffor-days" />
								</Field>
							</div>
							<button type="button" className="wnav-toggle" onClick={() => setAdvanced((v) => !v)} style={{ marginBottom: 8 }}>
								{advanced ? 'Hide fees' : 'Fees'}
							</button>
							{advanced && (
								<div className="row">
									<Field label="Fee to the peer per voucher (msat)">
										<input value={feeBase} onChange={(e) => setFeeBase(e.target.value.replace(/[^0-9]/g, ''))} />
									</Field>
									<Field label="Fee (ppm)">
										<input value={feePpm} onChange={(e) => setFeePpm(e.target.value.replace(/[^0-9]/g, ''))} />
									</Field>
								</div>
							)}
							<div className="field-hint" style={{ marginBottom: 10 }}>
								{plan.body
									? `${fmtSats(plan.budgetSats)} in ${plan.body.voucherAmountsMsat.length} voucher${plan.body.voucherAmountsMsat.length === 1 ? '' : 's'}. Return by block ${plan.settlementDeadline}, about ${awayDays} day${Number(awayDays) === 1 ? '' : 's'} from now at ten minutes a block; the peer keeps what was paid claimable on-chain for another week past that. ${fit ? fit.note : ''}`
									: amount
									? plan.error
									: 'Each voucher is one fixed-amount invoice; a payer pays exactly that amount.'}
							</div>
							{refusal && (
								<div className="error-note" role="status" data-testid="ffor-refusal">
									{refusal}
								</div>
							)}
							<Button variant="primary" busy={busy} disabled={!plan.body || (fit && !fit.ok)} onClick={start}>
								Start receiving offline
							</Button>
						</>
					)}
				</>
			) : SETUP_STATES.includes(epoch.state) ? (
				<>
					<div className="info-note">
						Setting up the voucher book with {epochPeer}: {described.detail} This takes a few seconds while the
						two sides sign.
					</div>
					<Button className="sm" busy={busy} onClick={cancelSetup}>
						Cancel setup
					</Button>
				</>
			) : (
				<>
					<div className={described.warn || described.mismatch ? 'error-note' : 'info-note'} data-testid="ffor-epoch">
						<Badge tone={described.tone}>{described.label}</Badge>{' '}
						{epoch.state === 'ACTIVE' && !described.mismatch && !described.enforced
							? `with ${epochPeer}. ${described.detail} Blocks come about ten minutes apart, sometimes much slower; come back with a day to spare.`
							: described.detail}
						{described.warn ? ' Under a day of margin is left: return now.' : ''}
					</div>
					<div className="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Voucher</th>
									<th>Amount</th>
									<th>State</th>
									<th></th>
								</tr>
							</thead>
							<tbody>
								{(epoch.slots || []).map((slot) => {
									const inv = minted[slot.k] || (slot.bolt11 ? { bolt11: slot.bolt11 } : null);
									const sats = Math.floor(Number(slot.amountMsat || 0) / 1000);
									return [
										<tr key={slot.k}>
											<td className="mono">{slot.k}</td>
											<td>{fmtSats(sats)}</td>
											<td>
												<Badge tone={slotTone(slot)}>{slotLabel(slot)}</Badge>
											</td>
											<td>
												{slot.state === 'unissued' && epoch.state === 'ACTIVE' && !described.enforced && (
													<Button className="sm" busy={busy} onClick={() => mint(slot.k)} data-testid={`ffor-mint-${slot.k}`}>
														Create invoice
													</Button>
												)}
												{slot.state === 'exposed' && inv && (
													<Button className="sm" onClick={() => setOpenSlot(openSlot === slot.k ? null : slot.k)}>
														{openSlot === slot.k ? 'Hide' : 'Show'}
													</Button>
												)}
												{slot.state === 'exposed' && !inv && (
													<span className="wallet-meta">Created in another session; share it from there, or update the app for an engine that carries it here.</span>
												)}
											</td>
										</tr>,
										openSlot === slot.k && inv ? (
											<tr key={`${slot.k}-qr`}>
												<td colSpan={4} style={{ textAlign: 'center' }}>
													<QR value={inv.bolt11} />
													<div style={{ marginTop: 12 }}>
														<CopyText value={inv.bolt11} truncate />
													</div>
													<div className="field-hint" style={{ marginTop: 8 }}>
														Payable while this wallet is off, until the return-by height. One payment per voucher.
													</div>
												</td>
											</tr>
										) : null
									];
								})}
							</tbody>
						</table>
					</div>
					{epoch.state === 'ACTIVE' && !described.enforced && (
						<div className="center-actions" style={{ justifyContent: 'flex-start', marginTop: 10 }}>
							<Button className="sm" busy={busy} onClick={closeNow}>
								Close the book now
							</Button>
							<span className="wallet-meta">
								Collects what was paid and releases the rest. The manager does this by itself after every start.
							</span>
						</div>
					)}
					{(epoch.state === 'CLOSED' || epoch.state === 'ABORTED' || described.enforced) && (
						<div className="center-actions" style={{ justifyContent: 'flex-start', marginTop: 10 }}>
							<Button className="sm" onClick={() => setAnother(true)}>
								Start another
							</Button>
						</div>
					)}
					{epoch.state === 'DRAINING' && <div className="wallet-meta" style={{ marginTop: 8 }}>Settling the paid vouchers into your balance…</div>}
				</>
			)}
		</Card>
	);
}
