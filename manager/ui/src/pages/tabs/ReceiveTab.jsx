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
	const [includeInvoice, setIncludeInvoice] = useState(true);
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
	const trimmedMessage = onchainMessage.trim();

	// A request can carry the invoice from the card beside it, which makes it one
	// thing to hand out that a payer can settle on either rail: the address for a
	// wallet that only reads BIP21, the invoice for one that would rather use
	// Lightning. That is the shape the Send tab has always been able to read, and
	// until now nothing here could write one.
	//
	// The two amounts have to agree. A payer's wallet is entitled to treat the
	// BIP21 amount as binding on both rails, and our own parser refuses a request
	// whose halves disagree rather than guess which was meant, so a request this
	// tab could mint and the Send tab would refuse is not one to mint. An
	// amountless invoice agrees with anything: it leaves the figure to the payer,
	// and the request supplies it.
	const invoiceConflicts =
		!!invoice && onchainSats > 0 && invoice.amountSats != null && invoice.amountSats !== onchainSats;
	const carriesInvoice = !!invoice && includeInvoice && !invoiceConflicts;

	const request = useMemo(
		// `message` rather than `label`: BIP21 defines label as the recipient's own
		// name for themselves and message as the note to the payer, and a note to
		// the payer is what this field is for.
		() =>
			buildBip21({
				address,
				amountSats: onchainSats,
				message: trimmedMessage,
				lightning: carriesInvoice ? invoice.bolt11 : undefined
			}),
		[address, onchainSats, trimmedMessage, carriesInvoice, invoice]
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
				{/* Built out of what is actually attached, sentence by sentence. Said
				    as one fixed paragraph it described the message field whether or
				    not anything had been typed into it, so an empty box showing its
				    "Coffee" placeholder read as though the placeholder were being
				    handed out, and the hint is the only thing explaining what is being
				    shared. */}
				<div className="field-hint" style={{ marginTop: 10 }}>
					{!isRequest
						? 'Nothing attached, so this is a plain address. Anyone can pay it any amount.'
						: [
								onchainSats > 0
									? `A wallet that scans this fills in ${fmtSats(onchainSats)} for the payer.`
									: null,
								trimmedMessage
									? 'The message travels with the request and is never written to the chain.'
									: null,
								carriesInvoice
									? 'It also carries the Lightning invoice below, so whoever scans it can settle on either rail.'
									: null
						  ]
								.filter(Boolean)
								.join(' ')}
				</div>
				{invoice && (
					<>
						<label className="checkbox field" style={{ marginTop: 10 }}>
							<input
								type="checkbox"
								checked={includeInvoice}
								disabled={invoiceConflicts}
								onChange={(e) => setIncludeInvoice(e.target.checked)}
							/>
							Carry the Lightning invoice in this request
						</label>
						{invoiceConflicts && (
							<div className="info-note">
								The invoice below asks for {fmtSats(invoice.amountSats)} and this request asks for{' '}
								{fmtSats(onchainSats)}. A payer's wallet reads the request's amount as binding on
								both rails, so the two have to agree before they can be handed out as one thing.
							</div>
						)}
					</>
				)}
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
