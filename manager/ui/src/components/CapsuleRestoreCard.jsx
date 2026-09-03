import { useState } from 'react';
import { Button, Card } from './ui.jsx';
import { shortId } from '../lib/format.js';

/**
 * A channel checkpoint a storage peer returned (beignet 0.9.3+, peer-storage
 * mode). A wallet imported with peer storage pushes nothing while it is
 * empty, so the peers it reconnects to return the checkpoint its previous
 * life left with them; the status route reports the best one.
 *
 * Two ways out of it, the owner's choice:
 *
 * - Recover the funds: the checkpoint's embedded channel list (the SCB) is
 *   handed to the daemon's SCB restore, the channels close safely as their
 *   peers are reached and the funds return on-chain.
 * - Resume the channels: the daemon's exact restore from the checkpoint
 *   (POST /recovery/restore-capsule). The daemon installs the restored
 *   database and holds; the manager restarts the wallet on it, and the
 *   channels come back held (beignet #469): no new payments in until each
 *   peer confirms them, and a close needs the owner to accept that a peer
 *   may hold a newer state. Peer storage cannot prove recency, which is
 *   why the daemon holds them rather than trusting them outright.
 *
 * A wallet whose owner answered the import question (the previous device
 * is stopped) never sees this card: the daemon applies the checkpoint by
 * itself (beignet #690), and the Backup row says where that stands.
 */
export default function CapsuleRestoreCard({ api, offer, onRestored }) {
	const [busy, setBusy] = useState(null);
	const [result, setResult] = useState(null);
	const [refusal, setRefusal] = useState(null);

	const recover = async () => {
		setBusy('scb');
		setRefusal(null);
		try {
			const retrieved = await api.get('/backup/peer-retrieved');
			const r = await api.post('/restore/scb', { encoded: retrieved.encoded });
			setResult({ kind: 'scb', ...r });
			if (onRestored) onRestored(r);
		} catch (e) {
			setRefusal(e.message);
		} finally {
			setBusy(null);
		}
	};

	const resume = async () => {
		setBusy('capsule');
		setRefusal(null);
		try {
			const r = await api.post('/recovery/restore-capsule', { confirm: true });
			setResult({ kind: 'capsule', ...r });
			if (onRestored) onRestored(r);
		} catch (e) {
			setRefusal(e.message);
		} finally {
			setBusy(null);
		}
	};

	if (result && result.kind === 'capsule') {
		const n = result.channelCount ?? offer.channelCount;
		return (
			<Card title={result.restartRequired === false ? 'Channels resuming' : 'Checkpoint installed'}>
				<p className="restore-lead">
					{result.tier === 1
						? 'The checkpoint carried only the channel list, so the channels close safely as their peers are reached and the funds return on-chain.'
						: `${n} channel${n === 1 ? '' : 's'} come back from the checkpoint, held: no new payments in until each peer confirms them, and closing one means accepting that a peer may hold a newer state.${
								result.restartRequired === false
									? ''
									: ' The wallet restarts on the restored state by itself; give it a moment.'
						  }`}
				</p>
			</Card>
		);
	}

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
				Resuming the channels brings them back where the checkpoint left them, held: no new
				payments in until each peer confirms them, and closing one means accepting that a peer
				may hold a newer state. The wallet restarts on the restored state. Recovering the funds
				instead closes those channels safely and returns the funds on-chain.
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
			{refusal && <div className="error-note">The restore was refused: {refusal}</div>}
			<div className="center-actions">
				<Button variant="primary" busy={busy === 'capsule'} disabled={busy === 'scb'} onClick={resume}>
					Resume channels
				</Button>
				<Button busy={busy === 'scb'} disabled={busy === 'capsule'} onClick={recover}>
					Recover channel funds
				</Button>
			</div>
		</Card>
	);
}
