import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { usePoll } from '../../hooks/usePoll.js';
import { useToast } from '../../components/Toast.jsx';
import { Button, Card, CopyText, Field, QR, Badge } from '../../components/ui.jsx';
import { fmtSats, shortId } from '../../lib/format.js';
import { buildBip21 } from '../../lib/payment-uri.js';
import { HOLD_MIN_FINAL_CLTV, INBOUND_HEADROOM_SATS, planInvoice } from '../../lib/lfbw.js';
import { manager } from '../../api.js';

// A direct-funding request is re-minted when the amount changes (the
// receiver signs the amount into it), after the hand has settled.
const FUNDING_DEBOUNCE_MS = 400;

export default function ReceiveTab({ id, api, rec, tick, lastReceive }) {
	const onchainOnly = !!rec?.onchainOnly;
	// A lightning-first wallet's on-chain request also carries a direct-funding
	// request, and its invoices are provisioned by the primary node just in
	// time when the home channel cannot take the amount as it stands.
	const isLfbw = !!rec?.lfbw?.enabled;
	const lfbwReady = isLfbw && rec.lfbw.setup === 'ready';
	const toast = useToast();
	const [funding, setFunding] = useState(null);
	const [jitInfo, setJitInfo] = useState(null);
	const [address, setAddress] = useState('');
	const [onchainAmount, setOnchainAmount] = useState('');
	const [onchainMessage, setOnchainMessage] = useState('');
	const [invoice, setInvoice] = useState(null);
	const [includeInvoice, setIncludeInvoice] = useState(true);
	const [amount, setAmount] = useState('');
	const [description, setDescription] = useState('');
	const [busy, setBusy] = useState(false);
	const { data: invoices, refresh } = usePoll(
		() => (onchainOnly ? Promise.resolve([]) : api.get('/invoices').catch(() => [])),
		10000,
		[id, tick, onchainOnly]
	);
	const { data: channels } = usePoll(
		() => (isLfbw ? api.get('/channels').catch(() => null) : Promise.resolve(null)),
		15000,
		[id, tick, isLfbw]
	);

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

	// The direct-funding request minted for this address and amount. Minted by
	// the daemon (the receiver signs it), with the wallet's reachable address
	// when it has one; without one, payers reach the wallet through the
	// primary's relay. A mint that fails leaves a plain request, which is what
	// the address is anyway.
	useEffect(() => {
		if (!lfbwReady || !address) {
			setFunding(null);
			return undefined;
		}
		let alive = true;
		const t = setTimeout(() => {
			const body = {};
			if (rec.reach) {
				body.host = rec.reach.host;
				body.port = rec.reach.port;
			}
			if (onchainSats > 0) body.amountSats = onchainSats;
			api
				.post('/direct-funding/request', body)
				.then((r) => alive && setFunding({ ...r, address, amountSats: onchainSats }))
				.catch(() => alive && setFunding(null));
		}, FUNDING_DEBOUNCE_MS);
		return () => {
			alive = false;
			clearTimeout(t);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [lfbwReady, address, onchainSats, rec?.reach?.host, rec?.reach?.port, api]);
	const carriesFunding =
		!!funding && funding.address === address && funding.amountSats === onchainSats && funding.expiresAt > Date.now();

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

	// Whether the invoice on screen has been paid, learned two ways: the page's
	// receive watcher hands settled hashes down the moment they settle, and the
	// invoice list below is polled anyway and marks it PAID within its interval
	// even when every event was missed. This is the moment the tab exists for.
	// Someone showing this QR across a table is watching this screen, not their
	// balance, and the payer's phone saying "sent" is the payer's wallet
	// talking; the receipt is ours to show.
	const paidInfo = useMemo(() => {
		if (!invoice) return null;
		if (
			lastReceive?.rail === 'lightning' &&
			lastReceive.paymentHash &&
			lastReceive.paymentHash === invoice.paymentHash
		) {
			return { amountSats: lastReceive.amountSats ?? invoice.amountSats ?? null };
		}
		const row = (invoices || []).find((i) => i.paymentHash === invoice.paymentHash);
		if (row && (row.status === 'PAID' || row.status === 'COMPLETED')) {
			return { amountSats: row.amountSats ?? invoice.amountSats ?? null };
		}
		return null;
	}, [invoice, invoices, lastReceive]);
	const paid = !!paidInfo;

	// A settled invoice cannot be paid again, so it has no place in a request
	// still being handed out.
	const carriesInvoice =
		!onchainOnly && !!invoice && !paid && includeInvoice && !invoiceConflicts;

	const request = useMemo(
		// `message` rather than `label`: BIP21 defines label as the recipient's own
		// name for themselves and message as the note to the payer, and a note to
		// the payer is what this field is for.
		() =>
			buildBip21({
				address,
				amountSats: onchainSats,
				message: trimmedMessage,
				lightning: carriesInvoice ? invoice.bolt11 : undefined,
				funding: carriesFunding ? funding.request : undefined
			}),
		[address, onchainSats, trimmedMessage, carriesInvoice, invoice, carriesFunding, funding]
	);
	const isRequest = request !== address;

	const createInvoice = async () => {
		setBusy(true);
		try {
			const body = { description };
			if (amount) body.amountSats = parseInt(amount, 10);
			let r;
			let jit = null;
			if (isLfbw) {
				// Provision inbound first when the home channel cannot take the
				// amount: the invoice is payable through a channel the primary
				// funds the moment the payment arrives (a zero-conf open, or a
				// splice of the home channel), minus the fee it quotes.
				const lf = rec.lfbw;
				let primaryRunning = true;
				if (lf.mode === 'internal' && lf.primaryWalletId) {
					primaryRunning = await manager
						.getWallet(lf.primaryWalletId)
						.then((w) => w.status === 'running')
						.catch(() => true);
				}
				const plan = planInvoice({
					wantedSats: body.amountSats || 0,
					channels: channels || (await api.get('/channels').catch(() => [])),
					primaryPubkey: lf.primaryPubkey,
					setup: lf.setup,
					primaryRunning
				});
				if (plan.kind === 'refuse') {
					throw new Error(
						plan.code === 'PRIMARY_DOWN'
							? 'Your primary node is not running, and this invoice needs it to provide inbound capacity. Start it, or ask for an amount the channel already covers.'
							: 'The link to your primary node is not set up yet. Retry setup from the Overview tab.'
					);
				}
				if (plan.kind === 'jit') {
					r = await api.post('/jit/invoice', {
						lspPubkey: lf.primaryPubkey,
						...(body.amountSats ? { amountSats: body.amountSats } : {}),
						description: body.description,
						targetRemainingInboundSat: INBOUND_HEADROOM_SATS
					});
					jit = { flatFeeSat: r.flatFeeSat || 0, feePpm: r.feePpm || 0 };
				} else if (plan.kind === 'hold') {
					// The channel exists but is short: a plain invoice with CLTV
					// headroom, so the primary can hold the payment while it
					// splices the home channel bigger rather than open a second.
					r = await api.post('/invoice/create', { ...body, minFinalCltvExpiry: HOLD_MIN_FINAL_CLTV });
					jit = { flatFeeSat: 0, feePpm: 0, hold: true };
				}
			}
			if (!r) r = await api.post('/invoice/create', body);
			setInvoice(r);
			setJitInfo(jit);
			toast(
				jit
					? jit.flatFeeSat > 0 || jit.feePpm > 0
						? `Invoice created. Your primary node provides the capacity when it is paid, for ${fmtSats(jit.flatFeeSat)}${jit.feePpm > 0 ? ` plus ${jit.feePpm} ppm` : ''}.`
						: 'Invoice created. Your primary node provides the capacity when it is paid.'
					: 'Invoice created',
				'success'
			);
			// The list below polls every ten seconds, which is a long time to look
			// at a table that does not yet have the invoice you just made in it.
			refresh();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className={onchainOnly ? undefined : 'grid cols-2'}>
			<Card
				title={isLfbw ? 'Deposit bitcoin' : 'On-chain'}
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
									: null,
								carriesFunding
									? 'It also carries a direct-funding request: a beignet wallet paying it funds your Lightning balance in one transaction, with no deposit to move afterwards.'
									: null
						  ]
								.filter(Boolean)
								.join(' ')}
					{isLfbw && !isRequest
						? ' Whatever lands here moves into your Lightning balance by itself once it confirms.'
						: ''}
				</div>
				{invoice && !paid && (
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

			{!onchainOnly && (
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
				<AnimatePresence mode="wait">
					{invoice && !paid && (
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
							{jitInfo && (
								<div className="field-hint" style={{ marginTop: 10 }} role="status">
									Payable now: your primary node provides the inbound capacity the moment this is paid
									{jitInfo.flatFeeSat > 0 || jitInfo.feePpm > 0
										? `, and takes ${fmtSats(jitInfo.flatFeeSat)}${jitInfo.feePpm > 0 ? ` plus ${jitInfo.feePpm} ppm` : ''} from the delivery for it.`
										: ', at no charge.'}
								</div>
							)}
						</m.div>
					)}
					{invoice && paid && (
						// The receipt takes the QR's place outright. A paid invoice
						// cannot be paid again, so leaving its code on screen invites
						// the one scan that is guaranteed to fail.
						<m.div
							key={`paid-${invoice.bolt11}`}
							className="paid-receipt"
							role="status"
							initial={{ opacity: 0, scale: 0.9 }}
							animate={{ opacity: 1, scale: 1 }}
						>
							<div className="paid-check" aria-hidden="true">
								✓
							</div>
							<div className="paid-title">Paid</div>
							<div className="wallet-meta">
								{paidInfo.amountSats != null
									? `${fmtSats(paidInfo.amountSats)} received over Lightning.`
									: 'Received over Lightning.'}
							</div>
						</m.div>
					)}
				</AnimatePresence>
			</Card>
			)}

			{!onchainOnly && (
				<Card title="Recent invoices" className="grid-full">
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
			)}
		</div>
	);
}
