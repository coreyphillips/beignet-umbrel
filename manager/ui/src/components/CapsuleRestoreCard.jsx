import { useState } from 'react';
import { Button, Card } from './ui.jsx';
import { shortId } from '../lib/format.js';

/**
 * A channel checkpoint a storage peer returned (beignet 0.9.3+, peer-storage
 * mode). A wallet imported with peer storage pushes nothing while it is
 * empty, so the peers it reconnects to return the checkpoint its previous
 * life left with them; the status route reports the best one.
 *
 * What this card does with it is the path that works with this engine: the
 * checkpoint's embedded channel list (the SCB) is handed to the daemon's
 * SCB restore, the channels close safely as their peers are reached and the
 * funds return on-chain. The engine also has an exact restore from the
 * checkpoint (POST /recovery/restore-capsule), but against a live peer it
 * cannot resume anything today: the peer closes the channel the moment the
 * empty wallet reconnects, before the checkpoint can be applied (beignet
 * issues #462 and #463), and the restored copy then drops the channel and
 * leaves the closing output unswept. Until those land, offering it would be
 * offering a trap, so the card offers the recovery that holds.
 */
export default function CapsuleRestoreCard({ api, offer, onRestored }) {
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState(null);
	const [refusal, setRefusal] = useState(null);

	const recover = async () => {
		setBusy(true);
		setRefusal(null);
		try {
			const retrieved = await api.get('/backup/peer-retrieved');
			const r = await api.post('/restore/scb', { encoded: retrieved.encoded });
			setResult(r);
			if (onRestored) onRestored(r);
		} catch (e) {
			setRefusal(e.message);
		} finally {
			setBusy(false);
		}
	};

	if (result) {
		const n = (result.recovering || []).length;
		const skipped = (result.skipped || []).length;
		return (
			<Card title="Channel funds recovering">
				<p className="restore-lead">
					{n} channel{n === 1 ? '' : 's'} recovering: each closes safely as its peer is reached
					and the funds return on-chain. A peer that is offline is retried as the wallet keeps
					running.
					{skipped > 0 ? ` ${skipped} already known to this wallet were left as they are.` : ''}
				</p>
			</Card>
		);
	}

	return (
		<Card title="Channel checkpoint found">
			<p className="restore-lead">
				A peer returned a channel checkpoint for this seed: {offer.channelCount} channel
				{offer.channelCount === 1 ? '' : 's'}, sequence {offer.sequence}, from{' '}
				<code>{shortId(offer.fromPeer)}</code>
				{offer.candidates > 1 ? ` (the newest of ${offer.candidates})` : ''}.
			</p>
			<p className="restore-lead">
				Recovering from it closes those channels safely and returns the funds on-chain. This
				engine cannot yet resume them where they were: a peer closes a channel the moment the
				empty wallet reconnects, before the checkpoint can be applied.
			</p>
			{offer.guardians.length > 0 && (
				<div className="info-note">
					This checkpoint names {offer.guardians.length} guardians, so its channels are also
					held by a guardian set, which can resume them exactly. To try that instead, set
					those guardians in Settings and import the seed with a guardian mode:
					<ul className="guardian-list">
						{offer.guardians.map((g) => (
							<li key={g.guardianId}>
								<code>
									{g.guardianId}@{(g.transports || []).map((t) => t.url).join(' or ')}
								</code>
							</li>
						))}
					</ul>
				</div>
			)}
			{refusal && <div className="error-note">The recovery was refused: {refusal}</div>}
			<div className="center-actions">
				<Button variant="primary" busy={busy} onClick={recover}>
					Recover channel funds
				</Button>
			</div>
		</Card>
	);
}
