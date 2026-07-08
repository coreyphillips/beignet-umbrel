import { useState } from 'react';
import { usePoll } from '../../hooks/usePoll.js';
import { useToast } from '../../components/Toast.jsx';
import { Button, Card, CopyText, Field } from '../../components/ui.jsx';
import { fmtSats, shortId } from '../../lib/format.js';

export default function OffersTab({ id, api, tick, bump }) {
	const toast = useToast();
	const { data: offers, refresh } = usePoll(() => api.get('/offers').catch(() => []), 12000, [id, tick]);

	const [description, setDescription] = useState('');
	const [amount, setAmount] = useState('');
	const [creating, setCreating] = useState(false);

	const [payStr, setPayStr] = useState('');
	const [payAmount, setPayAmount] = useState('');
	const [paying, setPaying] = useState(false);

	const create = async () => {
		setCreating(true);
		try {
			const body = { description };
			if (amount) body.amountSats = parseInt(amount, 10);
			await api.post('/offer/create', body);
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
			const body = { offer: payStr.trim() };
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
				</Card>

				<Card title="Pay an offer">
					<Field label="Offer (lno…)">
						<textarea rows={3} value={payStr} onChange={(e) => setPayStr(e.target.value)} placeholder="lno…" />
					</Field>
					<Field label="Amount (sats, if offer has none)">
						<input value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
					</Field>
					<Button variant="primary" busy={paying} onClick={pay} disabled={!payStr}>
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
								</tr>
							</thead>
							<tbody>
								{offers.map((o) => (
									<tr key={o.offerId}>
										<td>{o.description || '-'}</td>
										<td>{o.amountSats ? fmtSats(o.amountSats) : 'any'}</td>
										<td>{o.encoded ? <CopyText value={o.encoded} truncate /> : shortId(o.offerId)}</td>
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
