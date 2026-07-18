import { useEffect, useRef, useState } from 'react';
import { usePoll } from '../../hooks/usePoll.js';
import { useToast } from '../../components/Toast.jsx';
import { AmountField, Badge, BalanceBar, Button, Card, CopyText, DetailRow, Field, FeeField, Modal } from '../../components/ui.jsx';
import { fmtSats, shortId } from '../../lib/format.js';
import { FEE_CAP_MULTIPLE, vbytes } from '../../lib/fees.js';
import { useQuote } from '../../hooks/useQuote.js';
import { withPeerHint } from '../../lib/hints.js';
import { watchChannelOpen } from '../../lib/channel-open.js';

const STATE_TONE = {
	NORMAL: 'green',
	AWAITING_CHANNEL_READY: 'yellow',
	AWAITING_FUNDING_CONFIRMED: 'yellow',
	AWAITING_REESTABLISH: 'yellow',
	SHUTTING_DOWN: 'yellow',
	NEGOTIATING_CLOSING: 'yellow',
	FORCE_CLOSED: 'red',
	CLOSED: 'muted'
};

// beignet splice/open feerates are per-kiloweight. Users think in sat/vB.
const SATVB_TO_PERKW = 250;

const clickOrigin = (e) => ({ x: e.clientX, y: e.clientY });

