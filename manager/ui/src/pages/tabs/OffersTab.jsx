import { useMemo, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { usePoll } from '../../hooks/usePoll.js';
import { useToast } from '../../components/Toast.jsx';
import { Button, Card, CopyText, Field, Modal, QR } from '../../components/ui.jsx';
import { fmtSats, shortId } from '../../lib/format.js';
import { parsePayment } from '../../lib/payment-uri.js';
import { useSettledRefusal } from '../../hooks/useSettledRefusal.js';

export default function OffersTab({ id, api, tick, bump }) {
	const toast = useToast();
	const { data: offers, refresh } = usePoll(() => api.get('/offers').catch(() => []), 12000, [id, tick]);

	const [description, setDescription] = useState('');
	const [amount, setAmount] = useState('');
	const [creating, setCreating] = useState(false);
	// The create response is the one place the daemon is guaranteed to hand
	// over the encoded offer: daemons through 0.7.5 omit it from /offers, so a
	// toast-and-clear here left no way to see or copy what was just made.
	const [created, setCreated] = useState(null);

	const [payStr, setPayStr] = useState('');
	const [payAmount, setPayAmount] = useState('');
	const [paying, setPaying] = useState(false);
	const [focused, setFocused] = useState(false);
	// The offer a delete has been asked for and not yet confirmed. Deleting is
	// asked about rather than done on the click, because an offer is a code other
	// people hold: what it costs is not this row disappearing, it is every saved
	// copy of it becoming unpayable, and that is not visible from here.
	const [deleting, setDeleting] = useState(null);
	const [removing, setRemoving] = useState(false);

	// An offer arrives the same way every other payment string does: out of a chat
	// window with the scheme still on it, off a QR code in capitals, wrapped in the
	// punctuation of the sentence it was copied from. This is the one tab the Send
	// card explicitly sends people to, so it is the one that most has to understand
	// what it is handed.
	const parsed = useMemo(() => parsePayment(payStr), [payStr]);
	const offer = parsed.kind === 'bolt12' ? parsed.offer : null;
	const mayRefuse = useSettledRefusal(payStr, focused);
	// What this tab pays is an offer. Anything else the parser can name, it names,
	// and a bolt11 belongs on the Send tab rather than here.
	const refusal =
		offer || parsed.kind === 'empty' || !mayRefuse
			? null
			: parsed.kind === 'invalid'
			? parsed.message
			: parsed.kind === 'bolt11'
			? 'That is a Lightning invoice rather than an offer. Pay it from the Send tab.'
			: 'That is not a BOLT12 offer. An offer starts with lno1.';

	const create = async () => {
		setCreating(true);
		try {
			const body = { description };
			if (amount) body.amountSats = parseInt(amount, 10);
			const r = await api.post('/offer/create', body);
			setCreated(r && r.encoded ? r : null);
			toast('Offer created', 'success');
			setDescription('');
			setAmount('');
			refresh();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setCreating(false);
		}
	};

	const pay = async () => {
		setPaying(true);
		try {
			// The offer the parser settled on, with the lightning: scheme stripped and
			// the capitals folded back down, rather than the raw box.
			const body = { offer };
			if (payAmount) body.amountSats = parseInt(payAmount, 10);
			const r = await api.post('/offer/pay', body);
			toast(r.status === 'COMPLETED' ? 'Offer paid' : `Payment ${r.status}`, r.status === 'COMPLETED' ? 'success' : 'error');
			bump();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setPaying(false);
		}
	};

	// Removal is by offer id in the query string, which is the daemon's contract
	// (DELETE /offer?offerId=...). Requires beignet 0.8.0; older daemons answer
	// 404 and the refusal is surfaced as-is rather than guessed at.
	const remove = async () => {
		setRemoving(true);
		try {
			await api.del(`/offer?offerId=${encodeURIComponent(deleting.offerId)}`);
			// The created-offer panel is showing the same offer often enough that
			// leaving it up after the delete would keep a QR on screen for a code
			// the daemon has just stopped answering for.
			if (created && created.offerId === deleting.offerId) setCreated(null);
			toast('Offer deleted', 'success');
			setDeleting(null);
			refresh();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setRemoving(false);
		}
	};

	return (
		<div>
			<div className="info-note">BOLT12 offers are reusable payment codes. Share one to receive repeat payments.</div>
			<div className="grid cols-2">
				<Card title="Create an offer">
					<Field label="Description">
						<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Donations" />
					</Field>
					<Field label="Amount (sats, optional)">
						<input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="any amount" />
					</Field>
					<Button variant="primary" busy={creating} onClick={create} disabled={!description}>
						Create offer
					</Button>
					<AnimatePresence>
						{created && (
							<m.div
								key={created.encoded}
								style={{ textAlign: 'center', marginTop: 16 }}
								initial={{ opacity: 0, scale: 0.92, y: 8 }}
								animate={{ opacity: 1, scale: 1, y: 0 }}
								exit={{ opacity: 0, scale: 0.96 }}
							>
								<QR value={created.encoded} />
								<div style={{ marginTop: 12 }}>
									<CopyText value={created.encoded} truncate />
								</div>
							</m.div>
						)}
					</AnimatePresence>
				</Card>

				<Card title="Pay an offer">
					<Field label="Offer (lno…)">
						<textarea
							rows={3}
							value={payStr}
							onChange={(e) => setPayStr(e.target.value)}
							onFocus={() => setFocused(true)}
							onBlur={() => setFocused(false)}
							placeholder="lno…"
						/>
					</Field>
					{refusal && <div className="error-note">{refusal}</div>}
					<Field label="Amount (sats, if offer has none)">
						<input value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
					</Field>
					<Button variant="primary" busy={paying} onClick={pay} disabled={!offer}>
						Pay offer
					</Button>
				</Card>
			</div>

			<Card title="Your offers" actions={<Button className="sm" onClick={refresh}>Refresh</Button>}>
				{!offers || offers.length === 0 ? (
					<div className="empty">No offers yet.</div>
				) : (
					<div className="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Description</th>
									<th>Amount</th>
									<th>Offer</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{offers.map((o) => (
									<tr key={o.offerId}>
										<td>{o.description || '-'}</td>
										<td>{o.amountSats ? fmtSats(o.amountSats) : 'any'}</td>
										<td>{o.encoded ? <CopyText value={o.encoded} truncate /> : shortId(o.offerId)}</td>
										<td>
											<Button
												className="sm"
												onClick={(e) => setDeleting({ ...o, origin: e.currentTarget })}
											>
												Delete
											</Button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Card>

			{deleting && (
				<Modal title="Delete offer" onClose={() => setDeleting(null)} origin={deleting.origin}>
					<p className="wallet-meta">
						Delete{' '}
						{deleting.description ? (
							<strong>{deleting.description}</strong>
						) : (
							<span className="mono">{shortId(deleting.offerId)}</span>
						)}
						? This node stops answering for it, so anyone who saved the code can no
						longer pay it. Payments already made are unaffected, and nothing about
						this deletes them.
					</p>
					<p className="wallet-meta">
						An offer cannot be restored by making another one: a new offer is a
						different code.
					</p>
					<div className="center-actions">
						<Button variant="danger" busy={removing} onClick={remove}>
							Delete offer
						</Button>
						<Button onClick={() => setDeleting(null)}>Cancel</Button>
					</div>
				</Modal>
			)}
		</div>
	);
}
