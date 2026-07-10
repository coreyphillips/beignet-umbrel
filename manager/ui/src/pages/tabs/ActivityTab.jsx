import { useState } from 'react';
import { usePoll } from '../../hooks/usePoll.js';
import { useToast } from '../../components/Toast.jsx';
import { Badge, Button, Card, CopyText, Field, Modal, Segmented } from '../../components/ui.jsx';
import { fmtDate, fmtSats, shortId } from '../../lib/format.js';

const STATUS_TONE = { COMPLETED: 'green', PENDING: 'yellow', FAILED: 'red' };

export default function ActivityTab({ id, api, info, tick, bump }) {
	const [tab, setTab] = useState('onchain');
	const [bumping, setBumping] = useState(null);
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
	const { data: boostable } = usePoll(
		() => api.get('/transactions/boostable').catch(() => null),
		8000,
		[id, tick]
	);
	// txid -> 'rbf' | 'cpfp' (rbf wins when a tx appears in both lists)
	const boostMethod = {};
	for (const t of boostable?.cpfp || []) boostMethod[t.txid] = 'cpfp';
	for (const t of boostable?.rbf || []) boostMethod[t.txid] = 'rbf';

	return (
		<div>
			<Segmented
				id="activity-view"
				value={tab}
				onChange={setTab}
				options={[
					['onchain', 'On-chain'],
					['lightning', 'Lightning'],
					['utxos', 'Coins']
				]}
			/>

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
										<th></th>
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
											<td>
												{!t.confirmed && boostMethod[t.txid] && (
													<button
														type="button"
														className="btn sm"
														onClick={() => setBumping({ tx: t, method: boostMethod[t.txid] })}
													>
														Bump fee
													</button>
												)}
											</td>
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

			{bumping && (
				<BumpFeeModal
					api={api}
					tx={bumping.tx}
					method={bumping.method}
					onClose={() => setBumping(null)}
					onDone={() => {
						setBumping(null);
						bump?.();
					}}
				/>
			)}
		</div>
	);
}

function BumpFeeModal({ api, tx, method, onClose, onDone }) {
	const toast = useToast();
	const [feeRate, setFeeRate] = useState('');
	const [busy, setBusy] = useState(false);
	const { data: fees } = usePoll(() => api.get('/fees/estimates').catch(() => null), 30000, []);

	const boost = async () => {
		setBusy(true);
		try {
			const body = { txid: tx.txid };
			const rate = parseInt(feeRate, 10);
			if (rate > 0) body.satsPerVbyte = rate;
			const r = await api.post('/tx/boost', body);
			toast(
				`Fee bumped via ${r.boostType === 'cpfp' ? 'CPFP' : 'RBF'} · new fee ${fmtSats(r.feeSats)}`,
				'success'
			);
			onDone();
		} catch (e) {
			toast(e.message, 'error');
			setBusy(false);
		}
	};

	return (
		<Modal title="Bump transaction fee" onClose={onClose}>
			<table style={{ marginBottom: 14 }}>
				<tbody>
					<tr>
						<td className="wallet-meta">Transaction</td>
						<td className="mono">{shortId(tx.txid)}</td>
					</tr>
					<tr>
						<td className="wallet-meta">Amount</td>
						<td>{fmtSats(Math.abs(tx.valueSats))}</td>
					</tr>
					<tr>
						<td className="wallet-meta">Current fee</td>
						<td>{tx.feeSats != null ? fmtSats(tx.feeSats) : 'unknown'}</td>
					</tr>
				</tbody>
			</table>
			<Field
				label="New fee rate (sat/vB, optional)"
				hint={
					method === 'cpfp'
						? 'This transaction cannot be replaced, so a child transaction will spend its output at a higher fee (CPFP).'
						: 'The transaction will be replaced with a higher-fee version (RBF). Leave blank to let the wallet pick a rate.'
				}
			>
				<input value={feeRate} onChange={(e) => setFeeRate(e.target.value)} placeholder="auto" />
			</Field>
			{fees && (
				<div className="preset-row" style={{ marginBottom: 14 }}>
					{[
						['Fast', fees.fast],
						['Normal', fees.normal],
						['Slow', fees.slow]
					].map(([label, rate]) => (
						<button key={label} type="button" className="btn sm" onClick={() => setFeeRate(String(rate))}>
							{label} · {rate} sat/vB
						</button>
					))}
				</div>
			)}
			<div className="center-actions">
				<Button onClick={onClose}>Cancel</Button>
				<Button variant="primary" busy={busy} onClick={boost}>
					Bump fee
				</Button>
			</div>
		</Modal>
	);
}
