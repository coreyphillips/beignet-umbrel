import { useState } from 'react';
import { usePoll } from '../../hooks/usePoll.js';
import { useToast } from '../../components/Toast.jsx';
import { Badge, BalanceBar, Button, Card, Field, Modal } from '../../components/ui.jsx';
import { fmtSats, shortId } from '../../lib/format.js';
import { vbytes } from '../../lib/fees.js';

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

export default function ChannelsTab({ id, api, tick, bump }) {
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
									<tr key={c.channelId}>
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
										<td>
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
				<OpenChannelModal api={api} origin={modal.origin} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); bump(); }} />
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

function OpenChannelModal({ api, origin, onClose, onDone }) {
	const toast = useToast();
	const [uri, setUri] = useState('');
	const [pubkey, setPubkey] = useState('');
	const [host, setHost] = useState('');
	const [port, setPort] = useState('9735');
	const [amount, setAmount] = useState('');
	const [push, setPush] = useState('');
	const [busy, setBusy] = useState(false);
	const { data: info } = usePoll(() => api.get('/info').catch(() => null), 30000, []);
	const { data: fees } = usePoll(() => api.get('/fees/estimates').catch(() => null), 30000, []);
	const { data: utxos } = usePoll(() => api.get('/utxos').catch(() => null), 30000, []);

	const balance = info?.onchainBalanceSats;
	// The daemon picks the funding fee rate itself; show the current normal
	// estimate so the user knows what comes out of the balance on top of the
	// channel amount. Funding tx: channel output + change.
	const estRate = fees?.normal || null;
	const estFee = estRate ? vbytes(Math.max(1, Math.min(utxos?.length || 1, 2)), 2) * estRate : null;
	const amountNum = parseInt(amount, 10) || 0;
	const pushNum = parseInt(push, 10) || 0;
	const overBalance =
		amountNum > 0 && balance != null && estFee != null && amountNum + estFee > balance;
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
		try {
			const body = {
				pubkey: pubkey.trim(),
				host: host.trim(),
				port: parseInt(port, 10),
				amountSats: parseInt(amount, 10)
			};
			if (push) body.pushSats = parseInt(push, 10);
			await api.post('/channel/connect-and-open', body);
			toast('Channel opening', 'success');
			onDone();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
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
			<div className="row">
				<Field
					label="Channel amount (sats)"
					hint="Becomes your outbound capacity. The on-chain funding fee is paid on top, from the remaining balance."
				>
					<input value={amount} onChange={(e) => setAmount(e.target.value)} />
				</Field>
				<Field
					label="Push to peer (sats, optional)"
					hint="Gifted to the peer from your side of the channel."
				>
					<input value={push} onChange={(e) => setPush(e.target.value)} placeholder="0" />
				</Field>
			</div>
			{estFee != null && amountNum > 0 && !overBalance && (
				<div className="wallet-meta" style={{ marginBottom: 12 }}>
					Estimated funding fee: ~{fmtSats(estFee)} at {estRate} sat/vB (approximate; the wallet
					sets the final rate when broadcasting). Total needed: ~{fmtSats(amountNum + estFee)}.
				</div>
			)}
			{overBalance && (
				<div className="error-note" style={{ marginBottom: 12 }}>
					Channel amount plus the estimated funding fee (~{fmtSats(estFee)}) exceeds your on-chain
					balance. Lower the amount to leave room for the fee.
				</div>
			)}
			{pushTooBig && (
				<div className="error-note" style={{ marginBottom: 12 }}>
					Push amount must be smaller than the channel amount.
				</div>
			)}
			{belowCommonMin && !overBalance && (
				<div className="info-note" style={{ marginBottom: 12 }}>
					Many nodes reject channels under {fmtSats(COMMON_MIN_CHANNEL_SATS)}.
				</div>
			)}
			<div className="center-actions">
				<Button
					variant="primary"
					busy={busy}
					onClick={open}
					disabled={!pubkey || !host || !amount || overBalance || pushTooBig}
				>
					Connect &amp; open
				</Button>
				<Button onClick={onClose}>Cancel</Button>
			</div>
		</Modal>
	);
}

function SpliceModal({ api, dir, channel, origin, onClose, onDone }) {
	const toast = useToast();
	const [amount, setAmount] = useState('');
	const [feeVb, setFeeVb] = useState('');
	const [busy, setBusy] = useState(false);
	const isIn = dir === 'in';
	const { data: info } = usePoll(() => api.get('/info').catch(() => null), 30000, []);
	const { data: fees } = usePoll(() => api.get('/fees/estimates').catch(() => null), 30000, []);

	const balance = info?.onchainBalanceSats;
	const effRate = parseFloat(feeVb) || fees?.normal || null;
	// Splice tx approximation: shared input + a wallet input/output either way.
	const estFee = effRate ? vbytes(2, 2) * Math.ceil(effRate) : null;
	const amountNum = parseInt(amount, 10) || 0;
	const overBalance =
		isIn && amountNum > 0 && balance != null && estFee != null && amountNum + estFee > balance;
	const overLocal =
		!isIn && amountNum > 0 && amountNum + (estFee || 0) > (channel.localBalanceSats || 0);

	const submit = async () => {
		setBusy(true);
		try {
			const body = {
				channelId: channel.channelId,
				amountSats: parseInt(amount, 10),
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
			<div className="row">
				<Field label="Amount (sats)">
					<input value={amount} onChange={(e) => setAmount(e.target.value)} />
				</Field>
				<Field label="Fee rate (sat/vB)">
					<input
						value={feeVb}
						onChange={(e) => setFeeVb(e.target.value)}
						placeholder={fees?.normal ? `auto (${fees.normal})` : 'auto'}
						style={{ maxWidth: 120 }}
					/>
				</Field>
			</div>
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
					Amount plus the estimated fee exceeds your local channel balance.
				</div>
			)}
			<div className="center-actions">
				<Button
					variant="primary"
					busy={busy}
					onClick={submit}
					disabled={!amount || !effRate || overBalance || overLocal}
				>
					{isIn ? 'Splice in' : 'Splice out'}
				</Button>
				<Button onClick={onClose}>Cancel</Button>
			</div>
		</Modal>
	);
}
