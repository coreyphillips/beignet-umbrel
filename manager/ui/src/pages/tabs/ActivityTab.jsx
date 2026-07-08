import { useState } from 'react';
import { usePoll } from '../../hooks/usePoll.js';
import { Badge, Card, CopyText } from '../../components/ui.jsx';
import { fmtDate, fmtSats, shortId } from '../../lib/format.js';

const STATUS_TONE = { COMPLETED: 'green', PENDING: 'yellow', FAILED: 'red' };

export default function ActivityTab({ id, api, info, tick }) {
	const [tab, setTab] = useState('onchain');
	const tipHeight = info?.blockHeight || 0;

	const { data } = usePoll(
		async () => {
			const [txs, payments, utxos] = await Promise.all([
				api.get('/transactions').catch(() => []),
				api.get('/payments').catch(() => []),
				api.get('/utxos').catch(() => [])
			]);
			return { txs, payments, utxos };
		},
		8000,
		[id, tick]
	);

	return (
		<div>
			<div className="pills">
				<button className={`pill ${tab === 'onchain' ? 'active' : ''}`} onClick={() => setTab('onchain')}>
					On-chain
				</button>
				<button className={`pill ${tab === 'lightning' ? 'active' : ''}`} onClick={() => setTab('lightning')}>
					Lightning
				</button>
				<button className={`pill ${tab === 'utxos' ? 'active' : ''}`} onClick={() => setTab('utxos')}>
					Coins
				</button>
			</div>

			{tab === 'onchain' && (
				<Card title="On-chain transactions">
					{!data?.txs || data.txs.length === 0 ? (
						<div className="empty">No on-chain transactions yet.</div>
					) : (
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th>Type</th>
										<th>Amount</th>
										<th>Fee</th>
										<th>Confirmations</th>
										<th>Txid</th>
										<th>When</th>
									</tr>
								</thead>
								<tbody>
									{data.txs.map((t) => (
										<tr key={t.txid}>
											<td>
												<Badge tone={t.type === 'received' ? 'green' : 'blue'}>{t.type}</Badge>
											</td>
											<td>{fmtSats(Math.abs(t.valueSats))}</td>
											<td>{t.feeSats != null ? fmtSats(t.feeSats) : '-'}</td>
											<td>
												{t.confirmed ? (
													<Badge tone="green">{Math.max(1, tipHeight - t.height + 1)}</Badge>
												) : (
													<Badge tone="yellow">pending</Badge>
												)}
											</td>
											<td className="mono" title={t.txid}>{shortId(t.txid)}</td>
											<td className="wallet-meta">{fmtDate(t.confirmTimestamp || t.timestamp)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</Card>
			)}

			{tab === 'lightning' && (
				<Card title="Lightning payments">
					{!data?.payments || data.payments.length === 0 ? (
						<div className="empty">No Lightning payments yet.</div>
					) : (
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th>Direction</th>
										<th>Amount</th>
										<th>Fee</th>
										<th>Status</th>
										<th>Hash</th>
										<th>When</th>
									</tr>
								</thead>
								<tbody>
									{data.payments.slice(0, 50).map((p) => (
										<tr key={p.paymentHash + p.createdAt}>
											<td>
												<Badge tone={p.direction === 'INCOMING' ? 'green' : 'blue'}>
													{p.direction === 'INCOMING' ? 'received' : 'sent'}
												</Badge>
											</td>
											<td>{fmtSats(p.amountSats)}</td>
											<td>{p.feeSats != null ? fmtSats(p.feeSats) : '-'}</td>
											<td>
												<Badge tone={STATUS_TONE[p.status] || 'muted'}>{p.status}</Badge>
											</td>
											<td className="mono" title={p.paymentHash}>{shortId(p.paymentHash)}</td>
											<td className="wallet-meta">{fmtDate(p.completedAt || p.createdAt)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</Card>
			)}

			{tab === 'utxos' && (
				<Card title="Unspent outputs">
					{!data?.utxos || data.utxos.length === 0 ? (
						<div className="empty">No unspent outputs.</div>
					) : (
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th>Outpoint</th>
										<th>Address</th>
										<th>Amount</th>
										<th>Height</th>
									</tr>
								</thead>
								<tbody>
									{data.utxos.map((u) => (
										<tr key={`${u.txid}:${u.vout}`}>
											<td className="mono" title={`${u.txid}:${u.vout}`}>
												{shortId(u.txid)}:{u.vout}
											</td>
											<td>
												<CopyText value={u.address} truncate />
											</td>
											<td>{fmtSats(u.valueSats)}</td>
											<td className="wallet-meta">{u.height || 'unconfirmed'}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</Card>
			)}
		</div>
	);
}
