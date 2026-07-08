import { useState } from 'react';
import { usePoll } from '../../hooks/usePoll.js';
import { useToast } from '../../components/Toast.jsx';
import { Badge, BalanceBar, Button, Card, Field, Modal } from '../../components/ui.jsx';
import { fmtSats, shortId } from '../../lib/format.js';

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
				actions={<Button variant="primary" className="sm" onClick={() => setModal({ type: 'open' })}>Open channel</Button>}
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
												<Button className="sm" onClick={() => setModal({ type: 'splice', dir: 'in', channel: c })}>
													Splice in
												</Button>
												<Button className="sm" onClick={() => setModal({ type: 'splice', dir: 'out', channel: c })}>
													Splice out
												</Button>
												<Button className="sm" onClick={() => setModal({ type: 'close', channel: c })}>
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
				<OpenChannelModal api={api} onClose={() => setModal(null)} onDone={() => { setModal(null); refresh(); bump(); }} />
			)}
			{modal?.type === 'splice' && (
				<SpliceModal
					api={api}
					dir={modal.dir}
					channel={modal.channel}
					onClose={() => setModal(null)}
					onDone={() => { setModal(null); refresh(); bump(); }}
				/>
			)}
			{modal?.type === 'close' && (
				<Modal title="Close channel" onClose={() => setModal(null)}>
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

function OpenChannelModal({ api, onClose, onDone }) {
	const toast = useToast();
	const [uri, setUri] = useState('');
	const [pubkey, setPubkey] = useState('');
	const [host, setHost] = useState('');
	const [port, setPort] = useState('9735');
	const [amount, setAmount] = useState('');
	const [push, setPush] = useState('');
	const [busy, setBusy] = useState(false);

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
		<Modal title="Open channel" onClose={onClose}>
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
				<Field label="Channel amount (sats)">
					<input value={amount} onChange={(e) => setAmount(e.target.value)} />
				</Field>
				<Field label="Push to peer (sats, optional)">
					<input value={push} onChange={(e) => setPush(e.target.value)} placeholder="0" />
				</Field>
			</div>
			<div className="center-actions">
				<Button variant="primary" busy={busy} onClick={open} disabled={!pubkey || !host || !amount}>
					Connect &amp; open
				</Button>
				<Button onClick={onClose}>Cancel</Button>
			</div>
		</Modal>
	);
}

function SpliceModal({ api, dir, channel, onClose, onDone }) {
	const toast = useToast();
	const [amount, setAmount] = useState('');
	const [feeVb, setFeeVb] = useState('2');
	const [busy, setBusy] = useState(false);
	const isIn = dir === 'in';

	const submit = async () => {
		setBusy(true);
		try {
			const body = {
				channelId: channel.channelId,
				amountSats: parseInt(amount, 10),
				feeratePerkw: Math.max(253, Math.round(parseFloat(feeVb) * SATVB_TO_PERKW))
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
		<Modal title={isIn ? 'Splice in (add funds)' : 'Splice out (remove funds)'} onClose={onClose}>
			<div className="info-note">
				{isIn
					? 'Add on-chain funds into this channel, increasing its capacity and your outbound balance, without closing it.'
					: 'Move funds out of this channel back on-chain without closing it.'}
			</div>
			<div className="wallet-meta" style={{ marginBottom: 12 }}>
				Channel <span className="mono">{shortId(channel.channelId)}</span> · capacity{' '}
				{fmtSats(channel.capacitySats)} · local {fmtSats(channel.localBalanceSats)}
			</div>
			<div className="row">
				<Field label="Amount (sats)">
					<input value={amount} onChange={(e) => setAmount(e.target.value)} />
				</Field>
				<Field label="Fee rate (sat/vB)">
					<input value={feeVb} onChange={(e) => setFeeVb(e.target.value)} style={{ maxWidth: 120 }} />
				</Field>
			</div>
			<div className="center-actions">
				<Button variant="primary" busy={busy} onClick={submit} disabled={!amount}>
					{isIn ? 'Splice in' : 'Splice out'}
				</Button>
				<Button onClick={onClose}>Cancel</Button>
			</div>
		</Modal>
	);
}
