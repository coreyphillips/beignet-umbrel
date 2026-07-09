import { useEffect, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { usePoll } from '../../hooks/usePoll.js';
import { useToast } from '../../components/Toast.jsx';
import { Button, Card, CopyText, Field, QR, Badge } from '../../components/ui.jsx';
import { fmtSats, shortId } from '../../lib/format.js';

export default function ReceiveTab({ id, api, tick }) {
	const toast = useToast();
	const [address, setAddress] = useState('');
	const [invoice, setInvoice] = useState(null);
	const [amount, setAmount] = useState('');
	const [description, setDescription] = useState('');
	const [busy, setBusy] = useState(false);

	const newAddress = async () => {
		try {
			const r = await api.post('/address/new', {});
			setAddress(r.address);
		} catch (e) {
			toast(e.message, 'error');
		}
	};

	useEffect(() => {
		newAddress();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [id]);

	const createInvoice = async () => {
		setBusy(true);
		try {
			const body = { description };
			if (amount) body.amountSats = parseInt(amount, 10);
			const r = await api.post('/invoice/create', body);
			setInvoice(r);
			toast('Invoice created', 'success');
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	const { data: invoices } = usePoll(() => api.get('/invoices').catch(() => []), 10000, [id, tick]);

	return (
		<div className="grid cols-2">
			<Card title="On-chain address" actions={<Button className="sm" onClick={newAddress}>New</Button>}>
				<div style={{ textAlign: 'center' }}>
					<QR value={address} />
				</div>
				<div style={{ marginTop: 12 }}>
					<CopyText value={address} />
				</div>
			</Card>

			<Card title="Lightning invoice">
				<div className="row">
					<Field label="Amount (sats, optional)">
						<input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="any amount" />
					</Field>
				</div>
				<Field label="Description">
					<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Coffee" />
				</Field>
				<Button variant="primary" busy={busy} onClick={createInvoice}>
					Create invoice
				</Button>
				<AnimatePresence>
					{invoice && (
						<m.div
							key={invoice.bolt11}
							style={{ textAlign: 'center', marginTop: 16 }}
							initial={{ opacity: 0, scale: 0.92, y: 8 }}
							animate={{ opacity: 1, scale: 1, y: 0 }}
							exit={{ opacity: 0, scale: 0.96 }}
						>
							<QR value={invoice.bolt11} />
							<div style={{ marginTop: 12, textAlign: 'left' }}>
								<CopyText value={invoice.bolt11} truncate />
							</div>
						</m.div>
					)}
				</AnimatePresence>
			</Card>

			<Card title="Recent invoices" className="grid-full" >
				{!invoices || invoices.length === 0 ? (
					<div className="empty">No invoices yet.</div>
				) : (
					<div className="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Amount</th>
									<th>Description</th>
									<th>Hash</th>
									<th>Status</th>
								</tr>
							</thead>
							<tbody>
								{invoices.slice(0, 20).map((inv) => (
									<tr key={inv.paymentHash}>
										<td>{inv.amountSats ? fmtSats(inv.amountSats) : 'any'}</td>
										<td>{inv.description || '-'}</td>
										<td className="mono">{shortId(inv.paymentHash)}</td>
										<td>
											<Badge tone={inv.status === 'PAID' || inv.status === 'COMPLETED' ? 'green' : 'muted'}>
												{inv.status || 'open'}
											</Badge>
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