export default function ChannelsTab({ id, api, rec, tick, bump }) {
	const toast = useToast();
	const [modal, setModal] = useState(null);
	const { data: channels, refresh } = usePoll(() => api.get('/channels').catch(() => []), 8000, [id, tick]);

	const doAction = async (fn, ok) => {
		try {
			await fn();
			toast(ok, 'success');
			bump();
			refresh();
		} catch (e) {
			toast(e.message, 'error');
		}
	};

	return (
		<div>
			<Card
				title="Channels"
				actions={<Button variant="primary" className="sm" onClick={(e) => setModal({ type: 'open', origin: clickOrigin(e) })}>Open channel</Button>}
			>
				{!channels || channels.length === 0 ? (
					<div className="empty">No channels. Open one to start using Lightning.</div>
				) : (
					<div className="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Peer</th>
									<th>Capacity</th>
									<th style={{ width: 180 }}>Local / Remote</th>
									<th>State</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{channels.map((c) => (
									<tr
										key={c.channelId}
										className="row-clickable"
										onClick={(e) => setModal({ type: 'detail', channel: c, origin: clickOrigin(e) })}
									>
										<td className="mono" title={c.peerPubkey}>{shortId(c.peerPubkey)}</td>
										<td>{fmtSats(c.capacitySats)}</td>
										<td>
											<BalanceBar local={c.localBalanceSats} remote={c.remoteBalanceSats} />
											<div className="wallet-meta" style={{ marginTop: 4 }}>
												{fmtSats(c.localBalanceSats)} / {fmtSats(c.remoteBalanceSats)}
											</div>
										</td>
										<td>
											<Badge tone={STATE_TONE[c.state] || 'muted'}>{c.state}</Badge>
											{c.isPrivate && <Badge tone="muted">private</Badge>}
										</td>
										{/* The buttons act on the channel; only the rest of the row opens it. */}
										<td onClick={(e) => e.stopPropagation()}>
											<div className="wallet-actions">
												<Button className="sm" onClick={(e) => setModal({ type: 'splice', dir: 'in', channel: c, origin: clickOrigin(e) })}>
													Splice in
												</Button>
												<Button className="sm" onClick={(e) => setModal({ type: 'splice', dir: 'out', channel: c, origin: clickOrigin(e) })}>
													Splice out
												</Button>
												<Button className="sm" onClick={(e) => setModal({ type: 'close', channel: c, origin: clickOrigin(e) })}>
													Close
												</Button>
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Card>

			{modal?.type === 'open' && (
				<OpenChannelModal id={id} api={api} rec={rec} origin={modal.origin} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); bump(); }} />
			)}
			{modal?.type === 'detail' && (
				<ChannelDetailModal
					api={api}
					channel={modal.channel}
					origin={modal.origin}
					onClose={() => setModal(null)}
				/>
			)}
			{modal?.type === 'splice' && (
				<SpliceModal
					api={api}
					dir={modal.dir}
					channel={modal.channel}
					origin={modal.origin}
					onClose={() => setModal(null)}
					onDone={() => { setModal(null); refresh(); bump(); }}
				/>
			)}
			{modal?.type === 'close' && (
				<Modal title="Close channel" onClose={() => setModal(null)} origin={modal.origin}>
					<p className="wallet-meta">
						Cooperatively close the channel with <span className="mono">{shortId(modal.channel.peerPubkey)}</span>?
						Your local balance ({fmtSats(modal.channel.localBalanceSats)}) returns on-chain.
					</p>
					<div className="center-actions">
						<Button
							variant="primary"
							onClick={() => { doAction(() => api.post('/channel/close', { channelId: modal.channel.channelId }), 'Closing channel'); setModal(null); }}
						>
							Close cooperatively
						</Button>
						<Button
							variant="danger"
							onClick={() => { doAction(() => api.post('/channel/forceclose', { channelId: modal.channel.channelId }), 'Force closing'); setModal(null); }}
						>
							Force close
						</Button>
						<Button onClick={() => setModal(null)}>Cancel</Button>
					</div>
				</Modal>
			)}
		</div>
	);
}

// Many routing nodes reject channels below this (LND's default minchansize).
const COMMON_MIN_CHANNEL_SATS = 20000;

function OpenChannelModal({ id, api, rec, origin, onClose, onDone }) {
	const toast = useToast();
	const [uri, setUri] = useState('');
	const [pubkey, setPubkey] = useState('');
	const [host, setHost] = useState('');
	const [port, setPort] = useState('9735');
	const [amount, setAmount] = useState('');
	const [maxAmount, setMaxAmount] = useState(false);
	const [feeRate, setFeeRate] = useState('');
	const [push, setPush] = useState('');
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState(null);
	const [error, setError] = useState(null);
	// Aborted on unmount so a watch in flight stops when the modal is closed,
	// rather than polling on and reporting to a modal that is no longer there.
	const abort = useRef(null);
	useEffect(() => {
		const controller = new AbortController();
		abort.current = controller;
		return () => controller.abort();
	}, []);
	const { data: info } = usePoll(() => api.get('/info').catch(() => null), 30000, []);
	const { data: fees } = usePoll(() => api.get('/fees/estimates').catch(() => null), 30000, []);
	const { data: utxos } = usePoll(() => api.get('/utxos').catch(() => null), 30000, []);

	const balance = info?.onchainBalanceSats;

	// The funding rate is ours to set (beignet 0.5.3 takes satsPerVbyte on the
	// open), so it no longer has to be guessed at and padded against. Default to
	// fast: an open that sits unconfirmed for days is worse than one that overpaid
	// a little, and the user can drag it down.
	const effRate = parseInt(feeRate, 10) || fees?.fast || null;
	const typed = parseInt(amount, 10) || 0;

	// What the funding transaction really costs, from the wallet. `channelFunding`
	// matters: a channel is funded into a 2-of-2 P2WSH, which is a bigger output
	// than the P2WPKH an ordinary payment goes to, so it costs more to create.
	const { quote } = useQuote(
		api,
		{
			// A probe of 1 sat when nothing is typed yet: the ceiling of the amount
			// slider is the balance less the fee, so there has to be a fee before
			// there is a slider to type into. The wallet consolidates its UTXOs, so
			// the fee does not turn on the amount, and this re-quotes as it changes.
			amountSats: maxAmount ? undefined : typed || 1,
			satsPerVbyte: effRate || undefined,
			max: maxAmount,
			channelFunding: true
		},
		balance > 0 && effRate > 0
	);

	const shownFee = quote?.feeSats ?? null;
	const vsize = quote?.vsize ?? null;

	// Max is the whole balance less the funding fee, worked out by the wallet at
	// the rate we are about to name. Nothing is held back "just in case", because
	// there is nothing left to guess at.
	const sweepAmount = maxAmount ? quote?.maxSendSats ?? null : null;
	const ordinaryMax =
		balance != null && shownFee != null ? Math.max(0, balance - shownFee) : 0;

	// The range must not collapse to nothing while the sweep's own figure is still
	// in flight: a ceiling of zero hands back a zero, which reads as a deliberate
	// amount and knocks Max off again. Hold the last one until the real one lands.
	const maxChannel = maxAmount ? sweepAmount ?? ordinaryMax : ordinaryMax;

	// Same rule as the send form: amount + fee never exceeds the balance, so the fee
	// may only grow into what the amount leaves behind. Priced off the quote's own
	// size, not an approximation of it.
	const feeHeadroom =
		balance == null || !vsize
			? 0
			: Math.floor(Math.max(0, balance - typed) / vsize);
	const typedRate = parseInt(feeRate, 10) || 0;
	const feeMax = Math.max(
		1,
		Math.min(
			Math.max(fees?.fast ? fees.fast * FEE_CAP_MULTIPLE : 100, typedRate),
			feeHeadroom || Infinity
		)
	);
	// A rate the balance cannot cover alongside the amount is not accepted. Anything
	// it can cover is, however large: the slider's ceiling is where the slider ends,
	// not what the form permits, and typing past it grows the range rather than
	// being refused.
	const setFeeRateManually = (val) => {
		const next = parseInt(val, 10) || 0;
		if (feeHeadroom > 0 && next > feeHeadroom) return;
		setFeeRate(val);
	};

	// Derived, never stored, so it tracks the fee estimate as that refreshes
	// rather than freezing the number that was right when Max was pressed.
	const shownAmount = maxAmount ? String(maxChannel) : amount;
	// The open is funded at exactly this number, so it must be the wallet's own
	// figure and not the placeholder held while that figure is on its way.
	const amountNum = maxAmount ? sweepAmount ?? 0 : parseInt(amount, 10) || 0;

	// An amount the balance cannot fund once the fee is taken is not accepted,
	// rather than accepted and then complained about, so the form is never in a
	// state that cannot be opened.
	// Reaching the top of the range means "everything", which is what Max is, so
	// arriving there presses it rather than leaving a number that Max would beat.
	const setAmountManually = (val) => {
		const next = parseInt(val, 10) || 0;
		if (maxAmount) {
			if (sweepAmount == null) return; // the sweep's figure is still coming
			if (next >= sweepAmount) return; // still at the top
			setMaxAmount(false);
			setAmount(String(Math.min(next, ordinaryMax)));
			return;
		}
		if (ordinaryMax > 0 && next >= ordinaryMax) {
			setMaxAmount(true);
			return;
		}
		setAmount(val);
	};

	const pushNum = parseInt(push, 10) || 0;
	const overBalance =
		amountNum > 0 && balance != null && shownFee != null && amountNum + shownFee > balance;
	const belowCommonMin = amountNum > 0 && amountNum < COMMON_MIN_CHANNEL_SATS;
	const pushTooBig = pushNum > 0 && amountNum > 0 && pushNum >= amountNum;

	// Accept a pubkey@host:port URI and split it into fields.
	const applyUri = (val) => {
		setUri(val);
		const m = val.trim().match(/^([0-9a-fA-F]{66})@([^:]+):(\d+)$/);
		if (m) {
			setPubkey(m[1]);
			setHost(m[2]);
			setPort(m[3]);
		}
	};

	const open = async () => {
		setBusy(true);
		setStatus('Connecting to the peer…');
		setError(null);
		const peerPubkey = pubkey.trim();
		try {
			const body = {
				pubkey: peerPubkey,
				host: host.trim(),
				port: parseInt(port, 10),
				// Max is derived from the live fee rate, so read the amount that is on
				// screen right now rather than the text field, which Max never wrote.
				amountSats: amountNum
			};
			// Fund at the rate the amount above was sized against. Without this the
			// daemon picks its own, and a Max sized against ours would be short.
			if (effRate) body.satsPerVbyte = effRate;
			if (push) body.pushSats = parseInt(push, 10);

			// Snapshot the channels we already have with this peer. The open returns
			// a *temporary* channel id that is swapped for a permanent one the moment
			// funding is created, so the new channel has to be spotted by its peer,
			// not by the id we get back. This must not be allowed to fail quietly: an
			// empty snapshot would make a channel we already hold with this peer look
			// like the one we just opened, and report a failed open as a success.
			const before = await api.get('/channels');
			const knownIds = new Set((before || []).map((c) => c.channelId));
			const since = Date.now();

			const res = await api.post('/channel/connect-and-open', body);

			// A 200 here means only that open_channel was sent. The peer can still
			// reject it, and the funding can still fail, so wait for a real outcome
			// rather than reporting success now.
			setStatus('Negotiating with the peer and funding the channel…');
			const outcome = await watchChannelOpen({
				api,
				id,
				peerPubkey,
				tempChannelId: res?.channelId,
				knownIds,
				since,
				signal: abort.current?.signal
			});

			if (outcome.status === 'abandoned') return;
			if (outcome.status === 'funded') {
				toast('Channel opened. Funding transaction broadcast.', 'success');
				onDone();
				return;
			}
			if (outcome.status === 'pending') {
				toast(outcome.reason, 'info');
				onDone();
				return;
			}
			setError(outcome.reason);
		} catch (e) {
			if (abort.current?.signal.aborted) return;
			setError(withPeerHint(rec, e.message, { port }));
		} finally {
			setBusy(false);
			setStatus(null);
		}
	};

	return (
		<Modal title="Open channel" onClose={onClose} origin={origin}>
			<div className="wallet-meta" style={{ marginBottom: 12 }}>
				On-chain available: {fmtSats(balance)}
			</div>
			<Field label="Peer URI (pubkey@host:port)" hint="Or fill the fields below individually.">
				<input value={uri} onChange={(e) => applyUri(e.target.value)} placeholder="02abc…@1.2.3.4:9735" />
			</Field>
			<Field label="Node pubkey">
				<input value={pubkey} onChange={(e) => setPubkey(e.target.value)} placeholder="02…" />
			</Field>
			<div className="row">
				<Field label="Host">
					<input value={host} onChange={(e) => setHost(e.target.value)} />
				</Field>
				<Field label="Port">
					<input value={port} onChange={(e) => setPort(e.target.value)} style={{ maxWidth: 110 }} />
				</Field>
			</div>
			<AmountField
				label="Channel amount (sats)"
				value={shownAmount}
				onChange={setAmountManually}
				max={maxChannel}
				isMax={maxAmount}
				onMax={() => setMaxAmount((v) => !v)}
				hint={
					maxAmount && shownFee != null
						? `Everything except the ${fmtSats(shownFee)} funding fee at ${effRate} sat/vB. Change the fee rate and this follows it.`
						: 'Becomes your outbound capacity. The on-chain funding fee is paid on top, from the remaining balance.'
				}
			/>
			<FeeField
				label="Funding fee rate (sat/vB)"
				value={feeRate}
				onChange={setFeeRateManually}
				rate={effRate}
				max={feeMax}
				hint={
					maxAmount
						? 'The rate the funding transaction is broadcast at. Raising it takes sats off the channel amount above.'
						: 'The rate the funding transaction is broadcast at. Defaults to fast, so the channel does not sit unconfirmed.'
				}
			/>
			{fees && (
				<div className="preset-row" style={{ marginBottom: 14 }}>
					{[
						['Fast', fees.fast],
						['Normal', fees.normal],
						['Slow', fees.slow]
					].map(([label, rate]) => (
						<button
							key={label}
							type="button"
							className="btn sm"
							disabled={rate > feeMax}
							title={rate > feeMax ? 'Lower the amount to afford this fee rate' : undefined}
							onClick={() => setFeeRateManually(String(rate))}
						>
							{label} · {rate} sat/vB
						</button>
					))}
				</div>
			)}
			<Field
				label="Push to peer (sats, optional)"
				hint="Gifted to the peer from your side of the channel."
			>
				<input value={push} onChange={(e) => setPush(e.target.value)} placeholder="0" />
			</Field>
			{shownFee != null && amountNum > 0 && (
				<div className="wallet-meta" style={{ marginBottom: 12 }}>
					Funding fee: {fmtSats(shownFee)} at {effRate} sat/vB over {vsize} vB. Total needed:{' '}
					{fmtSats(amountNum + shownFee)}. This is what the transaction pays, not an estimate.
				</div>
			)}
			{pushTooBig && (
				<div className="error-note" style={{ marginBottom: 12 }}>
					Push amount must be smaller than the channel amount.
				</div>
			)}
			{belowCommonMin && (
				<div className="info-note" style={{ marginBottom: 12 }}>
					Many nodes reject channels under {fmtSats(COMMON_MIN_CHANNEL_SATS)}.
				</div>
			)}
			{status && (
				<div className="info-note" style={{ marginBottom: 12 }}>
					{status} This can take a minute. The channel is not open until the funding
					transaction is broadcast.
				</div>
			)}
			{error && (
				<div className="error-note" style={{ marginBottom: 12 }}>
					{error}
					<div style={{ marginTop: 6, opacity: 0.85 }}>
						The full daemon output is in the <strong>Logs</strong> tab.
					</div>
				</div>
			)}
			<div className="center-actions">
				<Button
					variant="primary"
					busy={busy}
					onClick={open}
					disabled={!pubkey || !host || amountNum <= 0 || overBalance || pushTooBig}
				>
					Connect &amp; open
				</Button>
				<Button onClick={onClose}>{error ? 'Close' : 'Cancel'}</Button>
			</div>
		</Modal>
	);
}

function SpliceModal({ api, dir, channel, origin, onClose, onDone }) {
	const toast = useToast();
	const [amount, setAmount] = useState('');
	const [maxMode, setMaxMode] = useState(false);
	const [feeVb, setFeeVb] = useState('');
	const [busy, setBusy] = useState(false);
	const isIn = dir === 'in';
	const { data: info } = usePoll(() => api.get('/info').catch(() => null), 30000, []);
	const { data: fees } = usePoll(() => api.get('/fees/estimates').catch(() => null), 30000, []);

	const balance = info?.onchainBalanceSats;
	const effRate = parseFloat(feeVb) || fees?.normal || null;
	// Splice tx approximation: shared input + a wallet input/output either way.
	const estFee = effRate ? vbytes(2, 2) * Math.ceil(effRate) : null;
	// A splice-out may only spend local balance down to the channel reserve the
	// peer set. The channel listing does not carry the exact figure, so hold
	// back BOLT 2's customary reserve (1% of capacity, dust floor) rather than
	// submit a splice the daemon will bounce.
	const reserve = Math.max(354, Math.ceil((channel.capacitySats || 0) / 100));
	const available = isIn
		? balance ?? 0
		: Math.max(0, (channel.localBalanceSats || 0) - reserve);
	// Most that can be spliced at this fee rate, already net of the fee: the
	// same contract as the Send view, so the ceiling moves with the fee rate
	// and Max re-derives from it every render instead of freezing a number.
	const ceiling = Math.max(0, available - (estFee || 0));
	const shownAmount = maxMode ? String(ceiling) : amount;
	const amountNum = maxMode ? ceiling : parseInt(amount, 10) || 0;

	// Mirrors the Send view: dragging the slider to the top presses Max,
	// coming back down releases it.
	const setAmountManually = (val) => {
		const next = parseInt(val, 10) || 0;
		if (maxMode) {
			if (next >= ceiling) return; // still at the top
			setMaxMode(false);
			setAmount(String(Math.min(next, ceiling)));
			return;
		}
		if (ceiling > 0 && next >= ceiling) {
			setMaxMode(true);
			return;
		}
		setAmount(val);
	};

	const overBalance =
		isIn && !maxMode && amountNum > 0 && balance != null && estFee != null &&
		amountNum + estFee > balance;
	const overLocal =
		!isIn && !maxMode && amountNum > 0 && estFee != null &&
		amountNum + estFee > available;

	const submit = async () => {
		setBusy(true);
		try {
			const body = {
				channelId: channel.channelId,
				amountSats: amountNum,
				feeratePerkw: Math.max(253, Math.round(effRate * SATVB_TO_PERKW))
			};
			const r = await api.post(isIn ? '/channel/splice-in' : '/channel/splice-out', body);
			if (r && r.ok === false) throw new Error(r.error || 'Splice failed');
			toast(isIn ? 'Splice-in submitted' : 'Splice-out submitted', 'success');
			onDone();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal title={isIn ? 'Splice in (add funds)' : 'Splice out (remove funds)'} onClose={onClose} origin={origin}>
			<div className="info-note">
				{isIn
					? 'Add on-chain funds into this channel, increasing its capacity and your outbound balance, without closing it.'
					: 'Move funds out of this channel back on-chain without closing it.'}
			</div>
			<div className="wallet-meta" style={{ marginBottom: 12 }}>
				Channel <span className="mono">{shortId(channel.channelId)}</span> · capacity{' '}
				{fmtSats(channel.capacitySats)} · local {fmtSats(channel.localBalanceSats)}
				{isIn && balance != null && <> · on-chain available {fmtSats(balance)}</>}
			</div>
			<AmountField
				label="Amount (sats)"
				value={shownAmount}
				onChange={setAmountManually}
				max={ceiling}
				isMax={maxMode}
				onMax={() => setMaxMode((v) => !v)}
				hint={
					isIn
						? 'The slider stops at the most you can splice in at this fee rate, so it leaves room for the fee.'
						: 'The slider stops at the most this channel can spare: it leaves room for the fee and the ~1% channel reserve, which cannot be withdrawn without closing.'
				}
			/>
			<Field label="Fee rate (sat/vB)">
				<input
					value={feeVb}
					onChange={(e) => setFeeVb(e.target.value)}
					placeholder={fees?.normal ? `auto (${fees.normal})` : 'auto'}
					style={{ maxWidth: 120 }}
				/>
			</Field>
			{fees && (
				<div className="preset-row" style={{ marginBottom: 14 }}>
					{[
						['Fast', fees.fast],
						['Normal', fees.normal],
						['Slow', fees.slow]
					].map(([label, rate]) => (
						<button key={label} type="button" className="btn sm" onClick={() => setFeeVb(String(rate))}>
							{label} · {rate} sat/vB
						</button>
					))}
				</div>
			)}
			{estFee != null && amountNum > 0 && (
				<div className="wallet-meta" style={{ marginBottom: 12 }}>
					Estimated splice fee: ~{fmtSats(estFee)} at {Math.ceil(effRate)} sat/vB (approximate),
					paid {isIn ? 'from your on-chain balance on top of the amount' : 'from the amount moved out'}.
				</div>
			)}
			{overBalance && (
				<div className="error-note" style={{ marginBottom: 12 }}>
					Amount plus the estimated fee exceeds your on-chain balance.
				</div>
			)}
			{overLocal && (
				<div className="error-note" style={{ marginBottom: 12 }}>
					Amount plus the estimated fee exceeds what this channel can spare
					(local balance minus the ~1% channel reserve).
				</div>
			)}
			<div className="center-actions">
				<Button
					variant="primary"
					busy={busy}
					onClick={submit}
					disabled={!amountNum || !effRate || overBalance || overLocal}
				>
					{isIn ? 'Splice in' : 'Splice out'}
				</Button>
				<Button onClick={onClose}>Cancel</Button>
			</div>
		</Modal>
	);
}

/** 8-byte SCID hex → the human block x tx x output form. */
function fmtScid(scidHex) {
	if (!scidHex || scidHex.length !== 16) return scidHex || null;
	const block = parseInt(scidHex.slice(0, 6), 16);
	const tx = parseInt(scidHex.slice(6, 12), 16);
	const vout = parseInt(scidHex.slice(12, 16), 16);
	return `${block}x${tx}x${vout}`;
}

function ChannelDetailModal({ api, channel, origin, onClose }) {
	const [diag, setDiag] = useState(null);
	const [health, setHealth] = useState(null);
	const [policy, setPolicy] = useState(null);

	useEffect(() => {
		let alive = true;
		const qs = `?channelId=${channel.channelId}`;
		// Three independent lookups; each may 404 on older daemons or a channel
		// that vanished between the list and the click, and the modal shows
		// whatever it does get.
		api.get(`/channel/diagnostics${qs}`).then((d) => alive && setDiag(d)).catch(() => {});
		api.get(`/channel/health${qs}`).then((d) => alive && setHealth(d)).catch(() => {});
		api.get(`/channel/policy${qs}`).then((d) => alive && setPolicy(d)).catch(() => {});
		return () => {
			alive = false;
		};
	}, [api, channel.channelId]);

	const local = diag?.localBalanceSats ?? channel.localBalanceSats;
	const remote = diag?.remoteBalanceSats ?? channel.remoteBalanceSats;
	const state = diag?.state || channel.state;
	const scid = fmtScid(diag?.effectiveScid);
	const announcing =
		diag?.announceChannel &&
		!(diag.announcementSigsSent && diag.announcementSigsReceived);

	return (
		<Modal title="Channel" onClose={onClose} origin={origin} wide>
			<div className="detail">
				<DetailRow label="State">
					<Badge tone={STATE_TONE[state] || 'muted'}>{state}</Badge>
					{diag && (
						<Badge tone={diag.isPeerConnected ? 'green' : 'red'}>
							{diag.isPeerConnected ? 'peer connected' : 'peer offline'}
						</Badge>
					)}
				</DetailRow>
				<DetailRow label="Peer">
					<CopyText value={channel.peerPubkey} truncate />
				</DetailRow>
				<DetailRow label="Channel id">
					<CopyText value={channel.channelId} truncate />
				</DetailRow>
				<DetailRow label="Balance">
					<BalanceBar local={local} remote={remote} />
					<div className="wallet-meta" style={{ marginTop: 4 }}>
						{fmtSats(local)} local / {fmtSats(remote)} remote of{' '}
						{fmtSats(channel.capacitySats)} capacity
					</div>
				</DetailRow>
				{scid && (
					<DetailRow label="Short channel id">
						<span className="mono" title={diag.effectiveScid}>
							{scid}
						</span>
					</DetailRow>
				)}
				{diag && (
					<DetailRow label="Visibility">
						{diag.announceChannel
							? announcing
								? 'public, announcement in progress'
								: 'public, announced'
							: 'private (payments to you need routing hints, which invoices include)'}
					</DetailRow>
				)}
				{health && (
					<DetailRow label="In-flight payments">
						{health.htlcCount} of {health.maxHtlcs} HTLC slots in use
					</DetailRow>
				)}
				{policy && (
					<DetailRow label="Routing policy">
						{policy.feeBaseMsat} msat + {policy.feeProportionalMillionths} ppm,
						cltv delta {policy.cltvExpiryDelta}
					</DetailRow>
				)}
				{diag?.issues?.length > 0 && (
					<DetailRow label="Issues">
						{diag.issues.map((issue, i) => (
							<div className="error-note" key={i} style={{ marginBottom: 6 }}>
								{issue}
							</div>
						))}
					</DetailRow>
				)}
				{diag?.issues?.length === 0 && health?.warnings?.length > 0 && (
					<DetailRow label="Warnings">
						{health.warnings.map((wrn, i) => (
							<div className="wallet-meta" key={i}>
								{wrn}
							</div>
						))}
					</DetailRow>
				)}
			</div>
		</Modal>
	);
}
