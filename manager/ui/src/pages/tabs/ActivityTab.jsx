import { useState } from 'react';
import { usePoll } from '../../hooks/usePoll.js';
import { Badge, Card } from '../../components/ui.jsx';
import { fmtDate, fmtSats, shortId } from '../../lib/format.js';

const STATUS_TONE = { COMPLETED: 'green', PENDING: 'yellow', FAILED: 'red' };

export default function ActivityTab({ id, api, tick }) {
	const [dir, setDir] = useState('');
	const { data: payments } = usePoll(
		() => api.get(`/payments${dir ? `?direction=${dir}` : ''}`).catch(() => []),
		8000,
		[id, tick, dir]
	);

	return (
		<div>
			<div className="info-note">
				Activity shows Lightning payments. The beignet daemon does not expose on-chain transaction
				history yet, so on-chain sends/receives are reflected in balances only.
			</div>
			<Card
				title="Lightning payments"
				actions={
					<select value={dir} onChange={(e) => setDir(e.target.value)} style={{ width: 160 }}>
						<option value="">All</option>
						<option value="OUTGOING">Sent</option>
						<option value="INCOMING">Received</option>
					</select>
				}
			>
				{!payments || payments.length === 0 ? (
					<div className="empty">No payments yet.</div>
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
								{payments.slice(0, 50).map((p) => (
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
		</div>
	);
}
