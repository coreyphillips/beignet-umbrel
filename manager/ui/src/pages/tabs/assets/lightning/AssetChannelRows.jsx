import { useState } from 'react';
import AssetAvatar from '../../../../components/AssetAvatar.jsx';
import { AssetAmount } from '../../../../components/AssetAmount.jsx';
import { Badge, Button, CopyText, ExplorerLink, FeeField, Modal } from '../../../../components/ui.jsx';
import { fmtAsset } from '../../../../lib/asset-amount.js';
import { canClose, canReclaim, channelState, closeWays, peerAway, peerName, reclaimSent, sharePct, undeliveredNote } from '../../../../lib/asset-lightning.js';
import { txUrl } from '../../../../lib/explorer.js';
import { FEE_CAP_MULTIPLE } from '../../../../lib/fees.js';
import { fmtSats, shortId } from '../../../../lib/format.js';
import { FeePresets } from '../shared.jsx';

/**
 * The asset channels of a wallet, one block each.
 *
 * A channel funded with an asset is counted in the asset, so every figure
 * here is in its units: what is on each side, what can be sent and received
 * right now, and how much the channel holds in all. The bitcoin the channel
 * also holds is the one figure in sats, and is labelled as that.
 *
 * A list and not a table: six figures a channel do not fit a phone as
 * columns, and a block wraps where a row would scroll sideways.
 *
 * An open whose funding transaction has not confirmed says so, and where
 * the wallet says its bitcoin can be taken back (`reclaimable`) the line
 * offers that, quietly: most fundings confirm by themselves. Once a
 * transaction that takes it back is out, the row says that instead, links
 * it, and the one thing left to offer is a higher fee.
 *
 * A channel whose peer is away keeps its badge and says "peer offline"
 * beside it, in grey: it is still open, and carries nothing until the
 * peer is back. A channel the wallet's node gave up is badged "failed" and
 * says what to do about it. A state this page has not met is shown in the
 * wallet's own word, and can be closed like any other.
 *
 * An open that failed after the wallet had taken it on (`failure`) stays
 * listed for a while as what it is: the wallet's sentence for why, what it
 * was for, and no figures, since nothing is in it and nothing left the
 * wallet.
 */
export default function AssetChannelRows({ channels, network, onClose, onReclaim }) {
	return (
		<ul className="asset-channel-list" data-testid="asset-channel-list">
			{(channels || []).map((c) => {
				const state = channelState(c.state);
				const alias = typeof c.peerAlias === 'string' && c.peerAlias.trim() ? c.peerAlias.trim() : null;
				const takingBack = reclaimSent(c);
				const failed = c.failure && typeof c.failure === 'object' ? c.failure : null;
				const away = peerAway(c);
				const errored = String(c.state || '').toUpperCase() === 'ERRORED';
				const reclaim = onReclaim && canReclaim(c) && (
					<div className="note-actions">
						<Button className="sm" data-testid="asset-channel-reclaim" onClick={(e) => onReclaim(c, e)}>
							{takingBack ? 'Raise the fee' : 'Take the funding back'}
						</Button>
					</div>
				);
				return (
					// A channel is known by the id its open was given until the funding
					// transaction gives it its own. The first stays with it, so the row
					// is the same row across that change.
					<li key={c.pendingChannelId || c.channelId} className="asset-channel" data-testid="asset-channel" data-state={c.state}>
						<div className="asset-channel-head">
							<AssetAvatar asset={c.asset} />
							<div className="asset-channel-title">
								<div className="asset-name">{c.asset?.name || 'Asset'}</div>
								<div className="wallet-meta">
									with {alias ? `${alias} · ` : ''}
									<span className="mono" title={c.peerPubkey}>
										{shortId(c.peerPubkey)}
									</span>
								</div>
							</div>
							<Badge tone={state.tone}>{takingBack ? 'taking back' : state.word}</Badge>
							{/* Beside the state, where a narrow screen does not cut it short. */}
							{away && (
								<span className="badge muted" data-testid="asset-channel-peer-offline">
									peer offline
								</span>
							)}
							{/* An open whose funding is being taken back cannot be closed: it ends by itself. */}
							{onClose && canClose(c) && !takingBack && (
								<Button className="sm" data-testid="asset-channel-close" onClick={(e) => onClose(c, e)}>
									Close
								</Button>
							)}
						</div>

						{failed && (
							<div className="error-note" role="note" data-testid="asset-channel-failure" data-code={failed.code}>
								{failed.message || 'This channel was not opened, and nothing was spent.'} It was for{' '}
								<AssetAmount value={c.capacity} asset={c.asset} />.
							</div>
						)}
						{!failed && (
							<>
						<div
							className="balbar asset-channel-bar"
							role="img"
							aria-label={`${fmtAsset(c.localBalance, c.asset)} on your side, ${fmtAsset(c.remoteBalance, c.asset)} on the peer's side`}
						>
							<div className="balbar-local" style={{ width: `${sharePct(c.localBalance, c.remoteBalance)}%` }} />
						</div>
						<div className="asset-channel-sides">
							<span data-testid="asset-channel-local">
								<AssetAmount value={c.localBalance} asset={c.asset} /> <span className="side-word">yours</span>
							</span>
							<span data-testid="asset-channel-remote">
								<span className="side-word">theirs</span> <AssetAmount value={c.remoteBalance} asset={c.asset} />
							</span>
						</div>

						<dl className="asset-channel-facts">
							<div>
								<dt>Can send</dt>
								<dd>
									<AssetAmount value={c.sendable} asset={c.asset} />
								</dd>
							</div>
							<div>
								<dt>Can receive</dt>
								<dd>
									<AssetAmount value={c.receivable} asset={c.asset} />
								</dd>
							</div>
							<div>
								<dt>Capacity</dt>
								<dd>
									<AssetAmount value={c.capacity} asset={c.asset} />
								</dd>
							</div>
							<div>
								<dt>Bitcoin in the channel</dt>
								<dd>{fmtSats(c.channelSats)}</dd>
							</div>
						</dl>
							</>
						)}
						{errored && (
							<div className="error-note" role="note" data-testid="asset-channel-errored">
								This channel has failed and carries no payments. Force close it to bring what is in it back on-chain.
							</div>
						)}
						{undeliveredNote(c) && (
							<div className="info-note" role="note" data-testid="asset-channel-undelivered" data-count={c.undeliveredOutcomes}>
								{undeliveredNote(c)}
							</div>
						)}
						{away && !errored && state.word !== 'opening' && (
							<div className="field-hint" data-testid="asset-channel-away">
								The peer of this channel is not connected, so it carries no payments until it is back.
							</div>
						)}
						{takingBack ? (
							<div className="field-hint note-with-action" data-testid="asset-channel-reclaiming">
								<span>
									The funding of this channel is being taken back. Once that transaction confirms the channel is
									gone, and its {c.asset?.name || 'asset'} is back in this wallet&apos;s holdings.{' '}
									<CopyText value={c.reclaimTxid} label={shortId(c.reclaimTxid, 8)} />{' '}
									<ExplorerLink url={txUrl(network, c.reclaimTxid)}>View</ExplorerLink>
								</span>
								{reclaim}
							</div>
						) : (
							state.word === 'opening' && (
								<div className="field-hint note-with-action" data-testid="asset-channel-opening">
									<span>Opening. It can carry payments once its funding transaction has confirmed.</span>
									{reclaim}
								</div>
							)
						)}
					</li>
				);
			})}
		</ul>
	);
}

