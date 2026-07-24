import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { usePoll } from '../../hooks/usePoll.js';
import { useToast } from '../../components/Toast.jsx';
import { Button, Card, CopyText, Field, QR, Badge } from '../../components/ui.jsx';
import { fmtSats, shortId } from '../../lib/format.js';
import { buildBip21 } from '../../lib/payment-uri.js';

export default function ReceiveTab({ id, api, tick }) {
	const toast = useToast();
	const [address, setAddress] = useState('');
	const [onchainAmount, setOnchainAmount] = useState('');
	const [onchainMessage, setOnchainMessage] = useState('');
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

	// An on-chain request is the address plus what is being asked for, written as
	// a BIP21 URI. It is derived here rather than fetched: the daemon can encode
	// one, but it mints a fresh address every time it is asked, and this changes
	// on every keystroke. With nothing attached it comes back as the bare
	// address, which is what should be shared when nothing is being asked for.
	const onchainSats = parseInt(onchainAmount, 10) || 0;
	const request = useMemo(
		// `message` rather than `label`: BIP21 defines label as the recipient's own
		// name for themselves and message as the note to the payer, and a note to
		// the payer is what this field is for.
		() => buildBip21({ address, amountSats: onchainSats, message: onchainMessage.trim() }),
		[address, onchainSats, onchainMessage]
	);
	const isRequest = request !== address;

	const createInvoice = async () => {
		setBusy(true);
		try {
			const body = { description };
			if (amount) body.amountSats = parseInt(amount, 10);
			const r = await api.post('/invoice/create', body);
			setInvoice(r);
			toast('Invoice created', 'success');
			// The list below polls every ten seconds, which is a long time to look
			// at a table that does not yet have the invoice you just made in it.
			refresh();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	const { data: invoices, refresh } = usePoll(() => api.get('/invoices').catch(() => []), 10000, [id, tick]);

	return (
		<div className="grid cols-2">
			<Card
				title="On-chain"
				actions={
					<Button className="sm" onClick={newAddress}>
						New address
					</Button>
				}
			>
				<div className="row">
					<Field label="Amount (sats, optional)">
						<input
							value={onchainAmount}
							onChange={(e) => setOnchainAmount(e.target.value.replace(/[^0-9]/g, ''))}
							placeholder="any amount"
						/>
					</Field>
				</div>
				<Field label="Message (optional)">
					<input
						value={onchainMessage}
						onChange={(e) => setOnchainMessage(e.target.value)}
						placeholder="Coffee"
					/>
				</Field>
				<div style={{ textAlign: 'center' }}>
					<QR value={request} />
				</div>
				<div style={{ marginTop: 12, textAlign: 'center' }}>
					<CopyText value={request} truncate={isRequest} />
				</div>
				<div className="field-hint" style={{ marginTop: 10 }}>
					{isRequest
						? `A wallet that scans this fills in ${
								onchainSats > 0 ? fmtSats(onchainSats) : 'the details'
						  } for the payer. The message travels with the request and is never written to the chain.`
						: 'Nothing attached, so this is a plain address. Anyone can pay it any amount.'}
				</div>
			</Card>

			<Card title="Lightning invoice">
				<div className="row">
					<Field label="Amount (sats, optional)">
						<input
							value={amount}
							onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
							placeholder="any amount"
						/>
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
							<div style={{ marginTop: 12 }}>
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
									<th>Invoice</th>
									<th>Status</th>
								</tr>
							</thead>
							<tbody>
								{invoices.slice(0, 20).map((inv) => (
									<tr key={inv.paymentHash}>
										<td>{inv.amountSats ? fmtSats(inv.amountSats) : 'any'}</td>
										<td>{inv.description || '-'}</td>
										{/* The invoice itself rather than its hash: an invoice you cannot
										    hand out again is of no use to anyone, and the hash never was. */}
										<td>
											{inv.bolt11 ? (
												<CopyText value={inv.bolt11} label={shortId(inv.bolt11)} />
											) : (
												<span className="mono">{shortId(inv.paymentHash)}</span>
											)}
										</td>
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
