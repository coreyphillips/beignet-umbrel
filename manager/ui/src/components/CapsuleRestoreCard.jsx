import { useState } from 'react';
import { Button, Card, Field } from './ui.jsx';
import { shortId } from '../lib/format.js';
import { assetRestoreRefusal, refusedAssetChannels, restoreAssetChannels, unresolvedPayments, OMIT_ASSET_CHANNELS_PHRASE } from '../lib/recovery.js';

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
 *
 * A checkpoint that holds asset channels is not resumed as it is: the
 * daemon refuses, writes nothing, and names the channels
 * (`error.details.assetChannels`). The card then lists them, says what
 * leaving them out means, and offers the restore without them behind a
 * typed phrase. That one confirmed call is the only thing that sends
 * `omitAssetChannels`, and what it left out is listed from its answer
 * (`omittedAssetChannels`). The page keeps that answer and hands it back as
 * `restored`, and `onDismiss` is for it to take the card away once the list
 * has been read: the offer itself goes with the restore.
 */
function AssetChannelList({ channels, testId }) {
	return (
		<ul className="guardian-list" data-testid={testId}>
			{channels.map((c) => (
				<li key={c.channelId}>
					with <code>{shortId(c.peerPubkey)}</code>
					{c.capacitySats != null ? `, ${c.capacitySats.toLocaleString('en-US')} sats` : ''}
				</li>
			))}
		</ul>
	);
}

export default function CapsuleRestoreCard({ api, offer, restored, onRestored, onDismiss }) {
	const [busy, setBusy] = useState(null);
	// `restored` is the answer of a restore this card already ran, kept by the
	// page: the wallet restarts on the restored state and the page with it,
	// and a card mounted again shows that answer and not the offer.
	const [result, setResult] = useState(restored ? { kind: 'capsule', ...restored } : null);
	const [refusal, setRefusal] = useState(null);
	// The asset channels the daemon refused the restore over, once it has named them.
	const [held, setHeld] = useState(null);
	const [typed, setTyped] = useState('');

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

	// The exact restore. `without` is true only from the button under the
	// list of asset channels the daemon refused over, once its phrase is
	// typed: nothing else sends the option that leaves them out.
	const resume = async (without) => {
		const omit = without === true && !!held;
		setBusy(omit ? 'omit' : 'capsule');
		setRefusal(null);
		try {
			const r = await api.post('/recovery/restore-capsule', omit ? { confirm: true, omitAssetChannels: true } : { confirm: true });
			setHeld(null);
			setResult({ kind: 'capsule', ...r });
			if (onRestored) onRestored(r);
		} catch (e) {
			const named = refusedAssetChannels(e);
			if (named) {
				setHeld({ code: e.code, channels: named });
				setTyped('');
			} else {
				setRefusal(assetRestoreRefusal(e) || e.message);
			}
		} finally {
			setBusy(null);
		}
	};

	if (result && result.kind === 'capsule') {
		const n = result.channelCount ?? offer.channelCount;
		const left = restoreAssetChannels(result.omittedAssetChannels);
		const unresolved = unresolvedPayments(result);
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
				{left.length > 0 && (
					<div className="info-note" role="status" data-testid="capsule-omitted">
						{left.length === 1 ? 'One asset channel was' : `${left.length} asset channels were`} left out of the restore, as asked. This wallet has no record
						of {left.length === 1 ? 'it' : 'them'} and cannot bring the assets in {left.length === 1 ? 'it' : 'them'} back by itself. The peer of each
						can still close its channel.
						<AssetChannelList channels={left} testId="capsule-omitted-list" />
					</div>
				)}
				{unresolved > 0 && (
					<div className="info-note" role="status" data-testid="capsule-unresolved" data-count={unresolved}>
						{unresolved === 1
							? 'One payment that was under way on those channels is'
							: `${unresolved} payments that were under way on those channels are`}{' '}
						left unresolved. This wallet no longer holds the channels that would say how {unresolved === 1 ? 'it' : 'they'} ended, so{' '}
						{unresolved === 1 ? 'it' : 'each'} stays pending for good: it is not counted as paid or as failed, and it cannot be cancelled or
						tried again from here.
					</div>
				)}
				{left.length > 0 && onDismiss && (
					<div className="center-actions">
						<Button data-testid="capsule-omitted-done" onClick={onDismiss}>
							Done
						</Button>
					</div>
				)}
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
			{held && (
				<div className="error-note" role="alert" data-testid="capsule-asset-channels" data-code={held.code}>
					<p className="restore-lead">
						The restore was refused, and nothing was restored and nothing was written: the checkpoint holds{' '}
						{held.channels.length === 1 ? 'an asset channel' : `${held.channels.length} asset channels`}, which this wallet cannot bring back from it.
					</p>
					<AssetChannelList channels={held.channels} testId="capsule-asset-channel-list" />
					<p className="restore-lead">
						The restore can be run without {held.channels.length === 1 ? 'it' : 'them'}. The bitcoin channels then come back, held as said above, and
						payments and invoices are kept. The asset {held.channels.length === 1 ? 'channel does' : 'channels do'} not come back: this wallet will have no
						record of {held.channels.length === 1 ? 'it' : 'them'} and cannot bring the assets in {held.channels.length === 1 ? 'it' : 'them'} back by
						itself afterwards. The peer of each can still close its channel.
					</p>
					<Field label={`Type ${OMIT_ASSET_CHANNELS_PHRASE} to confirm`}>
						<input value={typed} autoComplete="off" spellCheck={false} data-testid="capsule-omit-typed" onChange={(e) => setTyped(e.target.value)} />
					</Field>
					<div className="center-actions">
						<Button
							variant="danger"
							busy={busy === 'omit'}
							disabled={!!busy || typed.trim().toLowerCase() !== OMIT_ASSET_CHANNELS_PHRASE}
							data-testid="capsule-omit-confirm"
							onClick={() => resume(true)}
						>
							Restore without the asset channels
						</Button>
					</div>
				</div>
			)}
			{refusal && <div className="error-note">The restore was refused: {refusal}</div>}
			<div className="center-actions">
				<Button variant="primary" busy={busy === 'capsule'} disabled={busy === 'scb' || busy === 'omit'} onClick={() => resume(false)}>
					Resume channels
				</Button>
				<Button busy={busy === 'scb'} disabled={busy === 'capsule' || busy === 'omit'} onClick={recover}>
					Recover channel funds
				</Button>
			</div>
		</Card>
	);
}