/**
 * Taking the funding of an open back.
 *
 * What it does in two sentences, the fee rate, and the button. The wallet
 * cannot say what the transaction costs before it is made, so the dialog
 * says where the fee comes from, and the wallet's answer says the figure.
 * Asked for again on an open whose funding is already being taken back, it
 * is the same request at a higher fee, and is worded as that.
 *
 * `onConfirm(feeRate)` does it and may reject with { code, text }; the
 * dialog stays open with the reason when it does.
 */
export function ReclaimFundingModal({ channel, fees, origin, onClose, onConfirm }) {
	const [feeRate, setFeeRate] = useState('');
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState(null);
	const again = reclaimSent(channel);
	const who = peerName(channel);
	const name = channel.asset?.name || 'asset';
	const rate = parseInt(feeRate, 10) || fees?.fast || null;
	const label = again ? 'Raise the fee' : 'Take the funding back';

	const run = async () => {
		if (busy || !rate) return;
		setBusy(true);
		setFailure(null);
		try {
			await onConfirm(rate);
		} catch (e) {
			setFailure({ code: e?.code || '', text: e?.text || e?.message || 'The funding could not be taken back.' });
			setBusy(false);
		}
	};

	return (
		<Modal title={label} onClose={onClose} origin={origin}>
			<div data-testid="asset-channel-reclaim-dialog" data-again={again ? 'yes' : 'no'}>
				{again ? (
					<p className="wallet-meta">
						The transaction that takes the funding of the {name} channel with {who} back has not confirmed. This sends
						it again at a higher fee, in place of the one before.
					</p>
				) : (
					<p className="wallet-meta">
						This sends a transaction that spends the same bitcoin back to this wallet at a higher fee, so the funding of
						the {name} channel with {who} can never confirm and the {name} stays in the wallet. Most fundings confirm by
						themselves, and waiting costs nothing.
					</p>
				)}
				<FeeField
					label="Fee rate (sat/vB)"
					value={feeRate}
					onChange={setFeeRate}
					rate={rate}
					max={Math.max(10, (fees?.fast || 10) * FEE_CAP_MULTIPLE)}
					hint={
						again
							? 'It has to be above the rate of the transaction sent before, or the network does not take it in its place.'
							: 'It has to be above the rate the funding transaction pays, or the network does not take it in its place.'
					}
				/>
				<FeePresets fees={fees} onPick={setFeeRate} />
				<div className="field-note" data-testid="asset-channel-reclaim-cost">
					The miner fee comes out of the bitcoin that returns. The wallet says the figure once the transaction is made.
				</div>
				{failure && (
					<div className="error-note" role="alert" data-testid="asset-channel-reclaim-error" data-code={failure.code}>
						{failure.text}
					</div>
				)}
				<div className="center-actions">
					<Button variant="primary" busy={busy} disabled={!rate || busy} data-testid="asset-channel-reclaim-confirm" onClick={run}>
						{label}
					</Button>
					<Button onClick={onClose}>{failure ? 'Close' : 'Cancel'}</Button>
				</div>
			</div>
		</Modal>
	);
}

