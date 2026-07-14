import { useState } from 'react';
import { usePoll } from '../../hooks/usePoll.js';
import { useToast } from '../../components/Toast.jsx';
import {
	Badge,
	Button,
	Card,
	CopyText,
	DetailRow,
	ExplorerLink,
	Field,
	Modal,
	Segmented
} from '../../components/ui.jsx';
import { fmtDate, fmtSats, shortId } from '../../lib/format.js';
import { addressUrl, txUrl } from '../../lib/explorer.js';

const STATUS_TONE = { COMPLETED: 'green', PENDING: 'yellow', FAILED: 'red' };

const confirmations = (tx, tipHeight) =>
	tx.confirmed && tx.height ? Math.max(1, tipHeight - tx.height + 1) : 0;

export default function ActivityTab({ id, api, info, rec, tick, bump }) {
	const [tab, setTab] = useState('onchain');
	const [bumping, setBumping] = useState(null);
	// The row the user opened, if any. Every list here is a summary of something
	// with more to it than the columns can hold.
	const [detail, setDetail] = useState(null);
	const tipHeight = info?.blockHeight || 0;
	const network = rec?.network || info?.network;

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
										<tr
											key={t.txid}
											className="row-clickable"
											onClick={() => setDetail({ kind: 'tx', item: t })}
										>
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
														// The row opens the details; this button does its own job.
														onClick={(e) => {
															e.stopPropagation();
															setBumping({ tx: t, method: boostMethod[t.txid] });
														}}
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
										<tr
											key={p.paymentHash + p.createdAt}
											className="row-clickable"
											onClick={() => setDetail({ kind: 'payment', item: p })}
										>
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
										<tr
											key={`${u.txid}:${u.vout}`}
											className="row-clickable"
											onClick={() => setDetail({ kind: 'utxo', item: u })}
										>
											<td className="mono" title={`${u.txid}:${u.vout}`}>
												{shortId(u.txid)}:{u.vout}
											</td>
											{/* Plain text, not a copy button. A copy button here would sit in
											    the middle of a row whose job is to open the coin, so most clicks
											    aimed at the row would copy instead. The detail view has copy for
											    the address, the outpoint and the transaction id. */}
											<td className="mono trunc-cell" title={u.address}>
												{u.address}
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

			{detail && (
				<DetailModal
					detail={detail}
					network={network}
					tipHeight={tipHeight}
					onClose={() => setDetail(null)}
				/>
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

function DetailModal({ detail, network, tipHeight, onClose }) {
	const { kind, item } = detail;
	const title =
		kind === 'tx' ? 'Transaction' : kind === 'payment' ? 'Lightning payment' : 'Coin';
	return (
		// The modal already carries a Close in its header; a second one at the foot
		// is just a second thing to read.
		<Modal title={title} onClose={onClose} wide>
			{kind === 'tx' && <TxDetail tx={item} network={network} tipHeight={tipHeight} />}
			{kind === 'payment' && <PaymentDetail payment={item} />}
			{kind === 'utxo' && <UtxoDetail utxo={item} network={network} />}
		</Modal>
	);
}

function TxDetail({ tx, network, tipHeight }) {
	const confs = confirmations(tx, tipHeight);
	const url = txUrl(network, tx.txid);
	return (
		<div className="detail">
			<DetailRow label="Type">
				<Badge tone={tx.type === 'received' ? 'green' : 'blue'}>{tx.type}</Badge>
			</DetailRow>
			<DetailRow label="Amount">{fmtSats(Math.abs(tx.valueSats))}</DetailRow>
			<DetailRow label="Fee">
				{tx.feeSats != null ? fmtSats(tx.feeSats) : 'not known for a received transaction'}
				{/* The rate is in the wallet's own record of the transaction and was
				    never shown anywhere: it is the number that decides how long a
				    pending transaction sits there. */}
				{tx.feeSats != null && tx.satsPerVbyte ? ` at ${tx.satsPerVbyte} sat/vB` : ''}
			</DetailRow>
			<DetailRow label="Status">
				{tx.confirmed ? (
					<>
						<Badge tone="green">{confs} confirmation{confs === 1 ? '' : 's'}</Badge>
						{tx.height ? <span className="wallet-meta"> in block {tx.height}</span> : null}
					</>
				) : (
					<Badge tone="yellow">pending, waiting for a block</Badge>
				)}
			</DetailRow>
			{tx.address && (
				<DetailRow label={tx.type === 'received' ? 'Received at' : 'Sent to'}>
					<CopyText value={tx.address} />
					<ExplorerLink url={addressUrl(network, tx.address)}>View address</ExplorerLink>
				</DetailRow>
			)}
			<DetailRow label="Transaction id">
				<CopyText value={tx.txid} />
				<ExplorerLink url={url}>View on mempool.space</ExplorerLink>
			</DetailRow>
			<DetailRow label="First seen">{fmtDate(tx.timestamp)}</DetailRow>
			{tx.confirmTimestamp && (
				<DetailRow label="Confirmed">{fmtDate(tx.confirmTimestamp)}</DetailRow>
			)}
			{!url && (
				<div className="field-hint">
					This wallet is on {network}, which no public explorer can see, so there is nothing
					to link to.
				</div>
			)}
			{url && (
				<div className="field-hint">
					Opening the explorer tells mempool.space which transaction you are looking at.
					Nothing is sent there unless you click.
				</div>
			)}
		</div>
	);
}

function PaymentDetail({ payment: p }) {
	const failed = p.status === 'FAILED';
	const hops = p.route?.hops || p.route?.totalHops || null;
	return (
		<div className="detail">
			<DetailRow label="Direction">
				<Badge tone={p.direction === 'INCOMING' ? 'green' : 'blue'}>
					{p.direction === 'INCOMING' ? 'received' : 'sent'}
				</Badge>
			</DetailRow>
			<DetailRow label="Amount">{fmtSats(p.amountSats)}</DetailRow>
			<DetailRow label="Routing fee">
				{p.feeSats != null ? fmtSats(p.feeSats) : '-'}
			</DetailRow>
			<DetailRow label="Status">
				<Badge tone={STATUS_TONE[p.status] || 'muted'}>{p.status}</Badge>
			</DetailRow>

			{/* A failed payment knows why it failed. The list said only "FAILED",
			    which is the least useful half of what the wallet has. */}
			{failed && (p.failureDescription || p.failureCode != null) && (
				<div className="error-note" style={{ marginBottom: 12 }}>
					{p.failureDescription || 'The payment failed.'}
					{p.failureCode != null && (
						<div className="wallet-meta" style={{ marginTop: 4 }}>
							Failure code {p.failureCode}
						</div>
					)}
				</div>
			)}

			<DetailRow label="Payment hash">
				<CopyText value={p.paymentHash} />
			</DetailRow>
			{p.preimage && (
				<DetailRow label="Preimage">
					<CopyText value={p.preimage} />
					<span className="field-hint">
						Proof this payment was made. Whoever holds it can prove the invoice was paid.
					</span>
				</DetailRow>
			)}
			{hops != null && <DetailRow label="Route">{hops} hops</DetailRow>}
			<DetailRow label="Started">{fmtDate(p.createdAt)}</DetailRow>
			{p.completedAt && <DetailRow label="Finished">{fmtDate(p.completedAt)}</DetailRow>}
		</div>
	);
}

function UtxoDetail({ utxo: u, network }) {
	return (
		<div className="detail">
			<DetailRow label="Amount">{fmtSats(u.valueSats)}</DetailRow>
			<DetailRow label="Status">
				{u.height ? (
					<>
						<Badge tone="green">confirmed</Badge>
						<span className="wallet-meta"> in block {u.height}</span>
					</>
				) : (
					<Badge tone="yellow">unconfirmed</Badge>
				)}
			</DetailRow>
			<DetailRow label="Address">
				<CopyText value={u.address} />
				<ExplorerLink url={addressUrl(network, u.address)}>View address</ExplorerLink>
			</DetailRow>
			<DetailRow label="Outpoint">
				<CopyText value={`${u.txid}:${u.vout}`} />
			</DetailRow>
			<DetailRow label="Transaction id">
				<CopyText value={u.txid} />
				<ExplorerLink url={txUrl(network, u.txid)}>View on mempool.space</ExplorerLink>
			</DetailRow>
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
