import { useState } from 'react';
import { usePoll } from '../../hooks/usePoll.js';
import { useToast } from '../../components/Toast.jsx';
import { Badge, Button, Card, CopyText, Field } from '../../components/ui.jsx';
import { shortId } from '../../lib/format.js';
import { withPeerHint } from '../../lib/hints.js';

export default function PeersTab({ id, api, info, rec, tick, bump }) {
	const toast = useToast();
	const { data: peers, refresh } = usePoll(() => api.get('/peers').catch(() => []), 8000, [id, tick]);
	const { data: nodeUri } = usePoll(
		() => api.get('/node/uri?host=127.0.0.1').then((r) => r.uri).catch(() => null),
		15000,
		[id, tick]
	);
	const [uri, setUri] = useState('');
	const [pubkey, setPubkey] = useState('');
	const [host, setHost] = useState('');
	const [port, setPort] = useState('9735');
	const [busy, setBusy] = useState(false);

	const applyUri = (val) => {
		setUri(val);
		const m = val.trim().match(/^([0-9a-fA-F]{66})@([^:]+):(\d+)$/);
		if (m) {
			setPubkey(m[1]);
			setHost(m[2]);
			setPort(m[3]);
		}
	};

	const connect = async () => {
		setBusy(true);
		try {
			await api.post('/peer/connect', { pubkey: pubkey.trim(), host: host.trim(), port: parseInt(port, 10) });
			toast('Connected', 'success');
			setUri('');
			setPubkey('');
			setHost('');
			refresh();
			bump();
		} catch (e) {
			toast(withPeerHint(rec, e.message), 'error');
		} finally {
			setBusy(false);
		}
	};

	const disconnect = async (pk) => {
		try {
			await api.post('/peer/disconnect', { pubkey: pk });
			toast('Disconnected', 'info');
			refresh();
		} catch (e) {
			toast(e.message, 'error');
		}
	};

	return (
		<div>
			<Card title="Your node">
				<div className="field">
					<span className="field-label">Node ID (pubkey)</span>
					{info?.nodeId ? <CopyText value={info.nodeId} /> : <span className="wallet-meta">-</span>}
				</div>
				<div className="field">
					<span className="field-label">Local connection URI</span>
					{nodeUri ? (
						<CopyText value={nodeUri} />
					) : (
						<span className="wallet-meta">Starting listener… refresh in a moment.</span>
					)}
					<span className="field-hint">
						The <span className="mono">127.0.0.1</span> address works for connecting wallets running
						in this same Beignet app (e.g. two regtest nodes here).
					</span>
				</div>
				{rec?.onionAddress && info?.nodeId && (
					<div className="field">
						<span className="field-label">Tor connection URI (share for inbound channels)</span>
						<CopyText value={`${info.nodeId}@${rec.onionAddress}`} />
						<span className="field-hint">
							Reachable over Tor. Give this to a peer so they can open a channel to you.
						</span>
					</div>
				)}
			</Card>

			<Card title="Connect to a peer">
				<Field label="Peer URI (pubkey@host:port)">
					<input value={uri} onChange={(e) => applyUri(e.target.value)} placeholder="02abc…@1.2.3.4:9735" />
				</Field>
				<div className="row">
					<Field label="Pubkey">
						<input value={pubkey} onChange={(e) => setPubkey(e.target.value)} placeholder="02…" />
					</Field>
					<Field label="Host">
						<input value={host} onChange={(e) => setHost(e.target.value)} />
					</Field>
					<Field label="Port">
						<input value={port} onChange={(e) => setPort(e.target.value)} style={{ maxWidth: 110 }} />
					</Field>
				</div>
				<Button variant="primary" busy={busy} onClick={connect} disabled={!pubkey || !host}>
					Connect
				</Button>
			</Card>

			<Card title="Connected peers" actions={<Button className="sm" onClick={refresh}>Refresh</Button>}>
				{!peers || peers.length === 0 ? (
					<div className="empty">No peers connected.</div>
				) : (
					<div className="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Pubkey</th>
									<th>Address</th>
									<th>State</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{peers.map((p) => (
									<tr key={p.pubkey}>
										<td className="mono" title={p.pubkey}>{shortId(p.pubkey)}</td>
										<td className="mono">{p.host}:{p.port}</td>
										<td>
											<Badge tone={p.state === 'connected' ? 'green' : 'yellow'}>{p.state}</Badge>
										</td>
										<td>
											<Button className="sm" onClick={() => disconnect(p.pubkey)}>
												Disconnect
											</Button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Card>
		</div>
	);
}