/**
 * Closing an asset channel.
 *
 * The cooperative close is the one offered. A force close is a second
 * question behind it, asked on a page of its own: it is slower, costs more,
 * and is only for a peer that has stopped answering, so it is never one
 * misplaced press away.
 *
 * A channel whose peer is away says, before anything is tried, that a
 * close with the peer needs the peer. A channel that failed has no close
 * with its peer at all: its dialog is the force close, worded for that.
 * An open has no force close at all: nothing of it is on chain to close.
 *
 * `onConfirm(force)` does the close and may reject; the dialog stays open
 * with the reason when it does.
 */
export function CloseAssetChannelModal({ channel, origin, onClose, onConfirm }) {
	const ways = closeWays(channel);
	const [forcing, setForcing] = useState(!ways.cooperative);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(null);
	const who = peerName(channel);
	const mine = fmtAsset(channel.localBalance, channel.asset);

	const run = async (force) => {
		setBusy(true);
		setError(null);
		try {
			await onConfirm(force);
		} catch (e) {
			setError(e?.text || e?.message || 'The channel could not be closed.');
			setBusy(false);
		}
	};

	return (
		<Modal title={forcing ? 'Force close asset channel' : 'Close asset channel'} onClose={onClose} origin={origin}>
			<div data-testid="asset-channel-close-dialog" data-step={forcing ? 'force' : 'cooperative'}>
				{!forcing ? (
					<>
						<p className="wallet-meta">
							Close the {channel.asset?.name} channel with {who}? Your side of it, {mine}, comes back to this wallet
							on-chain, along with the bitcoin the channel holds, once the closing transaction confirms.
						</p>
						<p className="wallet-meta">
							After that this wallet can no longer send or receive {channel.asset?.name} over Lightning through this
							peer.
						</p>
						{ways.peerAway && (
							<div className="info-note" role="note" data-testid="asset-channel-close-offline">
								The peer is not connected. A channel is closed together with its peer only while it is, so this will be
								refused until the peer is back.{' '}
								{ways.force
									? 'If the peer is gone for good, a force close brings your side back without it.'
									: 'An open that does not go through ends by itself.'}
							</div>
						)}
					</>
				) : !ways.cooperative ? (
					<>
						<div className="error-note" role="alert">
							This channel has failed, so it can no longer be closed together with its peer. A force close is the way to
							bring what is in it back.
						</div>
						<p className="wallet-meta">
							Your {mine} and the channel&apos;s bitcoin come back only after the channel&apos;s safety delay, which can
							be days, and the transaction costs more in mining fees than an agreed close.
						</p>
					</>
				) : (
					<>
						<div className="error-note" role="alert">
							A force close does not ask the peer. It is for a peer that has stopped answering, and for nothing else.
						</div>
						<p className="wallet-meta">
							Your {mine} and the channel&apos;s bitcoin come back only after the channel&apos;s safety delay, which can
							be days, and the transaction costs more in mining fees than an agreed close. If the peer is reachable,
							go back and close cooperatively.
						</p>
					</>
				)}
				{error && (
					<div className="error-note" role="alert" data-testid="asset-channel-close-error">
						{error}
					</div>
				)}
				<div className="center-actions">
					{!forcing ? (
						<>
							<Button variant="primary" busy={busy} data-testid="asset-channel-close-coop" onClick={() => run(false)}>
								Close cooperatively
							</Button>
							{ways.force && (
								<Button
									variant="danger"
									disabled={busy}
									data-testid="asset-channel-close-force"
									onClick={() => {
										setError(null);
										setForcing(true);
									}}
								>
									Force close…
								</Button>
							)}
							<Button onClick={onClose}>Cancel</Button>
						</>
					) : (
						<>
							<Button variant="danger" busy={busy} data-testid="asset-channel-close-force-confirm" onClick={() => run(true)}>
								Force close anyway
							</Button>
							{ways.cooperative ? (
								<Button
									disabled={busy}
									data-testid="asset-channel-close-back"
									onClick={() => {
										setError(null);
										setForcing(false);
									}}
								>
									Back
								</Button>
							) : (
								<Button onClick={onClose}>Cancel</Button>
							)}
						</>
					)}
				</div>
			</div>
		</Modal>
	);
}
