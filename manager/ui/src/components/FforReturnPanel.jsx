import { useState } from 'react';
import { Button, Modal } from './ui.jsx';
import { useToast } from './Toast.jsx';
import { describeReturn } from '../lib/ffor.js';
import { manager } from '../api.js';

// A return a session has seen and put away stays away: the stamp of the last
// dismissed return per wallet, so a reload does not bring it back.
const KEY = (id) => `beignet-ffor-return-${id}`;
function readDismissed(id) {
	try {
		return Number(sessionStorage.getItem(KEY(id))) || 0;
	} catch (_) {
		return 0;
	}
}

/**
 * The return half of an offline receive, said above the tabs whatever page
 * the owner came in through: what the manager's reconcile with the
 * settlement peer produced after this start, and the two things left to do
 * when it produced nothing (retry when the peer is back, or enforce the
 * epoch on-chain). Also raised when the daemon reports a peer contradicting
 * an ACTIVE epoch at reconnect (ffor:enforce), which only enforcing answers.
 */
export default function FforReturnPanel({ id, api, rec, onChanged }) {
	const toast = useToast();
	const [dismissed, setDismissed] = useState(() => readDismissed(id));
	const [busy, setBusy] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const ret = rec?.fforReturn && (rec.fforReturn.at || 0) > dismissed ? describeReturn(rec.fforReturn) : null;
	const enforce = rec?.fforEnforce || null;
	if (!ret && !enforce) return null;
	const channelId = (enforce && enforce.channelId) || (ret && ret.channelId) || null;

	const dismiss = () => {
		const at = rec?.fforReturn?.at || Date.now();
		setDismissed(at);
		try {
			sessionStorage.setItem(KEY(id), String(at));
		} catch (_) {
			/* no storage, no memory */
		}
	};
	const retry = async () => {
		setBusy(true);
		try {
			await manager.fforReturn(id, { channelId });
			toast('Reconciled with the settlement peer', 'success');
			onChanged?.();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};
	const doEnforce = async () => {
		setBusy(true);
		try {
			const r = await api.post('/ffor/enforce', { channelId });
			toast(`Force close broadcast${r?.commitmentTxid ? ` (${String(r.commitmentTxid).slice(0, 12)}…)` : ''}`, 'success');
			setConfirming(false);
			onChanged?.();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	const tone = enforce ? 'red' : ret.tone;
	const className = tone === 'red' ? 'error-note' : 'info-note';
	const title = enforce ? 'Your settlement peer contradicted the offline-receive epoch' : ret.title;
	const detail = enforce
		? 'At reconnect the peer reported a different epoch than this wallet holds. Payments made to your vouchers can still be claimed on-chain: enforcing force-closes the channel with every known preimage.'
		: ret.detail;
	const offersEnforce = enforce || (ret && (ret.action === 'nothing' || ret.state === 'ACTIVE'));
	const offersRetry = !enforce && ret && ret.action === 'nothing';
	return (
		<div className={className} style={{ gridColumn: '1 / -1', marginBottom: 14 }} data-testid="ffor-return">
			<strong>{title}.</strong> {detail}
			<div className="center-actions" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
				{offersRetry && (
					<Button className="sm" busy={busy} onClick={retry}>
						Try again
					</Button>
				)}
				{offersEnforce && channelId && (
					<Button className="sm" disabled={busy} onClick={() => setConfirming(true)}>
						Enforce on-chain
					</Button>
				)}
				{!enforce && (
					<Button className="sm" onClick={dismiss}>
						Dismiss
					</Button>
				)}
			</div>
			{confirming && (
				<Modal title="Enforce the epoch on-chain" onClose={() => setConfirming(false)}>
					<div className="error-note">
						This force-closes the channel with your settlement peer. Every voucher this wallet holds a
						preimage for is claimed on-chain through the signature the peer gave at setup; the
						vouchers nobody paid time out back to the peer at the voucher expiry height. The channel
						is gone afterwards and the funds return to your on-chain balance as the close confirms,
						after the usual delays. Do this when the peer stays unreachable or contradicts the epoch,
						not while a cooperative return could still happen.
					</div>
					<div className="center-actions">
						<Button variant="primary" busy={busy} onClick={doEnforce}>
							Force close and claim
						</Button>
						<Button onClick={() => setConfirming(false)}>Cancel</Button>
					</div>
				</Modal>
			)}
		</div>
	);
}
